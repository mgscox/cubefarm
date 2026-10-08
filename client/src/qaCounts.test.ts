import { describe, expect, it } from 'vitest';
import type { PullInfo, QaView } from '../../shared/types';
import { qaCounts } from './qaCounts';

const pull = (number: number, state: PullInfo['state'] = 'OPEN', isDraft = false): PullInfo => ({
  number, title: '', url: '', headRefName: `swarm/issue-${number}-ada`, state, isDraft, closesIssues: [], checks: 'none',
  mergeable: 'MERGEABLE', headSha: 'sha', reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
  mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
});
const qa = (prNumber: number, status: QaView['status'], repoId = 'r1'): QaView => ({
  repoId, prNumber, status, round: 1, devAgentId: null, qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
});

describe('qaCounts', () => {
  it('counts only records whose PR is open on its floor', () => {
    const pulls = new Map([['r1', [pull(1), pull(2), pull(3, 'MERGED'), pull(4, 'CLOSED'), pull(5)]]]);
    const records = [qa(1, 'passed'), qa(2, 'testing'), qa(3, 'passed'), qa(4, 'queued'), qa(45, 'passed'), qa(46, 'failed'), qa(5, 'passed', 'r2')];
    expect(qaCounts(records, pulls)).toEqual({ inQa: 1, readyToMerge: 1, passedDrafts: 0 });
  });

  it('counts passed drafts separately from ready to merge', () => {
    const pulls = new Map([['r1', [pull(1, 'OPEN', true), pull(2), pull(3, 'OPEN', true)]]]);
    expect(qaCounts([qa(1, 'passed'), qa(2, 'passed'), qa(3, 'needs-human')], pulls)).toEqual({ inQa: 1, readyToMerge: 1, passedDrafts: 1 });
  });
});
