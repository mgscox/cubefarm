import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBox } from './boxLink.ts';
import { encode, PTY_PROTOCOL, type ToHost } from './ptyProtocol.ts';
import { withOperation } from './operation.ts';
import type { BoxConnection } from './machine.ts';
import { images, IMAGE_ROUTE } from './attachments.ts';
import { BASH_EXPANSION_PERMISSION, NAVIGATE_PERMISSION } from './fixtures/claudePermissions.ts';
import type { AgentTerminal } from './terminal.ts';
import { saveClaudeToken } from '../bin/claudeAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliPlan } from './machine.ts';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('./machineHealth.ts', () => ({ monitorResources: () => () => {} }));

describe('remote desk cancellation', () => {
  let box: BoxConnection;
  let sent: ToHost[];
  let authHome: string;
  let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    authHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-box-auth-'));
    vi.stubEnv('SWARM_HOME', authHome);
    vi.stubEnv('CUBEFARM_CLAUDE_AUTH_BOXES', 'other-box, fake-box');
    sent = [];
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => child.emit('close', 0)) });
    child.stdin.on('data', (line: Buffer) => {
      const message = JSON.parse(line.toString()) as ToHost;
      sent.push(message);
      if (message.op === 'rpc' && ['info', 'detectClis'].includes(message.method)) {
        child.stdout.write(encode({ op: 'rpcReply', rid: message.rid, ok: true, value: message.method === 'info' ? {} : [] }));
      }
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    box = connectBox({ box: { id: 'box', name: 'Attic', destination: 'fake-box' }, officeId: 'test', changed: () => {}, terminalFor: () => null });
    await Promise.resolve();
    child.stdout.write(encode({ op: 'ready', version: PTY_PROTOCOL, hookPort: 0, ptys: [], officeClaudeAuth: true }));
    await box.reconnected;
  });

  afterEach(() => {
    box.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(authHome, { recursive: true, force: true, maxRetries: 5 });
  });

  it.each(['prepareDesk', 'releaseDesk'] as const)('times out and cancels its own %s RPC without dropping other desks', async (method) => {
    const pending = method === 'prepareDesk' ? box.machine.prepareDesk('demo/repo', { defaultBranch: 'main' }, 'ada', 'feature') : box.machine.releaseDesk('demo/repo', 'ada', 5324);
    const failed = expect(pending).rejects.toThrow('operation aborted');
    const call = sent.find((m) => m.op === 'rpc' && m.method === method)!;
    await vi.advanceTimersByTimeAsync(method === 'prepareDesk' ? 15 * 60_000 : 2 * 60_000);
    await failed;
    expect(sent).toContainEqual({ op: 'cancelRpc', rid: (call as Extract<ToHost, { op: 'rpc' }>).rid });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('forwards watchdog cancellation to the remote operation immediately', async () => {
    const controller = new AbortController();
    const pending = withOperation(controller.signal, () => box.machine.prepareDesk('demo/repo', { defaultBranch: 'main' }, 'ada', 'feature'));
    const failed = expect(pending).rejects.toThrow();
    controller.abort(new Error('Startup timed out'));
    await failed;
    expect(sent.at(-1)).toMatchObject({ op: 'cancelRpc' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('sends image bytes over SSH before resolving a remote follow-up prompt', async () => {
    const name = images.save(Buffer.from('GIF89a image fixture'));
    const text = `Look at http://localhost:1234${IMAGE_ROUTE}/${name}`;
    const pending = box.machine.cliHost!.preparePrompt!(text);
    const call = sent.find((m) => m.op === 'rpc' && m.method === 'preparePrompt') as Extract<ToHost, { op: 'rpc' }>;
    expect(call.args).toEqual([text, [{ name, data: images.read(name).toString('base64') }]]);
    child.stdout.write(encode({ op: 'rpcReply', rid: call.rid, ok: true, value: 'Read the file on the box' }));
    expect(await pending).toBe('Read the file on the box');
    expect(box.machine.cliHost!.preparePrompt!('text only')).toBe('text only');
  });

  it('includes images from both task and system instructions when starting a remote CLI', async () => {
    const name = images.save(Buffer.from('GIF89a initial prompt fixture'));
    const text = `See http://localhost:1234${IMAGE_ROUTE}/${name}`;
    const pending = box.machine.cliHost!.prepare({
      cli: 'codex', token: 'image-task', sessionId: 'image-session', cwd: 'remote-desk', prompt: text,
      systemAppend: text, model: '', effort: '', name: 'Test', role: 'dev', additionalDirectories: [],
      browserTesting: false, officeUrl: 'http://localhost:1234', officeTools: false,
    });
    const call = sent.find((m) => m.op === 'rpc' && m.method === 'prepare') as Extract<ToHost, { op: 'rpc' }>;
    expect(call.args[1]).toEqual([{ name, data: images.read(name).toString('base64') }]);
    child.stdout.write(encode({ op: 'rpcReply', rid: call.rid, ok: true, value: { dir: 'remote-session', prompt: 'remote prompt' } }));
    expect(await pending).toMatchObject({ dir: 'remote-session', prompt: 'remote prompt' });
  });

  it('sends the current office token only for Claude on an opted-in SSH link', async () => {
    const plan: CliPlan = {
      cli: 'claude', token: 'auth-task', sessionId: 'auth-session', cwd: 'remote-desk', prompt: 'Test',
      systemAppend: '', model: '', effort: '', name: 'Test', role: 'dev', additionalDirectories: [],
      browserTesting: false, officeUrl: 'http://localhost:1234', officeTools: false,
    };
    const first = 'sk-ant-oat01-' + 'a'.repeat(36);
    const second = 'sk-ant-oat01-' + 'b'.repeat(36);
    async function prepare(cli: CliPlan['cli']) {
      const pending = box.machine.cliHost!.prepare({ ...plan, cli });
      const call = sent.at(-1) as Extract<ToHost, { op: 'rpc' }>;
      child.stdout.write(encode({ op: 'rpcReply', rid: call.rid, ok: true, value: { dir: 'remote-session', prompt: 'Test' } }));
      await pending;
      return call.args.slice(2);
    }
    expect(vi.mocked(spawn).mock.lastCall?.[1]).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'ControlPath=none']));
    await saveClaudeToken(authHome, first);
    expect(await prepare('claude')).toEqual([first]);
    await saveClaudeToken(authHome, second);
    expect(await prepare('claude')).toEqual([second]);
    expect(await prepare('codex')).toEqual([]);
    expect(await prepare('opencode')).toEqual([]);
    vi.stubEnv('CUBEFARM_CLAUDE_AUTH_BOXES', 'fake-box-alias');
    expect(await prepare('claude')).toEqual([]);
  });
  it.each([
    { tool: 'Playwright', dialog: NAVIGATE_PERMISSION, log: 'Approved playwright — Navigate to a URL (hook missed)' },
    { tool: 'Bash', dialog: BASH_EXPANSION_PERMISSION, log: 'Approved Bash shell expansion once' },
  ])('answers the Claude $tool dialog over the box transport and continues the remote session', async ({ tool, dialog, log }) => {
    let screen = '';
    let queued = '';
    const term = {
      cols: 120, rows: 32, bind: vi.fn(), note: vi.fn(),
      write: (s: string) => { if (tool === 'Bash') queued = s; else screen = s; },
      flush: async () => { screen = queued; }, screen: () => screen,
    } as unknown as AgentTerminal;
    const cb = { log: vi.fn(), tool: vi.fn(), sessionId: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), finished: vi.fn() };
    const session = box.machine.startSession({
      cwd: 'remote-desk', cli: 'claude', terminal: term, prompt: 'Test the preview', systemAppend: '',
      model: '', effort: 'medium', role: 'qa', browserTesting: true, additionalDirectories: [],
    }, cb);
    const prepare = sent.find((m) => m.op === 'rpc' && m.method === 'prepare') as Extract<ToHost, { op: 'rpc' }>;
    child.stdout.write(encode({ op: 'rpcReply', rid: prepare.rid, ok: true, value: { dir: 'remote-session', prompt: 'Test the preview', hookUrl: 'http://127.0.0.1:12345/api/hooks' } }));
    await vi.advanceTimersByTimeAsync(0);
    const launch = sent.find((m) => m.op === 'launch') as Extract<ToHost, { op: 'launch' }>;
    child.stdin.on('data', (line: Buffer) => {
      const message = JSON.parse(line.toString()) as ToHost;
      if (message.op !== 'write' || message.id !== launch.id || message.data !== '\r') return;
      child.stdout.write(encode({ op: 'data', id: launch.id, data: '❯' }));
      child.stdout.write(encode({ op: 'hook', rid: 991, token: launch.token, body: { hook_event_name: 'Stop', last_assistant_message: 'Preview checked' } }));
    });
    // A missing hook produces a permission dialog on the remote PTY, carried to the office over SSH.
    await vi.advanceTimersByTimeAsync(121_000);
    child.stdout.write(encode({ op: 'data', id: launch.id, data: dialog }));
    if (tool === 'Bash') {
      child.stdout.write(encode({ op: 'hook', rid: 990, token: launch.token, body: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } }));
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.filter((m) => m.op === 'write')).toEqual([{ op: 'write', id: launch.id, data: '\r' }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Preview checked' }));
    expect(sent).toContainEqual({ op: 'hookReply', rid: 991, answer: {} });
    expect(cb.log.mock.calls.flat(2)).toContainEqual({ kind: 'system', text: log });
    session.stop();
  });
});

it('uses the current provider key when a dropped transport redials', async () => {
  vi.useFakeTimers();
  const children: EventEmitter[] = [];
  const mockedSpawn = vi.mocked(spawn);
  mockedSpawn.mockClear().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    children.push(child);
    return child as unknown as ReturnType<typeof spawn>;
  });
  let key = 'first-key';
  const box = connectBox({
    box: { id: 'box', name: 'Disposable', destination: 'fake-box' },
    officeId: 'test', changed: () => {}, terminalFor: () => null,
    transport: { file: 'bridge', args: [], env: () => ({ UPSTASH_BOX_API_KEY: key }) },
  });
  try {
    await Promise.resolve();
    expect(mockedSpawn.mock.lastCall?.[2]).toMatchObject({ env: { UPSTASH_BOX_API_KEY: 'first-key' } });
    key = 'replacement-key';
    children[0].emit('close', 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(mockedSpawn.mock.lastCall?.[2]).toMatchObject({ env: { UPSTASH_BOX_API_KEY: 'replacement-key' } });
  } finally {
    box.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    mockedSpawn.mockReset();
  }
});
