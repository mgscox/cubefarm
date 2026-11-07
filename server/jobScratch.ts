import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { AgentRole } from '../shared/types.ts';
import { HOME_DIR } from './config.ts';
import { operationSignal } from './operation.ts';

// Disposable files are scoped to a CubeFarm session, separate from its CLI state and Git desk.

export const SESSIONS_DIR = path.join(HOME_DIR, 'sessions');

export function jobScratchEnabled(role: AgentRole): boolean {
  return role === 'dev' || role === 'qa';
}

export function createJobScratch(sessionDir: string): string {
  const scratch = path.join(sessionDir, 'job-scratch');
  fs.mkdirSync(scratch, { mode: 0o700 });
  return scratch;
}

export const JOB_SCRATCH_INSTRUCTIONS = `\n\nUse the directory in CUBEFARM_JOB_SCRATCH for disposable test and PR files such as demo copies, temporary installs and browser profiles. Pass it as TMPDIR (TEMP on Windows) to test commands that use system temp. CubeFarm deletes its contents after the job finishes. Stop subprocesses using it before reporting completion. Keep source changes and required evidence in their normal locations.`;

export function sessionScratchDir(dir: string): string {
  const sessionDir = path.resolve(dir);
  if (path.dirname(sessionDir) !== path.resolve(SESSIONS_DIR)) throw new Error('Invalid session scratch location');
  if (fs.lstatSync(sessionDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Invalid session scratch location');
  return path.join(sessionDir, 'job-scratch');
}

/** Detach finished files before awaiting deletion, so a later turn gets its own empty directory. */
export async function clearSessionScratch(dir: string): Promise<void> {
  const scratch = sessionScratchDir(dir);
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
    createJobScratch(sessionDir);
  } finally {
    await fs.promises.rm(discard, { recursive: true, force: true, maxRetries: 5 });
  }
}
