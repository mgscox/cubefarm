import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneDeskSkills, readRepoSkills, stageCodexSkills, writeSessionSkills } from './repoSkills.ts';

const folders: string[] = [];
const skill = 'cubefarm-rollout-probe';
const deskBundle = path.join('.agents', 'skills', 'cubefarm-bundle');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm skills '));
  folders.push(dir);
  return dir;
}

function release(root: string, marker?: string) {
  fs.mkdirSync(root, { recursive: true });
  if (marker) {
    const skillDir = path.join(root, 'skills', skill);
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Read the release marker.\n---\nRead references/version.txt.\n`);
    fs.writeFileSync(path.join(skillDir, 'references', 'version.txt'), marker);
  }
  return readRepoSkills(root, marker ?? 'removed');
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('release skills in a Codex desk', () => {
  it('stages the release on a linked worktree and excludes only its own bundle', () => {
    const root = fixture();
    const main = path.join(root, 'main');
    const desk = path.join(root, 'linked desk');
    git(root, 'init', main);
    git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git(main, 'worktree', 'add', '--detach', desk);
    const project = path.join(desk, '.agents', 'skills', 'project-review');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'SKILL.md'), 'Project skill');

    const first = release(path.join(root, 'release 1'), 'release 1');
    const sessionDir = path.join(root, 'session');
    stageCodexSkills(first, desk, sessionDir);
    const marker = path.join(desk, deskBundle, skill, 'references', 'version.txt');
    expect(fs.readFileSync(marker, 'utf8')).toBe('release 1');
    git(desk, 'add', '-A');
    expect(git(desk, 'diff', '--cached', '--name-only')).toBe('.agents/skills/project-review/SKILL.md');

    stageCodexSkills(release(path.join(root, 'release 2')), desk, sessionDir);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(project, 'SKILL.md'), 'utf8')).toBe('Project skill');
    stageCodexSkills(first, desk, sessionDir);
    expect(fs.readFileSync(marker, 'utf8')).toBe('release 1');
  });

  it('reclaims a retired startup copy only after its keeper releases the session', () => {
    const root = fixture();
    const workspace = path.join(root, 'workspaces');
    const desk = path.join(workspace, 'owner__project', 'desks', 'codex');
    fs.mkdirSync(desk, { recursive: true });
    git(desk, 'init');
    const sessionDir = path.join(root, 'running session');
    const first = release(path.join(root, 'release 1'), 'release 1');
    const second = release(path.join(root, 'release 2'));
    stageCodexSkills(first, desk, sessionDir);

    pruneDeskSkills(second, workspace, [{ exit: null, meta: { dir: sessionDir } }]);
    expect(fs.existsSync(path.join(desk, deskBundle, skill, 'SKILL.md'))).toBe(true);
    pruneDeskSkills(second, workspace, [{ exit: 0, meta: { dir: sessionDir } }]);
    expect(fs.existsSync(path.join(desk, deskBundle))).toBe(false);
  });

  it('preserves a foreign file even inside a formerly managed bundle', () => {
    const root = fixture();
    const desk = path.join(root, 'desk');
    git(root, 'init', desk);
    const first = release(path.join(root, 'release 1'), 'release 1');
    stageCodexSkills(first, desk, root);
    const foreign = path.join(desk, deskBundle, 'project.txt');
    fs.writeFileSync(foreign, 'keep this');
    expect(() => stageCodexSkills(release(path.join(root, 'release 2')), desk, root)).toThrow(/unmanaged/i);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('keep this');
  });
});

describe('release skills in local agent processes', () => {
  it('keeps Claude and OpenCode supporting files readable through release removal', () => {
    const root = fixture();
    const checkout = path.join(root, 'release');
    const first = release(checkout, 'release 1');
    const claude = writeSessionSkills(first, path.join(root, 'Claude session'), 'claude')!;
    const openCode = writeSessionSkills(first, path.join(root, 'OpenCode session'), 'opencode')!;
    fs.rmSync(path.join(checkout, 'skills'), { recursive: true });
    expect(readRepoSkills(checkout, 'release 2').skills).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(claude, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('cubefarm');
    for (const skills of [path.join(claude, 'skills'), openCode]) {
      expect(fs.readFileSync(path.join(skills, skill, 'references', 'version.txt'), 'utf8')).toBe('release 1');
    }
  });

  it('rejects a release skill with a different metadata name', () => {
    const root = fixture();
    release(root, 'release 1');
    const manifest = path.join(root, 'skills', skill, 'SKILL.md');
    fs.writeFileSync(manifest, '---\nname: cubefarm-other\ndescription: Fixture.\n---\n');
    expect(() => readRepoSkills(root, 'bad release')).toThrow(/invalid skill metadata/i);
  });

  it('rejects nested manifests that Codex could discover as undeclared skills', () => {
    const root = fixture();
    release(root, 'release 1');
    const dir = path.join(root, 'skills', skill);
    fs.copyFileSync(path.join(dir, 'SKILL.md'), path.join(dir, 'references', 'SKILL.md'));
    expect(() => readRepoSkills(root, 'bad release')).toThrow(/nested skill\.md/i);
  });
});
