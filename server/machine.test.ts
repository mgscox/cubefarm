import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planCli, type CliHost } from './machine.ts';
import { handleHook, reconnectClis, startCliSession } from './cliRunner.ts';
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
    prepare, recoverTurn: () => null, hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null, codexThread: async () => undefined,
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

  const claudeCallbacks = () => ({ ...callbacks(), boot: vi.fn(), turn: vi.fn() });
  /** A Claude session in a new CLI; again(): a later session in the same terminal, on the same host (picking the CLI up if it waits). */
  const claude = (screen: () => string, claudeTurn: CliHost['claudeTurn'], more: Partial<SessionOptions> = {}) => {
    const cb = claudeCallbacks();
    let token = '';
    const prepare = vi.fn((plan: { token: string }) => {
      token = plan.token;
      return { dir: 'sessions/t', prompt: 'Fix #12', hookUrl: 'http://127.0.0.1:41234/api/hooks', start: () => pty };
    });
    const term = { ...terminal(), screen } as unknown as AgentTerminal;
    const h = { ...host(prepare as CliHost['prepare']), claudeTurn };
    const session = startCliSession({ ...opts, ...more, terminal: term }, cb, h);
    const again = (later: Partial<SessionOptions>) => {
      const cb = claudeCallbacks();
      return { cb, session: startCliSession({ ...opts, ...later, terminal: term }, cb, h) };
    };
    return { cb, session, again, term, hook: (body: Record<string, unknown>) => handleHook(token, body) };
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

  const replies = (cb: SessionCallbacks, text: string) => vi.mocked(cb.log).mock.calls.flat(2).filter((e) => e.text === `● ${text}`).length;

  it('handles a turn its transcript ended once, when its Stop hook arrives after all', async () => {
    let now: ClaudeTurn | null = turn({ bytes: 2000 });
    const { cb, hook } = claude(() => 'esc to interrupt', async () => now);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb.boot).toHaveBeenLastCalledWith('no-hooks');
    now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'Done' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(cb.turn).toHaveBeenCalledTimes(1);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cb.turn).toHaveBeenCalledTimes(1);
    expect(replies(cb, 'Done')).toBe(1);
    expect(cb.finished).toHaveBeenCalledTimes(1);
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Done', turns: 1 }));
  });

  for (const later of [{ reattach: true }, { typed: true }]) {
    it(`leaves a CLI whose hooks worked alone when it's picked up again (${Object.keys(later)[0]}), however long it goes quiet`, async () => {
      const claudeTurn = vi.fn(async () => turn({ bytes: 500 }));
      const first = claude(() => '● Bash(npm run test:e2e)\n✻ Running… (esc to interrupt)', claudeTurn, { keepAlive: true, resumeSessionId: 'sess-1' });
      first.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix #12' });
      first.hook({ hook_event_name: 'Stop', last_assistant_message: 'Opened the PR' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(first.cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      claudeTurn.mockClear();

      const { cb, session } = first.again({ ...later, keepAlive: true, resumeSessionId: 'sess-1', prompt: 'Address the review' });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(errors(cb)).toEqual([]);
      expect(cb.boot).not.toHaveBeenCalled();
      expect(claudeTurn).not.toHaveBeenCalled();
      expect(cb.finished).not.toHaveBeenCalled();
      first.hook({ hook_event_name: 'Stop', last_assistant_message: 'Fixed' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Fixed' }));
      session.stop();
    });
  }

  it('follows the transcript of a CLI picked up again whose hooks never reached the office, from the start', async () => {
    let now: ClaudeTurn | null = turn({ bytes: 2000 });
    const first = claude(() => 'esc to interrupt', async () => now, { keepAlive: true, resumeSessionId: 'sess-1' });
    await vi.advanceTimersByTimeAsync(60_000);
    now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'Opened the PR' });
    await vi.advanceTimersByTimeAsync(5000 + 3000);
    expect(first.cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Opened the PR' }));

    const { cb, session } = first.again({ typed: true, keepAlive: true, resumeSessionId: 'sess-1' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(cb.boot).toHaveBeenLastCalledWith('no-hooks');
    expect(cb.finished).not.toHaveBeenCalled(); // the earlier reply is not this follow-up's completion
    now = turn({ bytes: 12_000, ended: true, mark: 'msg_3', text: 'Fixed' });
    await vi.advanceTimersByTimeAsync(5000 + 3000);
    expect(cb.finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Fixed' }));
    session.stop();
  });

  for (const handledBeforeRestart of [false, true]) {
    it(`recovers a hookless completion across a keeper restart exactly once (already handled: ${handledBeforeRestart})`, async () => {
      let now = turn({ bytes: 2000, ended: true, mark: 'msg_1', text: 'Earlier reply' });
      const first = claude(() => 'esc to interrupt', async () => now, { keepAlive: true, resumeSessionId: 'sess-1', agentId: 'ada' });
      await vi.advanceTimersByTimeAsync(60_000);
      if (handledBeforeRestart) {
        now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'Opened the PR' });
        await vi.advanceTimersByTimeAsync(5000);
      }
      const meta = vi.mocked(pty.setMeta).mock.calls.at(-1)![0];
      vi.clearAllTimers(); // the old office is gone; the keeper and CLI keep running
      now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'Opened the PR' });
      const term = { ...terminal(), screen: () => '❯' } as unknown as AgentTerminal;
      const h = { ...host(vi.fn()), claudeTurn: async () => now, recoverTurn: async () => now, reconnect: async () => [{ id: 'held', pid: 7, exit: null, meta }] };
      expect(await reconnectClis(() => term, h)).toEqual([{ agentId: 'ada', cli: 'claude', resumeId: 'sess-1', busy: true }]);
      const cb = claudeCallbacks();
      startCliSession({ ...opts, terminal: term, reattach: true, keepAlive: true, resumeSessionId: 'sess-1' }, cb, h);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cb.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true, text: 'Opened the PR', turns: 1 }));
      expect(vi.mocked(first.cb.turn).mock.calls.length + cb.turn.mock.calls.length).toBe(1);
      expect(replies(first.cb, 'Opened the PR') + replies(cb, 'Opened the PR')).toBe(1);
      term.releaseIdle?.();
    });
  }

  for (const cli of ['claude', 'codex'] as const) for (const hookless of [false, true]) for (const resumeId of [null, 'sess-1']) {
    it(`collects ${cli} completed during downtime (hookless=${hookless}, resumeId=${resumeId}) through two restarts`, async () => {
      let meta: unknown = { agentId: 'ada', cli, token: 'restart-token', dir: 'sessions/t', busy: true, hookless, resumeId };
      const result = turn({ bytes: 9000, ended: true, mark: 'reply-1', text: 'Opened https://github.com/o/r/pull/7' });
      const recoverTurn = vi.fn(async () => ({ ...result, sessionId: 'sess-1' }));
      const h = { ...host(vi.fn()), claudeTurn: async (_cwd: string, id: string) => id === resumeId ? result : null, recoverTurn,
        reconnect: async () => [{ id: 'held', pid: 7, exit: null, meta }],
        adopt: () => ({ ...pty, setMeta: (next: unknown) => { meta = next; } }),
      };
      let term1 = terminal();
      await reconnectClis(() => term1, h);
      vi.clearAllTimers(); // restart again before the swarm has attached the session
      term1 = terminal();
      expect((await reconnectClis(() => term1, h))[0].busy).toBe(true);
      const cb1 = claudeCallbacks();
      startCliSession({ ...opts, cli, terminal: term1, reattach: true, keepAlive: true }, cb1, h);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb1.turn).toHaveBeenCalledExactlyOnceWith(result.text);
      expect(cb1.finished).not.toHaveBeenCalled();
      vi.clearAllTimers(); // restart during finish grace
      const term2 = terminal();
      expect((await reconnectClis(() => term2, h))[0].busy).toBe(true);
      const cb2 = claudeCallbacks();
      startCliSession({ ...opts, cli, terminal: term2, reattach: true, keepAlive: true }, cb2, h);
      await vi.advanceTimersByTimeAsync(8000);
      expect(cb2.turn).not.toHaveBeenCalled();
      expect(cb2.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true, text: result.text, turns: 1 }));
      expect(meta).toMatchObject({ busy: false, transcriptPending: false });
      const term3 = terminal();
      expect((await reconnectClis(() => term3, h))[0].busy).toBe(false);
      term3.releaseIdle?.();
      term2.releaseIdle?.();
    });
  }

  it('retains a hooked reply collected just before restart without delivering its queued Stop again', async () => {
    const first = claude(() => '❯', async () => null, { agentId: 'ada', keepAlive: true });
    first.hook({ hook_event_name: 'Stop', last_assistant_message: 'Done' });
    const meta = vi.mocked(pty.setMeta).mock.calls.at(-1)![0];
    vi.clearAllTimers();
    const term = terminal();
    const h = { ...host(vi.fn()), reconnect: async () => [{ id: 'held', pid: 7, exit: null, meta }] };
    await reconnectClis(() => term, h);
    const cb = claudeCallbacks();
    startCliSession({ ...opts, terminal: term, reattach: true, keepAlive: true }, cb, h);
    handleHook((meta as { token: string }).token, { hook_event_name: 'Stop', last_assistant_message: 'Done' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(cb.turn).not.toHaveBeenCalled();
    expect(first.cb.turn).toHaveBeenCalledTimes(1);
    expect(cb.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true, text: 'Done', turns: 1 }));
    term.releaseIdle?.();
  });

  it('ends visibly when a restarted idle CLI has no readable result', async () => {
    const meta = { agentId: 'ada', cli: 'codex', token: 'lost', dir: 'sessions/t', busy: true, resumeId: null };
    const term = { ...terminal(), screen: () => 'Worked for 45m 38s\n› Ask anything' } as unknown as AgentTerminal;
    const h = { ...host(vi.fn()), recoverTurn: async () => null, reconnect: async () => [{ id: 'held', pid: 7, exit: null, meta }] };
    await reconnectClis(() => term, h);
    const cb = claudeCallbacks();
    startCliSession({ ...opts, cli: 'codex', terminal: term, reattach: true }, cb, h);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cb.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: false, errors: [expect.stringMatching(/finished while the office restarted; result not collected/)] }));
  });

  it('cancels hookless completion when a prompt starts inside the finish grace period', async () => {
    let now = turn({ bytes: 2000 });
    const { cb } = claude(() => 'esc to interrupt', async () => now);
    await vi.advanceTimersByTimeAsync(60_000);
    now = turn({ bytes: 9000, ended: true, mark: 'msg_2', text: 'First reply' });
    await vi.advanceTimersByTimeAsync(6000); // the end was observed at 65 s, next prompt at 66 s
    now = turn({ bytes: 10_000, mark: 'msg_2' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(cb.finished).not.toHaveBeenCalled();
    now = turn({ bytes: 12_000, ended: true, mark: 'msg_3', text: 'Follow-up reply' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cb.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true, text: 'Follow-up reply', turns: 2 }));
  });

  it('recognizes terminal interruption after confirmed hookless activity', async () => {
    let screen = 'esc to interrupt';
    const { cb, term } = claude(() => screen, async () => turn({ bytes: 2000 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb.boot).toHaveBeenLastCalledWith('no-hooks');
    term.onInput?.('\x1b');
    screen = 'Interrupted · What should Claude do instead?';
    await vi.advanceTimersByTimeAsync(800);
    expect(cb.finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: false, interrupted: true, errors: ['Interrupted in the terminal'] }));
  });
});
