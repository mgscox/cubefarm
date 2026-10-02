import { describe, expect, it } from 'vitest';
import type { IssueInfo, PullInfo, RepoRefresh } from '../shared/types.ts';
import { applyRepoRefresh } from './repoRefresh.ts';

const ok = <T>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value });
const fail = (message: string): PromiseRejectedResult => ({ status: 'rejected', reason: new Error(message) });
const previous = {
  issues: [{ number: 1 }] as IssueInfo[], pulls: [{ number: 2, checks: 'passing' }] as PullInfo[], lastSync: 10,
  refresh: { status: 'success', issues: { at: 10 }, pulls: { at: 10 } } as RepoRefresh,
};

describe('independent repository refresh', () => {
  it('keeps fresh issues and stale PR metadata when the PR query fails', () => {
    const result = applyRepoRefresh(previous, ok([]), fail('network down'), 20);
    expect(result).toMatchObject({ issues: [], pulls: previous.pulls, lastSync: 10, syncError: 'network down', refresh: { status: 'partial', issues: { at: 20 }, pulls: { at: 10, error: 'network down' } } });
  });

  it('keeps fresh PRs and stale issues when only the issue query fails', () => {
    const result = applyRepoRefresh(previous, fail('issues forbidden'), ok({ pulls: [] }), 20);
    expect(result).toMatchObject({ issues: previous.issues, pulls: [], lastSync: 10, refresh: { status: 'partial', issues: { at: 10, error: 'issues forbidden' }, pulls: { at: 20 } } });
  });

  it('reports complete failure without replacing known data with empty lists', () => {
    expect(applyRepoRefresh(previous, fail('unauthorized'), fail('unauthorized'), 20)).toMatchObject({ issues: previous.issues, pulls: previous.pulls, lastSync: 10, refresh: { status: 'failed', issues: { at: 10 }, pulls: { at: 10 } } });
    expect(applyRepoRefresh({ issues: [], pulls: [], lastSync: null }, fail('unauthorized'), fail('unauthorized'), 20).refresh).toMatchObject({ status: 'failed', issues: { at: null }, pulls: { at: null } });
  });

  it('clears old warnings and errors after full recovery', () => {
    const failed = applyRepoRefresh(previous, fail('network down'), ok({ pulls: previous.pulls, checksError: 'denied' }), 20);
    expect(applyRepoRefresh(failed, ok([]), ok({ pulls: [] }), 30)).toMatchObject({ lastSync: 30, syncError: undefined, refresh: { status: 'success', issues: { at: 30, error: undefined }, pulls: { at: 30, error: undefined }, checksError: undefined } });
  });
});
