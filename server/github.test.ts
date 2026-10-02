import { describe, expect, it, vi } from 'vitest';
import { CommandError } from './exec.ts';
import { isCheckAccessError, listPulls } from './github.ts';
import { applyRepoRefresh } from './repoRefresh.ts';

const denial = (node = 0) => `Resource not accessible by personal access token (repository.pullRequests.nodes.${node}.statusCheckRollup.nodes.0.commit.statusCheckRollup.contexts.nodes.0)`;
const error = (stderr: string) => new CommandError(`gh pr list -R failed: ${stderr}`, stderr, 1);
type Query = NonNullable<Parameters<typeof listPulls>[1]>;
const raw = {
  number: 12, title: 'A useful change', url: 'https://github.com/demo/repo/pull/12', headRefName: 'swarm/12', headRefOid: 'abc',
  state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  closingIssuesReferences: [{ number: 11 }], createdAt: '2026-10-01', mergedAt: null, additions: 1, deletions: 0,
};

describe('optional PR checks', () => {
  it('retries denied check queries without check fields and refreshes metadata', async () => {
    const diagnostic = `GraphQL: ${denial()}, ${denial(1)}`;
    const query = vi.fn<Query>(async (args) => {
      if (args.at(-1)!.includes('statusCheckRollup')) throw error(diagnostic);
      return args.includes('open') ? [raw] : [];
    });
    const result = await listPulls('demo/repo', query);
    expect(query).toHaveBeenCalledTimes(4);
    expect(result.pulls).toEqual([expect.objectContaining({ number: 12, title: raw.title, headSha: 'abc', closesIssues: [11], checks: 'unavailable', failedChecks: [], pendingChecks: [] })]);
    expect(result.checksError).toContain(diagnostic);
    const synced = applyRepoRefresh({ issues: [], pulls: [], lastSync: null }, { status: 'fulfilled', value: [] }, { status: 'fulfilled', value: result }, 100);
    expect(synced).toMatchObject({ pulls: result.pulls, lastSync: 100, syncError: undefined, refresh: { status: 'partial', pulls: { at: 100 } } });
  });

  it('keeps normal check enrichment for authorized credentials', async () => {
    const query = vi.fn<Query>().mockResolvedValue([{ ...raw, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }]);
    const result = await listPulls('demo/repo', query);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.pulls.every((p) => p.checks === 'passing')).toBe(true);
    expect(result.checksError).toBeUndefined();
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
