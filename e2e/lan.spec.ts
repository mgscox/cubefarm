import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Local non-loopback coverage of the built CLI and Vite. A second-device LAN drill is still separate.
const root = path.resolve(import.meta.dirname, '..');
const lanHost = Object.values(os.networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.2';

// Node fetch rewrites Host; use the raw HTTP client for proxy authorization probes.
async function send(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(url, init, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Proxy authorization request timed out')));
    request.end(init.body);
  });
}

async function start(args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(process.execPath, args, {
    cwd: root, env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
  let output = '';
  proc.stdout.on('data', (data) => { output += String(data); });
  proc.stderr.on('data', (data) => { output += String(data); });
  let error: Error | undefined;
  proc.on('error', (err) => { error = err; });
  return { proc, output: () => output, error: () => error };
}

async function stop(proc: ChildProcess) {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else process.kill(-proc.pid, 'SIGTERM');
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
}

async function browserFlow(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('button', { name: /Enter the office|Skip setup/i })).toBeVisible();
  const result = await page.evaluate(async () => {
    let state = await fetch('/api/state').then((r) => r.json());
    const socket = new WebSocket(`ws://${location.host}/ws`);
    const events: { type: string }[] = [];
    socket.onmessage = (event) => events.push(JSON.parse(event.data));
    const waitFor = async (check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 15_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for office socket');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await waitFor(() => events.some((e) => e.type === 'snapshot'));
    await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyName: 'LAN smoke office' }) });
    await waitFor(() => events.some((e) => e.type === 'settings'));
    await waitFor(async () => {
      state = await fetch('/api/state').then((r) => r.json());
      return state.agents.some((a: { terminal: boolean }) => a.terminal);
    });
    const agent = state.agents.find((a: { terminal: boolean }) => a.terminal);
    const terminal = new WebSocket(`ws://${location.host}/ws/term?agent=${agent.id}`);
    const frames: { t: string }[] = [];
    terminal.onmessage = (event) => frames.push(JSON.parse(event.data));
    await waitFor(() => frames.some((f) => f.t === 'snapshot'));
    terminal.close();
    socket.close();
    return { demo: state.demo, events: events.map((e) => e.type), terminal: frames.map((f) => f.t) };
  });
  expect(result.demo).toBe(true);
  expect(result.events).toContain('settings');
  expect(result.terminal).toContain('snapshot');
}

test('CLI binding defaults to loopback and wildcard serves the office through built and Vite URLs', async ({ page }) => {
  const home = fs.mkdtempSync(path.join(root, 'test-results', 'lan-home-'));
  const children: ChildProcess[] = [];
  try {
    for (const host of [undefined, '0.0.0.0']) {
      const server = await start(['bin/cubefarm.js', '--demo', '--no-open', '--port', '0'], {
        SWARM_HOME: path.join(home, host ? 'lan' : 'local'), SWARM_HOST: host,
      });
      children.push(server.proc);
      await expect.poll(() => server.error()?.message ?? server.output()).toMatch(/cubefarm on http:\/\/localhost:\d+/);
      const port = Number(server.output().match(/cubefarm on http:\/\/localhost:(\d+)/)![1]);
      expect(server.output()).toContain(`Listening on ${host || '127.0.0.1'}:${port}`);
      expect(server.output()).toContain('DEMO MODE');
      const local = `http://127.0.0.1:${port}`;
      expect((await fetch(`${local}/api/state`).then((r) => r.json())).demo).toBe(true);
      const remote = `http://${lanHost}:${port}`;
      if (!host) {
        await expect(fetch(`${remote}/api/state`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
      } else {
        await browserFlow(page, remote);
        const duplicate = await start(['bin/cubefarm.js', '--demo', '--no-open', '--port', String(port)], { SWARM_HOME: path.join(home, 'duplicate'), SWARM_HOST: host });
        children.push(duplicate.proc);
        await expect.poll(duplicate.output).toContain(`already running: http://localhost:${port}`);
        expect(fs.existsSync(path.join(home, 'duplicate'))).toBe(false);
        const vite = await start(['node_modules/vite/bin/vite.js', '--port', '0'], { SWARM_PORT: String(port), SWARM_HOST: host });
        children.push(vite.proc);
        await expect.poll(vite.output).toMatch(/Local:\s+http:\/\/localhost:\d+/);
        const clientPort = Number(vite.output().match(/Local:\s+http:\/\/localhost:(\d+)/)![1]);
        const route = '/api/settings/upstash';
        const aliases = [route, '/api/settings/UPSTASH', '/api/Settings/upstash', '/api/SETTINGS/UpStAsH/?probe=1'];
        const localhost = `http://127.0.0.1:${clientPort}`;
        const keyPatch = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'synthetic-box-key' }) };
        // A LAN client can set Host and omit Origin. Vite must forward the actual peer address.
        if (!lanHost.startsWith('127.')) {
          for (const alias of aliases) {
            for (const forwarded of [undefined, '127.0.0.1']) {
              const spoofed = await send(`http://${lanHost}:${clientPort}${alias}`, {
                ...keyPatch, headers: {
                  ...keyPatch.headers, Host: `127.0.0.1:${clientPort}`,
                  ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}),
                },
              });
              expect(spoofed.status, `${alias}, X-Forwarded-For=${forwarded}`).toBe(403);
            }
          }
          expect(await fetch(`${localhost}${route}`).then((r) => r.json())).toEqual({ keySource: null, canManage: true });
        }
        for (const alias of aliases) {
          const saved = await fetch(`${localhost}${alias}`, {
            ...keyPatch, headers: { ...keyPatch.headers, Origin: localhost },
          });
          expect(saved.status, alias).toBe(200);
          expect(await saved.json()).toEqual({ keySource: 'settings', canManage: true });
        }
        await browserFlow(page, `http://${lanHost}:${clientPort}`);
      }
      await stop(server.proc);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('Vite cannot act as the trusted Claude authentication proxy for any route spelling', async ({}, testInfo) => {
  const home = testInfo.outputPath('claude-vite-home');
  const children: ChildProcess[] = [];
  try {
    for (const authHost of [lanHost, 'localhost']) {
      const origin = `https://${authHost}`;
      const server = await start(['--import', 'tsx', 'server/index.ts', '--demo'], {
        SWARM_HOME: path.join(home, authHost), SWARM_PORT: '0', SWARM_HOST: '127.0.0.1',
        CUBEFARM_AUTH_ORIGIN: origin, CUBEFARM_AUTH_PROXY_ADDRESS: '',
      });
      children.push(server.proc);
      await expect.poll(() => server.error()?.message ?? server.output()).toMatch(/localhost:\d+.*DEMO MODE/);
      const port = Number(server.output().match(/localhost:(\d+)/)![1]);
      const vite = await start(['node_modules/vite/bin/vite.js', '--port', '0'], { SWARM_PORT: String(port), SWARM_HOST: '0.0.0.0' });
      children.push(vite.proc);
      await expect.poll(vite.output).toMatch(/Local:\s+http:\/\/localhost:\d+/);
      const clientPort = Number(vite.output().match(/Local:\s+http:\/\/localhost:(\d+)/)![1]);
      const route = '/api/settings/claude';
      const headers = { Host: authHost, Origin: origin, 'Content-Type': 'application/json', 'X-CubeFarm-Claude-Auth': '1' };
      const post = (base: string, action: string, body = {}, extra = {}) => send(`${base}${action}`, {
        method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
      });
      const local = `http://127.0.0.1:${port}${route}`;
      // An authenticated loopback nginx hop may legitimately forward the browser's LAN address.
      const started = await post(local, '/start', { mode: 'manual-token' }, { 'X-Forwarded-For': lanHost });
      expect(started.status).toBe(200);
      const { flowId } = await started.json();
      for (const alias of [route, '/api/settings/CLAUDE', '/api/Settings/ClAuDe']) {
        const base = `http://${lanHost}:${clientPort}${alias}`;
        for (const [action, body] of [
          ['/status', {}], ['/start', { mode: 'manual-token' }], ['/code', { flowId, code: 'synthetic-code' }],
          ['/complete', { flowId, token: 'sk-ant-oat01-' + 't'.repeat(80) }], ['/cancel', { flowId }],
        ] as const) {
          expect((await post(base, action, body)).status, `${origin} ${alias}${action}`).toBe(403);
        }
        expect((await post(base, '/status', {}, { 'X-CubeFarm-Dev-Proxy': '' })).status).toBe(403);
      }
      expect(await (await post(local, '/status')).json()).toMatchObject({ phase: 'pending', flowId });
      expect((await post(local, '/cancel', { flowId })).status).toBe(200);
      await stop(vite.proc);
      await stop(server.proc);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a single-address SWARM_HOST is probed, opened and proxied on that address, and a bad one is refused', async () => {
  const home = fs.mkdtempSync(path.join(root, 'test-results', 'lan-home-'));
  const children: ChildProcess[] = [];
  try {
    const bad = await start(['bin/cubefarm.js', '--demo', '--no-open', '--port', '0'], { SWARM_HOME: path.join(home, 'bad'), SWARM_HOST: 'mini.local' });
    children.push(bad.proc);
    await expect.poll(bad.output).toContain(`SWARM_HOST="mini.local" isn't an address to listen on`);
    await expect.poll(() => bad.proc.exitCode).toBe(1);

    const url = new RegExp(`http://${lanHost.replaceAll('.', '\\.')}:(\\d+)`);
    const server = await start(['bin/cubefarm.js', '--demo', '--no-open', '--port', '0'], { SWARM_HOME: path.join(home, 'single'), SWARM_HOST: ` ${lanHost} ` });
    children.push(server.proc);
    await expect.poll(() => server.error()?.message ?? server.output()).toMatch(new RegExp(`cubefarm on ${url.source}`));
    const port = Number(server.output().match(url)![1]);
    const remote = `http://${lanHost}:${port}`;
    expect(server.output()).toContain(`Listening on ${lanHost}:${port} · remote: ${remote}`);
    expect((await fetch(`${remote}/api/state`).then((r) => r.json())).demo).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();

    const duplicate = await start(['bin/cubefarm.js', '--demo', '--no-open', '--port', String(port)], { SWARM_HOME: path.join(home, 'duplicate'), SWARM_HOST: lanHost });
    children.push(duplicate.proc);
    await expect.poll(duplicate.output).toContain(`already running: ${remote}`);
    expect(fs.existsSync(path.join(home, 'duplicate'))).toBe(false);

    const vite = await start(['node_modules/vite/bin/vite.js', '--port', '0'], { SWARM_PORT: String(port), SWARM_HOST: lanHost });
    children.push(vite.proc);
    await expect.poll(vite.output).toMatch(url);
    const client = `${lanHost}:${Number(vite.output().match(url)![1])}`;
    expect((await fetch(`http://${client}/api/state`).then((r) => r.json())).demo).toBe(true);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://${client}/ws`);
      socket.onmessage = (event) => { resolve(JSON.parse(String(event.data))); socket.close(); };
      socket.onerror = () => reject(new Error('Vite /ws proxy failed'));
    });
    expect(first.type).toBe('snapshot');
  } finally {
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
