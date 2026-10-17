import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planCli, type CliHost } from './machine.ts';
import { handleHook, startCliSession } from './cliRunner.ts';
import type { ClaudeTurn } from './clis.ts';
import type { SessionCallbacks, SessionOptions } from './agentRunner.ts';
import type { AgentTerminal } from './terminal.ts';

const opts: SessionOptions = {
  cwd: 'desk', prompt: 'Fix #12', systemAppend: 'Be brief', model: 'opus', effort: 'high',
  browserTesting: true, additionalDirectories: ['ref'], role: 'dev',
};
const ids = { cli: 'claude' as const, token: 't1', sessionId: 's1', officeUrl: 'http://127.0.0.1:4317' };

describe('planCli', () => {
  it('carries the session as the CLI needs it', () => {
    expect(planCli({ ...opts, resumeSessionId: 'r1', label: 'Ada · #12' }, ids)).toEqual({
      ...ids, resumeId: 'r1', cwd: 'desk', prompt: 'Fix #12', systemAppend: 'Be brief', model: 'opus', effort: 'high',
      name: 'Ada · #12', role: 'dev', additionalDirectories: ['ref'], browserTesting: true, officeTools: false,
    });
  });

  it('names an unlabelled session cubefarm', () => {
    expect(planCli(opts, ids).name).toBe('cubefarm');
  });

  it('asks for the structured report in the prompt', () => {
    const plan = planCli({ ...opts, outputSchema: { type: 'object' } }, ids);
    expect(plan.prompt.startsWith('Fix #12\n\n')).toBe(true);
    expect(plan.prompt).toContain('{"type":"object"}');
  });

  it('gives the CEO the office tools', () => {
    expect(planCli({ ...opts, office: {} as SessionOptions['office'] }, ids).officeTools).toBe(true);
  });
});

describe('startCliSession on a host', () => {
  const callbacks = (): SessionCallbacks => ({
    log: vi.fn(), tool: vi.fn(), sessionId: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), finished: vi.fn(),
  });
  const terminal = () => ({ cols: 100, rows: 30, note: vi.fn(), bind: vi.fn(), screen: () => '' }) as unknown as AgentTerminal;
  const pty = { pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setMeta: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
  const host = (prepare: CliHost['prepare']): CliHost => ({
    prepare, hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null, codexThread: async () => undefined,
    removeDir: vi.fn(), reconnect: async () => [], adopt: () => pty, discard: vi.fn(), hooksReady: vi.fn(), leave: vi.fn(),
    protect: () => ({ pids: [], markers: [] }),
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('starts the planned CLI in a terminal of its size, on that host', () => {
    const start = vi.fn(() => pty);
    const prepare = vi.fn(() => ({ dir: 'sessions/t', prompt: 'Fix #12', start }));
    const session = startCliSession({ ...opts, cli: 'codex', terminal: terminal() }, callbacks(), host(prepare));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ cli: 'codex', cwd: 'desk', prompt: 'Fix #12' }));
    expect(start).toHaveBeenCalledWith({ cols: 100, rows: 30 }, expect.objectContaining({ cli: 'codex', dir: 'sessions/t', busy: true }));
    session.stop();
  });

  it("ends the session with the host's reason when the CLI can't be prepared", () => {
    const cb = callbacks();
    startCliSession({ ...opts, terminal: terminal() }, cb, host(() => {
      throw new Error("Could not start Codex: Codex isn't installed (no \"codex\" on PATH).");
    }));
    vi.runOnlyPendingTimers();
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errors: ["Could not start Codex: Codex isn't installed (no \"codex\" on PATH)."] }));
  });

  // ---------- a Claude CLI whose hooks never reach the office ----------

  const claude = (screen: () => string, claudeTurn: CliHost['claudeTurn']) => {
    const cb = callbacks();
    cb.boot = vi.fn();
    cb.turn = vi.fn();
    let token = '';
    const prepare = vi.fn((plan: { token: string }) => {
      token = plan.token;
      return { dir: 'sessions/t', prompt: 'Fix #12', hookUrl: 'http://127.0.0.1:41234/api/hooks', start: () => pty };
    });
    const term = { ...terminal(), screen } as unknown as AgentTerminal;
    const session = startCliSession({ ...opts, terminal: term }, cb, { ...host(prepare as CliHost['prepare']), claudeTurn });
    return { cb, session, hook: (body: Record<string, unknown>) => handleHook(token, body) };
  };
  const errors = (cb: SessionCallbacks) => vi.mocked(cb.log).mock.calls.flat(2).filter((e) => e.kind === 'error').map((e) => e.text);
  const turn = (t: Partial<ClaudeTurn>): ClaudeTurn => ({ bytes: 100, ended: false, mark: '', text: '', ...t });

  it('says a CLI working with no hooks is out of reach, and ends its session when its transcript ends the turn', async () => {
    let now: ClaudeTurn | null = null;
    const { cb } = claude(() => '✻ Pondering… (12s · esc to interrupt)', async () => now);
    now = turn({ bytes: 2000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors(cb)).toEqual([expect.stringMatching(/is working but the office isn't receiving its hooks.*http:\/\/127\.0\.0\.1:41234\/api\/hooks/)]);
    expect(cb.boot).toHaveBeenLastCalledWith('no-hooks');
    expect(cb.finished).not.toHaveBeenCalled();

    now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'Opened https://github.com/o/r/pull/7' });
    await vi.advanceTimersByTimeAsync(5000 + 3000);
    expect(cb.turn).toHaveBeenCalledWith('Opened https://github.com/o/r/pull/7');
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Opened https://github.com/o/r/pull/7', errors: [] }));
    expect(cb.boot).toHaveBeenLastCalledWith(null);
  });

  it('says a CLI idle at startup with no hooks has not started, and keeps waiting', async () => {
    const { cb, session } = claude(() => 'Do you trust the files in this folder?\n❯ 1. Yes, proceed', async () => null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors(cb)).toEqual([expect.stringMatching(/hasn't started on the task yet/)]);
    expect(cb.boot).toHaveBeenLastCalledWith('waiting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors(cb)).toHaveLength(1);
    expect(cb.finished).not.toHaveBeenCalled();
    session.stop();
    expect(cb.boot).toHaveBeenLastCalledWith(null);
  });

  it('leaves a CLI whose hooks arrive alone, and finishes it on Stop as before', async () => {
    const claudeTurn = vi.fn(async () => null);
    const { cb, hook } = claude(() => '✻ Pondering… (esc to interrupt)', claudeTurn);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix #12' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(errors(cb)).toEqual([]);
    expect(cb.boot).not.toHaveBeenCalled();
    expect(claudeTurn).not.toHaveBeenCalled();
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Done' }));
  });

  it('hands back to the hooks when they start arriving', async () => {
    const { cb, hook } = claude(() => 'esc to interrupt', async () => turn({ bytes: 500 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb.boot).toHaveBeenLastCalledWith('no-hooks');
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(cb.boot).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(cb.log).mock.calls.flat(2).some((e) => /receiving Claude Code's hooks now/.test(e.text))).toBe(true);
  });
});
