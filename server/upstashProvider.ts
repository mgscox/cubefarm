// Upstash transport for the existing box keeper. Only task credentials enter a disposable Box.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Box, type BoxConfig, type ExecSessionOptions } from '@upstash/box';
import type { AgentCli } from '../shared/types.ts';
import { UPSTASH_ROOT as ROOT, type UpstashProvider } from './upstash.ts';
import { readConfigEnv, VERSION } from './config.ts';
import { gh } from './exec.ts';
import { connectBox } from './boxLink.ts';
import { PTY_PROTOCOL, runtimeFlags } from './ptyProtocol.ts';

const PACKAGE = `${ROOT}/node_modules/cubefarm`;
/** OpenCode v2, which the launcher and notification plugin target (`opencode-ai` on npm is v1). */
export const OPENCODE_VERSION = '2.2.6';
const OPENCODE_BIN = `${ROOT}/node_modules/.bin/opencode`;
const KEYS: Record<AgentCli, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', opencode: 'OPENROUTER_API_KEY' };
export function upstashConfig(env: NodeJS.ProcessEnv, cli: AgentCli, name: string, gitToken: string): BoxConfig {
  return {
    apiKey: env.UPSTASH_BOX_API_KEY, name, runtime: 'node', size: 'small', browser: true,
    enableTelemetry: false,
    git: { token: gitToken, userName: 'CubeFarm', userEmail: 'cubefarm@users.noreply.github.com' },
    env: { [KEYS[cli]]: env[KEYS[cli]]!, GH_TOKEN: gitToken, CUBEFARM_UPSTASH_CLI: cli },
  };
}

/** Exact argv over the provider WebSocket. No host shell and no secrets in command arguments. */
export async function boxExec(box: Box, argv: string[], options: Pick<ExecSessionOptions, 'cwd' | 'env'> = {}, timeoutMs = 15 * 60_000): Promise<string> {
  let output = '';
  const session = await box.exec.session({ argv, ...options, onStdout: (b) => { output += Buffer.from(b).toString(); } });
  const timer = setTimeout(() => session.terminate(1000), timeoutMs);
  try {
    if (await session.wait() !== 0) throw new Error('Command in Upstash Box failed.');
    return output.trim();
  } finally { clearTimeout(timer); session.close(); }
}

export async function verifyUpstashOpenCode(box: Box): Promise<void> {
  const version = await boxExec(box, [OPENCODE_BIN, '--version'], {}, 10_000).catch(() => {
    throw new Error(`Could not run ${OPENCODE_BIN} --version on the Upstash Box. Expected OpenCode v${OPENCODE_VERSION}.`);
  });
  if (version !== `opencode v${OPENCODE_VERSION}`) {
    throw new Error(`Upstash OpenCode at ${OPENCODE_BIN} reported "${version.split('\n')[0].slice(0, 80)}"; expected opencode v${OPENCODE_VERSION}.`);
  }
}

// Install the package's dependencies, then overlay this office's bundled worker code (also works before a release).
export const BOOTSTRAP = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
(async () => {
  const root = '${ROOT}';
  fs.mkdirSync(root, { recursive: true });
  const [version, playwright, yaml, cli] = process.argv.slice(1);
  const extra = cli === 'codex' ? ['@openai/codex'] : cli === 'opencode' ? ['@opencode/cli@${OPENCODE_VERSION}'] : [];
  // Remove v1 if installed or declared, so only v2 owns the opencode command.
  const manifest = root + '/package.json';
  if (cli === 'opencode' && (
    fs.existsSync(root + '/node_modules/opencode-ai') ||
    (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies?.['opencode-ai'])
  )) {
    cp.execFileSync('npm', ['uninstall', '--prefix', root, 'opencode-ai'], { stdio: 'ignore' });
  }
  cp.execFileSync('npm', ['install', '--prefix', root, 'cubefarm@' + version, 'playwright@' + playwright, 'yaml@' + yaml, ...extra], { stdio: 'ignore' });
  // npm 12 skips install scripts by default, and this one puts v2's native binary in place.
  if (cli === 'opencode') cp.execFileSync('node', [root + '/node_modules/@opencode/cli/postinstall.mjs'], { stdio: 'ignore' });
  cp.execFileSync('node', [root + '/node_modules/playwright/cli.js', 'install', 'chromium'], { stdio: 'ignore' });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const res = await fetch('https://github.com/cli/cli/releases/download/v2.83.2/gh_2.83.2_linux_' + arch + '.tar.gz');
  if (!res.ok) throw new Error('gh download failed');
  fs.writeFileSync(root + '/gh.tgz', Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(root + '/gh', { recursive: true });
  cp.execFileSync('tar', ['-xzf', root + '/gh.tgz', '-C', root + '/gh', '--strip-components=1']);
  process.env.PATH = root + '/node_modules/.bin:' + root + '/gh/bin:' + process.env.PATH;
  cp.execFileSync('gh', ['auth', 'setup-git'], { stdio: 'ignore' });
  cp.execFileSync('git', ['config', '--global', 'user.name', 'CubeFarm']);
  cp.execFileSync('git', ['config', '--global', 'user.email', 'cubefarm@users.noreply.github.com']);
  if (cli === 'codex') cp.execFileSync('codex', ['login', '--with-api-key'], { input: process.env.OPENAI_API_KEY, stdio: ['pipe', 'ignore', 'ignore'] });
})().catch(() => process.exit(1));
`;

// Confirm the keeper has exited before checking Git, including when the office lost the worker runtime.
export const STOP_KEEPER = String.raw`
const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process');
const home = process.argv[2] || '${ROOT}/home';
const evidence = home + '/stopped-writers.json';
let writers = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, 'utf8')) : [];
const processes = () => cp.execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/));
const live = row => !row[3].startsWith('Z');
const confirm = () => {
  if (processes().some(row => live(row) && writers.some(pid => Number(row[0]) === pid || Number(row[2]) === pid))) process.exit(1);
};
const timer = setTimeout(() => process.exit(1), 15000);
const sock = net.connect(home + '/pty.sock');
let ready = false, absent = false, data = '';
sock.on('connect', () => sock.write(JSON.stringify({ op: 'hello', version: Number(process.argv[1]), secret: fs.readFileSync(home + '/pty.secret', 'utf8').trim() }) + '\n'));
sock.on('data', chunk => {
  data += chunk.toString();
  if (!ready && data.includes('\n')) {
    const reply = JSON.parse(data.slice(0, data.indexOf('\n')));
    if (reply.op !== 'ready' || reply.version !== Number(process.argv[1])) process.exit(1);
    ready = true;
    const recorded = fs.existsSync(home + '/task-processes.jsonl') ? fs.readFileSync(home + '/task-processes.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
    const roots = [...new Set([...recorded, ...reply.ptys.map(p => p.pid)])];
    for (const pid of roots) { try { process.kill(-pid, 'SIGSTOP'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    const tree = new Set(roots), rows = processes();
    for (let n = -1; n !== tree.size;) { n = tree.size; for (const row of rows) if (tree.has(Number(row[1])) || roots.includes(Number(row[2]))) tree.add(Number(row[0])); }
    writers = [...tree];
    fs.writeFileSync(evidence, JSON.stringify(writers));
    for (const pid of roots) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    for (const pid of writers) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    sock.write(JSON.stringify({ op: 'shutdown' }) + '\n');
  }
});
sock.on('error', e => {
  if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') process.exit(1);
  absent = true;
});
sock.on('close', () => {
  clearTimeout(timer);
  if (!ready && !absent) process.exit(1);
  if (!ready && !fs.existsSync(evidence) && process.argv[3] !== 'empty') process.exit(1);
  confirm();
});
`;

export const RELEASE_DESK = String.raw`
(async () => {
  const { createBoxOps } = await import('${PACKAGE}/dist-server/boxOps.js');
  await createBoxOps({ hookUrl: () => '', pids: () => [] }).rpc('releaseDesk', [process.argv[1], process.argv[2], Number(process.argv[3])]);
})().catch(() => process.exit(1));
`;

// Inspect all worktrees and all local branches, including commits outside the assigned branch.
export const SAVED_WORK = String.raw`
const cp = require('node:child_process'), fs = require('node:fs');
const root = process.argv[1];
const git = (cwd, args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (!fs.existsSync(root)) process.exit(1);
git(root, ['fetch', '--all', '--prune']);
const trees = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
for (const tree of trees) {
  if (git(tree, ['status', '--porcelain', '--untracked-files=all'])) process.exit(1);
  if (git(tree, ['rev-list', 'HEAD', '--not', '--remotes=origin'])) process.exit(1);
}
if (git(root, ['rev-list', '--branches', '--not', '--remotes=origin'])) process.exit(1);
if (git(root, ['stash', 'list'])) process.exit(1);
`;

/** Bootstrap marker; an OpenCode Box bootstrapped before the pin had only `ready-<version>` and still has v1. */
export const readyMarker = (cli: AgentCli) => `${ROOT}/ready-${VERSION}${cli === 'opencode' ? `-opencode-${OPENCODE_VERSION}` : ''}`;

export function createUpstashProvider(config?: () => NodeJS.ProcessEnv): UpstashProvider {
  let cached: NodeJS.ProcessEnv | undefined;
  const settings = () => config ? config() : cached ??= { ...readConfigEnv(), ...process.env };
  const connection = () => ({ apiKey: settings().UPSTASH_BOX_API_KEY, enableTelemetry: false });
  const get = (id: string) => Box.get(id, connection());
  return {
    missing: (cli) => !settings().UPSTASH_BOX_API_KEY ? 'Set the Upstash Box API key in Settings or UPSTASH_BOX_API_KEY in the office config.' : !settings()[KEYS[cli]] ? `Set ${KEYS[cli]} in the office config for Upstash ${cli}.` : null,
    list: async () => (await Box.list(connection())).filter((b) => b.status !== 'deleted'),
    create: async (task) => {
      const token = await gh(['auth', 'token']).catch(() => { throw Object.assign(new Error('GitHub authentication is unavailable.'), { notCreated: true }); });
      return (await Box.create(upstashConfig(settings(), task.cli, task.name, token))).id;
    },
    async connect(task, opts) {
      const box = await get(task.boxId!);
      // A durable marker avoids reinstalling packages beneath live CLIs after a reconnect.
      const marker = readyMarker(task.cli);
      const ready = await box.files.stat(marker).then(() => true, (err: { statusCode?: number }) => {
        if (err.statusCode !== 404) throw err;
        return false;
      });
      if (!ready) {
        // The release on npm can predate the dependencies used by the office's overlay.
        const manifest = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
        await boxExec(box, ['node', '-e', BOOTSTRAP, VERSION, manifest.dependencies.playwright, manifest.dependencies.yaml, task.cli]);
        for (const file of ['boxStdio.js', 'boxOps.js', 'ptyHost.js', 'browser-init.js']) {
          const content = await fs.readFile(path.resolve(import.meta.dirname, '..', 'dist-server', file), 'utf8');
          await box.files.write({ path: `${PACKAGE}/dist-server/${file}`, content });
        }
      }
      if (task.cli === 'opencode') await verifyUpstashOpenCode(box);
      if (!ready) await box.files.write({ path: marker, content: VERSION });
      return connectBox({ ...opts, transport: {
        file: process.execPath,
        args: [...runtimeFlags(), path.join(import.meta.dirname, `upstashBridge${path.extname(import.meta.filename)}`), task.boxId!, opts.officeId, task.cli],
        env: () => ({ ...process.env, UPSTASH_BOX_API_KEY: settings().UPSTASH_BOX_API_KEY }),
      } });
    },
    async saved(task) {
      const box = await get(task.boxId!);
      await boxExec(box, ['node', '-e', STOP_KEEPER, String(PTY_PROTOCOL), `${ROOT}/home`, task.deskStarted ? 'started' : 'empty']);
      if (!task.deskStarted) return;
      await boxExec(box, ['node', '-e', RELEASE_DESK, task.repo, task.slug, String(task.port)], { env: [`SWARM_HOME=${ROOT}/home`] });
      const main = `${ROOT}/home/workspaces/${task.repo.replace('/', '__')}/main`;
      await boxExec(box, ['node', '-e', SAVED_WORK, main]);
    },
    delete: async (id) => { await (await get(id)).delete(); },
  };
}
