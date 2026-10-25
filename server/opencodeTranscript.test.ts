import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { opencodeTurn } from './opencodeTranscript.ts';
import { recoverCliTurn } from './cliTranscript.ts';
import { createBoxOps } from './boxOps.ts';
import { run } from './exec.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn(), git: async () => '' }));
vi.mock('./clis.ts', async (original) => ({ ...await original<typeof import('./clis.ts')>(), commandFor: () => ({ file: 'fake-opencode', args: [] }) }));
afterEach(() => vi.resetAllMocks());
const cwd = path.resolve('box desk with spaces');
const since = 1_000_000;
const report = '{"verdict":"pass"}';
const transcript = () => ({
  info: { id: 'ses_main', location: { directory: cwd } },
  messages: [
    { id: 'msg_old', type: 'assistant', content: [{ type: 'text', text: 'Earlier turn' }] },
    { id: 'msg_user', type: 'user' },
    { id: 'msg_tool', type: 'assistant', content: [{ type: 'tool', text: 'never a report' }] },
    { id: 'msg_reply', type: 'assistant', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: report }] },
    { id: 'msg_done', type: 'idle', outcome: 'succeeded', time: { created: since + 5000 } },
  ],
});

describe('OpenCode export recovery', () => {
  it('returns only the final assistant text after a durable idle success', () => {
    expect(opencodeTurn(transcript(), cwd, since, 'ses_main')).toMatchObject({ sessionId: 'ses_main', ended: true, mark: 'msg_done', text: report, completedAt: since + 5000 });
  });

  it('rejects old, failed, interrupted, unfinished, foreign, child and subsequent turns', () => {
    const data = transcript();
    expect(opencodeTurn(data, cwd, since + 6000, 'ses_main')).toBeNull();
    expect(opencodeTurn(data, cwd, 0, 'ses_main')).toBeNull();
    expect(opencodeTurn(data, path.resolve('other desk'), since, 'ses_main')).toBeNull();
    expect(opencodeTurn(data, cwd, since, 'another')).toBeNull();
    expect(opencodeTurn({ ...data, info: { ...data.info, parentID: 'parent' } }, cwd, since, 'ses_main')).toBeNull();
    for (const outcome of ['failed', 'interrupted']) {
      expect(opencodeTurn({ ...data, messages: [...data.messages.slice(0, -1), { ...data.messages.at(-1), outcome }] }, cwd, since, 'ses_main')).toBeNull();
    }
    expect(opencodeTurn({ ...data, messages: [data.messages[0], data.messages[1], data.messages.at(-1)] }, cwd, since, 'ses_main')).toBeNull();
    expect(opencodeTurn({ ...data, messages: data.messages.slice(0, -1) }, cwd, since, 'ses_main')).toBeNull();
    expect(opencodeTurn({ ...data, messages: [...data.messages, { id: 'new', type: 'user' }] }, cwd, since, 'ses_main')).toBeNull();
  });

  it.each([null, 'ses_main'])('recovers through the box RPC with sessionId=%s', async (id) => {
    vi.mocked(run).mockImplementation(async (_cmd, args) => args.includes('list') ? JSON.stringify([
      { id: 'ses_main', directory: cwd, created: since + 100 },
      { id: 'old', directory: cwd, created: since - 5000 },
      { id: 'foreign', directory: path.resolve('other'), created: since + 100 },
    ]) : JSON.stringify(transcript()));
    const box = createBoxOps({ hookUrl: () => 'http://box-keeper', pids: () => [], root: cwd });
    expect(await box.rpc('recoverTurn', [cwd, 'opencode', id, since])).toMatchObject({ sessionId: 'ses_main', text: report, ended: true });
    expect(run).toHaveBeenCalledWith('fake-opencode', ['session', 'export', 'ses_main', '--standalone'], expect.objectContaining({ cwd, timeoutMs: 20_000, env: expect.objectContaining({ CUBEFARM_NOTIFY_URL: '' }) }));
  });

  it('never guesses an unreported ID when discovery is ambiguous, missing or broken', async () => {
    vi.mocked(run).mockResolvedValue(JSON.stringify([{ id: 'a', directory: cwd, created: since }, { id: 'b', directory: cwd, created: since }]));
    expect(await recoverCliTurn(cwd, 'opencode', null, since)).toBeNull();
    vi.mocked(run).mockResolvedValue('[]');
    expect(await recoverCliTurn(cwd, 'opencode', null, since)).toBeNull();
    vi.mocked(run).mockRejectedValue(new Error('unreadable'));
    expect(await recoverCliTurn(cwd, 'opencode', 'known', since)).toBeNull();
  });
});
