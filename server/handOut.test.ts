import { describe, expect, it } from 'vitest';
import { fixGoesTo, PREP_HOLD_MS, prepFailure, prepHeld, type FixAuthor } from './handOut.ts';

const author = (o: Partial<FixAuthor> = {}): FixAuthor => ({ status: 'done', branch: 'swarm/issue-192-barbara', prNumber: 198, ...o });
const HEAD = 'swarm/issue-192-barbara';

describe('fixGoesTo', () => {
  it('waits for an author still working on the issue whose PR QA failed (#198)', () => {
    // Barbara opened PR #198 mid-session: still on task 'issue', no PR number recorded yet, desk on the branch.
    expect(fixGoesTo(author({ status: 'working', prNumber: null }), false, 198, HEAD)).toBe('wait');
    expect(fixGoesTo(author({ status: 'preparing', prNumber: null }), false, 198, HEAD)).toBe('wait');
    expect(fixGoesTo(author({ status: 'working', branch: 'elsewhere' }), false, 198, null)).toBe('wait');
  });

  it('goes to the author when they are free', () => {
    expect(fixGoesTo(author(), true, 198, HEAD)).toBe('author');
    expect(fixGoesTo(author({ status: 'error' }), true, 198, HEAD)).toBe('author'); // their cooldown is over
  });

  it('goes to anyone free when the author is gone, errored or busy with other work', () => {
    expect(fixGoesTo(null, false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'error' }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'stopped' }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'working', branch: 'swarm/issue-200-barbara', prNumber: null }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'working', branch: 'qa/pr-201-barbara', prNumber: 201 }), false, 198, HEAD)).toBe('anyone');
  });
});

describe('preparation retries', () => {
  it('retries, holds for ten minutes, then requires an explicit handoff', () => {
    let previous;
    const next: string[] = [];
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
      const step = prepFailure(previous, 'sha-1', now);
      previous = step.strikes;
      next.push(step.next);
    }
    expect(next).toEqual(['retry', 'hold', 'retry', 'needs-human']);
    expect(prepHeld(previous, 'sha-1', now)).toBe(true);
    expect(prepHeld(previous, 'sha-1', now + PREP_HOLD_MS)).toBe(false);
    expect(prepHeld(previous, 'sha-2', now)).toBe(false);
    expect(prepFailure(previous, 'sha-2', now)).toMatchObject({ next: 'retry', strikes: { failures: 1, holds: 0 } });
    expect(prepHeld(undefined, 'sha-1', now)).toBe(false);
  });
});
