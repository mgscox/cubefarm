import crypto from 'node:crypto';
import path from 'node:path';
import type { Socket } from 'node:net';

// What the office and its terminal keeper (ptyHost.ts) say to each other over their local socket: one JSON message
// per line. Kept free of the rest of the server so the keeper stays small and starts fast.

/** Bumped when the messages change: an office that finds a keeper on another version replaces it. */
export const PTY_PROTOCOL = 1;

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
  | { op: 'shutdown' }; // stop every terminal and exit (a keeper on another version)

export type FromHost =
  | { op: 'ready'; version: number; hookPort: number; ptys: HeldPty[]; pid?: number }
  | { op: 'spawned'; id: string; pid: number }
  | { op: 'failed'; id: string; error: string }
  | { op: 'data'; id: string; data: string }
  | { op: 'exit'; id: string; code: number; signal?: number } // signal: an older keeper doesn't say
  | { op: 'hook'; rid: number; token: string; body: unknown };

/** The keeper's socket for an office home: a named pipe on Windows, a Unix socket in the home elsewhere. */
export function hostSocket(home: string, platform = process.platform): string {
  if (platform !== 'win32') return path.join(home, 'pty.sock');
  const tag = crypto.createHash('sha1').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\cubefarm-pty-${tag}`;
}

export const encode = (m: ToHost | FromHost) => `${JSON.stringify(m)}\n`;

/** Calls back with each message a socket sends (newline-delimited JSON); a line that isn't JSON is skipped. */
export function readMessages<T>(sock: Socket, onMessage: (m: T) => void) {
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
