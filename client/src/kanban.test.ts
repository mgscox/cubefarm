import { describe, expect, it, vi } from 'vitest';
import type { PullInfo, QaView, RepoView } from '../../shared/types';
import { kanbanFor } from './store';

vi.mock('./ui/sfx', () => ({ chirp: () => {}, cue: () => {} })); // it listens on window, which tests don't have

const pull: PullInfo = {
  number: 45, title: 'Toolbar', url: '', headRefName: 'swarm/issue-12-ada', state: 'OPEN', isDraft: false, closesIssues: [12], checks: 'none',
  mergeable: 'MERGEABLE', headSha: 'sha', reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
  mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
};
const repo = { id: 'r1', pulls: [pull], issues: [] } as unknown as RepoView;
const qa = (mergeNote: string | null): Record<string, QaView> => ({
  'r1#45': { repoId: 'r1', prNumber: 45, status: 'needs-human', round: 2, devAgentId: null, qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote, updatedAt: 0 },
});

describe('kanbanFor', () => {
  it('says why a PR needs the manager when the office knows', () => {
    expect(kanbanFor(repo, [], qa('the fix was never pushed')).qa[0].note).toBe('⚠️ needs you · the fix was never pushed');
    expect(kanbanFor(repo, [], qa(null)).qa[0].note).toBe('⚠️ needs you');
  });
});
