import { describe, expect, it } from 'vitest';
import type { IssueInfo, PullInfo, RequestedStart } from '../shared/types.ts';
import { pickRequestedStart, retainRequestedStarts } from './requestedStarts.ts';

const request: RequestedStart = { issueNumber: 66, preferredAgentId: 'ada', note: 'Finish this', restartPending: true };
const issue: IssueInfo = { number: 66, title: '', body: '', url: '', labels: [], createdAt: '' };

describe('retaining explicit starts', () => {
  it('retains open issues and preserves requests when a resource refresh failed', () => {
    expect(retainRequestedStarts([request], [issue], [])).toEqual([request]);
    expect(retainRequestedStarts([request], null, null)).toEqual([request]);
  });

  it('drops closed or human issues', () => {
    expect(retainRequestedStarts([request], [], [])).toEqual([]);
    expect(retainRequestedStarts([request], [{ ...issue, labels: ['Ready-For-Human'] }], [])).toEqual([]);
  });

  it.each(['OPEN', 'CLOSED', 'MERGED'] as const)('drops an issue with a %s PR, by closing reference or swarm branch', (state) => {
    const pull = { state, closesIssues: [66], headRefName: 'feature' } as PullInfo;
    expect(retainRequestedStarts([request], [issue], [pull])).toEqual([]);
    expect(retainRequestedStarts([request], null, [{ ...pull, closesIssues: [], headRefName: 'swarm/issue-66-ada' }])).toEqual([]);
    expect(retainRequestedStarts([request], [issue], [{ ...pull, closesIssues: [], headRefName: 'swarm/issue-660-ada' }])).toEqual([request]);
  });
});

describe('selecting an explicit restart', () => {
  const ada = { id: 'ada' };
  const barbara = { id: 'barbara' };
  it('prefers the original developer and falls back to another free desk', () => {
    expect(pickRequestedStart([request], [barbara, ada], () => false)?.agent).toBe(ada);
    expect(pickRequestedStart([request], [barbara], () => false)?.agent).toBe(barbara);
  });

  it('waits when no desk is free, the issue is taken, or no restart is pending', () => {
    expect(pickRequestedStart([request], [], () => false)).toBeNull();
    expect(pickRequestedStart([request], [ada], () => true)).toBeNull();
    expect(pickRequestedStart([{ ...request, restartPending: false }], [ada], () => false)).toBeNull();
  });
});
