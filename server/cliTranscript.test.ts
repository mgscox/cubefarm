import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexTurn, recoverCliTurn } from './cliTranscript.ts';
import { createBoxOps } from './boxOps.ts';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});
const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-recovery-'));
  homes.push(home);
  const codex = path.join(home, '.codex');
  vi.stubEnv('CODEX_HOME', codex);
  const cwd = path.join(home, 'desk with spaces');
  const since = Date.parse('2026-10-18T06:00:00Z');
  const save = (id: string, source: unknown = 'cli', dir = cwd, timestamp = '2026-10-18T06:01:00Z') => {
    const day = path.join(codex, 'sessions', '2026', '10', '18');
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, `rollout-2026-10-18T06-01-00-${id}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id, source, cwd: dir, timestamp, base_instructions: { text: 'x'.repeat(100_000) } } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: '{"verdict":"pass"}' } },
      { type: 'event_msg', timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(), payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '{"verdict":"pass"}' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return file;
  };
  return { home, cwd, since, save };
};

describe('restart transcript recovery', () => {
  it('distinguishes final Codex completion from commentary, tool work and a subsequent turn', () => {
    const event = (type: string, more = {}) => JSON.stringify({ type: 'event_msg', payload: { type, ...more } });
    const working = event('agent_message', { message: 'I will check' });
    expect(codexTurn(working, 10).ended).toBe(false);
    const done = working + '\n' + event('task_complete', { turn_id: 't1', last_agent_message: 'Done\n' });
    expect(codexTurn(done + '\n{"cut', 20)).toEqual({ bytes: 20, ended: true, mark: 't1', text: 'Done' });
    expect(codexTurn(done + '\n' + event('task_started'), 30).ended).toBe(false);
  });

  it.each([null, 'main'])('finds the main rollout with sessionId=%s, excluding old, foreign and subagent sessions', (id) => {
    const f = fixture();
    f.save('main');
    f.save('sub', { subagent: { thread_spawn: { parent_thread_id: 'main' } } });
    f.save('other-desk', 'cli', path.join(f.home, 'other'));
    f.save('old', 'cli', f.cwd, '2026-10-17T06:01:00Z');
    expect(recoverCliTurn(f.cwd, 'codex', id, f.since, f.home)).toMatchObject({ sessionId: 'main', ended: true, mark: 'turn-1', text: '{"verdict":"pass"}' });
  });

  it('rejects an old completion even with a known Codex ID, but accepts a new turn in that older conversation', () => {
    const f = fixture();
    const file = f.save('known', 'cli', f.cwd, '2026-10-17T06:00:00Z');
    expect(recoverCliTurn(f.cwd, 'codex', 'known', f.since, f.home)).toBeNull();
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: '2026-10-18T06:02:00Z', payload: { type: 'task_complete', turn_id: 'new', last_agent_message: 'Current task' } }) + '\n');
    expect(recoverCliTurn(f.cwd, 'codex', 'known', f.since, f.home)).toMatchObject({ mark: 'new', text: 'Current task' });
  });

  it('rejects a known Claude conversation whose last completion predates this task', () => {
    const f = fixture();
    const dir = path.join(f.home, '.claude', 'projects', path.resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'known.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-17T06:00:00Z', message: { id: 'old', content: [{ type: 'text', text: 'Previous task' }], stop_reason: 'end_turn' } }));
    expect(recoverCliTurn(f.cwd, 'claude', 'known', f.since, f.home)).toBeNull();
  });

  it('rejects known-ID completed evidence without a timestamp or a task start bound', () => {
    const f = fixture();
    const file = f.save('known');
    expect(recoverCliTurn(f.cwd, 'codex', 'known', 0, f.home)).toBeNull();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => { const e = JSON.parse(line); delete e.timestamp; return JSON.stringify(e); });
    fs.writeFileSync(file, lines.join('\n'));
    expect(recoverCliTurn(f.cwd, 'codex', 'known', f.since, f.home)).toBeNull();
  });

  it('refuses ambiguous discovery and never guesses without a start bound', () => {
    const f = fixture();
    f.save('main');
    f.save('another');
    expect(recoverCliTurn(f.cwd, 'codex', null, f.since, f.home)).toBeNull();
    expect(recoverCliTurn(f.cwd, 'codex', null, 0, f.home)).toBeNull();
  });

  it('reads rollout evidence through the box RPC on the owning machine', async () => {
    const f = fixture();
    f.save('box-main');
    const box = createBoxOps({ hookUrl: () => '', pids: () => [], root: f.home });
    expect(await box.rpc('recoverTurn', [f.cwd, 'codex', null, f.since])).toMatchObject({ sessionId: 'box-main', text: '{"verdict":"pass"}', ended: true });
  });

  it.each([null, 'claude-main'])('recovers Claude with sessionId=%s', (id) => {
    const f = fixture();
    const dir = path.join(f.home, '.claude', 'projects', path.resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude-main.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-18T06:02:00Z', message: { id: 'm1', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' } }));
    expect(recoverCliTurn(f.cwd, 'claude', id, f.since, f.home)).toMatchObject({ ended: true, mark: 'm1', text: 'Done' });
  });
});
