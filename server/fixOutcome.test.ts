import { describe, expect, it } from 'vitest';
import { fixNeedsHuman, fixOutcome, type FixRecord } from './fixOutcome.ts';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const ada = { agentId: 'ada', devs: 3 };

const record = (r: Partial<FixRecord> = {}): FixRecord => ({ prNumber: 45, round: 2, testedSha: OLD, passedSha: null, fixReason: 'qa', fixCrashes: [], ...r });

describe('fixOutcome', () => {
  for (const fixReason of ['qa', 'other', null] as const) {
    describe(`a QA fix (fixReason ${fixReason})`, () => {
      it('with a new commit goes back to QA for the next round', () => {
        expect(fixOutcome(record({ fixReason, fixCrashes: ['bob'] }), NEW, 3, ada)).toEqual({
          set: { status: 'queued', round: 3, fixCrashes: [] },
          log: { kind: 'done', text: '✔ Fix pushed for PR #45 in 3m. Back to QA.' },
          pushed: true,
        });
      });

      it('without one is a failed session: no QA round, back in line for another developer', () => {
        expect(fixOutcome(record({ fixReason }), OLD, 3, ada)).toEqual({
          set: { status: 'failed', fixCrashes: ['ada'] },
          log: { kind: 'error', text: '✗ No new commits were pushed for PR #45' },
          pushed: false,
        });
      });
    });
  }

  it('sends it to the manager once a second developer fails on it, saying nothing was pushed', () => {
    const step = fixOutcome(record({ fixCrashes: ['bob'] }), OLD, 3, ada);
    expect(step.set).toEqual({ status: 'needs-human', fixCrashes: ['bob', 'ada'], mergeNote: 'the fix was never pushed' });
    expect(step.set.round).toBeUndefined();
  });

  it('gives the same developer a second go when nobody else could take it', () => {
    expect(fixOutcome(record({ fixCrashes: ['ada'] }), OLD, 3, ada).set.status).toBe('failed'); // three devs: waits for another
    expect(fixOutcome(record(), OLD, 3, { agentId: 'ada', devs: 1 }).set.status).toBe('failed');
    expect(fixOutcome(record({ fixCrashes: ['ada'] }), OLD, 3, { agentId: 'ada', devs: 1 }).set.status).toBe('needs-human');
  });

  it("doesn't count an unpushed fix while the usage limit is hit", () => {
    expect(fixOutcome(record({ fixCrashes: ['bob'] }), OLD, 3, { ...ada, counts: false }).set).toEqual({ status: 'failed', fixCrashes: ['bob'] });
  });

  describe('a conflict fix', () => {
    const conflict = record({ fixReason: 'conflict', testedSha: 'c'.repeat(40), passedSha: OLD });

    it('with a new commit goes back in line to merge', () => {
      expect(fixOutcome(conflict, NEW, 3, ada)).toEqual({
        set: { status: 'passed', mergeNote: 'waiting for fresh checks', fixCrashes: [] },
        log: { kind: 'done', text: '✔ PR #45 fixed in 3m. Back in line to merge.' },
        pushed: true,
      });
    });

    it('compares with the commit QA passed, which auto-merge may have moved on from the one QA tested', () => {
      expect(fixOutcome(conflict, OLD, 3, ada).pushed).toBe(false);
      expect(fixOutcome(conflict, conflict.testedSha, 3, ada).pushed).toBe(true);
    });

    it("without a new commit is a failed session, then the manager's", () => {
      expect(fixOutcome(conflict, OLD, 3, ada).set).toEqual({ status: 'failed', fixCrashes: ['ada'] });
      expect(fixOutcome({ ...conflict, fixCrashes: ['bob'] }, OLD, 3, ada).set).toEqual({ status: 'needs-human', fixCrashes: ['bob', 'ada'], mergeNote: 'the conflict was never resolved' });
    });

    it('without a passed commit (a CEO handoff) goes through QA again', () => {
      expect(fixOutcome({ ...conflict, passedSha: null }, NEW, 3, ada).set).toEqual({ status: 'queued', round: 3, fixCrashes: [] });
      expect(fixOutcome({ ...conflict, passedSha: null }, conflict.testedSha, 3, ada).pushed).toBe(false);
    });
  });

  it('lets a checks fix push nothing: it may have re-run a flaky check', () => {
    for (const head of [OLD, NEW, null]) {
      const step = fixOutcome(record({ fixReason: 'checks', passedSha: OLD, fixCrashes: ['bob'] }), head, 3, ada);
      expect(step.pushed).toBe(true);
      expect(step.set).toEqual({ status: 'passed', mergeNote: 'waiting for fresh checks', fixCrashes: [] });
    }
  });

  it("takes the session at its word when the head couldn't be read or nothing was recorded to compare", () => {
    expect(fixOutcome(record(), null, 3, ada).set).toEqual({ status: 'queued', round: 3, fixCrashes: [] });
    expect(fixOutcome(record({ testedSha: null }), OLD, 3, ada).set.status).toBe('queued');
    expect(fixOutcome(record({ fixReason: 'conflict', passedSha: OLD }), null, 3, ada).set.status).toBe('passed');
  });
});

describe('fixNeedsHuman', () => {
  it('needs two developers to fail, or one twice when they are the only one', () => {
    expect(fixNeedsHuman(['ada'], 3)).toBe(false);
    expect(fixNeedsHuman(['ada', 'ada'], 3)).toBe(false);
    expect(fixNeedsHuman(['ada', 'bob'], 3)).toBe(true);
    expect(fixNeedsHuman(['ada', 'ada'], 1)).toBe(true);
  });
});
