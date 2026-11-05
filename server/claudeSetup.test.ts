import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAuthentication } from './claudeAuth.ts';
import { claudeEnv } from '../bin/claudeAuth.js';
import { safeClaudeAuthorizationUrl, stopClaudeAuthPty, type AuthPtySpawner } from './claudeSetup.ts';

const url = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=abcdefgh01234567';
const token = 'sk-ant-oat01-' + 'z'.repeat(80);
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-setup-test-'));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  let data: (value: string) => void = () => {};
  let exit: (value: { exitCode: number }) => void = () => {};
  const writes: string[] = [];
  const stop = vi.fn(async () => {});
  const spawn = vi.fn<AuthPtySpawner>((_file, _args, _options) => ({
    onData(fn) { data = fn; return { dispose() {} }; },
    onExit(fn) { exit = fn; return { dispose() {} }; },
    write(value) { writes.push(value); }, stop,
  }));
  const auth = new ClaudeAuthentication({ home, env: { CLAUDE_CODE_OAUTH_TOKEN: 'inherited-secret', ANTHROPIC_API_KEY: 'inherited-secret', NODE_OPTIONS: 'inherited-secret', HTTPS_PROXY: 'inherited-secret' }, spawnPty: spawn });
  cleanup.push(() => auth.close());
  return { auth, home, spawn, writes, stop, data: (value: string) => data(value), exit: (exitCode: number) => exit({ exitCode }) };
}

it('phone flow isolates official setup-token, accepts one code, and saves only a captured token after successful exit for the next session', async () => {
  const f = fixture();
  const start = await f.auth.start();
  expect(start).toMatchObject({ mode: 'browser', phase: 'starting', authorizationUrl: null });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const [file, args, opts] = f.spawn.mock.calls[0];
  expect(path.isAbsolute(file)).toBe(true);
  expect(args).toEqual(['setup-token']);
  expect(opts.cwd.startsWith(process.cwd())).toBe(false);
  expect(opts.env.HOME).not.toBe(os.homedir());
  expect(new Set([opts.cwd, opts.env.HOME, opts.env.CLAUDE_CONFIG_DIR]).size).toBe(3);
  expect(Object.values(opts.env).includes('inherited-secret')).toBe(false);
  expect(fs.statSync(opts.cwd).isDirectory()).toBe(true);
  if (process.platform !== 'win32') expect(fs.statSync(opts.env.HOME).mode & 0o777).toBe(0o700);
  f.data('Browser did not open? Use this url:\r\n' + url.slice(0, 80));
  f.data(url.slice(80) + '\r\nPaste code here if prompted > ');
  expect(f.auth.view()).toMatchObject({ phase: 'awaiting-code', authorizationUrl: url });
  const id = start!.flowId!;
  expect(await f.auth.submitCode(id, 'dummy-code_123#dummy-state_456')).toMatchObject({ phase: 'exchanging', authorizationUrl: null });
  expect(f.writes).toEqual(['dummy-code_123#dummy-state_456\r']);
  expect(await f.auth.submitCode(id, 'dummy-code_123')).toBeNull();
  f.data('Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\nStore this token securely.');
  expect(fs.existsSync(path.join(f.home, 'credentials'))).toBe(false);
  expect(JSON.stringify(f.auth.view())).not.toContain(token);
  f.exit(0);
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('complete'));
  expect(claudeEnv({ SWARM_HOME: f.home }).CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
  expect(fs.existsSync(opts.cwd)).toBe(false);
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it('keeps a singleton across cancellation cleanup and rejects late output, exit, and code replays', async () => {
  const f = fixture();
  const start = await f.auth.start();
  expect(await f.auth.start()).toBeNull();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  let release!: () => void;
  f.stop.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const cancel = f.auth.cancel(start!.flowId!);
  expect(await f.auth.start()).toBeNull();
  f.data(url + '\r\nPaste code here if prompted >');
  f.exit(0);
  release();
  expect(await cancel).toMatchObject({ phase: 'cancelled', flowId: null, authorizationUrl: null });
  expect(await f.auth.submitCode(start!.flowId!, 'dummy-code-123')).toBeNull();
  expect(fs.existsSync(f.spawn.mock.calls[0][2].cwd)).toBe(false);
  f.stop.mockImplementation(async () => {});
  expect(await f.auth.start()).toMatchObject({ phase: 'starting' });
});

it.each(['nonzero', 'missing-token', 'token-without-success-pattern', 'overflow', 'cli-error'] as const)('fails closed on %s without writing credentials or leaking output', async (scenario) => {
  const f = fixture();
  const start = await f.auth.start();
  f.data(url + '\r\nPaste code here if prompted >');
  await f.auth.submitCode(start!.flowId!, 'dummy-code-123');
  if (scenario === 'overflow') f.data('private-error'.repeat(6000));
  else if (scenario === 'cli-error') f.data('OAuth error: private-provider-details');
  else {
    f.data(scenario === 'token-without-success-pattern' ? token : scenario === 'nonzero' ? 'Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\n' : 'Login successful.');
    f.exit(scenario === 'nonzero' ? 1 : 0);
  }
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('failed'));
  await vi.waitFor(() => expect(fs.existsSync(f.spawn.mock.calls[0][2].cwd)).toBe(false));
  expect(fs.existsSync(path.join(f.home, 'credentials'))).toBe(false);
  expect(JSON.stringify(f.auth.view())).not.toMatch(/private-|sk-ant-oat01-/);
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it('expires and shuts down process trees and private directories, without allowing a restart after shutdown', async () => {
  const f = fixture();
  f.auth.options.lifetimeMs = 30;
  const flow = await f.auth.start();
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('expired'));
  await vi.waitFor(() => expect(fs.existsSync(f.spawn.mock.calls[0][2].cwd)).toBe(false));
  expect(await f.auth.submitCode(flow!.flowId!, 'dummy-code-123')).toBeNull();
  f.auth.options.lifetimeMs = 600000;
  await f.auth.start();
  await f.auth.close();
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(f.spawn.mock.calls[1][2].cwd)).toBe(false);
  expect(await f.auth.start()).toBeNull();
});

it('cleans directories after spawn, write, and save errors using only safe status', async () => {
  const f = fixture();
  f.spawn.mockImplementationOnce(() => { throw new Error('private-spawn-error'); });
  expect(await f.auth.start()).toMatchObject({ phase: 'failed', flowId: null });
  await vi.waitFor(() => expect(fs.existsSync(f.spawn.mock.calls[0][2].cwd)).toBe(false));
  await f.auth.start();
  f.data(url + '\r\nPaste code here if prompted >');
  const id = f.auth.view().flowId!;
  const pty = f.spawn.mock.results[1].value!;
  vi.spyOn(pty, 'write').mockImplementationOnce(() => { throw new Error('private-write-error'); });
  expect(await f.auth.submitCode(id, 'dummy-code-123')).toMatchObject({ phase: 'failed' });
  await f.auth.start();
  f.data(url + '\r\nPaste code here if prompted >');
  await f.auth.submitCode(f.auth.view().flowId!, 'dummy-code-123');
  fs.mkdirSync(path.join(f.home, 'credentials', 'claude-subscription.json'), { recursive: true });
  f.data('Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\n');
  f.exit(0);
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('failed'));
  expect(fs.readdirSync(path.join(f.home, 'credentials'))).toEqual(['claude-subscription.json']);
  expect(JSON.stringify(f.auth.view())).not.toMatch(/private-|sk-ant-oat01-/);
});


it('accepts the exact installed CLI authorization host/path and rejects evil destinations and sensitive query values', () => {
  expect(safeClaudeAuthorizationUrl(url)).toBe(url);
  const installed = url.replace('claude.ai/oauth/authorize', 'claude.com/cai/oauth/authorize');
  expect(safeClaudeAuthorizationUrl(installed)).toBe(installed);
  for (const bad of [
    url.replace('https:', 'http:'), url.replace('https:', 'javascript:'), url.replace('claude.ai', 'claude.ai.evil.test'),
    url.replace('claude.ai', 'evil.test'), url.replace('claude.ai', 'user:password@claude.ai'), url.replace('claude.ai', 'claude.ai:444'),
    url.replace('/oauth/authorize', '/oauth/evil'), url + '#secret', url + '&access_token=private-token', url + '&code=private-code',
    url + '&state=private-state', url + '&unknown=private-value', url.replace('code=true', 'code=private-code'),
    url.replace('scope=user%3Ainference', 'scope=private-token'), url.replace('state=abcdefgh01234567', 'state=abc%0Adef'),
    url.replace('redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback', 'redirect_uri=https%3A%2F%2Fevil.test'),
    url.replace('https://claude.ai', 'https://claude.ai.'), url.replace('code=true', 'code=true&code=true'), url + 'a'.repeat(4096),
  ]) expect(safeClaudeAuthorizationUrl(bad)).toBeNull();
});

it('never exposes an unsafe authorization URL or code-shaped token in status', async () => {
  const f = fixture();
  await f.auth.start();
  f.data(url.replace('claude.ai', 'evil.test') + '\r\nPaste code here if prompted >');
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('failed'));
  expect(f.auth.view().authorizationUrl).toBeNull();
});

it('recognizes the installed Ink PTY cursor spacing and split ANSI sequences without exposing a terminal', async () => {
  const f = fixture();
  await f.auth.start();
  f.data('\x1b[32m' + url + '\x1b[39m\r\nPaste\x1b[');
  f.data('1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted >');
  expect(f.auth.view().phase).toBe('awaiting-code');
  await f.auth.submitCode(f.auth.view().flowId!, 'dummy-code-123');
  f.data('Long-lived\x1b[1Cauthentication\x1b[1Ctoken\x1b[1Ccreated\x1b[1Csuccessfully!\r\nYour\x1b[1COAuth\x1b[1Ctoken\x1b[1C(valid\x1b[1Cfor\x1b[1C1\x1b[1Cyear):\r\n\x1b[32m' + token + '\x1b[39m\r\n');
  f.exit(0);
  await vi.waitFor(() => expect(f.auth.view().phase).toBe('complete'));
  expect(claudeEnv({ SWARM_HOME: f.home }).CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
});

it('refuses a temp root inside the checkout and never starts an auth process there', async () => {
  const f = fixture();
  vi.spyOn(os, 'tmpdir').mockReturnValue(process.cwd());
  expect(await f.auth.start()).toMatchObject({ phase: 'failed', flowId: null });
  expect(f.spawn).not.toHaveBeenCalled();
});

it('cannot save after cancellation wins the subprocess-exit cleanup race', async () => {
  const f = fixture();
  await f.auth.start();
  f.data(url + '\r\nPaste code here if prompted >');
  const id = f.auth.view().flowId!;
  await f.auth.submitCode(id, 'dummy-code-123');
  let release!: () => void;
  f.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  f.data('Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\n');
  f.exit(0);
  expect(f.auth.view().phase).toBe('saving');
  const cancelled = f.auth.cancel(id);
  release();
  await cancelled;
  expect(f.auth.view().phase).toBe('cancelled');
  expect(fs.existsSync(path.join(f.home, 'credentials'))).toBe(false);
});

it('rejects a token hidden in otherwise allowed authorization query fields', () => {
  expect(safeClaudeAuthorizationUrl(url.replace('state=abcdefgh01234567', 'state=' + token))).toBeNull();
});

it('keeps the ten-minute deadline active while a successful exit is being cleaned up', async () => {
  const f = fixture();
  f.auth.options.lifetimeMs = 40;
  await f.auth.start();
  f.data(url + '\r\nPaste code here if prompted >');
  await f.auth.submitCode(f.auth.view().flowId!, 'dummy-code-123');
  let release!: () => void;
  f.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  f.data('Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n' + token + '\r\n');
  f.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const phaseAtDeadline = f.auth.view().phase;
  release();
  await vi.waitFor(() => expect(fs.existsSync(f.spawn.mock.calls[0][2].cwd)).toBe(false));
  expect(phaseAtDeadline).toBe('expired');
  expect(fs.existsSync(path.join(f.home, 'credentials'))).toBe(false);
});


it('bounds a hung Windows taskkill and still closes the native PTY without exposing errors', async () => {
  vi.useFakeTimers();
  try {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi.fn(() => child);
    const pty = { pid: 123456, kill: vi.fn() };
    const closed = stopClaudeAuthPty(pty, 'win32', spawn as never);
    await vi.advanceTimersByTimeAsync(2000);
    await closed;
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '123456', '/T', '/F'], expect.objectContaining({ windowsHide: true, stdio: 'ignore' }));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(pty.kill).toHaveBeenCalledTimes(1);
    // A late child error is absorbed after the deadline too.
    expect(() => child.emit('error', new Error('private-kill-error'))).not.toThrow();
  } finally { vi.useRealTimers(); }
});
