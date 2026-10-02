import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from './exec.ts';
import { isCheckAccessError, listPulls } from './github.ts';
import { applyRepoRefresh } from './repoRefresh.ts';
import { mergeStep } from './mergeGate.ts';

const denial = (node = 0) => `Resource not accessible by personal access token (repository.pullRequests.nodes.${node}.statusCheckRollup.nodes.0.commit.statusCheckRollup.contexts.nodes.0)`;
const error = (stderr: string) => new CommandError(`gh pr list -R failed: ${stderr}`, stderr, 1);
type Query = NonNullable<Parameters<typeof listPulls>[1]>;
type Api = NonNullable<Parameters<typeof listPulls>[2]>;
const raw = {
  number: 12, title: 'A useful change', url: 'https://github.com/demo/repo/pull/12', headRefName: 'swarm/12', headRefOid: 'abc',
  state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  closingIssuesReferences: [{ number: 11 }], createdAt: '2026-10-01', mergedAt: null, additions: 1, deletions: 0,
};
const deniedQuery = (pulls = [raw]) => vi.fn<Query>(async (args) => {
  if (args.at(-1)!.includes('statusCheckRollup')) throw error(`GraphQL: ${denial()}`);
  return args.includes('open') ? pulls : [];
});
const run = (status = 'completed', conclusion: string | null = 'success') => ({ name: 'CI', status, conclusion, html_url: 'https://github.com/demo/repo/actions/runs/123' });
const rest = (runs = [run()], statuses: { context: string; state: string; target_url: string | null }[] = []) => vi.fn<Api>(async (args) =>
  args[1].includes('/actions/runs?') ? { workflow_runs: runs, total_count: runs.length } : { statuses, total_count: statuses.length });
afterEach(() => vi.useRealTimers());

describe('optional PR checks', () => {
  it('retries denied check queries without check fields and refreshes metadata', async () => {
    const diagnostic = `GraphQL: ${denial()}, ${denial(1)}`;
    const query = vi.fn<Query>(async (args) => {
      if (args.at(-1)!.includes('statusCheckRollup')) throw error(diagnostic);
      return args.includes('open') ? [raw] : [];
    });
    const api = vi.fn<Api>().mockRejectedValue(error('HTTP 403: Resource not accessible by personal access token'));
    const result = await listPulls('demo/repo', query, api);
    expect(query).toHaveBeenCalledTimes(4);
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
    expect(result.pulls.every((p) => p.checks === 'passing')).toBe(true);
    expect(result.checksError).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it.each(['success', 'skipped', 'neutral'])('reads %s Actions runs as passing and permits QA-passed merges', async (conclusion) => {
    const api = rest([run('completed', conclusion)]);
    const { pulls: [pr], checksError } = await listPulls('demo/repo', deniedQuery(), api);
    expect(pr).toMatchObject({ checks: 'passing', failedChecks: [], pendingChecks: [] });
    expect(api).toHaveBeenCalledWith(['api', 'repos/demo/repo/actions/runs?head_sha=abc&per_page=100&page=1']);
    expect(api).toHaveBeenCalledWith(['api', 'repos/demo/repo/commits/abc/status?per_page=100&page=1']);
    expect(checksError?.match(/REST fallback in use/g)).toHaveLength(1);
    expect(mergeStep(pr, { passedSha: 'abc', mergeFixes: 0, pendingSince: null, mergeRetryAt: null, alerted: false }, 100, { base: 'main' }).do).toBe('merge');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])('sends %s runs back with their URL', async (conclusion) => {
    const { pulls: [pr] } = await listPulls('demo/repo', deniedQuery(), rest([run('completed', conclusion)]));
    expect(pr).toMatchObject({ checks: 'failing', failedChecks: [{ name: 'CI', url: run().html_url }] });
    expect(mergeStep(pr, { passedSha: 'abc', mergeFixes: 0, pendingSince: null, mergeRetryAt: null, alerted: false }, 100, { base: 'main' }))
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
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('passing');
  });

  it('keeps unexpected commit status failures unavailable', async () => {
    const api = rest();
    api.mockResolvedValueOnce({ workflow_runs: [run()], total_count: 1 }).mockRejectedValueOnce(error('HTTP 500: server error'));
    expect((await listPulls('demo/repo', deniedQuery(), api)).pulls[0].checks).toBe('unavailable');
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
    const query = vi.fn<Query>().mockRejectedValue(failure);
    await expect(listPulls('demo/repo', query)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed metadata retry', async () => {
    const failure = error('HTTP 403: repository access denied');
    const query = vi.fn<Query>(async (args) => {
      throw args.at(-1)!.includes('statusCheckRollup') ? error(`GraphQL: ${denial()}`) : failure;
    });
    await expect(listPulls('demo/repo', query)).rejects.toBe(failure);
  });

  it('recognizes repeated gh GraphQL diagnostics, not an arbitrary error mentioning checks', () => {
    expect(isCheckAccessError(error(`GraphQL: ${denial()}\n${denial(2)}`))).toBe(true);
    expect(isCheckAccessError(new Error(`GraphQL: ${denial()}`))).toBe(false);
  });
});
