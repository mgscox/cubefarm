import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonView, PrContributionView, RepoView, RunAttemptView } from '../../shared/types';
import { kanbanFor, useStore, type Agent } from './store';

// Audio is a browser boundary; these tests exercise incoming office events in Node.
vi.mock('./ui/sfx', () => ({ cue: vi.fn(), chirp: vi.fn() }));

const agent = { id: 'a1', role: 'dev', status: 'working', hasScreenshot: false, screenshotAt: null } as Agent;

beforeEach(() => useStore.setState({ agents: {}, screens: {}, loaded: false }));

it('receives developer score changes through agent events', () => {
  const apply = useStore.getState().apply;
  apply({ type: 'agent', agent: { ...agent, score: 0 } });
  apply({ type: 'agent', agent: { ...agent, score: 2 } });
  expect(useStore.getState().agents[agent.id].score).toBe(2);
});

it('updates live run history and removes attempts pruned by the office', () => {
  useStore.setState({ runAttempts: [] });
  const apply = useStore.getState().apply;
  const attempt = { id: 'attempt-1', outcome: null } as RunAttemptView;
  apply({ type: 'runAttempt', attempt });
  apply({ type: 'runAttempt', attempt: { ...attempt, outcome: { result: 'no-change', cause: 'agent' } } });
  expect(useStore.getState().runAttempts).toEqual([{ ...attempt, outcome: { result: 'no-change', cause: 'agent' } }]);
  apply({ type: 'runAttemptsRemoved', ids: [attempt.id] });
  expect(useStore.getState().runAttempts).toEqual([]);
});

it('adds a lesson and replaces it as its review history grows', () => {
  useStore.setState({ lessons: [] });
  const apply = useStore.getState().apply;
  const lesson = { id: 'lesson-1', repoId: 'r', versions: [], reviews: [] } as LessonView;
  const approved = { ...lesson, reviews: [{ id: 'r1', version: 1, action: 'approved' as const, actor: 'manager', reason: '', at: 1 }] };
  apply({ type: 'lesson', lesson });
  apply({ type: 'lesson', lesson: approved });
  expect(useStore.getState().lessons).toEqual([approved]);
});

it('keeps PR contributions after QA cleanup and replaces repeated history events', () => {
  useStore.setState({ prContributions: [], qa: {} });
  const apply = useStore.getState().apply;
  const history: PrContributionView = { repoId: 'r', prNumber: 1, title: 'Feature', url: '', state: 'OPEN', original: { agentId: 'a1', name: 'Ada', submittedSha: 'initial', at: 1 }, repairs: [] };
  apply({ type: 'prContribution', contribution: history });
  apply({ type: 'prContribution', contribution: { ...history, state: 'MERGED' } });
  apply({ type: 'qaRemoved', repoId: 'r', prNumber: 1 });
  apply({ type: 'agentRemoved', agentId: 'a1' });
  expect(useStore.getState().prContributions).toEqual([{ ...history, state: 'MERGED' }]);
});

describe('agent screenshot availability', () => {
  it('invalidates the previous session thumbnail when a handoff clears its screenshot', () => {
    const apply = useStore.getState().apply;
    apply({ type: 'agent', agent });
    apply({ type: 'screen', agentId: agent.id, at: 100, url: 'http://demo.invalid' });
    expect(useStore.getState().screens[agent.id]).toBe(100);

    apply({ type: 'agent', agent: { ...agent, status: 'preparing' } });
    expect(useStore.getState().screens[agent.id]).toBeUndefined();
    expect(useStore.getState().agents[agent.id].hasScreenshot).toBe(false);

    apply({ type: 'screen', agentId: agent.id, at: 200, url: null });
    expect(useStore.getState().screens[agent.id]).toBe(200);
  });

  it('takes availability from agent updates and removes it when an agent leaves', () => {
    const apply = useStore.getState().apply;
    apply({ type: 'agent', agent: { ...agent, hasScreenshot: true, screenshotAt: 100 } });
    expect(useStore.getState().screens[agent.id]).toBe(100);
    apply({ type: 'agentRemoved', agentId: agent.id });
    expect(useStore.getState().screens[agent.id]).toBeUndefined();
  });
});

describe('Idea state', () => {
  it('upserts intake and independent records by their stable identities', () => {
    useStore.setState({ ideas: [], ideaRecords: [] });
    const apply = useStore.getState().apply;
    const idea = { id: 'i1', description: 'An Idea', links: [], constraints: '', floorHints: [], status: 'queued' as const, createdAt: 1 };
    apply({ type: 'idea', idea });
    apply({ type: 'idea', idea: { ...idea, description: 'Updated context' } });
    expect(useStore.getState().ideas).toEqual([{ ...idea, description: 'Updated context' }]);
    const record = { id: 'r1', ideaId: idea.id, kind: 'research' as const, title: 'Evidence', body: 'Sources', createdAt: 2 };
    apply({ type: 'ideaRecord', record });
    apply({ type: 'ideaRecord', record: { ...record, body: 'More sources' } });
    apply({ type: 'ideaRecord', record: { ...record, kind: 'review' } });
    apply({ type: 'ideaRecord', record: { ...record, ideaId: 'i2' } });
    expect(useStore.getState().ideaRecords).toHaveLength(3);
    expect(useStore.getState().ideaRecords[0].body).toBe('More sources');
  });

  it('keeps every Issue Plan revision, replacing only the same plan', () => {
    useStore.setState({ issuePlans: [] });
    const apply = useStore.getState().apply;
    const plan = { id: 'p1', ideaId: 'i1', revision: 1, prdRevision: 1, entries: [], parents: [], dependencies: [], createdAt: 1 };
    apply({ type: 'issuePlan', plan });
    apply({ type: 'issuePlan', plan: { ...plan, id: 'p2', revision: 2 } });
    apply({ type: 'issuePlan', plan });
    expect(useStore.getState().issuePlans.map((p) => p.revision).sort()).toEqual([1, 2]);
  });

  it('keeps one review cycle per Idea', () => {
    useStore.setState({ ideaReviews: [] });
    const apply = useStore.getState().apply;
    const review = { ideaId: 'i1', author: 'lead', reviewers: { evidence: 'a', feasibility: 'b' }, rounds: [{ round: 1, prdRevision: 1, planRevision: 1, reviews: [] }], handoff: null };
    apply({ type: 'ideaReview', review });
    apply({ type: 'ideaReview', review: { ...review, rounds: [...review.rounds, { round: 2, prdRevision: 2, planRevision: 2, reviews: [] }] } });
    apply({ type: 'ideaReview', review: { ...review, ideaId: 'i2' } });
    expect(useStore.getState().ideaReviews.map((r) => [r.ideaId, r.rounds.length])).toEqual([['i1', 2], ['i2', 1]]);
  });
});

describe('publication state', () => {
  it('ignores a malformed publication instead of storing it', () => {
    useStore.setState({ publications: [] });
    const apply = useStore.getState().apply;
    apply({ type: 'publication', publication: { proposalId: '__proto__' } as never });
    apply({ type: 'publication', publication: null as never });
    expect(useStore.getState().publications).toEqual([]);
    const good = { proposalId: 'p1', issues: [], snapshot: { issues: [] } } as never;
    apply({ type: 'publication', publication: good });
    expect(useStore.getState().publications).toEqual([good]);
  });
});

describe('Proposal state', () => {
  it('replaces a Proposal by id when its decision or publication changes', () => {
    useStore.setState({ proposals: [] });
    const apply = useStore.getState().apply;
    const proposal = { id: 'p1', ideaId: 'i1', prd: { revision: 1, title: 'PRD', body: 'Body' }, plan: { revision: 1, issues: [] }, reviews: [], createdAt: 1 };
    apply({ type: 'proposal', proposal });
    apply({ type: 'proposal', proposal: { ...proposal, decision: { action: 'approve', at: 2, publication: { status: 'queued', at: 2 } } } });
    apply({ type: 'proposal', proposal: { ...proposal, id: 'p2' } });
    expect(useStore.getState().proposals.map((p) => [p.id, p.decision?.action])).toEqual([['p1', 'approve'], ['p2', undefined]]);
  });
});


describe('prototype Kanban', () => {
  it('shows a single approval card, moves revisions to In progress, and shows approved work in To do', () => {
    const issue = { number: 66, labels: ['swarm:prototype'], title: 'Try filters' };
    const pull = { number: 12, title: 'Prototype', headRefName: 'prototype/issue-66-ada', headSha: 'reviewed', state: 'OPEN', isDraft: true, closesIssues: [] };
    const repo = { id: 'r1', issues: [issue], pulls: [pull] } as unknown as RepoView;
    const waiting = kanbanFor(repo, [], {});
    expect(waiting.blocked).toEqual([expect.objectContaining({ prototype: { issueNumber: 66, head: 'reviewed' } })]);
    expect(waiting.todo).toEqual([]);
    expect(waiting.qa).toEqual([]);

    const developer = { ...agent, task: 'issue', issueNumber: 66, branch: pull.headRefName, prNumber: pull.number } as Agent;
    const revising = kanbanFor(repo, [developer], {});
    expect(revising.progress.map((card) => card.number)).toEqual([66]);
    expect(revising.blocked).toEqual([]);

    const approved = kanbanFor({ ...repo, issues: [{ ...repo.issues[0], labels: [] }] }, [], {});
    expect(approved.todo.map((card) => card.number)).toEqual([66]);
    expect(approved.blocked).toEqual([]);
    expect(approved.qa).toEqual([]);
  });
});
