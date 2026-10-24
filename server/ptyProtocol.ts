import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

// What the office and its terminal keeper (ptyHost.ts) say to each other over their local socket, and to a box's host
// over ssh: one JSON message per line. Kept free of the rest of the server so the keeper stays small and starts fast.

/** Bumped when the messages change: an office that finds a keeper on another version replaces it. */
export const PTY_PROTOCOL = 2;

/** A terminal the keeper holds, as it reports it to an office that (re)connects. */
export interface HeldPty {
  id: string;
  pid: number;
  /** What the office stored with it (who it belongs to, its session). */
  meta: unknown;
  /** The CLI has exited (while no office was listening): its exit code. */
  exit: number | null;
}

export type ToHost =
  | { op: 'hello'; secret: string; version: number }
  | { op: 'hooksReady' } // the office has picked up its terminals: hooks that waited for it can come in now
  | { op: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number; meta: unknown }
  | { op: 'attach'; id: string } // an office picking up a terminal it found: what it missed, then everything live
  | { op: 'write'; id: string; data: string }
  | { op: 'resize'; id: string; cols: number; rows: number }
  | { op: 'meta'; id: string; meta: unknown }
  | { op: 'kill'; id: string }
  | { op: 'hookReply'; rid: number; answer: unknown }
  | { op: 'shutdown' } // stop every terminal and exit (a keeper on another version)
  // to a box (answered by its bridge, boxStdio.ts, not its keeper):
  | { op: 'rpc'; rid: number; method: string; args: unknown[] } // a desk or session-file method, run on the box
  | { op: 'cancelRpc'; rid: number } // abort the commands of a timed-out desk operation
  | { op: 'launch'; id: string; token: string; cols: number; rows: number; meta: unknown }; // start the CLI a 'prepare' rpc wrote

export type FromHost =
  | { op: 'ready'; version: number; hookPort: number; ptys: HeldPty[]; pid?: number; build?: string | null } // build: keeperBuild when it started
  | { op: 'spawned'; id: string; pid: number }
  | { op: 'failed'; id: string; error: string }
  | { op: 'data'; id: string; data: string }
  | { op: 'exit'; id: string; code: number; signal?: number } // signal: an older keeper doesn't say
  | { op: 'hook'; rid: number; token: string; body: unknown }
  | { op: 'rpcReply'; rid: number; ok: boolean; value?: unknown; error?: string };

/** The keeper's socket for an office home: a named pipe on Windows, a Unix socket in the home elsewhere. */
export function hostSocket(home: string, platform = process.platform): string {
  if (platform !== 'win32') return path.join(home, 'pty.sock');
  const tag = crypto.createHash('sha1').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\cubefarm-pty-${tag}`;
}

/**
 * The keeper's code on disk, as a short hash: ptyHost.js (which bundles this file), or in development ptyHost.ts and
 * this file. null when it can't be read. A keeper reports the one it started with, so a box's bridge can tell whether
 * an update since changed it (keeperStale).
 */
export function keeperBuild(dir: string, ext: string): string | null {
  try {
    const hash = crypto.createHash('sha256');
    for (const f of ext === '.ts' ? ['ptyHost.ts', 'ptyProtocol.ts'] : [`ptyHost${ext}`]) hash.update(fs.readFileSync(path.join(dir, f)));
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** A running keeper's code differs from the keeper on disk now (one from before builds were reported counts). Unknown on disk: not stale. */
export const keeperStale = (running: string | null | undefined, onDisk: string | null) => onDisk !== null && running !== onDisk;

export const encode = (m: ToHost | FromHost) => `${JSON.stringify(m)}\n`;

/** Node flags this process runs with that a keeper it starts needs too (tsx in development), not debugging or watching. */
export const runtimeFlags = () => process.execArgv.filter((a, i, all) => !/^--(inspect|watch|debug)/.test(a) && !/^--(inspect|watch|debug)/.test(all[i - 1] ?? ''));

/** Calls back with each message a socket or pipe sends (newline-delimited JSON); a line that isn't JSON is skipped. */
export function readMessages<T>(sock: Readable, onMessage: (m: T) => void) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: T;
      try {
        m = JSON.parse(line) as T;
      } catch {
        continue;
      }
      onMessage(m);
    }
  });
}

// ---------- hooks a box answers itself ----------

/** PreToolUse's answer: nobody may be watching to answer a permission question, so every tool call is approved. */
export const ALLOW = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved by cubefarm' } };

/**
 * A box answers a hook at once when the office's answer never depends on the office, so a slow or dropped link never
 * stalls a CLI; the hook still goes to the office (fire-and-forget). Only a prompt the manager typed waits: the office
 * decides whether it becomes a follow-up. undefined: wait for the office.
 */
export function localHookAnswer(body: unknown, statusLine: string | undefined): Record<string, unknown> | undefined {
  const event = body && typeof body === 'object' ? String((body as { hook_event_name?: unknown }).hook_event_name ?? '') : '';
  if (event === 'UserPromptSubmit') return undefined;
  if (event === 'PreToolUse') return ALLOW;
  if (event === 'StatusLine') return { statusLine: statusLine ?? '🏢 cubefarm' };
  return {};
}
