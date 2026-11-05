import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as clis from './clis.ts';
import { ClaudeAuthentication, claudeAuthRouter } from './claudeAuth.ts';
import { claudeEnv } from '../bin/claudeAuth.js';

// Node fetch rewrites Host; a raw HTTP client reproduces nginx's preserved external Host.
async function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(url, { method: init.method, headers: init.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString(), { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function fixture(options: { demo?: boolean; lifetimeMs?: number; spawnPty?: import('./claudeSetup.ts').AuthPtySpawner } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-http-'));
  const env = { SWARM_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-startup' };
  const auth = new ClaudeAuthentication({ home, env, origin: 'https://office.example', ...options });
  const app = express();
  app.use('/auth', claudeAuthRouter(auth));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  cleanups.push(() => auth.close());
  const post = async (route: string, body: unknown = {}) => send(url + route, {
    method: 'POST', headers: { Host: 'office.example', Origin: 'https://office.example', 'Content-Type': 'application/json', 'X-CubeFarm-Claude-Auth': '1' }, body: JSON.stringify(body),
  });
  return { auth, home, env, post, url };
}

it('runs one bounded replacement lifecycle; saves only the supplied token, with safe metadata and replay rejection', async () => {
  const { post, env } = await fixture();
  const initial = await (await post('/status')).json();
  expect(initial).toMatchObject({ source: 'startup', expiresAt: null, phase: 'idle', mode: 'browser', canManage: true });
  expect(JSON.stringify(initial).includes('dummy-startup')).toBe(false);
  const begin = await post('/start', { mode: 'manual-token' });
  expect(begin.status).toBe(200);
  const pending = await begin.json();
  expect(pending).toMatchObject({ phase: 'pending', flowId: expect.any(String), flowExpiresAt: expect.any(Number) });
  expect(pending.setupCommand).toContain('setup-token');
  expect((await post('/start', { mode: 'manual-token' })).status).toBe(409);
  const token = 'sk-ant-oat01-' + 't'.repeat(80);
  expect((await post('/complete', { flowId: 'wrong', token })).status).toBe(409);
  const complete = await post('/complete', { flowId: pending.flowId, token });
  expect(complete.status).toBe(200);
  const result = await complete.json();
  expect(result).toMatchObject({ source: 'saved', phase: 'complete', flowId: null });
  expect(JSON.stringify(result).includes(token)).toBe(false);
  expect(claudeEnv(env).CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
  expect((await post('/complete', { flowId: pending.flowId, token })).status).toBe(409);
});

it('rejects cross-origin, forwarded-header spoofing, wrong content/header, malformed/oversized JSON and arbitrary fields without disclosing input', async () => {
  const { url, post } = await fixture();
  const headers = { Host: 'office.example', Origin: 'https://office.example', 'Content-Type': 'application/json', 'X-CubeFarm-Claude-Auth': '1' };
  const secret = 'dummy-do-not-echo';
  for (const [patch, body, expected] of [
    [{ Origin: 'https://evil.example' }, '{}', 403],
    [{ Origin: 'https://office.example.evil' }, '{}', 403],
    [{ Origin: 'null' }, '{}', 403],
    [{ Origin: '' }, '{}', 403],
    [{ Host: 'evil.example', 'X-Forwarded-Host': 'office.example', 'X-Forwarded-Proto': 'https' }, '{}', 403],
    [{ 'X-CubeFarm-Claude-Auth': '' }, '{}', 403],
    [{ 'Content-Type': 'text/plain' }, '{}', 415],
    [{}, '{"token":"' + secret, 400],
    [{}, JSON.stringify({ token: secret.repeat(200) }), 400],
    [{}, JSON.stringify({ args: ['--console'], token: secret }), 400],
  ] as const) {
    const response = await send(url + '/start', { method: 'POST', headers: { ...headers, ...patch }, body });
    expect(response.status).toBe(expected);
    expect((await response.text()).includes(secret)).toBe(false);
  }
  expect((await send(url + '/status')).status).toBe(404);
  const valid = await post('/start', { mode: 'manual-token' });
  expect(valid.status).toBe(200); // same-origin HTTPS URL remains valid behind the configured loopback nginx HTTP hop
  expect(valid.headers.get('access-control-allow-origin')).toBeNull();
  expect(valid.headers.get('cache-control')).toBe('no-store');
});

it('cancel/expiry discard the nonce, allow a fresh flow, and never mutate credentials', async () => {
  const { post, home } = await fixture({ lifetimeMs: 50 });
  const first = await (await post('/start', { mode: 'manual-token' })).json();
  expect((await post('/cancel', { flowId: first.flowId })).status).toBe(200);
  const token = 'sk-ant-oat01-' + 'x'.repeat(80);
  expect((await post('/complete', { flowId: first.flowId, token })).status).toBe(409);
  const next = await (await post('/start', { mode: 'manual-token' })).json();
  expect(next.flowId).not.toBe(first.flowId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const expired = await (await post('/status')).json();
  expect(expired).toMatchObject({ phase: 'expired', flowId: null, flowExpiresAt: null });
  expect((await post('/complete', { flowId: next.flowId, token })).status).toBe(410);
  expect(fs.existsSync(path.join(home, 'credentials'))).toBe(false);
  expect((await post('/start', { mode: 'manual-token' })).status).toBe(200);
});

it('demo fakes replacement without inspecting credentials or resolving/launching a Claude auth process', async () => {
  const { post, home } = await fixture({ demo: true });
  const file = path.join(home, 'credentials', 'claude-subscription.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'dummy-unreadable-as-credential');
  const status = await (await post('/status')).json();
  expect(status).toMatchObject({ source: 'demo', setupCommand: 'Demo: no Claude process is launched', demo: true });
  const flow = await (await post('/start', { mode: 'manual-token' })).json();
  const response = await post('/complete', { flowId: flow.flowId, token: 'sk-ant-oat01-' + 'd'.repeat(80) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ source: 'demo', phase: 'complete' });
  expect(fs.readFileSync(file, 'utf8')).toBe('dummy-unreadable-as-credential');
});

it('sanitizes a failed private write and removes its temporary file', async () => {
  const { post, home } = await fixture();
  const flow = await (await post('/start', { mode: 'manual-token' })).json();
  const dir = path.join(home, 'credentials');
  fs.mkdirSync(path.join(dir, 'claude-subscription.json'), { recursive: true }); // deterministic rename failure on every platform
  const token = 'sk-ant-oat01-' + 'f'.repeat(80);
  const response = await post('/complete', { flowId: flow.flowId, token });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Could not save Claude subscription token.' });
  expect(fs.readdirSync(dir)).toEqual(['claude-subscription.json']);
  const metadata = await (await post('/status')).json();
  expect(metadata).toMatchObject({ phase: 'failed', source: 'unavailable', flowId: null });
  expect(JSON.stringify(metadata).includes(token)).toBe(false);
});

it('never guides the user through a broken shell wrapper when the bundled executable is missing', async () => {
  vi.spyOn(clis, 'commandFor').mockReturnValue({ file: 'broken-claude-wrapper', args: [] });
  // A missing bundled binary must be unavailable rather than falling back to PATH.
  vi.spyOn(clis, 'bundledClaude').mockReturnValue(null);
  const { post } = await fixture();
  const view = await (await post('/status')).json();
  expect(view.setupCommand).toBeNull();
});


it('protects the phone code route, validates its input, and runs a deterministic demo browser lifecycle', async () => {
  const { post, url, home } = await fixture({ demo: true });
  const start = await (await post('/start')).json();
  expect(start).toMatchObject({ mode: 'browser', phase: 'awaiting-code', authorizationUrl: expect.stringMatching(/^https:\/\/claude\.ai\/oauth\/authorize\?/) });
  const headers = { Host: 'office.example', Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-CubeFarm-Claude-Auth': '1' };
  const secret = 'demo-code-123';
  const denied = await send(url + '/code', { method: 'POST', headers, body: JSON.stringify({ flowId: start.flowId, code: secret }) });
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain(secret);
  for (const body of [
    { flowId: start.flowId, code: 'abc\nprivate-value' }, { flowId: start.flowId, code: 'abc\rprivate-value' },
    { flowId: start.flowId, code: 'abc\x1bprivate-value' }, { flowId: start.flowId, code: 'a'.repeat(514) },
    { flowId: start.flowId, code: 'https://evil.test/code' }, { flowId: start.flowId, code: 'short' },
    { flowId: start.flowId, code: secret, args: ['--console'] }, { flowId: [], code: secret },
  ]) {
    const response = await post('/code', body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private-value');
  }
  expect((await post('/start')).status).toBe(409);
  expect((await post('/code', { flowId: 'wrong', code: secret })).status).toBe(409);
  expect((await post('/complete', { flowId: start.flowId, token: 'sk-ant-oat01-' + 'x'.repeat(80) })).status).toBe(409);
  const done = await post('/code', { flowId: start.flowId, code: secret });
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ mode: 'browser', source: 'demo', phase: 'complete', authorizationUrl: null, flowId: null });
  expect((await post('/code', { flowId: start.flowId, code: secret })).status).toBe(409);
  expect(fs.existsSync(path.join(home, 'credentials'))).toBe(false);
  expect((await post('/start', { mode: 'console' })).status).toBe(400);
  expect((await post('/start', { mode: null })).status).toBe(400);
  const fresh = await (await post('/start')).json();
  expect((await post('/cancel', { flowId: fresh.flowId })).status).toBe(200);
});

it('wires protected code requests to the actual auth manager with an injected PTY and next-session save', async () => {
  let data: (value: string) => void = () => {};
  let exit: (value: { exitCode: number }) => void = () => {};
  const write = vi.fn();
  const stop = vi.fn(async () => {});
  const spawnPty: import('./claudeSetup.ts').AuthPtySpawner = () => ({ write, stop,
    onData(fn) { data = fn; return { dispose() {} }; }, onExit(fn) { exit = fn; return { dispose() {} }; },
  });
  const { post, env } = await fixture({ spawnPty });
  const first = await (await post('/start')).json();
  expect(first.phase).toBe('starting');
  const authorizationUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=abcdefgh01234567';
  data(authorizationUrl + '\r\nPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted >');
  expect(await (await post('/status')).json()).toMatchObject({ phase: 'awaiting-code', authorizationUrl });
  expect((await post('/code', { flowId: first.flowId, code: 'dummy-http-code#dummy-http-state' })).status).toBe(200);
  expect(write).toHaveBeenCalledExactlyOnceWith('dummy-http-code#dummy-http-state\r');
  expect((await post('/code', { flowId: first.flowId, code: 'dummy-http-code' })).status).toBe(409);
  const token = 'sk-ant-oat01-' + 'h'.repeat(80);
  data('Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\n');
  exit({ exitCode: 0 });
  await vi.waitFor(async () => expect(await (await post('/status')).json()).toMatchObject({ phase: 'complete', source: 'saved', flowId: null, authorizationUrl: null }));
  expect(claudeEnv(env).CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});
