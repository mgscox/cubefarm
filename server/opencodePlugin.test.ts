import vm from 'node:vm';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_PLUGIN_SOURCE } from './clis.ts';

function plugin() {
  const post = vi.fn(async (_url: string, _opts: RequestInit) => ({ ok: true, status: 200 }));
  const error = vi.fn();
  const appendFileSync = vi.fn();
  const value = vm.runInNewContext(OPENCODE_PLUGIN_SOURCE.replace(/^import .*;\n/gm, '').replace('export default', 'plugin ='), {
    process: { env: { CUBEFARM_NOTIFY_URL: 'http://box-keeper/api/hooks/token' } }, fetch: post,
    fs: { mkdirSync: vi.fn(), appendFileSync }, os: { homedir: () => 'fake home' }, path,
    AbortSignal, AbortController, setTimeout, clearTimeout, console: { error },
  });
  return { value, post, error, appendFileSync };
}
const report = '{"verdict":"pass","summary":"Tested"}';
const context = (events: unknown[]) => ({
  location: { directory: 'box desk' },
  event: { subscribe: async function* () { yield* events; } },
  session: {
    get: vi.fn(async (_input: { sessionID: string }) => ({ id: 'ses_main', location: { directory: 'box desk' } })),
    context: vi.fn(async () => [{ id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: report }] }]),
  },
});
const created = { type: 'session.created', data: { sessionID: 'ses_main', location: { directory: 'box desk' } } };
const ended = { id: 'evt_done', created: 1000, type: 'session.execution.succeeded', data: { sessionID: 'ses_main' } };

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('OpenCode v2 plugin', () => {
  it('loads with the v2 contract and reports the box session before its last reply', async () => {
    const { value, post } = plugin();
    expect(value).toMatchObject({ id: 'cubefarm', setup: expect.any(Function) });
    await value.setup(context([created, ended]));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls.map(([, opts]) => JSON.parse(opts.body as string))).toEqual([
      expect.objectContaining({ hook_event_name: 'SessionStart', session_id: 'ses_main' }),
      expect.objectContaining({ hook_event_name: 'TurnComplete', session_id: 'ses_main', last_assistant_message: report, turn_id: 'msg_done' }),
    ]);
  });

  it('retries rejected POSTs and HTTP failures with backoff, then logs exhaustion', async () => {
    vi.useFakeTimers();
    const { value, post, error, appendFileSync } = plugin();
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false, status: 503 });
    await value.setup(context([created]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(post).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    post.mockRejectedValue(new Error('offline'));
    await value.setup(context([created]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(post).toHaveBeenCalledTimes(7);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/cubefarm.*SessionStart.*offline/));
    expect(appendFileSync).toHaveBeenCalledWith(path.join('fake home', '.local', 'share', 'opencode', 'log', 'cubefarm.log'), expect.stringMatching(/SessionStart.*offline/));
  });

  it('bounds a stalled reply read, logs it and still sends the turn end', async () => {
    vi.useFakeTimers();
    const { value, post, error } = plugin();
    const ctx = context([created, ended]);
    ctx.session.context.mockImplementation(() => new Promise(() => {}));
    await value.setup(ctx);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('session read timed out'));
    expect(JSON.parse(post.mock.calls.at(-1)![1].body as string)).toMatchObject({ hook_event_name: 'TurnComplete', session_id: 'ses_main' });
  });

  it('discovers a missed creation and ignores child and foreign session endings', async () => {
    const { value, post } = plugin();
    const ctx = context([ended, { ...ended, data: { sessionID: 'child' } }, { ...ended, data: { sessionID: 'foreign' } }]);
    ctx.session.get.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID, ...(sessionID === 'child' ? { parentID: 'ses_main' } : {}),
      location: { directory: sessionID === 'foreign' ? 'another desk' : 'box desk' },
    }));
    await value.setup(ctx);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(ctx.session.context).toHaveBeenCalledTimes(1);
  });
});
