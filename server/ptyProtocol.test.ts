import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ALLOW, encode, hostSocket, keeperBuild, keeperStale, localHookAnswer, readMessages, type ToHost } from './ptyProtocol.ts';

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

describe('keeperBuild', () => {
  it("hashes the bundled keeper alone, or in development the keeper's two files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-build-'));
    fs.writeFileSync(path.join(dir, 'ptyHost.js'), 'keeper v1');
    const v1 = keeperBuild(dir, '.js');
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(keeperBuild(dir, '.js')).toBe(v1);
    fs.writeFileSync(path.join(dir, 'ptyHost.js'), 'keeper v2');
    expect(keeperBuild(dir, '.js')).not.toBe(v1);
    expect(keeperBuild(dir, '.ts')).toBeNull(); // no ptyHost.ts here
    expect(keeperBuild(import.meta.dirname, '.ts')).toMatch(/^[0-9a-f]{16}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('keeperStale', () => {
  it('says a keeper runs older code when its build differs from the one on disk, or it never said', () => {
    expect(keeperStale('aaaa', 'aaaa')).toBe(false);
    expect(keeperStale('aaaa', 'bbbb')).toBe(true);
    expect(keeperStale(undefined, 'bbbb')).toBe(true); // a keeper from before builds were reported ran the box's methods too
    expect(keeperStale(null, 'bbbb')).toBe(true);
  });

  it("doesn't restart a keeper over a build it can't read on disk", () => {
    expect(keeperStale('aaaa', null)).toBe(false);
    expect(keeperStale(undefined, null)).toBe(false);
  });
});
