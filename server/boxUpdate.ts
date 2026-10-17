import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './exec.ts';
import { projectEnv } from './projectEnv.ts';
import { parseSymref, refusal, rollbackPlan, stepsFor } from '../scripts/officeSteps.mjs';
import type { BoxUpdateResult } from './fleet.ts';

// `cubefarm box --update <commit>`: a box bringing its cubefarm checkout to the office's commit (#94), run by the office
// over ssh once nothing runs there. The launcher's rules (office.mjs): fast-forward only, on the default branch, no
// local changes; npm install when the dependencies changed; a failed step rolls back. A box only runs the server
// bundle, so that's all it builds. The office then restarts the box's host on the new build. A box run by npx has no
// checkout: it says so, and its next link already runs the office's version.

const ROOT = path.resolve(import.meta.dirname, '..');
const short = (sha: string) => sha.slice(0, 7);
const real = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a: string, b: string) => (process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

/** Why the checkout can't move to the office's commit, or null when it can (the launcher's rules, then: not past it). */
export function updateRefusal(s: { branch: string; defaultBranch: string; dirty: boolean; ahead: number; behindOffice: boolean; office: string }): string | null {
  const why = refusal(s);
  if (why) return why.replace('the office folder', "the box's cubefarm folder");
  return s.behindOffice ? null : `the box's cubefarm has commits the office's ${short(s.office)} hasn't`;
}

/** The commit this box's cubefarm checkout is on; null when it doesn't run from a checkout. */
export async function checkoutCommit(root = ROOT): Promise<string | null> {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: root }).catch(() => null);
  if (!top || !samePath(top, root)) return null;
  return git(['rev-parse', 'HEAD'], { cwd: root }).catch(() => null);
}

/** npm, or node, in the checkout. On Windows npm is a .cmd, so it goes through cmd.exe (fixed arguments only). */
function step(file: 'npm' | 'node', args: string[], root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = file === 'node' ? [process.execPath, args] : process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]] : ['npm', args];
    const proc = spawn(cmd, cmdArgs, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: projectEnv(process.env) });
    let last = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => {
      const lines = d.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) last = lines[lines.length - 1].trim();
    });
    proc.on('error', (err) => reject(new Error(`${file} ${args[0]} failed: ${err.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${file} ${args.join(' ')} failed (exit ${code})${last ? `: ${last}` : ''}`))));
  });
}

const install = (root: string) => step('npm', ['install', '--no-audit', '--no-fund', '--no-save'], root);
const build = (root: string) => step('node', [path.join('scripts', 'build-server.mjs')], root);

async function defaultBranch(root: string) {
  const local = await git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd: root }).catch(() => '');
  if (local.startsWith('origin/')) return local.slice('origin/'.length);
  const remote = parseSymref(await git(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: root, timeoutMs: 60_000 }).catch(() => ''));
  if (remote) return remote;
  throw new Error("can't tell origin's default branch");
}

/** Bring the box's checkout to the office's commit. Never throws: a failure is in the result, rolled back. */
export async function updateBox(commit: string, root = ROOT): Promise<BoxUpdateResult> {
  const from = await checkoutCommit(root);
  if (!from) return { ok: true, checkout: false, from: null, to: null };
  if (from === commit) return { ok: true, checkout: true, from, to: from };
  const ran = { installed: false, built: false };
  const g = (args: string[], timeoutMs?: number) => git(args, { cwd: root, timeoutMs });
  let error: string | undefined;
  try {
    await g(['fetch', 'origin', '--prune'], 180_000);
    if (!(await g(['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false))) throw new Error(`the office's ${short(commit)} isn't on the box's origin`);
    const branch = await defaultBranch(root);
    const refused = updateRefusal({
      branch: await g(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
      defaultBranch: branch,
      dirty: (await g(['status', '--porcelain', '--untracked-files=no'])) !== '',
      ahead: Number(await g(['rev-list', '--count', `origin/${branch}..HEAD`])),
      behindOffice: await g(['merge-base', '--is-ancestor', 'HEAD', commit]).then(() => true, () => false),
      office: commit,
    });
    if (refused) throw new Error(refused);
    await g(['merge', '--ff-only', commit]);
    const changed = (await g(['diff', '--name-only', from, 'HEAD'])).split(/\r?\n/).filter(Boolean);
    const steps = stepsFor(changed, { startMode: true });
    if (steps.install) {
      ran.installed = true;
      await install(root);
    }
    if (steps.build) {
      ran.built = true;
      await build(root);
    }
  } catch (err) {
    error = (err as Error).message.split(/\r?\n/)[0];
    const head = await g(['rev-parse', 'HEAD']).catch(() => from);
    const plan = rollbackPlan({ moved: head !== from, ...ran });
    try {
      if (plan.reset) await g(['reset', '--keep', from]);
      if (plan.install) await install(root);
      if (plan.build) await build(root);
    } catch (e) {
      error += `; the rollback failed too: ${(e as Error).message.split(/\r?\n/)[0]}`;
    }
  }
  const to = await g(['rev-parse', 'HEAD']).catch(() => from);
  return { ok: !error, checkout: true, from, to, ...(error ? { error } : {}) };
}
