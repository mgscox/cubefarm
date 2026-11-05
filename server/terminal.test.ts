import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { AgentTerminal } from './terminal.ts';

describe('AgentTerminal', () => {
  it('counts CLI output, but not office notes, as activity', () => {
    const t = new AgentTerminal();
    t.note('Starting a session');
    expect(t.lastOutputAt).toBe(0);
    t.write('Working');
    const outputAt = t.lastOutputAt;
    expect(outputAt).toBeGreaterThan(0);
    t.note('The office nudged this session');
    expect(t.lastOutputAt).toBe(outputAt);
    t.dispose();
  });

  it('keeps what was printed, so a late viewer sees the same screen', async () => {
    const t = new AgentTerminal();
    t.write('\x1b[32mhello\x1b[0m world\r\n');
    await t.flush();
    expect(t.screen()).toContain('hello world');
    const again = new AgentTerminal();
    again.write(t.snapshot());
    await again.flush();
    expect(again.screen()).toContain('hello world');
    t.dispose();
    again.dispose();
  });

  it('sends keystrokes and sizes to the running CLI, within sane bounds', () => {
    const t = new AgentTerminal();
    const got: string[] = [];
    t.bind({ write: (d) => got.push(d), resize: (c, r) => got.push(`${c}x${r}`) });
    expect(got).toEqual([`${t.cols}x${t.rows}`]);
    t.resize(5000, 1);
    expect([t.cols, t.rows]).toEqual([400, 5]);
    expect(got.at(-1)).toBe('400x5');
    t.bind(null);
    expect(t.live).toBe(false);
    t.dispose();
  });

  it('preserves the dimensions and right edge of an archived full-screen terminal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm-terminal-test-'));
    const file = path.join(directory, 'screen.ansi');
    const original = new AgentTerminal();
    const restored = new AgentTerminal();
    try {
      original.resize(160, 40);
      original.write('\x1b[?1049h\x1b[2;145HRIGHT-EDGE');
      await original.save(file);
      await restored.load(file);
      expect([restored.cols, restored.rows]).toEqual([160, 40]);
      const viewer = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {}, close: () => {} });
      restored.attach(viewer as unknown as WebSocket);
      await restored.flush();
      viewer.emit('message', JSON.stringify({ t: 'resize', cols: 40, rows: 12 }));
      expect([restored.cols, restored.rows]).toEqual([160, 40]);
      expect(restored.screen()).toContain('RIGHT-EDGE');
      await fs.writeFile(file, '\x1b[32mlegacy output\x1b[0m');
      const legacy = new AgentTerminal();
      try {
        await legacy.load(file);
        await legacy.flush();
        expect(legacy.screen()).toContain('legacy output');
      } finally {
        legacy.dispose();
      }
    } finally {
      original.dispose();
      restored.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('checks admission before forwarding any keystrokes to an idle CLI', () => {
    const terminal = new AgentTerminal();
    const keys: string[] = [];
    const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {}, close: () => {} });
    terminal.bind({ write: (data) => keys.push(data), resize: () => {} });
    terminal.attach(ws as unknown as WebSocket);
    terminal.allowInput = () => false;
    ws.emit('message', JSON.stringify({ t: 'input', data: 'start another job\r' }));
    expect(keys).toEqual([]);
    terminal.allowInput = () => true;
    ws.emit('message', JSON.stringify({ t: 'input', data: 'feedback\r' }));
    expect(keys).toEqual(['feedback\r']);
    terminal.dispose();
  });

});
