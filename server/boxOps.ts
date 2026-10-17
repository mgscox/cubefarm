import path from 'node:path';
import { VERSION, WORKSPACE_ROOT } from './config.ts';
import { run } from './exec.ts';
import * as workspace from './workspace.ts';
import { codexThread, detectClis } from './clis.ts';
import { screenshotFile } from './agentRunner.ts';
import { checkoutCommit } from './boxUpdate.ts';
import { BIN_DIR, removeSessionDir, SESSIONS_DIR, sessionShots, writeCliSession, type CliLaunch } from './cliFiles.ts';
import type { BoxInfo } from './fleet.ts';
import type { CliPlan } from './machine.ts';
import type { DeskBase } from './workspace.ts';

// What a box's host (ptyHost.ts in box mode) does for an office on another machine, on the box's own disk: desks in
// its own clones (workspace.ts), CLI session files and command lines (cliFiles.ts), screenshots. Paths are the box's.

/** A prepared CLI waits this long for the office to start it. */
const PREPARED_MS = 10 * 60_000;

/** Base64 over the wire. */
const shot = (s: { data: Buffer; mime: string; name?: string }) => ({ name: s.name, mime: s.mime, data: s.data.toString('base64') });

/** A session folder this box made: nothing else is removed or read on the office's say-so. */
function sessionDir(dir: unknown): string {
  const d = path.resolve(String(dir));
  if (path.dirname(d) !== path.resolve(SESSIONS_DIR)) throw new Error(`not a session folder: ${String(dir)}`);
  return d;
}

/** root: the cubefarm checkout this host runs from (tests). */
export function createBoxOps(ctx: { hookUrl: () => string; pids: () => number[]; root?: string }) {
  // The commit this host started on, not the checkout's HEAD later: an update moves HEAD under a running host, and the
  // office has to see the old one to restart it (say, when the office itself restarted in between).
  const commit = checkoutCommit(ctx.root);
  const prepared = new Map<string, { cli: CliLaunch; at: number }>();
  const str = (v: unknown) => String(v ?? '');

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    async info(): Promise<BoxInfo> {
      const git = await run('git', ['--version'], { timeoutMs: 10_000 }).catch(() => null);
      const gh = await run('gh', ['auth', 'status'], { timeoutMs: 20_000 }).then(() => true, () => false);
      return { platform: process.platform, version: VERSION, commit: await commit, git: git?.trim() || null, ghReady: gh, workspaces: WORKSPACE_ROOT, sep: path.sep as '/' | '\\' };
    },
    detectClis: () => detectClis(),
    async prepareDesk(fullName, base, slug, branch) {
      const notes: string[] = [];
      await workspace.ensureClone(str(fullName));
      const dir = await workspace.prepareDesk(str(fullName), base as DeskBase, str(slug), str(branch), (t) => notes.push(t));
      return { dir, notes };
    },
    removeDesk: (fullName, slug) => workspace.removeDesk(str(fullName), str(slug)),
    releaseDesk: (fullName, slug, port) => workspace.releaseDesk(str(fullName), str(slug), Number(port), { pids: ctx.pids(), markers: [SESSIONS_DIR, BIN_DIR] }),
    deskHead: (fullName, slug) => workspace.deskHead(str(fullName), str(slug)),
    deskAhead: (fullName, slug, base) => workspace.deskAhead(str(fullName), str(slug), str(base)),
    prepare(plan) {
      const now = Date.now();
      for (const [t, p] of prepared) if (now - p.at > PREPARED_MS) prepared.delete(t);
      const cli = writeCliSession(plan as CliPlan, { url: ctx.hookUrl(), held: true });
      prepared.set((plan as CliPlan).token, { cli, at: now });
      return { dir: cli.dir, prompt: cli.prompt };
    },
    newShots: (dir, seen, now) => sessionShots(sessionDir(dir), new Set(seen as string[]), Number(now) || Infinity).map(shot),
    savedShot(cwd, text) {
      const s = screenshotFile(str(cwd), str(text));
      return s ? shot(s) : null;
    },
    codexThread: (action, id) => codexThread(action === 'archive' ? 'archive' : 'unarchive', str(id)),
    removeDir: (dir) => removeSessionDir(sessionDir(dir)),
  };

  return {
    /** Run one of the box's methods for the office. */
    async rpc(method: string, args: unknown[]): Promise<unknown> {
      const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (!fn) throw new Error(`a box has no method "${method}"`);
      return (await fn(...(Array.isArray(args) ? args : []))) ?? null;
    },
    /** The CLI a prepare wrote, to start now (once). */
    take(token: string): CliLaunch | null {
      const p = prepared.get(token);
      prepared.delete(token);
      return p?.cli ?? null;
    },
  };
}
