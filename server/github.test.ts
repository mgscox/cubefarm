import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from './exec.ts';
import { branchAhead, closeIssue, containsCommit, ensureLabel, findIssuesByMarker, isCheckAccessError, listPulls, prForBranch, readIssue, readTwice } from './github.ts';
import { applyRepoRefresh } from './repoRefresh.ts';
import { mergeStep } from './mergeGate.ts';

const denial = (node = 0) => `Resource not accessible by personal access token (repository.pullRequests.nodes.${node}.statusCheckRollup.nodes.0.commit.statusCheckRollup.contexts.nodes.0)`;
const error = (stderr: string) => new CommandError(`gh pr list -R failed: ${stderr}`, stderr, 1);
type Query = NonNullable<Parameters<typeof listPulls>[1]>;
type Api = NonNullable<Parameters<typeof listPulls>[2]>;
const raw = {
  number: 12, title: 'A useful change', url: 'https://github.com/demo/repo/pull/12', isCrossRepository: false, headRefName: 'swarm/12', headRefOid: 'abc',
  state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  labels: [{ name: 'needs-review' }], closingIssuesReferences: [{ number: 11 }], createdAt: '2026-10-01', mergedAt: null, additions: 1, deletions: 0,
};
const deniedQuery = (pulls = [raw]) => vi.fn<Query>(async (args) => {
  if (args.at(-1)!.includes('statusCheckRollup')) throw error(`GraphQL: ${denial()}`);
  return args.includes('open') ? pulls : [];
});
const run = (status = 'completed', conclusion: string | null = 'success') => ({ name: 'CI', status, conclusion, html_url: 'https://github.com/demo/repo/actions/runs/123' });
const rest = (runs = [run()], statuses: { context: string; state: string; target_url: string | null }[] = []) => vi.fn<Api>(async (args) =>
  args[1].includes('/actions/runs?') ? { workflow_runs: runs, total_count: runs.length } : { statuses, total_count: statuses.length });
afterEach(() => vi.useRealTimers());

describe('issue writes', () => {
  it('closes with the requested reason and literal comment', async () => {
    const command = vi.fn().mockResolvedValue('');
    await closeIssue('demo/repo', 66, 'not planned', 'Superseded by #67\n\n<!-- cubefarm:agent -->', command);
    expect(command).toHaveBeenCalledExactlyOnceWith(['issue', 'close', '66', '-R', 'demo/repo', '--reason', 'not planned', '--comment', 'Superseded by #67\n\n<!-- cubefarm:agent -->']);
  });

  it('preserves existing labels and remembers successful creation', async () => {
    const command = vi.fn().mockRejectedValue(error('label "swarm:server" already exists'));
    await ensureLabel('demo/labels', 'swarm:server', command);
    await ensureLabel('demo/labels', 'swarm:server', command);
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0][0]).toEqual(['label', 'create', 'swarm:server', '-R', 'demo/labels', '--color', 'c77dff', '--description', 'cubefarm: routed to this specialty']);
  });

  it('retries label creation after other failures', async () => {
    const denied = error('HTTP 403');
    const command = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue('');
    await expect(ensureLabel('demo/labels-denied', 'swarm:server', command)).rejects.toBe(denied);
    await ensureLabel('demo/labels-denied', 'swarm:server', command);
    expect(command).toHaveBeenCalledTimes(2);
  });
});

describe('audited base ancestry', () => {
  it('fails closed when GitHub cannot compare exact commits', async () => {
    const unavailable = new CommandError('Compare failed', 'HTTP 404', 1);
    const api = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue([]);
    await expect(containsCommit('demo/repo', 'head-sha', 'base-sha', api)).rejects.toBe(unavailable);
    expect(api).toHaveBeenCalledExactlyOnceWith(['api', 'repos/demo/repo/compare/head-sha...base-sha?per_page=1']);
  });
});

describe('board read retries', () => {
  it('returns a successful first read without retrying', async () => {
    const read = vi.fn().mockResolvedValue([1, 2]);
    await expect(readTwice(read, 0)).resolves.toEqual([1, 2]);
    expect(read).toHaveBeenCalledOnce();
  });

  it('retries once and propagates the second failure', async () => {
    const first = new Error('first failure');
    const second = new Error('second failure');
    const read = vi.fn().mockRejectedValueOnce(first).mockRejectedValue(second);
    await expect(readTwice(read, 0)).rejects.toBe(second);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['open', 'merged'])('retries only the failed %s PR listing with a bounded timeout', async (state) => {
    let attempts = 0;
    const query = vi.fn<Query>(async (args) => {
      if (!args.includes(state)) return [];
      if (++attempts === 1) throw error('HTTP 502: Bad Gateway');
      return [{ ...raw, state: state === 'open' ? 'OPEN' : 'MERGED' }];
    });
    const api = rest();
    const result = await listPulls('demo/repo', query, api);
    expect(result.pulls).toHaveLength(1);
    expect(query.mock.calls.filter(([args]) => args.includes(state))).toHaveLength(2);
    expect(query.mock.calls.filter(([args]) => !args.includes(state))).toHaveLength(1);
    expect(query.mock.calls.every(([, opts]) => opts?.timeoutMs === 60_000)).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('remote branch commits', () => {
  const branch = 'swarm/issue-66-ada';
  const missing = () => error('gh: Not Found (HTTP 404)');

  it.each([0, 3])('returns a verified comparison count of %s', async (count) => {
    const api = vi.fn<Api>().mockResolvedValue({ ahead_by: count });
    expect(await branchAhead('demo/repo', 'main', branch, api)).toBe(count);
    expect(api).toHaveBeenCalledOnce();
  });

  it.each([{ refs: [] }, { refs: [{ ref: `refs/heads/${branch}-other` }] }])('confirms an absent branch using successful matching refs: %j', async ({ refs }) => {
    const api = vi.fn<Api>().mockRejectedValueOnce(missing()).mockResolvedValueOnce(refs);
    expect(await branchAhead('demo/repo', 'main', branch, api)).toBe(0);
    expect(api.mock.calls[1][0]).toEqual(['api', `repos/demo/repo/git/matching-refs/heads/${encodeURIComponent(branch)}`]);
  });

  it('keeps a missing-base comparison unknown when the pushed head exists', async () => {
    const comparison = missing();
    const api = vi.fn<Api>().mockRejectedValueOnce(comparison).mockResolvedValueOnce([{ ref: `refs/heads/${branch}`, object: { sha: 'pushed-head' } }]);
    await expect(branchAhead('demo/repo', 'missing-base', branch, api)).rejects.toBe(comparison);
  });

  it.each(['HTTP 404: inaccessible repository', 'network unavailable'])('keeps a failed refs read unknown: %s', async (diagnostic) => {
    const lookup = error(diagnostic);
    const api = vi.fn<Api>().mockRejectedValueOnce(missing()).mockRejectedValueOnce(lookup);
    await expect(branchAhead('demo/repo', 'main', branch, api)).rejects.toBe(lookup);
  });

  it.each([{ refs: null }, { refs: {} }, { refs: [{ object: { sha: 'unknown' } }] }])('does not interpret malformed refs as absent: %j', async ({ refs }) => {
    const comparison = missing();
    const api = vi.fn<Api>().mockRejectedValueOnce(comparison).mockResolvedValueOnce(refs);
    await expect(branchAhead('demo/repo', 'main', branch, api)).rejects.toBe(comparison);
  });

  it.each([null, {}, { ahead_by: '0' }, { ahead_by: -1 }])('does not interpret unavailable comparison counts as zero: %j', async (result) => {
    const api = vi.fn<Api>().mockResolvedValue(result);
    await expect(branchAhead('demo/repo', 'main', branch, api)).rejects.toThrow('Branch comparison unavailable');
    expect(api).toHaveBeenCalledOnce();
  });
});

describe('optional PR checks', () => {
  it.each([false, true])('preserves repository provenance (%s) in normal and fallback PR lists', async (isCrossRepository) => {
    for (const fallback of [false, true]) {
      const query = vi.fn<Query>(async (args) => {
        if (fallback && args.at(-1)!.includes('statusCheckRollup')) throw error(`GraphQL: ${denial()}`);
        return [{ ...raw, isCrossRepository, state: args.includes('open') ? 'OPEN' : 'MERGED' }];
      });
      const result = await listPulls('demo/repo', query, rest());
      expect(query.mock.calls.every(([args]) => args.at(-1)!.split(',').includes('isCrossRepository'))).toBe(true);
      expect(result.pulls).toMatchObject([{ state: 'OPEN', isCrossRepository }, { state: 'MERGED', isCrossRepository }]);
    }
  });

  it('retries denied check queries without check fields and refreshes metadata', async () => {
    const diagnostic = `GraphQL: ${denial()}, ${denial(1)}`;
    const query = vi.fn<Query>(async (args) => {
      if (args.at(-1)!.includes('statusCheckRollup')) throw error(diagnostic);
      return args.includes('open') ? [raw] : [];
    });
    const api = vi.fn<Api>().mockRejectedValue(error('HTTP 403: Resource not accessible by personal access token'));
    const result = await listPulls('demo/repo', query, api);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.every(([, opts]) => opts?.timeoutMs === 60_000)).toBe(true);
    expect(result.pulls).toEqual([expect.objectContaining({ number: 12, title: raw.title, headSha: 'abc', closesIssues: [11], checks: 'unavailable', failedChecks: [], pendingChecks: [] })]);
    expect(result.checksError).toContain('REST fallback in use');
    expect(result.checksError).toContain('HTTP 403');
    const synced = applyRepoRefresh({ issues: [], pulls: [], lastSync: null }, { status: 'fulfilled', value: [] }, { status: 'fulfilled', value: result }, 100);
    expect(synced).toMatchObject({ pulls: result.pulls, lastSync: 100, syncError: undefined, refresh: { status: 'partial', pulls: { at: 100 } } });
  });

  it('keeps normal check enrichment for authorized credentials', async () => {
    const query = vi.fn<Query>().mockResolvedValue([{ ...raw, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }]);
    const api = rest();
    const result = await listPulls('demo/repo', query, api);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.pulls.every((p) => p.checks === 'passing' && p.hasSuccessfulChecks === true)).toBe(true);
    expect(result.checksError).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'COMPLETED', conclusion: 'SKIPPED' }, false],
    [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }, false],
    [{ status: 'IN_PROGRESS', conclusion: 'SUCCESS' }, false],
    [{ state: 'SUCCESS' }, true],
    [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, true],
  ] as const)('records successful GraphQL evidence separately: %j', async (check, hasSuccessfulChecks) => {
    const query = vi.fn<Query>().mockResolvedValue([{ ...raw, statusCheckRollup: [check] }]);
    expect((await listPulls('demo/repo', query, rest())).pulls[0].hasSuccessfulChecks).toBe(hasSuccessfulChecks);
  });

  it.each(['success', 'skipped', 'neutral'])('reads %s Actions runs as passing and permits QA-passed merges', async (conclusion) => {
    const api = rest([run('completed', conclusion)]);
    const { pulls: [pr], checksError } = await listPulls('demo/repo', deniedQuery(), api);
    expect(pr).toMatchObject({ checks: 'passing', failedChecks: [], pendingChecks: [], labels: ['needs-review'] });
    expect(api).toHaveBeenCalledWith(['api', 'repos/demo/repo/actions/runs?head_sha=abc&per_page=100&page=1']);
    expect(api).toHaveBeenCalledWith(['api', 'repos/demo/repo/commits/abc/status?per_page=100&page=1']);
    expect(checksError?.match(/REST fallback in use/g)).toHaveLength(1);
    expect(mergeStep(pr, { passedSha: 'abc', mergeFixes: 0, pendingSince: null, mergeRetryAt: null, alerted: false, checkRerunSha: null, checkRerunAt: null }, 100, { base: 'main' }).do).toBe('merge');
    expect(mergeStep(pr, { ciRequired: true, passedSha: 'abc', mergeFixes: 0, pendingSince: null, mergeRetryAt: null, alerted: false, checkRerunSha: null, checkRerunAt: null }, 100, { base: 'main' }).do)
      .toBe(conclusion === 'success' ? 'merge' : 'wait');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])('retries %s runs once, then sends them back with their URL', async (conclusion) => {
    const { pulls: [pr] } = await listPulls('demo/repo', deniedQuery(), rest([run('completed', conclusion)]));
    expect(pr).toMatchObject({ checks: 'failing', failedChecks: [{ name: 'CI', url: run().html_url }] });
    const rec = { passedSha: 'abc', mergeFixes: 0, pendingSince: null, mergeRetryAt: null, alerted: false, checkRerunSha: null, checkRerunAt: null };
    expect(mergeStep(pr, rec, 100, { base: 'main' })).toMatchObject({ do: 'rerun', runIds: [123] });
    expect(mergeStep(pr, { ...rec, checkRerunSha: 'abc', checkRerunAt: 100 }, 120_100, { base: 'main' }))
      .toMatchObject({ do: 'send-back', reason: 'checks', instructions: `- CI: ${run().html_url}` });
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('names pending %s runs', async (status) => {
    const result = await listPulls('demo/repo', deniedQuery(), rest([run(status, null)]));
    expect(result.pulls[0]).toMatchObject({ checks: 'pending', pendingChecks: ['CI'], failedChecks: [] });
  });

  it('reports no checks when both endpoints have empty results, despite combined pending state', async () => {
    const api = rest([]);
    api.mockResolvedValueOnce({ workflow_runs: [], total_count: 0 }).mockResolvedValueOnce({ state: 'pending', statuses: [], total_count: 0 });
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('none');
  });

  it.each(['403', '404'])('tolerates HTTP %s from optional commit statuses', async (code) => {
    const api = rest();
    api.mockResolvedValueOnce({ workflow_runs: [run()], total_count: 1 }).mockRejectedValueOnce(error(`gh: unavailable (HTTP ${code})`));
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('passing');
  });

  it.each(['failure', 'error', 'pending', 'success'])('combines %s commit statuses with successful runs', async (state) => {
    const statuses = [{ context: 'deploy', state, target_url: 'https://ci.example/deploy' }];
    const pr = (await listPulls('demo/repo', deniedQuery(), rest([run()], statuses))).pulls[0];
    expect(pr.checks).toBe(state === 'success' ? 'passing' : state === 'pending' ? 'pending' : 'failing');
    if (pr.checks === 'failing') expect(pr.failedChecks).toEqual([{ name: 'deploy', url: statuses[0].target_url }]);
    if (pr.checks === 'pending') expect(pr.pendingChecks).toEqual(['deploy']);
  });

  it('reads standalone commit statuses when there are no Actions workflows', async () => {
    const api = rest([], [{ context: 'external CI', state: 'success', target_url: null }]);
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0]).toMatchObject({ checks: 'passing', hasSuccessfulChecks: true });
  });

  it('keeps unexpected commit status failures unavailable', async () => {
    const api = rest();
    api.mockResolvedValueOnce({ workflow_runs: [run()], total_count: 1 }).mockRejectedValueOnce(error('HTTP 500: server error'));
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0]).toMatchObject({ checks: 'unavailable', hasSuccessfulChecks: false });
  });

  it('isolates a failed REST request to its PR and retries it on the next sync', async () => {
    const api = rest();
    api.mockImplementation(async (args) => {
      if (args[1].includes('head_sha=abc')) throw new Error('network timeout');
      return args[1].includes('/actions/runs?') ? { workflow_runs: [run()], total_count: 1 } : { statuses: [], total_count: 0 };
    });
    const query = deniedQuery([raw, { ...raw, number: 13, headRefOid: 'def' }]);
    const result = await listPulls('demo/repo', query, api);
    expect(result.pulls.map((p) => p.checks)).toEqual(['unavailable', 'passing']);
    expect(result.checksError).toContain('PR #12: network timeout');
    api.mockImplementation(rest());
    expect((await listPulls('demo/repo', query, api)).pulls[0].checks).toBe('passing');
  });

  it('reuses head SHAs across PRs and sync bursts but refreshes changing runs', async () => {
    vi.useFakeTimers();
    const query = deniedQuery([raw, { ...raw, number: 13 }]);
    const api = rest([run('in_progress', null)]);
    await listPulls('demo/repo', query, api);
    await listPulls('demo/repo', query, api);
    expect(api).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(45_000);
    api.mockImplementation(rest());
    expect((await listPulls('demo/repo', query, api)).pulls.every((p) => p.checks === 'passing')).toBe(true);
    expect(api).toHaveBeenCalledTimes(4);
    await listPulls('demo/other', query, api);
    expect(api).toHaveBeenCalledTimes(6);
    await listPulls('demo/repo', deniedQuery([{ ...raw, headRefOid: 'new' }]), api);
    expect(api).toHaveBeenCalledTimes(8);
  });

  it('never calls REST for merged PRs', async () => {
    const query = deniedQuery([]);
    query.mockImplementation(async (args) => {
      if (args.at(-1)!.includes('statusCheckRollup')) throw error(`GraphQL: ${denial()}`);
      return args.includes('merged') ? [{ ...raw, state: 'MERGED' }] : [];
    });
    const api = rest();
    expect((await listPulls('demo/repo', query, api)).pulls[0]).toMatchObject({ state: 'MERGED', checks: 'none' });
    expect(api).not.toHaveBeenCalled();
  });

  it('uses at most three concurrent REST calls', async () => {
    let active = 0;
    let peak = 0;
    const api = vi.fn<Api>(async (args) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return args[1].includes('/actions/runs?') ? { workflow_runs: [run()], total_count: 1 } : { statuses: [], total_count: 0 };
    });
    const query = deniedQuery(Array.from({ length: 8 }, (_, number) => ({ ...raw, number, headRefOid: `sha${number}` })));
    expect((await listPulls('demo/repo', query, api)).pulls).toHaveLength(8);
    expect(peak).toBe(3);
    expect(api).toHaveBeenCalledTimes(16);
  });

  it('reads additional pages so late failures are included', async () => {
    const api = rest();
    api.mockResolvedValueOnce({ workflow_runs: [run()], total_count: 2 })
      .mockResolvedValueOnce({ workflow_runs: [run('completed', 'failure')], total_count: 2 })
      .mockResolvedValueOnce({ statuses: [], total_count: 0 });
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('failing');
    expect(api).toHaveBeenCalledWith(['api', 'repos/demo/repo/actions/runs?head_sha=abc&per_page=100&page=2']);
  });

  it('does not report passing from a response exceeding the page cap', async () => {
    const api = vi.fn<Api>().mockResolvedValue({ workflow_runs: [run()], total_count: 1001 });
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('unavailable');
    expect(api).toHaveBeenCalledTimes(10);
  });

  it.each([
    'HTTP 401: Bad credentials', 'network timeout', 'GraphQL: Could not resolve to a Repository',
    'GraphQL: Resource not accessible by personal access token (repository.pullRequests)',
    'GraphQL: Field statusCheckRollup does not exist',
    `GraphQL: ${denial()}\nResource not accessible by personal access token (repository.issues)`,
  ])('does not hide unrelated failures: %s', async (message) => {
    const failure = error(message);
    const query = vi.fn<Query>(async (args) => {
      if (args.includes('merged')) return [];
      throw failure;
    });
    await expect(listPulls('demo/repo', query)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('propagates a failed metadata retry', async () => {
    const failure = error('HTTP 403: repository access denied');
    const query = vi.fn<Query>(async (args) => {
      if (args.includes('merged')) return [];
      throw args.at(-1)!.includes('statusCheckRollup') ? error(`GraphQL: ${denial()}`) : failure;
    });
    await expect(listPulls('demo/repo', query)).rejects.toBe(failure);
    expect(query.mock.calls.filter(([args]) => args.includes('open'))).toHaveLength(4);
    expect(query.mock.calls.filter(([args]) => args.includes('merged'))).toHaveLength(1);
  });

  it('recognizes repeated gh GraphQL diagnostics, not an arbitrary error mentioning checks', () => {
    expect(isCheckAccessError(error(`GraphQL: ${denial()}\n${denial(2)}`))).toBe(true);
    expect(isCheckAccessError(new Error(`GraphQL: ${denial()}`))).toBe(false);
  });
});

describe('publication reads', () => {
  const rest = (number: number, body: string | null, extra = {}) => ({
    number, title: `Issue ${number}`, body, html_url: `https://github.com/Demo/Repo/issues/${number}`, state: 'open', labels: [{ name: 'held-for-publication' }], ...extra,
  });

  it('finds issues by marker in a REST listing since a time, skipping pull requests', async () => {
    const marker = '<!-- cubefarm:plan-entry p1/e1 -->';
    const command = vi.fn(async (_args: string[]) => [rest(1, `Brief\n\n${marker}`), rest(2, null), rest(3, 'other'), rest(4, marker, { state: 'closed' })].map((i) => JSON.stringify(i)).join('\n') + '\n');
    const found = await findIssuesByMarker('demo/repo', marker, '2026-11-03T10:00:00.000Z', command);
    expect(found.map((i) => [i.number, i.state])).toEqual([[1, 'OPEN'], [4, 'CLOSED']]);
    expect(found[0]).toMatchObject({ repo: 'Demo/Repo', labels: ['held-for-publication'], url: 'https://github.com/Demo/Repo/issues/1' });
    const args = command.mock.calls[0][0];
    expect(args).toContain('--paginate');
    expect(args.find((a) => a.startsWith('repos/'))).toBe('repos/demo/repo/issues?state=all&per_page=100&since=2026-11-03T10%3A00%3A00.000Z');
  });

  it('reads an issue back, with null only for a missing one', async () => {
    expect(await readIssue('demo/repo', 1, async () => rest(1, 'x'))).toMatchObject({ number: 1, repo: 'Demo/Repo', state: 'OPEN' });
    expect(await readIssue('demo/repo', 1, async () => rest(1, 'x', { pull_request: {} }))).toBeNull();
    expect(await readIssue('demo/repo', 9, async () => { throw error('HTTP 404: Not Found'); })).toBeNull();
    await expect(readIssue('demo/repo', 9, async () => { throw error('HTTP 502: Bad Gateway'); })).rejects.toThrow();
  });
});

describe('desk branch PR lookup', () => {
  it('returns the open same-repo PR on the branch, skipping newer fork PRs with the same bare name', async () => {
    const query = vi.fn(async () => [
      { number: 9, url: 'u9', headRefName: 'swarm/issue-1-ada', isCrossRepository: true },
      { number: 7, url: 'u7', headRefName: 'swarm/issue-1-ada', isCrossRepository: false },
    ]);
    expect(await prForBranch('demo/repo', 'swarm/issue-1-ada', query)).toEqual({ number: 7, url: 'u7' });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(['--head', 'swarm/issue-1-ada', '--state', 'open']));
    expect(await prForBranch('demo/repo', 'swarm/issue-1-ada', async () => [{ number: 9, url: 'u9', headRefName: 'swarm/issue-1-ada', isCrossRepository: true }])).toBeNull();
  });
});
