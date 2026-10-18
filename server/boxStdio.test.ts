import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { terminalsAvailable } from './ptyClient.ts';
import { encode, readMessages, type FromHost, type ToHost } from './ptyProtocol.ts';

// A box for real: `cubefarm box --stdio` bridging to its keeper, dropped and dialled again the way the office relinks
// after an update. (A short temp folder: macOS caps a Unix socket path at 104 characters.)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-box-'));
const root = path.resolve(import.meta.dirname, '..');

/** One link: the bridge, what it sent, and a way to wait for a message. */
function link() {
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join('server', 'boxStdio.ts'), '--stdio', '--office', 'test-office'], {
    cwd: root,
    env: { ...process.env, SWARM_BOX_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const got: FromHost[] = [];
  const waiters: (() => void)[] = [];
  readMessages<FromHost>(proc.stdout, (m) => {
    got.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async <T extends FromHost>(match: (m: FromHost) => m is T): Promise<T> => {
    for (;;) {
      const found = got.find(match);
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const closed = new Promise<void>((r) => proc.on('close', () => r()));
  return { send: (m: ToHost) => proc.stdin.write(encode(m)), next, end: () => (proc.stdin.end(), closed) };
}

const op =
  <K extends FromHost['op']>(k: K, also: (m: Extract<FromHost, { op: K }>) => boolean = () => true) =>
  (m: FromHost): m is Extract<FromHost, { op: K }> =>
    m.op === k && also(m as Extract<FromHost, { op: K }>);

describe.skipIf(!terminalsAvailable)("a box's bridge", () => {
  afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

  it("runs the box's methods itself and keeps its terminals through a new link", { timeout: 90_000 }, async () => {
    const first = link();
    const ready = await first.next(op('ready'));
    expect(ready.ptys).toEqual([]);
    expect(ready.build).toMatch(/^[0-9a-f]{16}$/);

    first.send({ op: 'rpc', rid: 1, method: 'info', args: [] });
    const info = await first.next(op('rpcReply', (m) => m.rid === 1));
    expect(info).toMatchObject({ ok: true, value: { keeperStale: false, workspaces: path.join(home, 'workspaces') } });
    first.send({ op: 'launch', id: 'nope', token: 'never-prepared', cols: 80, rows: 24, meta: null });
    expect(await first.next(op('failed', (m) => m.id === 'nope'))).toMatchObject({ error: 'the session was not prepared on this box' });

    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    first.send({ op: 'spawn', id: 't1', file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home, env, cols: 80, rows: 24, meta: { agentId: 'ada' } });
    await first.next(op('spawned', (m) => m.id === 't1'));
    await first.end();

    // The office relinks: a new bridge finds the same keeper, still running the CLI.
    const second = link();
    const again = await second.next(op('ready'));
    expect(again.pid).toBe(ready.pid);
    // (Its pid: on Windows the keeper says 0 when it starts a CLI, and the real one later.)
    expect(again.ptys).toEqual([{ id: 't1', pid: expect.any(Number), meta: { agentId: 'ada' }, exit: null }]);
    second.send({ op: 'rpc', rid: 1, method: 'info', args: [] });
    expect(await second.next(op('rpcReply', (m) => m.rid === 1))).toMatchObject({ ok: true, value: { keeperStale: false } });

    second.send({ op: 'shutdown' });
    await second.end();
  });
});
