import { afterEach, describe, expect, it, vi } from 'vitest';
import { listIssues } from './github.ts';

type Query = NonNullable<Parameters<typeof listIssues>[1]>;
type Api = NonNullable<Parameters<typeof listIssues>[2]>;
const raw = (number: number) => ({ number, title: 'Issue', body: 'Depends on #1', url: '', labels: [{ name: 'swarm:server' }], createdAt: '' });
const blocker = (state: 'OPEN' | 'CLOSED' = 'OPEN', repo = 'demo/repo') => ({ number: 1, state, repository: { nameWithOwner: repo } });
const connection = (nodes = [blocker()], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const result = (blockedBy = connection()) => ({ data: { repository: { i2: { blockedBy } } } });
afterEach(() => vi.restoreAllMocks());

describe('native dependency sync', () => {
  it('reads native blockers using an issues-only GraphQL query and refreshes their state on each sync', async () => {
    const query = vi.fn<Query>().mockResolvedValue([raw(2)]);
    const api = vi.fn<Api>().mockResolvedValueOnce(result()).mockResolvedValueOnce(result(connection([blocker('CLOSED')])));
    expect((await listIssues('demo/repo', query, api))[0]).toMatchObject({ labels: ['swarm:server'], nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    expect((await listIssues('demo/repo', query, api))[0].nativeBlockers).toEqual([{ number: 1, state: 'CLOSED' }]);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[0][0]).toEqual(['api', 'graphql', '-f', expect.stringContaining('blockedBy(first:100)'), '-f', 'owner=demo', '-f', 'name=repo']);
    expect(api.mock.calls[0][0].join(' ')).not.toMatch(/checks|statusCheckRollup/i);
  });

  it('batches open issues and skips dependency queries for an empty backlog', async () => {
    const query = vi.fn<Query>().mockResolvedValue(Array.from({ length: 26 }, (_, i) => raw(i + 1)));
    const api = vi.fn<Api>(async (args) => ({ data: { repository: Object.fromEntries(
      [...args[3].matchAll(/i(\d+): issue/g)].map((m) => [`i${m[1]}`, { blockedBy: connection([]) }]),
    ) } }));
    expect(await listIssues('demo/repo', query, api)).toHaveLength(26);
    expect(api).toHaveBeenCalledTimes(2);
    expect([...api.mock.calls[0][0][3].matchAll(/i\d+: issue/g)]).toHaveLength(25);
    query.mockResolvedValue([]);
    await listIssues('demo/repo', query, api);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('paginates blockers and preserves cross-repository identity', async () => {
    const api = vi.fn<Api>().mockResolvedValueOnce(result(connection([blocker()], true, 'next')))
      .mockResolvedValueOnce(result(connection([blocker('OPEN', 'other/repo')])));
    const [issue] = await listIssues('demo/repo', vi.fn<Query>().mockResolvedValue([raw(2)]), api);
    expect(issue.nativeBlockers).toEqual([{ number: 1, state: 'OPEN' }, { number: 1, state: 'OPEN', repo: 'other/repo' }]);
    expect(api.mock.calls[1][0][3]).toContain('after:"next"');
  });

  it.each(['old-host', 'restricted-token', 'partial-data'])('falls back to body dependencies and logs once on %s API failure', async (repo) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn<Query>().mockResolvedValue([raw(2)]);
    const api = vi.fn<Api>().mockRejectedValue(new Error('Unavailable'));
    if (repo === 'partial-data') api.mockResolvedValueOnce({ ...result(), errors: [{ message: 'Denied' }] });
    for (let sync = 0; sync < 2; sync++) {
      expect(await listIssues(`demo/${repo}`, query, api)).toEqual([{ ...raw(2), labels: ['swarm:server'] }]);
    }
    expect(warn).toHaveBeenCalledOnce();
    // Retry on a later sync so a temporary API outage does not disable dependencies permanently.
    api.mockResolvedValue(result(connection([])));
    expect((await listIssues(`demo/${repo}`, query, api))[0].nativeBlockers).toEqual([]);
  });

  it('discards partial native data when a later page fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = vi.fn<Api>().mockResolvedValueOnce(result(connection([blocker()], true, 'next'))).mockRejectedValueOnce(new Error('Denied'));
    expect((await listIssues('demo/page-failure', vi.fn<Query>().mockResolvedValue([raw(2)]), api))[0].nativeBlockers).toBeUndefined();
  });
});
