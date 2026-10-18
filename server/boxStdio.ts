import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encode, hostSocket, keeperBuild, keeperStale, PTY_PROTOCOL, runtimeFlags, type FromHost, type ToHost } from './ptyProtocol.ts';
import { updateBox } from './boxUpdate.ts';
import { isUpdateTarget } from './fleet.ts';

// `cubefarm box --stdio --office <id>`: this machine as one of an office's boxes. The office runs it over ssh; it
// starts (or finds) the box's host, a keeper of its own (ptyHost.ts in box mode, detached, so ssh can drop and be
// redialled while the CLIs keep running), says hello for the office, and from then on bridges stdio to its socket.
// The box's methods (boxOps.ts: rpc, and launching a prepared CLI) run here, one bridge per link, so a link redialled
// after an update runs the new ones while the keeper keeps its terminals. One home per office
// (~/.cubefarm-box/<office id>), so a machine can be a box for two offices.

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

/** Run the bridge; it exits when either side closes. `--update <target>` brings this box to the office's commit or release instead. */
export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--update')) {
    const target = argv[argv.indexOf('--update') + 1] ?? '';
    if (!isUpdateTarget(target)) fail(`"${target}" isn't a commit or a release`);
    process.stdout.write(`${JSON.stringify(await updateBox(target))}\n`, () => process.exit(0));
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
  const ext = path.extname(import.meta.filename);
  process.env.SWARM_HOME = home; // the box's home, read on import: the CLIs it prepares don't inherit it
  const { createBoxOps } = (await import(pathToFileURL(path.join(import.meta.dirname, `boxOps${ext}`)).href)) as typeof import('./boxOps.ts');
  delete process.env.SWARM_HOME;

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
  /** The CLIs the keeper runs, by terminal: releasing a desk leaves them alone. */
  const cliPids = new Map(ready.ptys.filter((p) => p.exit === null).map((p) => [p.id, p.pid]));
  const ops = createBoxOps({
    hookUrl: () => `http://127.0.0.1:${ready.hookPort}`,
    pids: () => [process.pid, ...(ready.pid ? [ready.pid] : []), ...cliPids.values()],
    keeperStale: keeperStale(ready.build, keeperBuild(import.meta.dirname, ext)),
  });

  // To the office: the keeper's whole lines (it's watched for the CLIs it starts and ends), and the methods' replies.
  const out = (m: FromHost) => process.stdout.write(encode(m));
  out(ready);
  let kept = Buffer.alloc(0);
  const fromKeeper = (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk]);
    const end = kept.lastIndexOf(10) + 1;
    if (!end) return;
    const lines = kept.subarray(0, end);
    kept = kept.subarray(end);
    process.stdout.write(lines);
    for (const line of lines.toString('utf8').split('\n')) {
      if (!line.startsWith('{"op":"spawned"') && !line.startsWith('{"op":"exit"')) continue; // data is most of it, and never starts so
      try {
        const m = JSON.parse(line) as FromHost;
        if (m.op === 'spawned') cliPids.set(m.id, m.pid);
        else if (m.op === 'exit') cliPids.delete(m.id);
      } catch {
        // not a message
      }
    }
  };
  if (rest.length) fromKeeper(rest);
  sock.on('data', fromKeeper);

  // From the office: methods and launches are the bridge's, the rest goes to the keeper as it came.
  let given = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    given += chunk;
    let nl: number;
    while ((nl = given.indexOf('\n')) >= 0) {
      const line = given.slice(0, nl + 1);
      given = given.slice(nl + 1);
      let m: ToHost | null = null;
      try {
        m = JSON.parse(line) as ToHost;
      } catch {
        // not a message: the keeper skips it too
      }
      if (m?.op === 'rpc') {
        const { rid } = m;
        void ops.rpc(m.method, m.args).then(
          (value) => out({ op: 'rpcReply', rid, ok: true, value }),
          (err: unknown) => out({ op: 'rpcReply', rid, ok: false, error: (err as Error)?.message ?? String(err) }),
        );
      } else if (m?.op === 'launch') {
        const cli = ops.take(m.token);
        if (!cli) out({ op: 'failed', id: m.id, error: 'the session was not prepared on this box' });
        else sock.write(encode({ op: 'spawn', id: m.id, file: cli.file, args: cli.args, cwd: cli.cwd, env: cli.env, cols: m.cols, rows: m.rows, meta: m.meta }));
      } else {
        sock.write(line);
      }
    }
  });
  process.stdin.on('end', () => sock.end());
  process.stdin.on('error', () => sock.end());
  process.stdout.on('error', () => sock.destroy()); // ssh went: the host keeps the terminals for the next office
  sock.on('close', () => process.exit(0));
  await new Promise(() => undefined);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main(process.argv.slice(2));
