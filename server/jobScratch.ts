import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { AgentRole } from '../shared/types.ts';
import { HOME_DIR } from './config.ts';
import { operationSignal } from './operation.ts';

// Disposable files are scoped to a CubeFarm session, separate from its CLI state and Git desk.

export const SESSIONS_DIR = path.resolve(HOME_DIR, 'sessions');

export function jobScratchEnabled(role: AgentRole): boolean {
  return role === 'dev' || role === 'qa';
}

export function createJobScratch(sessionDir: string): string {
  const scratch = path.join(sessionDir, 'job-scratch');
  fs.mkdirSync(scratch, { mode: 0o700 });
  return scratch;
}

export const JOB_SCRATCH_INSTRUCTIONS = `\n\nUse the directory in CUBEFARM_JOB_SCRATCH for disposable test and PR files such as demo copies, temporary installs and browser profiles. Pass it as TMPDIR (TEMP on Windows) to test commands that use system temp. CubeFarm deletes its contents after the job finishes. Stop subprocesses using it before reporting completion. Keep source changes and required evidence in their normal locations.`;

export function sessionScratchDir(dir: string, root = SESSIONS_DIR): string {
  const sessionDir = path.resolve(dir);
  if (path.dirname(sessionDir) !== path.resolve(root)) throw new Error('Invalid session scratch location');
  if (fs.lstatSync(sessionDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Invalid session scratch location');
  return path.join(sessionDir, 'job-scratch');
}

async function allowRemoval(dir: string): Promise<void> {
  const info = await fs.promises.lstat(dir);
  if (!info.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) await fs.promises.chmod(dir, info.mode | 0o700);
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await allowRemoval(path.join(dir, entry.name));
  }
}

/** Detach finished files before awaiting deletion, so a later turn gets its own empty directory. */
export async function clearSessionScratch(dir: string, { root = SESSIONS_DIR, recreate = true } = {}): Promise<void> {
  const scratch = sessionScratchDir(dir, root);
  const sessionDir = path.dirname(scratch);
  const info = fs.lstatSync(scratch, { throwIfNoEntry: false });
  if (!info) return; // A session from before scratch was introduced.
  if (!info.isDirectory()) {
    throw new Error('Invalid session scratch location');
  }
  const discard = fs.mkdtempSync(path.join(sessionDir, 'discard-'));
  try {
    for (let attempt = 0; ; attempt++) {
      operationSignal()?.throwIfAborted();
      try {
        fs.renameSync(scratch, path.join(discard, 'job-scratch'));
        break;
      } catch (err) {
        const { code } = err as NodeJS.ErrnoException;
        if (code === 'ENOENT') return; // The terminal exited and its session directory was removed.
        if (attempt === 5 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err;
        await setTimeout((attempt + 1) * 100, undefined, { signal: operationSignal() });
      }
    }
    if (recreate) createJobScratch(sessionDir);
  } finally {
    const remove = () => fs.promises.rm(discard, { recursive: true, force: true, maxRetries: 5 });
    try {
      await remove();
    } catch (err) {
      if (process.platform === 'win32' || (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
      // Audits may make disposable dependency copies read-only for their validation runs.
      await allowRemoval(discard);
      await remove();
    }
  }
}
