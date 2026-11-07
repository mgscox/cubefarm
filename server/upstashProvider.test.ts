import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box } from '@upstash/box';
import { createUpstashProvider, SAVED_WORK, upstashConfig } from './upstashProvider.ts';
import { UpstashTasks } from './upstash.ts';
import type { AgentCli, UpstashTask } from '../shared/types.ts';
import { launchArgs } from './clis.ts';

vi.mock('./exec.ts', async (original) => ({ ...await original<typeof import('./exec.ts')>(), gh: async () => 'fake-github-token' }));
afterEach(() => vi.unstubAllGlobals());

// The real SDK against an in-memory HTTP emulator: state survives controller and provider reconstruction.
function emulator() {
  const boxes = new Map<string, Record<string, unknown>>();
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ url, method, body });
    expect(new Headers(init?.headers).get('X-Box-Api-Key')).toBe('box-test-secret');
    const pathname = new URL(url).pathname;
    if (pathname === '/v2/box' && method === 'POST') {
      const box = { id: `box-${boxes.size + 1}`, name: body.name, status: 'idle', size: body.size, env_vars: body.env_vars };
      boxes.set(box.id, box);
      return Response.json(box);
    }
    if (pathname === '/v2/box') return Response.json([...boxes.values()]);
    const id = pathname.split('/')[3];
    if (method === 'DELETE') { boxes.delete(id); return Response.json({}); }
    return boxes.has(id) ? Response.json(boxes.get(id)) : Response.json({ error: 'not found' }, { status: 404 });
  });
  return { boxes, requests };
}

const env = { UPSTASH_BOX_API_KEY: 'box-test-secret', ANTHROPIC_API_KEY: 'anthropic-test-secret', OPENAI_API_KEY: 'openai-platform-test-secret', OPENROUTER_API_KEY: 'openrouter-test-secret', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-forward', OTHER_SECRET: 'must-not-forward' };

describe('Upstash provider rehearsal', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('creates, reconnects and deletes a Small Box configured for %s without forwarding other accounts', async (cli) => {
    const emu = emulator();
    const provider = createUpstashProvider(() => env);
    const tasks: UpstashTask[] = [];
    const office = new UpstashTasks(tasks, provider, async () => {});
    const task = (await office.ensure({ agentId: 'ada', slug: 'ada-0000', port: 5324, repo: 'team/app', branch: 'swarm/issue-277', cli }, 'office'))!;
    expect(emu.boxes.size).toBe(1);
    const create = emu.requests.find((r) => r.method === 'POST')!.body;
    expect(create).toMatchObject({ runtime: 'node', size: 'small', github_token: 'fake-github-token', env_vars: { CUBEFARM_UPSTASH_CLI: cli, GH_TOKEN: 'fake-github-token' } });
    const keys: Record<AgentCli, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', opencode: 'OPENROUTER_API_KEY' };
    expect(create.env_vars).toEqual({ [keys[cli]]: env[keys[cli] as keyof typeof env], GH_TOKEN: 'fake-github-token', CUBEFARM_UPSTASH_CLI: cli });
    const restarted = new UpstashTasks(structuredClone(tasks), createUpstashProvider(() => env), async () => {});
    expect((await restarted.ensure({ ...task }, 'office'))?.boxId).toBe(task.boxId);
    const box = await Box.get(task.boxId!, { apiKey: env.UPSTASH_BOX_API_KEY });
    expect(box.id).toBe(task.boxId);
    await box.delete();
    expect(await provider.list()).toEqual([]);
    expect(emu.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(tasks)).not.toMatch(/test-secret|fake-github-token|must-not-forward/);
  });

  it('explains missing host config without reading any login on the worker', () => {
    expect(createUpstashProvider(() => ({})).missing('claude')).toContain('UPSTASH_BOX_API_KEY');
    expect(createUpstashProvider(() => ({ UPSTASH_BOX_API_KEY: 'test' })).missing('codex')).toContain('OPENAI_API_KEY');
    expect(upstashConfig(env, 'opencode', 'task', 'github').env?.OPENROUTER_API_KEY).toBe('openrouter-test-secret');
  });
});

it('confirms all Git worktrees and local branches are saved, including detached QA changes and untracked files', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.CUBEFARM_JOB_SCRATCH || os.tmpdir(), 'upstash-git-'));
  const remote = path.join(dir, 'remote.git'), repo = path.join(dir, 'main'), desk = path.join(dir, 'desk with spaces');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const saved = () => spawnSync(process.execPath, ['-e', SAVED_WORK, repo], { windowsHide: true }).status;
  try {
    git(dir, 'init', '--bare', remote);
    git(dir, 'clone', remote, repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'readme'), 'initial');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial'); git(repo, 'push', 'origin', 'HEAD');
    git(repo, 'worktree', 'add', '-b', 'task', desk, 'HEAD');
    expect(saved()).toBe(0);
    await fs.writeFile(path.join(desk, 'unsaved'), 'work');
    expect(saved()).not.toBe(0);
    git(desk, 'add', '.'); git(desk, 'commit', '-m', 'task');
    expect(saved()).not.toBe(0);
    git(desk, 'push', 'origin', 'task');
    expect(saved()).toBe(0);
    git(desk, 'checkout', '--detach');
    await fs.writeFile(path.join(desk, 'readme'), 'detached work');
    git(desk, 'add', '.'); git(desk, 'commit', '-m', 'detached');
    expect(saved()).not.toBe(0);
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

it('keeps the OpenRouter provider in the OpenCode launch configuration', () => {
  const launch = launchArgs('opencode', { prompt: 'task', systemAppend: 'rules', model: 'openrouter/anthropic/claude-sonnet-4.6', effort: '', sessionId: 'id', cwd: '/workspace', role: 'dev', files: { system: 'instructions.md', settings: 'settings.json', mcp: null }, notify: { script: 'notify.cjs', url: 'http://localhost/hooks' }, plugin: 'file:///plugin.js', codexHook: 'hook.cjs', name: 'Ada', additionalDirectories: [], browser: null });
  expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).model).toBe('openrouter/anthropic/claude-sonnet-4.6');
});

it.skipIf(process.platform !== 'linux')('confirms a CLI that ignores SIGTERM is killed before accepting keeper shutdown, and can confirm again after restart', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const syncFs = await import('node:fs');
  const { STOP_KEEPER } = await import('./upstashProvider.ts');
  const home = await fs.mkdtemp(path.join(process.env.CUBEFARM_JOB_SCRATCH || os.tmpdir(), 'upstash-stop-'));
  const fd = syncFs.openSync(home, 'r');
  // Keep the socket address short while every byte remains in the supplied scratch directory.
  const socketHome = `/proc/${process.pid}/fd/${fd}`;
  await fs.writeFile(path.join(home, 'pty.secret'), 'test-secret');
  const writer = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise<string | null>((resolve) => writer.once('exit', (_code, signal) => resolve(signal)));
  await new Promise<void>((resolve) => writer.stdout!.once('data', () => resolve()));
  await fs.writeFile(path.join(home, 'task-processes.jsonl'), `${JSON.stringify(writer.pid)}\n`);
  let hello = false;
  const server = net.createServer((sock) => {
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
        if (msg.op === 'hello') {
          hello = msg.secret === 'test-secret';
          sock.write(`${JSON.stringify({ op: 'ready', version: 2, ptys: [] })}\n`);
        } else if (msg.op === 'shutdown') sock.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(`${socketHome}/pty.sock`, resolve));
  const stop = () => new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ['-e', STOP_KEEPER, '2', socketHome, 'started'], { stdio: 'ignore', windowsHide: true });
    child.once('exit', resolve);
  });
  try {
    expect(await stop()).toBe(0);
    expect(hello).toBe(true);
    expect(await exited).toBe('SIGKILL');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await stop()).toBe(0);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (writer.exitCode === null && writer.signalCode === null) { try { process.kill(-writer.pid!, 'SIGKILL'); } catch { /* exited */ } }
    syncFs.closeSync(fd);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
