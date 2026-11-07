import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { savedDeskCheck, UpstashBoxes, upstashConfig } from './upstash.ts';
import { run } from './exec.ts';
import type { AgentCli } from '../shared/types.ts';

const secrets = {
  CUBEFARM_UPSTASH_BOX_API_KEY: 'box-fixture',
  CUBEFARM_UPSTASH_GITHUB_TOKEN: 'github-fixture',
  CUBEFARM_UPSTASH_ANTHROPIC_API_KEY: 'anthropic-fixture',
  CUBEFARM_UPSTASH_OPENAI_API_KEY: 'openai-fixture',
  CUBEFARM_UPSTASH_OPENROUTER_API_KEY: 'openrouter-fixture',
};

const servers: ReturnType<typeof createServer>[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function emulator() {
  const boxes = new Map<string, { id: string; name: string; status: string; labels: string[] }>();
  const creates: Record<string, unknown>[] = [];
  let rejectCreate = '';
  let dropCreate = false;
  let rejectDelete = false;
  let checkout = 'clean';
  const scripts: string[] = [];
  const uploaded = new Set<string>();
  const runner = await fs.mkdtemp(path.join(os.tmpdir(), 'upstash-runner-fixture-'));
  scratch.push(runner);
  for (const dir of ['bin', 'dist-server', 'docs/specialisms', 'skills']) await fs.mkdir(path.join(runner, dir), { recursive: true });
  await fs.writeFile(path.join(runner, 'package.json'), '{}');
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.headers['x-box-api-key'] !== secrets.CUBEFARM_UPSTASH_BOX_API_KEY) return send(401, { error: 'Unauthorized' });
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/v2/box' && req.method === 'GET') return send(200, [...boxes.values()]);
    if (url.pathname === '/v2/box' && req.method === 'POST') {
      if (rejectCreate) return send(429, { error: rejectCreate });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      creates.push(data);
      const box = { id: `box-${creates.length}`, name: data.name, status: 'idle', labels: data.labels };
      boxes.set(box.id, box);
      if (dropCreate) return req.socket.destroy();
      return send(201, box);
    }
    const [, , , id, operation, subOperation] = url.pathname.split('/');
    const box = boxes.get(id);
    if (!box) return send(404, { error: 'Box not found' });
    if (req.method === 'POST' && operation === 'files' && subOperation === 'upload') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (!Buffer.concat(chunks).includes('cubefarm-runner.tar.gz')) return send(400, { error: 'Missing runner archive' });
      uploaded.add(id);
      return send(200, {});
    }
    if (req.method === 'POST' && operation === 'exec') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const script = JSON.parse(Buffer.concat(chunks).toString()).command?.[2];
      if (typeof script !== 'string') return send(400, { error: 'Missing command' });
      scripts.push(script);
      if (script.includes('rev-list')) return send(200, { exit_code: 0, output: checkout });
      if (!uploaded.has(id)) return send(409, { error: 'Missing runner archive' });
      return send(200, { exit_code: 0, output: '' });
    }
    if (!operation && req.method === 'GET') return send(200, box);
    if (!operation && req.method === 'DELETE') {
      if (rejectDelete) return send(503, { error: 'Provider unavailable' });
      boxes.delete(box.id);
      return send(200, {});
    }
    return send(501, { error: 'Unsupported operation' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Emulator did not bind');
  const client = new UpstashBoxes(upstashConfig({}, secrets), `http://127.0.0.1:${address.port}`, runner);
  return {
    boxes, creates, client, scripts, reject: (message: string) => { rejectCreate = message; },
    dropCreateResponse: () => { dropCreate = true; },
    blockDelete: (blocked: boolean) => { rejectDelete = blocked; },
    desk: (state: string) => { checkout = state; },
  };
}

describe('Upstash Box API', () => {
  it.each([
    ['claude', 'ANTHROPIC_API_KEY', 'anthropic-fixture', '@anthropic-ai/claude-code'],
    ['codex', 'OPENAI_API_KEY', 'openai-fixture', '@openai/codex'],
    ['opencode', 'OPENROUTER_API_KEY', 'openrouter-fixture', 'opencode-ai'],
  ] as const)('provisions and deletes an isolated %s Box with only its provider credential', async (cli: AgentCli, key, value, executable) => {
    const { client, boxes, creates, scripts, desk, blockDelete } = await emulator();
    const id = await client.allocate('cf-test-worker', 'cf-test', cli, cli === 'opencode' ? 'openrouter/example/model' : '');
    expect(id).toBe('box-1');
    expect(creates[0]).toMatchObject({ size: 'small', runtime: 'node', env_vars: { [key]: value, GH_TOKEN: 'github-fixture' } });
    expect(creates[0].env_vars).toEqual({ CUBEFARM_UPSTASH_WORKER: cli, GH_TOKEN: 'github-fixture', [key]: value });
    expect(JSON.stringify(creates[0])).not.toContain('box-fixture');
    expect(await client.find('cf-test-worker', 'cf-test')).toBe(id);
    await client.bootstrap(id!, cli);
    expect(scripts[0]).toContain(executable);
    expect(scripts[0].includes('codex login --with-api-key')).toBe(cli === 'codex');
    expect(scripts[0]).not.toContain(value);
    desk('dirty');
    expect(await client.safeToDelete(id!, '/workspace/home/worktree', '/workspace/home/main')).toBe(false);
    desk('unpushed');
    expect(await client.safeToDelete(id!, '/workspace/home/worktree', '/workspace/home/main')).toBe(false);
    desk('clean');
    expect(await client.safeToDelete(id!, '/workspace/home/worktree', '/workspace/home/main')).toBe(true);
    blockDelete(true);
    await expect(client.remove(id!)).rejects.toThrow('HTTP 503');
    expect(boxes.size).toBe(1);
    blockDelete(false);
    await client.remove(id!);
    await client.remove(id!);
    expect(boxes.size).toBe(0);
  });

  it('counts account boxes towards the cap and distinguishes quota from request throttling', async () => {
    const { client, boxes, reject } = await emulator();
    for (let i = 0; i < 10; i++) boxes.set(String(i), { id: String(i), name: 'outside-office', status: 'paused', labels: [] });
    expect(await client.allocate('cf-test-worker', 'cf-test', 'claude', '')).toBeNull();
    boxes.clear();
    reject('Concurrent box quota exceeded');
    expect(await client.allocate('cf-test-worker', 'cf-test', 'claude', '')).toBeNull();
    reject('API request rate limit exceeded');
    await expect(client.allocate('cf-test-worker', 'cf-test', 'claude', '')).rejects.toThrow('HTTP 429');
  });

  it('recovers a lost create response by name without creating twice', async () => {
    const { client, creates, dropCreateResponse } = await emulator();
    dropCreateResponse();
    await expect(client.allocate('cf-test-worker', 'cf-test', 'claude', '')).rejects.toThrow('could not complete');
    expect(await client.find('cf-test-worker', 'cf-test')).toBe('box-1');
    expect(await client.allocate('cf-test-worker', 'cf-test', 'claude', '')).toBe('box-1');
    expect(creates).toHaveLength(1);
  });

  it('reconciles an existing name only when its office label matches', async () => {
    const { client, boxes, creates } = await emulator();
    boxes.set('existing', { id: 'existing', name: 'cf-test-worker', status: 'idle', labels: ['cf-test'] });
    expect(await client.allocate('cf-test-worker', 'cf-test', 'codex', '')).toBe('existing');
    expect(await client.find('cf-test-worker', 'cf-other')).toBeNull();
    expect(creates).toEqual([]);
  });
});


it.skipIf(process.platform === 'win32')('keeps a Box with a stash, an unpushed side branch, or another worktree', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'upstash-desk-fixture-'));
  scratch.push(folder);
  const remote = path.join(folder, 'remote');
  const main = path.join(folder, 'main');
  const desk = path.join(folder, "worker's desk");
  const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);
  const verify = () => run('sh', ['-c', savedDeskCheck(desk, main)]);
  await git(folder, 'init', '--bare', '--initial-branch=main', remote);
  await git(folder, 'clone', remote, main);
  await git(main, 'config', 'user.name', 'Test Worker');
  await git(main, 'config', 'user.email', 'worker@example.test');
  await fs.writeFile(path.join(main, 'tracked.txt'), 'initial');
  await git(main, 'add', 'tracked.txt');
  await git(main, 'commit', '-m', 'initial');
  await git(main, 'push', 'origin', 'main');
  await git(main, 'worktree', 'add', '-b', 'task', desk);
  expect(await verify()).toBe('clean');

  await fs.writeFile(path.join(desk, 'tracked.txt'), 'stash');
  await git(desk, 'stash', 'push');
  expect(await verify()).toBe('unpushed');
  await git(desk, 'stash', 'drop');

  await git(desk, 'switch', '-c', 'side');
  await fs.writeFile(path.join(desk, 'tracked.txt'), 'side branch');
  await git(desk, 'commit', '-am', 'side');
  await git(desk, 'switch', 'task');
  expect(await verify()).toBe('unpushed');
  await git(desk, 'push', 'origin', 'side');
  expect(await verify()).toBe('clean');

  await git(desk, 'worktree', 'add', '--detach', path.join(folder, 'extra'));
  expect(await verify()).toBe('dirty');
});
