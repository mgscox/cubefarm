import { describe, expect, it, vi } from 'vitest';
import type { IssueInfo, PullInfo, QaView, RepoView } from '../../shared/types';
import { kanbanFor } from './store';

vi.mock('./ui/sfx', () => ({ chirp: () => {}, cue: () => {} })); // it listens on window, which tests don't have

const pull: PullInfo = {
  number: 45, title: 'Toolbar', url: '', headRefName: 'swarm/issue-12-ada', state: 'OPEN', isDraft: false, closesIssues: [12], checks: 'none',
  mergeable: 'MERGEABLE', headSha: 'sha', reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
  mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
};
const repo = { id: 'r1', pulls: [pull], issues: [] } as unknown as RepoView;
const qa = (mergeNote: string | null, status: QaView['status'] = 'needs-human'): Record<string, QaView> => ({
  'r1#45': { repoId: 'r1', prNumber: 45, status, round: 2, devAgentId: null, qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote, updatedAt: 0 },
});

describe('kanbanFor', () => {
  it('says why a PR needs the manager when the office knows', () => {
    expect(kanbanFor(repo, [], qa('the fix was never pushed')).blocked[0].note).toBe('⚠️ needs you · the fix was never pushed');
    expect(kanbanFor(repo, [], qa(null)).blocked[0].note).toBe('⚠️ needs you');
  });

  it('separates triage and human intervention from To do', () => {
    const issue = (number: number, labels: string[]): IssueInfo => ({ number, labels, title: `Issue ${number}`, url: '', body: '', createdAt: '' });
    const issues = [issue(1, ['Needs-Triage']), issue(2, []), issue(3, ['needs-triage', 'Needs-Human']), issue(12, [])];
    const cols = kanbanFor({ ...repo, issues }, [], {});
    expect(cols.backlog.map((card) => card.number)).toEqual([1]);
    expect(cols.todo.map((card) => card.number)).toEqual([2]);
    expect(cols.blocked.map((card) => card.number)).toEqual([3]);
  });

  it.each([
    { labels: ['Needs-Review'], status: 'queued', column: 'qa' },
    { labels: ['Needs-Review'], status: 'passed', column: 'review' },
    { labels: [], status: 'passed', column: 'ready' },
    { labels: ['needs-review', 'Needs-Human'], status: 'passed', column: 'blocked' },
  ] as const)('places a $status PR with $labels in $column only', ({ labels, status, column }) => {
    const cols = kanbanFor({ ...repo, pulls: [{ ...pull, labels: [...labels] }] }, [], qa(null, status));
    expect(cols[column].map((card) => card.number)).toEqual([45]);
    expect(Object.values(cols).flat()).toHaveLength(1);
  });
});
