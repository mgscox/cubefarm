import { describe, expect, it } from 'vitest';
import { duplicateIssueSessions, issueHolder, issueTaken } from './issueClaims.ts';

const agent = (id: string) => ({ id, repoId: 'r1', role: 'dev' as const, task: 'issue' as const, status: 'working' as const, issueNumber: 66, prNumber: null as number | null, startedAt: 100 });

describe('issueTaken', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it.each([
    { closesIssues: [66], headRefName: 'feature' },
    { closesIssues: [], headRefName: 'swarm/issue-66-ada' },
    { closesIssues: [], headRefName: 'swarm/research-66-hypatia' },
  ])('holds recently merged work: %j', (link) => {
    const pull = { ...link, state: 'MERGED' as const, mergedAt: '2026-11-04T11:59:00Z' };
    expect(issueTaken([], 'r1', 66, [pull], now)).toBe(true);
    expect(issueTaken([], 'r1', 66, [{ ...pull, state: 'OPEN', mergedAt: null }], now)).toBe(true);
    expect(issueTaken([], 'r1', 66, [{ ...pull, state: 'CLOSED' }], now)).toBe(false);
    expect(issueTaken([], 'r1', 66, [{ ...pull, mergedAt: null }], now)).toBe(false);
    expect(issueTaken([], 'r1', 66, [{ ...pull, mergedAt: 'invalid' }], now)).toBe(false);
    expect(issueTaken([], 'r1', 66, [{ ...pull, mergedAt: '2026-11-04T06:00:01Z' }], now)).toBe(true);
    expect(issueTaken([], 'r1', 66, [{ ...pull, mergedAt: '2026-11-04T06:00:00Z' }], now)).toBe(false);
    expect(issueTaken([], 'r1', 6, [pull], now)).toBe(false);
  });

  it('keeps researcher sessions and held retries, excluding QA and other floors', () => {
    const a = agent('a');
    expect(issueTaken([{ ...a, role: 'researcher' }], 'r1', 66, [], now)).toBe(true);
    expect(issueTaken([{ ...a, status: 'error', heldRetry: {} }], 'r1', 66, [], now)).toBe(true);
    expect(issueTaken([{ ...a, status: 'idle' }], 'r1', 66, [], now)).toBe(false);
    expect(issueTaken([{ ...a, status: 'error' }], 'r1', 66, [], now)).toBe(false);
    expect(issueTaken([{ ...a, role: 'qa' }], 'r1', 66, [], now)).toBe(false);
    expect(issueTaken([{ ...a, task: 'qa' }], 'r1', 66, [], now)).toBe(false);
    expect(issueTaken([a], 'r2', 66, [], now)).toBe(false);
  });
});

describe('issue claims', () => {
  it('counts fixes and held retries, excludes QA, free desks, other floors and the caller', () => {
    const a = agent('a');
    expect(issueHolder([a], 'r1', 66, 'a')).toBeUndefined();
    expect(issueHolder([a], 'r2', 66, 'b')).toBeUndefined();
    expect(issueHolder([a], 'r1', null, 'b')).toBeUndefined();
    expect(issueHolder([{ ...a, task: 'fix' }], 'r1', 66, 'b')?.id).toBe('a');
    expect(issueHolder([{ ...a, task: 'qa' }], 'r1', 66, 'b')).toBeUndefined();
    expect(issueHolder([{ ...a, status: 'error' }], 'r1', 66, 'b')).toBeUndefined();
    expect(issueHolder([{ ...a, status: 'error', heldRetry: {} }], 'r1', 66, 'b')?.id).toBe('a');
  });

  it('repairs all duplicates per floor and issue while leaving QA and unrelated work alone', () => {
    const old = agent('old');
    const pr = { ...agent('pr'), prNumber: 13, startedAt: 200 };
    const newerPr = { ...agent('new-pr'), prNumber: 14, startedAt: 300 };
    expect(duplicateIssueSessions([
      old, pr, newerPr, { ...agent('qa'), task: 'qa' },
      { ...agent('floor'), repoId: 'r2' }, { ...agent('issue'), issueNumber: 67 },
    ])).toEqual([{ keep: pr, stop: newerPr }, { keep: pr, stop: old }]);
  });

  it('uses the oldest known start without a PR, then stable order for ties', () => {
    const unknown = { ...agent('unknown'), startedAt: null };
    const older = agent('older');
    const tied = agent('tied');
    expect(duplicateIssueSessions([unknown, older, tied])).toEqual([{ keep: older, stop: tied }, { keep: older, stop: unknown }]);
  });

  it.each([true, false])('repairs held retries with the same PR/oldest priority (linked reconnect: %s)', (linked) => {
    const held = { ...agent('held'), status: 'error' as const, heldRetry: {}, startedAt: 100 };
    const reconnect = { ...agent('reconnect'), prNumber: linked ? 13 : null, startedAt: 200 };
    expect(duplicateIssueSessions([
      held, reconnect, { ...held, id: 'qa', task: 'qa' },
      { ...held, id: 'floor', repoId: 'r2' }, { ...held, id: 'issue', issueNumber: 67 },
      { ...held, id: 'unassigned', issueNumber: null }, { ...held, id: 'no-task', task: null },
    ])).toEqual([linked ? { keep: reconnect, stop: held } : { keep: held, stop: reconnect }]);
  });
});
