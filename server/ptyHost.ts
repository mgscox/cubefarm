import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as nodePty from '@lydell/node-pty';
import { encode, PTY_PROTOCOL, readMessages, type FromHost, type HeldPty, type ToHost } from './ptyProtocol.ts';

// The office's terminal keeper: a small process of its own that runs the agents' CLIs in pseudo-terminals, so they
// keep working while the office restarts (an update, a crash, a code change in development). The office connects over
// a local socket (one office at a time), starts and drives CLIs through it and, when it comes back, picks up the ones
// still running. The CLIs' hooks come in here too and wait while the office is away, so none is lost and none fails.
//
// node ptyHost.js launch <socket> <secret file>   starts a keeper outside the caller's process tree, then exits
// node ptyHost.js serve <socket> <secret file>    is the keeper

/** Output kept per terminal while no office is listening. */
const BACKLOG_BYTES = 2 * 1024 * 1024;
/** A hook waits this long for an office (the CLIs are told 120 s). */
const HOOK_WAIT_MS = 110_000;
/** With no office for this long, nobody is coming back: the terminals are stopped. */
const ORPHAN_MS = 10 * 60_000;
/** Nothing left to keep and no office: the keeper goes. */
const IDLE_EXIT_MS = 60_000;

const [mode, socketPath, secretFile] = process.argv.slice(2);

if (mode === 'launch') {
  // A detached child whose parent exits at once: the office's process tree (which the launcher kills on a restart)
  // doesn't include it, and on Windows nothing ties it to a console window.
  spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve', socketPath, secretFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}

const logFile = path.join(path.dirname(secretFile), 'pty-host.log');
const note = (text: string) => fs.appendFile(logFile, `${new Date().toISOString()} ${text}\n`, () => undefined);
process.on('uncaughtException', (err) => note(`uncaught: ${err.stack ?? err}`));
for (const sig of ['SIGINT', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => undefined); // the office's console isn't ours

const secret = fs.readFileSync(secretFile, 'utf8').trim();

interface Held {
  proc: nodePty.IPty;
  meta: unknown;
  /** An office is taking this terminal's output right now. */
  attached: boolean;
  backlog: string[];
  bytes: number;
  exit: number | null;
  /** The signal that stopped it, if one did. */
  signal?: number;
  /** The office stopped it: nobody needs to hear how it ended. */
  killed: boolean;
}
const held = new Map<string, Held>();
let office: net.Socket | null = null;
let officeLeft = Date.now();
let hooksOpen = false; // the connected office has picked up its terminals and takes hooks

const send = (m: FromHost) => {
  if (office && !office.destroyed) office.write(encode(m));
};

function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // the CLI leads its own session: take its MCP servers and tools with it
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

// ---------- terminals ----------

function start(m: Extract<ToHost, { op: 'spawn' }>) {
  let proc: nodePty.IPty;
  try {
    // Windows' own console host lingers after each CLI exits (one conhost.exe per terminal, forever in a keeper that
    // outlives restarts); the one node-pty ships goes with its terminal.
    proc = nodePty.spawn(m.file, m.args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env, useConptyDll: true });
  } catch (err) {
    send({ op: 'failed', id: m.id, error: (err as Error).message });
    return;
  }
  const h: Held = { proc, meta: m.meta, attached: true, backlog: [], bytes: 0, exit: null, killed: false };
  held.set(m.id, h);
  send({ op: 'spawned', id: m.id, pid: proc.pid });
  proc.onData((data) => {
    if (h.attached && office) return send({ op: 'data', id: m.id, data });
    h.backlog.push(data);
    h.bytes += data.length;
    while (h.bytes > BACKLOG_BYTES && h.backlog.length > 1) h.bytes -= h.backlog.shift()!.length;
  });
  proc.onExit(({ exitCode, signal }) => {
    h.exit = exitCode;
    h.signal = signal || undefined;
    quietly(() => proc.kill()); // on Windows the terminal's console host (conhost.exe) outlives the CLI until then
    if (h.attached && office) send({ op: 'exit', id: m.id, code: exitCode, signal: h.signal });
    if ((h.attached && office) || h.killed) held.delete(m.id);
  });
}

function attach(id: string) {
  const h = held.get(id);
  if (!h) return send({ op: 'exit', id, code: -1 });
  h.attached = true;
  if (h.backlog.length) send({ op: 'data', id, data: h.backlog.join('') });
  h.backlog = [];
  h.bytes = 0;
  if (h.exit !== null) {
    send({ op: 'exit', id, code: h.exit, signal: h.signal });
    held.delete(id);
  }
}

function stopAll() {
  for (const h of held.values()) if (h.exit === null) killTree(h.proc.pid);
}

// ---------- hooks: CLIs call here, the office answers ----------

interface Waiting {
  token: string;
  body: unknown;
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
  sent: boolean;
}
const waiting = new Map<number, Waiting>();
let nextRid = 1;

function answer(rid: number, reply: unknown) {
  const w = waiting.get(rid);
  if (!w) return;
  waiting.delete(rid);
  clearTimeout(w.timer);
  if (!w.res.writableEnded) w.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply ?? {}));
}

/** Hooks that waited for an office go to the one that's ready (again, if the office before it went without answering). */
function passHooks() {
  if (!office || !hooksOpen) return;
  for (const [rid, w] of waiting) {
    if (w.sent) continue;
    w.sent = true;
    send({ op: 'hook', rid, token: w.token, body: w.body });
  }
}

const hooks = http.createServer((req, res) => {
  const token = req.method === 'POST' ? req.url?.match(/^\/api\/hooks\/([\w-]+)$/)?.[1] : undefined;
  if (!token) return void res.writeHead(404).end();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= 64 * 1024 * 1024) chunks.push(c);
  });
  req.on('end', () => {
    let body: unknown = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      // not JSON: an empty hook
    }
    const rid = nextRid++;
    waiting.set(rid, { token, body, res, timer: setTimeout(() => answer(rid, {}), HOOK_WAIT_MS), sent: false });
    passHooks();
  });
});

// ---------- the office ----------

function connected(sock: net.Socket) {
  let helloed = false;
  readMessages<ToHost>(sock, (m) => {
    if (!helloed) {
      if (m.op !== 'hello' || m.secret !== secret) return void sock.destroy();
      helloed = true;
      if (office && office !== sock) office.destroy();
      office = sock;
      hooksOpen = false;
      const ptys: HeldPty[] = [...held].map(([id, h]) => ({ id, pid: h.proc.pid, meta: h.meta, exit: h.exit }));
      send({ op: 'ready', version: PTY_PROTOCOL, hookPort: (hooks.address() as net.AddressInfo).port, ptys, pid: process.pid });
      return;
    }
    const h = 'id' in m ? held.get(m.id) : undefined;
    switch (m.op) {
      case 'spawn':
        return start(m);
      case 'attach':
        return attach(m.id);
      case 'write':
        return void (h && h.exit === null && quietly(() => h.proc.write(m.data)));
      case 'resize':
        return void (h && h.exit === null && quietly(() => h.proc.resize(m.cols, m.rows)));
      case 'meta':
        if (h) h.meta = m.meta;
        return;
      case 'kill':
        if (h) h.killed = true;
        if (h?.exit === null) killTree(h.proc.pid);
        else if (h) held.delete(m.id);
        return;
      case 'hooksReady':
        hooksOpen = true;
        return passHooks();
      case 'hookReply':
        return answer(m.rid, m.answer);
      case 'shutdown':
        stopAll();
        setTimeout(() => process.exit(0), 3000);
        return;
    }
  });
  sock.on('error', () => undefined);
  sock.on('close', () => {
    if (office !== sock) return;
    office = null;
    officeLeft = Date.now();
    for (const h of held.values()) h.attached = false;
    for (const w of waiting.values()) w.sent = false; // unanswered: the next office gets them
  });
}

/** A pseudo-terminal whose CLI just died throws on writes and resizes before it reports the exit. */
function quietly(fn: () => void) {
  try {
    fn();
  } catch {
    // its exit is on the way
  }
}

const server = net.createServer(connected);
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE' || process.platform === 'win32') {
    note(`cannot listen on ${socketPath}: ${err.message}`);
    process.exit(1);
  }
  // A Unix socket file left behind: take it over, unless a keeper still answers on it.
  const probe = net.connect(socketPath, () => {
    probe.destroy();
    process.exit(0);
  });
  probe.on('error', () => {
    fs.rmSync(socketPath, { force: true });
    server.listen(socketPath);
  });
});

hooks.listen(0, '127.0.0.1', () => server.listen(socketPath));

let orphaned = false;
setInterval(() => {
  if (office) return void (orphaned = false);
  const away = Date.now() - officeLeft;
  if (away > ORPHAN_MS) {
    for (const [id, h] of held) if (h.exit !== null) held.delete(id);
    if (held.size && !orphaned) {
      orphaned = true;
      note(`no office for ${Math.round(away / 60_000)} min: stopping ${held.size} terminal(s)`);
      stopAll();
    }
  }
  if (held.size === 0 && away > IDLE_EXIT_MS) process.exit(0);
}, 10_000).unref();
