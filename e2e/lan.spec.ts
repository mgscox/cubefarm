import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Local non-loopback coverage of the built CLI and Vite. A second-device LAN drill is still separate.
const root = path.resolve(import.meta.dirname, '..');
const lanHost = Object.values(os.networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.2';

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
        await browserFlow(page, `http://${lanHost}:${clientPort}`);
      }
      await stop(server.proc);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
