import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_ROUNDS, currentRound, jointlyEndorsed, nextStep, pickReviewers, promote, recordReview, reviseRound, startReview } from './ideaReview.ts';
import type { IdeaReviewCycleView, IdeaReviewFocus, IdeaReviewView } from './types.ts';

const reviewers = { evidence: 'ada', feasibility: 'qa-1' };
const start = () => startReview('idea-1', 'lead', reviewers, 1, 1);
const review = (focus: IdeaReviewFocus, prdRevision: number, findings: string[] = []): IdeaReviewView => ({
  focus, reviewer: reviewers[focus], prdRevision, verdict: findings.length ? 'findings' : 'endorse', findings, at: 1,
});
const both = (cycle: IdeaReviewCycleView, rev: number, findings: string[] = []) =>
  recordReview(recordReview(cycle, review('evidence', rev)), review('feasibility', rev, findings));

describe('choosing reviewers', () => {
  it('picks two agents other than the author, researchers first', () => {
    const agents = [{ id: 'dev-1', role: 'dev' as const }, { id: 'lead', role: 'researcher' as const }, { id: 'qa-1', role: 'qa' as const }, { id: 'ada', role: 'researcher' as const }];
    expect(pickReviewers('lead', agents)).toEqual({ evidence: 'ada', feasibility: 'qa-1' });
    expect(pickReviewers('lead', agents.slice(0, 2))).toBeNull();
  });

  it('refuses the author or one agent covering both focuses', () => {
    expect(() => startReview('i', 'lead', { evidence: 'lead', feasibility: 'qa-1' }, 1, 1)).toThrow();
    expect(() => startReview('i', 'lead', { evidence: 'ada', feasibility: 'ada' }, 1, 1)).toThrow();
  });
});

describe('a review round', () => {
  it('waits for both reviews, then promotes a joint endorsement in the first round', () => {
    const one = recordReview(start(), review('evidence', 1));
    expect(nextStep(one)).toBe('wait');
    const done = promote(both(start(), 1), 5);
    expect(done.handoff).toEqual({ prdRevision: 1, planRevision: 1, round: 1, endorsed: true, unresolved: [], at: 5 });
    expect(nextStep(done)).toBe('done');
  });

  it('only counts reviews of the revision under review', () => {
    const revised = reviseRound(both(start(), 1, ['No evidence for offline use']), 2, 2);
    expect(() => recordReview(revised, review('evidence', 1))).toThrow(/r1/);
    // A round that somehow holds a stale endorsement still isn't jointly endorsed.
    const round = { ...currentRound(revised), reviews: [review('evidence', 1), review('feasibility', 2)] };
    expect(jointlyEndorsed(round)).toBe(false);
  });

  it('refuses the author, the wrong reviewer, duplicates and empty findings', () => {
    expect(() => recordReview(start(), { ...review('evidence', 1), reviewer: 'lead' })).toThrow();
    expect(() => recordReview(start(), { ...review('evidence', 1), reviewer: 'qa-1' })).toThrow();
    expect(() => recordReview(recordReview(start(), review('evidence', 1)), review('evidence', 1))).toThrow();
    expect(() => recordReview(start(), { ...review('evidence', 1), verdict: 'findings' })).toThrow();
  });

  it('asks the lead to revise on findings, with newer revisions only', () => {
    const disputed = both(start(), 1, ['Floor B has no owner']);
    expect(nextStep(disputed)).toBe('revise');
    expect(() => promote(disputed, 1)).toThrow();
    expect(() => reviseRound(disputed, 1, 2)).toThrow();
    expect(() => reviseRound(start(), 2, 2)).toThrow();
    expect(currentRound(reviseRound(disputed, 2, 3))).toEqual({ round: 2, prdRevision: 2, planRevision: 3, reviews: [] });
  });

  it('promotes the latest pair with its findings at the round cap', () => {
    let cycle = start();
    for (let rev = 1; rev < MAX_REVIEW_ROUNDS; rev++) cycle = reviseRound(both(cycle, rev, [`Finding ${rev}`]), rev + 1, rev + 1);
    cycle = both(cycle, MAX_REVIEW_ROUNDS, ['Dependency on #12 unproven']);
    expect(nextStep(cycle)).toBe('promote');
    expect(() => reviseRound(cycle, 9, 9)).toThrow();
    expect(promote(cycle, 7).handoff).toEqual({
      prdRevision: 3, planRevision: 3, round: 3, endorsed: false, at: 7,
      unresolved: [{ focus: 'feasibility', reviewer: 'qa-1', text: 'Dependency on #12 unproven' }],
    });
    expect(() => recordReview(promote(cycle, 7), review('evidence', 3))).toThrow();
  });
});
