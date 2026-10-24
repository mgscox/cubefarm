import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBox } from './boxLink.ts';
import { encode, PTY_PROTOCOL, type ToHost } from './ptyProtocol.ts';
import { withOperation } from './operation.ts';
import type { BoxConnection } from './machine.ts';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('./machineHealth.ts', () => ({ monitorResources: () => () => {} }));

describe('remote desk cancellation', () => {
  let box: BoxConnection;
  let sent: ToHost[];
  let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
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
    child.stdout.write(encode({ op: 'ready', version: PTY_PROTOCOL, hookPort: 0, ptys: [] }));
    await box.reconnected;
  });

  afterEach(() => {
    box.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
});
