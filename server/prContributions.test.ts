import { describe, expect, it } from 'vitest';
import type { PrContributionView } from '../shared/types.ts';
import type { PrDetails } from './github.ts';
import { finishedContribution, submittedContribution } from './prContributions.ts';

const history: PrContributionView = { repoId: 'r', prNumber: 1, title: 'Feature', url: '', state: 'OPEN', original: null, repairs: [] };
const agent = { id: 'ada', name: 'Ada', task: 'issue', branch: 'swarm/issue-1-ada', startedAt: 10_123 };
const pr = { number: 1, state: 'OPEN', isCrossRepository: false, headRefName: agent.branch, headSha: 'initial', createdAt: new Date(11_000).toISOString() } as PrDetails;

describe('verified handoff contributions', () => {
  it('records the original submitted revision once', () => {
    const recorded = submittedContribution(history, pr, agent, 20_000);
    expect(recorded.original).toEqual({ agentId: 'ada', name: 'Ada', submittedSha: 'initial', at: 20_000 });
    expect(submittedContribution(recorded, { ...pr, headSha: 'later' }, { ...agent, id: 'bob' }, 30_000)).toBe(recorded);
  });

  it.each([
    { isCrossRepository: true }, { isCrossRepository: undefined }, { state: 'CLOSED' },
    { headRefName: 'other' }, { createdAt: undefined }, { createdAt: new Date(10_000).toISOString() }, { createdAt: new Date(9_000).toISOString() }, { headSha: '' },
  ])('leaves unverified or pre-existing PRs unknown: %j', (patch) => {
    expect(submittedContribution(history, { ...pr, ...patch } as PrDetails, agent, 20_000).original).toBeNull();
  });

  it('does not infer original authorship from a repair handoff', () => {
    expect(submittedContribution(history, pr, { ...agent, task: 'fix' }, 20_000).original).toBeNull();
  });
});

it('preserves prior repairs and refuses late submissions from another owner', () => {
  const attempts = { ...history, repairs: [{ id: 'one', agentId: 'bob', name: 'Bob', reason: 'qa', startingSha: 'initial', submittedSha: null, reviewId: 'review', round: 1, commentUrl: 'report', findings: 'Fix layout', startedAt: 21_000, finishedAt: null }] };
  expect(submittedContribution(attempts, pr, agent, 22_000).original).toBeNull();
  expect(finishedContribution(attempts, 'one', 'ada', 'wrong', 22_000)).toBe(attempts);
  const finished = finishedContribution(attempts, 'one', 'bob', 'fixed', 23_000);
  expect(finished.repairs[0]).toMatchObject({ startingSha: 'initial', submittedSha: 'fixed', finishedAt: 23_000 });
  expect(finishedContribution(finished, 'one', 'bob', 'overwrite', 24_000)).toBe(finished);
});
