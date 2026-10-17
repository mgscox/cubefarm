import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ALLOW, encode, hostSocket, localHookAnswer, readMessages, type ToHost } from './ptyProtocol.ts';

describe('hostSocket', () => {
  it('names one named pipe per office home on Windows, whatever the path looks like', () => {
    const a = hostSocket('C:\\Users\\Ada\\.cubefarm', 'win32');
    expect(a).toMatch(/^\\\\\.\\pipe\\cubefarm-pty-[0-9a-f]{12}$/);
    expect(hostSocket('c:\\users\\ada\\.cubefarm', 'win32')).toBe(a);
    expect(hostSocket('C:\\Users\\Ada\\other-home', 'win32')).not.toBe(a);
  });

  it('puts the socket in the office home elsewhere', () => {
    expect(hostSocket('/home/ada/.cubefarm', 'linux')).toBe(path.join('/home/ada/.cubefarm', 'pty.sock'));
  });
});

describe('readMessages', () => {
  it('reads one message per line, across chunks, skipping lines that are not JSON', () => {
    const sock = Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as Socket;
    const got: ToHost[] = [];
    readMessages<ToHost>(sock, (m) => got.push(m));
    const a = encode({ op: 'write', id: 'x', data: 'line one\nline two' });
    sock.emit('data', a.slice(0, 10));
    sock.emit('data', `${a.slice(10)}not json\n${encode({ op: 'kill', id: 'x' })}`);
    expect(got).toEqual([
      { op: 'write', id: 'x', data: 'line one\nline two' },
      { op: 'kill', id: 'x' },
    ]);
  });
});

describe('localHookAnswer', () => {
  it("answers on the box what never depends on the office: tool calls are allowed, the status line is the last one the office gave", () => {
    expect(localHookAnswer({ hook_event_name: 'PreToolUse' }, undefined)).toBe(ALLOW);
    expect(localHookAnswer({ hook_event_name: 'StatusLine' }, '🏢 cubefarm · Ada')).toEqual({ statusLine: '🏢 cubefarm · Ada' });
    expect(localHookAnswer({ hook_event_name: 'Stop' }, undefined)).toEqual({});
    expect(localHookAnswer({ hook_event_name: 'TurnComplete' }, undefined)).toEqual({});
  });

  it('leaves a prompt the manager typed to the office, which decides whether it becomes a follow-up', () => {
    expect(localHookAnswer({ hook_event_name: 'UserPromptSubmit', prompt: 'carry on' }, undefined)).toBeUndefined();
  });
});
