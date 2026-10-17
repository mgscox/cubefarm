import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encode, hostSocket, PTY_PROTOCOL, runtimeFlags, type FromHost } from './ptyProtocol.ts';
import { updateBox } from './boxUpdate.ts';

// `cubefarm box --stdio --office <id>`: this machine as one of an office's boxes. The office runs it over ssh; it
// starts (or finds) the box's host, a keeper of its own (ptyHost.ts in box mode, detached, so ssh can drop and be
// redialled while the CLIs keep running), says hello for the office, and from then on bridges stdio to its socket.
// One home per office (~/.cubefarm-box/<office id>), so a machine can be a box for two offices.

type Ready = Extract<FromHost, { op: 'ready' }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Say hello to the host: its ready, the open socket and whatever it sent after it; null when none answers. */
function hello(socket: string, secret: string): Promise<{ ready: Ready; sock: net.Socket; rest: Buffer } | null> {
  return new Promise((resolve) => {
    const sock = net.connect(socket);
    let buf = Buffer.alloc(0);
    const fail = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(null);
    };
    const timer = setTimeout(fail, 2000);
    sock.once('error', fail);
    sock.once('connect', () => sock.write(encode({ op: 'hello', secret, version: PTY_PROTOCOL })));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      let ready: Ready | null = null;
      try {
        ready = JSON.parse(buf.subarray(0, nl).toString('utf8')) as Ready;
      } catch {
        // not a hello's answer
      }
      if (ready?.op !== 'ready') return fail();
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', fail);
      sock.on('error', () => undefined);
      resolve({ ready, sock, rest: buf.subarray(nl + 1) });
    };
    sock.on('data', onData);
  });
}

function launch(home: string, socket: string, secretFile: string) {
  const entry = path.join(import.meta.dirname, `ptyHost${path.extname(import.meta.filename)}`);
  spawn(process.execPath, [...runtimeFlags(), entry, 'launch', socket, secretFile, 'box'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SWARM_HOME: home } })
    .once('error', () => undefined)
    .unref();
}

const fail = (text: string) => {
  process.stderr.write(`cubefarm box: ${text}\n`);
  process.exit(1);
};

/** Run the bridge; it exits when either side closes. `--update <commit>` brings this box to the office's commit instead. */
export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--update')) {
    const commit = argv[argv.indexOf('--update') + 1] ?? '';
    if (!/^[0-9a-f]{7,40}$/.test(commit)) fail(`"${commit}" isn't a commit`);
    process.stdout.write(`${JSON.stringify(await updateBox(commit))}\n`, () => process.exit(0));
    return new Promise(() => undefined);
  }
  const office = argv[argv.indexOf('--office') + 1] ?? '';
  if (!argv.includes('--stdio') || !argv.includes('--office')) fail('an office starts this over ssh: cubefarm box --stdio --office <office id>');
  if (!/^[\w-]{1,64}$/.test(office)) fail(`"${office}" isn't an office id`);

  const home = process.env.SWARM_BOX_HOME || path.join(os.homedir(), '.cubefarm-box', office);
  const socket = hostSocket(home);
  const secretFile = path.join(home, 'pty.secret');
  try {
    fs.mkdirSync(home, { recursive: true });
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  } catch (err) {
    fail(`can't write ${home}: ${(err as Error).message}`);
  }
  const secret = fs.readFileSync(secretFile, 'utf8').trim();

  let found = await hello(socket, secret);
  if (found && found.ready.version !== PTY_PROTOCOL) {
    // A host from another version of cubefarm: its terminals can't be picked up, so they stop and it goes.
    process.stderr.write(`cubefarm box: replacing a v${found.ready.version} box host (${found.ready.ptys.length} terminal(s) stopped)\n`);
    found.sock.end(encode({ op: 'shutdown' }));
    found = null;
    await sleep(3500);
  }
  if (!found) {
    launch(home, socket, secretFile);
    for (let i = 0; i < 50 && !found; i++) {
      await sleep(200);
      found = await hello(socket, secret);
    }
  }
  if (!found) return fail(`the box host didn't start (see ${path.join(home, 'pty-host.log')})`);

  const { ready, sock, rest } = found;
  process.stdout.write(encode(ready));
  if (rest.length) process.stdout.write(rest);
  sock.on('data', (chunk) => process.stdout.write(chunk));
  process.stdin.on('data', (chunk) => sock.write(chunk));
  process.stdin.on('end', () => sock.end());
  process.stdin.on('error', () => sock.end());
  process.stdout.on('error', () => sock.destroy()); // ssh went: the host keeps the terminals for the next office
  sock.on('close', () => process.exit(0));
  await new Promise(() => undefined);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main(process.argv.slice(2));
