import { describe, expect, it } from 'vitest';
import { developerFeedback, type FeedbackEvent } from './feedback.ts';

const dev = { id: 'ada', repoId: 'floor-1', role: 'dev' as const, score: 0 };
const merged: FeedbackEvent = { kind: 'merged', repoId: dev.repoId, prNumber: 13, devAgentId: dev.id };

describe('developer feedback', () => {
  it('awards two for a merge and subtracts one for each distinct QA send-back', () => {
    const reward = developerFeedback(merged, dev, {})!;
    expect(reward.score).toBe(2);
    const recorded = { [reward.key]: true as const };
    expect(developerFeedback(merged, { ...dev, score: 2 }, recorded)).toBeNull();
    const sendBack = { ...merged, kind: 'qa-send-back' as const, reviewId: 'review-1', round: 1 };
    const penalty = developerFeedback(sendBack, { ...dev, score: 2 }, recorded)!;
    expect(penalty.score).toBe(1);
    recorded[penalty.key] = true;
    expect(developerFeedback(sendBack, { ...dev, score: 1 }, recorded)).toBeNull();
    expect(developerFeedback({ ...sendBack, round: 2 }, { ...dev, score: 1 }, recorded)?.score).toBe(0);
    expect(developerFeedback({ ...sendBack, reviewId: 'reopened-review' }, { ...dev, score: 1 }, recorded)?.score).toBe(0);
  });

  it('starts legacy scores at zero and allows negative scores', () => {
    const { score: _score, ...legacy } = dev;
    expect(developerFeedback(merged, legacy, {})?.score).toBe(2);
    expect(developerFeedback({ ...merged, kind: 'qa-send-back', reviewId: 'review-1', round: 1 }, legacy, {})?.score).toBe(-1);
  });

  it('attributes only to the recorded developer on the same floor', () => {
    for (const agent of [undefined, { ...dev, id: 'tester' }, { ...dev, role: 'qa' as const }, { ...dev, role: 'researcher' as const }, { ...dev, repoId: 'floor-2' }]) {
      expect(developerFeedback(merged, agent, {})).toBeNull();
    }
    expect(developerFeedback({ ...merged, devAgentId: null }, dev, {})).toBeNull();
    const first = developerFeedback(merged, dev, {})!;
    expect(developerFeedback({ ...merged, repoId: 'floor-2' }, { ...dev, repoId: 'floor-2' }, { [first.key]: true })?.score).toBe(2);
    expect(developerFeedback({ ...merged, devAgentId: 'replacement' }, { ...dev, id: 'replacement' }, { [first.key]: true })).toBeNull();
  });
});
