import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { AgentTerminal } from './terminal.ts';

describe('AgentTerminal', () => {
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
