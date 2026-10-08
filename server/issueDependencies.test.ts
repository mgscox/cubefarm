import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from './exec.ts';
import { dependenciesUnsupported, listIssues, unsupportedFields } from './github.ts';

type Query = NonNullable<Parameters<typeof listIssues>[1]>;
type Api = NonNullable<Parameters<typeof listIssues>[2]>;
const raw = (number: number) => ({ number, title: 'Issue', body: 'Depends on #1', url: '', labels: [{ name: 'swarm:server' }], createdAt: '' });
const blocker = (state: 'OPEN' | 'CLOSED' = 'OPEN', repo = 'demo/repo') => ({ number: 1, state, repository: { nameWithOwner: repo } });
const connection = (nodes = [blocker()], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const result = (blockedBy = connection()) => ({ data: { repository: { i2: { blockedBy, subIssuesSummary: { total: 0, completed: 0 } } } } });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
      [...args[3].matchAll(/i(\d+): issue/g)].map((m) => [`i${m[1]}`, { blockedBy: connection([]), subIssuesSummary: { total: 0, completed: 0 } }]),
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

  it.each(['old-host', 'restricted-token', 'partial-data'])('uses explicit support evidence on %s API failure', async (repo) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn<Query>().mockResolvedValue([raw(2)]);
    const diagnostic = repo === 'old-host' ? "GraphQL: Field 'blockedBy' doesn't exist on type 'Issue'"
      : 'GraphQL: Resource not accessible by personal access token (repository.i2.blockedBy)';
    const api = vi.fn<Api>().mockRejectedValue(new CommandError(diagnostic, diagnostic, 1));
    if (repo === 'partial-data') api.mockResolvedValue({ ...result(), errors: [{ message: 'Denied' }] });
    for (let sync = 0; sync < 2; sync++) {
      expect((await listIssues(`demo/${repo}`, query, api))[0].nativeBlockers).toBe(repo === 'partial-data' ? null : undefined);
    }
    expect(warn).toHaveBeenCalledOnce();
    api.mockResolvedValue(result(connection([])));
    expect((await listIssues(`demo/${repo}`, query, api))[0].nativeBlockers).toEqual([]);
  });

  it('discards partial native data when a later page fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = vi.fn<Api>().mockResolvedValueOnce(result(connection([blocker()], true, 'next'))).mockRejectedValueOnce(new CommandError('Denied', 'GraphQL: Resource not accessible by personal access token (repository.i2.blockedBy)', 1));
    expect((await listIssues('demo/page-failure', vi.fn<Query>().mockResolvedValue([raw(2)]), api))[0].nativeBlockers).toBeNull();
  });
});

const error = (stderr: string) => new CommandError(stderr, stderr, 1);

describe('native dependency refresh', () => {
  const issue = { number: 2, title: 'Implement', body: '', url: '', labels: [], createdAt: '' };
  const connection = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
  const blocked = { number: 1, state: 'OPEN', repository: { nameWithOwner: 'demo/deps' } };
  const query = () => vi.fn<NonNullable<Parameters<typeof listIssues>[1]>>().mockResolvedValue([issue]);

  it('retains the earlier blockers after an outage and leaves new issues unread', async () => {
    const q = query();
    const api = vi.fn<Api>().mockResolvedValueOnce({ data: { repository: { i2: { blockedBy: connection([blocked]), subIssuesSummary: { total: 0, completed: 0 } } } } }).mockRejectedValue(new Error('rate limit'));
    const first = await listIssues('demo/deps', q, api);
    q.mockResolvedValue([issue, { ...issue, number: 3 }]);
    const next = await listIssues('demo/deps', q, api);
    expect(next[0].nativeBlockers).toEqual(first[0].nativeBlockers);
    expect(next[1].nativeBlockers).toBeNull();
  });

  it('fails closed on a first transient failure', async () => {
    expect((await listIssues('demo/deps', query(), vi.fn<Api>().mockRejectedValue(new Error('network'))))[0].nativeBlockers).toBeNull();
  });

  it('falls back only for hosts/tokens with explicit unsupported errors before any success', async () => {
    const api = vi.fn<Api>().mockRejectedValue(error("GraphQL: Field 'blockedBy' doesn't exist on type 'Issue'"));
    expect((await listIssues('demo/deps', query(), api))[0].nativeBlockers).toBeUndefined();
    api.mockRejectedValue(new Error('network'));
    expect((await listIssues('demo/deps', query(), api))[0].nativeBlockers).toBeUndefined();
  });

  it('never downgrades a previously supported host after an access denial', async () => {
    const api = vi.fn<Api>().mockResolvedValueOnce({ data: { repository: { i2: { blockedBy: connection([blocked]), subIssuesSummary: { total: 0, completed: 0 } } } } })
      .mockRejectedValue(error('GraphQL: Resource not accessible by personal access token (repository.i2.blockedBy)'));
    await listIssues('demo/deps', query(), api);
    expect((await listIssues('demo/deps', query(), api))[0].nativeBlockers).toEqual([{ number: 1, state: 'OPEN' }]);
  });

  it.each(['partial', 'pagination', 'errors'])('does not replace cached blockers with a %s response', async (kind) => {
    const api = vi.fn<Api>().mockResolvedValueOnce({ data: { repository: { i2: { blockedBy: connection([blocked]), subIssuesSummary: { total: 0, completed: 0 } } } } });
    await listIssues('demo/deps', query(), api);
    api.mockResolvedValue(kind === 'partial' ? { data: { repository: {} } } : kind === 'errors' ? { errors: [{ message: 'rate limit' }] }
      : { data: { repository: { i2: { blockedBy: connection([], true), subIssuesSummary: { total: 0, completed: 0 } } } } });
    expect((await listIssues('demo/deps', query(), api))[0].nativeBlockers).toEqual([{ number: 1, state: 'OPEN' }]);
  });

  it('fails closed when a partial response proves support despite an access error', async () => {
    const api = vi.fn<Api>().mockResolvedValue({ data: { repository: { i2: { blockedBy: connection([]), subIssuesSummary: { total: 0, completed: 0 } } } },
      errors: [{ message: 'Resource not accessible by personal access token (repository.i3.blockedBy)' }],
    });
    const issues = await listIssues('demo/deps', vi.fn<Query>().mockResolvedValue([issue, { ...issue, number: 3 }]), api);
    expect(issues.map((i) => i.nativeBlockers)).toEqual([null, null]);
  });

  it('names each unsupported native field, including mixes, and keeps partial denials closed', () => {
    const missing = (field: string) => ({ message: `Field '${field}' doesn't exist on type 'Issue'` });
    expect(unsupportedFields([missing('blockedBy'), missing('subIssuesSummary'), missing('comments')])).toEqual(new Set(['blockedBy', 'subIssuesSummary', 'comments']));
    expect(unsupportedFields(error("gh: GraphQL: Field 'subIssuesSummary' doesn't exist on type 'Issue', Field 'blockedBy' doesn't exist on type 'Issue'\n"))).toEqual(new Set(['subIssuesSummary', 'blockedBy']));
    expect(unsupportedFields([{ message: 'Resource not accessible by integration', path: ['repository', 'i2', 'subIssuesSummary'] }])).toEqual(new Set(['subIssuesSummary']));
    expect(unsupportedFields([missing('title')])).toBeNull();
    expect(unsupportedFields([missing('subIssuesSummary'), { message: 'rate limit' }])).toBeNull();
    const denied = 'Resource not accessible by personal access token (repository.i3.subIssuesSummary)';
    const partial = JSON.stringify({ data: { repository: { i2: { subIssuesSummary: { total: 1, completed: 0 } } } }, errors: [{ message: denied }] });
    expect(unsupportedFields(new CommandError(denied, denied, 1, partial))).toBeNull();
  });

  it('reads sub-issues without blockers, and blockers without sub-issues, on hosts lacking one of them', async () => {
    const answer = (args: string[]) => args[3].includes('subIssuesSummary') && args[3].includes('blockedBy')
      ? Promise.reject(error(`GraphQL: Field '${args[7] === 'name=a' ? 'blockedBy' : 'subIssuesSummary'}' doesn't exist on type 'Issue'`))
      : Promise.resolve({ data: { repository: { i2: args[3].includes('blockedBy') ? { blockedBy: connection([blocker('OPEN', 'demo/b')]) } : { subIssuesSummary: { total: 3, completed: 1 } } } } });
    const api = vi.fn<Api>(answer);
    const [a] = await listIssues('demo/a', query(), api);
    expect([a.nativeBlockers, a.subIssues]).toEqual([undefined, { total: 3, completed: 1 }]);
    const [b] = await listIssues('demo/b', query(), api);
    expect([b.nativeBlockers, b.subIssues]).toEqual([[{ number: 1, state: 'OPEN' }], undefined]);
  });

  it('logs persistent failures again after ten minutes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = vi.fn<Api>().mockRejectedValue(new Error('network'));
    await listIssues('demo/deps', query(), api);
    await listIssues('demo/deps', query(), api);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000);
    await listIssues('demo/deps', query(), api);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it.each(['\n', '\r\n'])('normalizes %j diagnostics without dropping substantive failures', (ending) => {
    const unsupported = "gh: GraphQL: Field 'blockedBy' doesn't exist on type 'Issue'";
    const denied = 'gh: GraphQL: Resource not accessible by personal access token (repository.i2.blockedBy)';
    for (const diagnostic of [unsupported, denied]) {
      expect(dependenciesUnsupported(error(`  ${diagnostic}${ending}  ${ending}`))).toBe(true);
      expect(dependenciesUnsupported(error(`${diagnostic}${ending}${ending}network unavailable${ending}`))).toBe(false);
    }
    expect(dependenciesUnsupported(error(ending))).toBe(false);
  });

  it('does not classify mixed access and outage errors as unsupported', () => {
    expect(dependenciesUnsupported([{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }, { message: 'rate limit' }])).toBe(false);
  });

  it('checks failed-command JSON errors before allowing unsupported fallback', () => {
    const denied = 'Resource not accessible by personal access token (repository.i2.blockedBy)';
    const stderr = `gh: GraphQL: ${denied}\n`;
    const failed = (stdout: string) => new CommandError(stderr, stderr, 1, stdout);
    expect(dependenciesUnsupported(failed(JSON.stringify({ errors: [{ message: denied }] })))).toBe(true);
    expect(dependenciesUnsupported(failed(JSON.stringify({ errors: [{ message: 'Resource not accessible by personal access token', path: ['repository', 'i2', 'blockedBy'] }] })))).toBe(true);
    expect(dependenciesUnsupported(failed(JSON.stringify({ errors: [{ message: 'Resource not accessible by personal access token', path: ['repository', 'i2', 'title'] }] })))).toBe(false);
    expect(dependenciesUnsupported(failed(JSON.stringify({ errors: [{ message: denied }, { message: 'network unavailable' }] })))).toBe(false);
    expect(dependenciesUnsupported(failed('{incomplete'))).toBe(false);
  });
});
