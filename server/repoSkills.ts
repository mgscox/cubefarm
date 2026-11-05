// Release-local agent skills and the managed copy used by Codex worktrees.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const DESK_BUNDLE = '.agents/skills/cubefarm-bundle';
const DESK_EXCLUDE = `/${DESK_BUNDLE}/`;
const OWNED = '.cubefarm-managed';
const OWNER = 'cubefarm repo skills';
const SKILL_NAME = /^(?:cubebase-prototype|cubefarm-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

interface SkillFile {
  path: string;
  content: Buffer;
  mode: number;
}

export interface RepoSkills {
  release: string;
  skills: { name: string; path: string }[];
  files: SkillFile[];
}

function stat(file: string) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function entries(dir: string) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function readFiles(root: string, dir: string): SkillFile[] {
  return entries(dir).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(root, file);
    if (!entry.isFile()) throw new Error(`Expected a regular file in repo skills: ${file}`);
    const mode = (fs.statSync(file).mode & 0o111) ? 0o755 : 0o644;
    return [{ path: path.relative(root, file).split(path.sep).join('/'), content: fs.readFileSync(file), mode }];
  });
}

/** Load the complete release into memory so future checkout changes cannot alter this process's bundle. */
export function readRepoSkills(releaseRoot: string, version: string): RepoSkills {
  const root = path.join(releaseRoot, 'skills');
  const skills: RepoSkills['skills'] = [];
  const files: SkillFile[] = [];
  const info = stat(root);
  if (info && !info.isDirectory()) throw new Error(`Expected a repo skills directory: ${root}`);
  for (const entry of info ? entries(root) : []) {
    if (entry.isFile() && entry.name === 'README.md') continue;
    const name = entry.name;
    const manifest = `${name}/SKILL.md`;
    if (!entry.isDirectory() || name.length > 64 || !SKILL_NAME.test(name)) {
      throw new Error(`Invalid repo skill directory: ${path.join(root, name)}`);
    }
    const skillFiles = readFiles(root, path.join(root, name));
    if (skillFiles.some((file) => file.path !== manifest && path.posix.basename(file.path).toLowerCase() === 'skill.md')) {
      throw new Error(`Nested SKILL.md is not allowed inside repo skill ${name}`);
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillFiles.find((file) => file.path === manifest)?.content.toString('utf8') ?? '');
    const metadata = frontmatter && parseDocument(frontmatter[1]);
    const description = metadata && metadata.get('description');
    if (!metadata || metadata.errors.length || metadata.get('name') !== name ||
        typeof description !== 'string' || !description.trim() || description.length > 1024) {
      throw new Error(`Invalid skill metadata in ${path.join(root, manifest)}: expected name ${name} and a description`);
    }
    skills.push({ name, path: `skills/${manifest}` });
    files.push(...skillFiles);
  }
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(JSON.stringify([file.path, file.content.length])).update(file.content);
  }
  return { release: `${version}+${digest.digest('hex')}`, skills, files };
}

const releaseRoot = path.resolve(import.meta.dirname, '..');
export const ACTIVE_REPO_SKILLS = readRepoSkills(
  releaseRoot,
  JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8')).version,
);

function writeSkillFiles(bundle: RepoSkills, dir: string) {
  for (const file of bundle.files) {
    const destination = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content, { mode: file.mode });
  }
}

/** Per-process copies survive a checkout update for as long as the owning session needs them. */
export function writeSessionSkills(bundle: RepoSkills, dir: string, runtime: 'claude' | 'opencode'): string | undefined {
  if (!bundle.skills.length) return;
  const root = path.join(dir, 'repo-skills');
  const skills = path.join(root, 'skills');
  writeSkillFiles(bundle, skills);
  if (runtime === 'opencode') return skills;
  const manifest = path.join(root, '.claude-plugin');
  fs.mkdirSync(manifest, { recursive: true });
  fs.writeFileSync(path.join(manifest, 'plugin.json'), JSON.stringify({ name: 'cubefarm', description: 'CubeFarm release skills' }));
  return root;
}

function git(cwd: string, args: string[], input?: string) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ensureDeskExclude(cwd: string, files: SkillFile[]) {
  const exclude = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim();
  const info = stat(exclude);
  if (info && !info.isFile()) throw new Error(`Expected a regular Git exclude file: ${exclude}`);
  const current = info ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).includes(DESK_EXCLUDE)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# added by cubefarm\n${DESK_EXCLUDE}\n`);
  }
  const paths = [OWNED, ...files.map((file) => file.path)].map((file) => `${DESK_BUNDLE}/${file}`);
  let ignored = '';
  try {
    ignored = git(cwd, ['check-ignore', '-z', '--stdin'], `${paths.join('\0')}\0`);
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
  if (ignored.split('\0').filter(Boolean).length !== paths.length) {
    throw new Error(`Git is not ignoring all CubeFarm skills in ${DESK_BUNDLE}; check the desk's ignore rules`);
  }
}

function deskBundle(cwd: string) {
  const target = path.join(cwd, DESK_BUNDLE);
  for (const parent of [path.join(cwd, '.agents'), path.dirname(target)]) {
    const info = stat(parent);
    if (info && !info.isDirectory()) throw new Error(`Cannot stage CubeFarm skills through ${parent}`);
  }
  return target;
}

function assertUntracked(cwd: string) {
  if (git(cwd, ['ls-files', '-z', '--', `:(icase)${DESK_BUNDLE}`])) {
    throw new Error(`Tracked files conflict with CubeFarm skills in ${DESK_BUNDLE}`);
  }
}

function deskOwner(target: string): { release: string; sessionDir: string } {
  const marker = path.join(target, OWNED);
  if (stat(target)?.isDirectory() && stat(marker)?.isFile()) {
    try {
      const { owner, release, sessionDir, files } = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (owner === OWNER && typeof release === 'string' && typeof sessionDir === 'string' && Array.isArray(files)) {
        const managed = new Set([OWNED, ...files]);
        if (readFiles(target, target).every((file) => managed.has(file.path))) return { release, sessionDir };
      }
    } catch { /* an unrecognized marker does not grant ownership */ }
  }
  throw new Error(`Unmanaged files conflict with CubeFarm skills in ${DESK_BUNDLE}`);
}

/** Retire stale copies after the keeper identifies the sessions it still holds. */
export function pruneDeskSkills(bundle: RepoSkills, workspace: string, held: { exit: number | null; meta: unknown }[]) {
  const live = new Set(held.filter((pty) => pty.exit === null).map((pty) => (pty.meta as { dir?: string } | null)?.dir));
  const list = (dir: string) => {
    try { return stat(dir)?.isDirectory() ? entries(dir) : []; }
    catch (err) {
      console.warn(`Could not scan for retired repo skills in ${dir}: ${(err as Error).message}`);
      return [];
    }
  };
  for (const repo of list(workspace)) {
    if (!repo.isDirectory()) continue;
    const desks = path.join(workspace, repo.name, 'desks');
    for (const desk of list(desks)) {
      if (!desk.isDirectory()) continue;
      const cwd = path.join(desks, desk.name);
      try {
        const target = deskBundle(cwd);
        if (!stat(target)) continue;
        const owner = deskOwner(target);
        if (owner.release === bundle.release || live.has(owner.sessionDir)) continue;
        assertUntracked(cwd);
        fs.rmSync(target, { recursive: true, maxRetries: 5 });
      } catch (err) {
        console.warn(`Could not retire repo skills in ${cwd}: ${(err as Error).message}`);
      }
    }
  }
}

/** Reconcile a desk only when it is about to start a Codex process. */
export function stageCodexSkills(bundle: RepoSkills, cwd: string, sessionDir: string) {
  const target = deskBundle(cwd);
  const existing = stat(target);
  if (!existing && !bundle.skills.length) return;
  assertUntracked(cwd);
  if (existing) deskOwner(target);
  if (!bundle.skills.length) {
    fs.rmSync(target, { recursive: true, maxRetries: 5 });
    return;
  }
  ensureDeskExclude(cwd, bundle.files);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(cwd), '.cubefarm-skills-'));
  const next = path.join(temp, 'next');
  const previous = path.join(temp, 'previous');
  let keepBackup = false;
  try {
    writeSkillFiles(bundle, next);
    fs.writeFileSync(path.join(next, OWNED), JSON.stringify({
      owner: OWNER, release: bundle.release, sessionDir, files: bundle.files.map((file) => file.path),
    }));
    if (existing) fs.renameSync(target, previous);
    try {
      fs.renameSync(next, target);
    } catch (err) {
      if (existing) {
        keepBackup = true;
        fs.renameSync(previous, target);
        keepBackup = false;
      }
      throw err;
    }
  } finally {
    if (!keepBackup) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}
