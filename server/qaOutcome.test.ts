import { describe, expect, it } from 'vitest';
import { qaOutcome } from './qaOutcome.ts';
import { MAX_MERGE_FIXES } from './mergeGate.ts';

describe('qaOutcome', () => {
  const lastFail = { pass: false, incomplete: false, escalate: false, security: false, qaRounds: 3, mergeFixes: 0 };

  it.each([{ mergeable: 'CONFLICTING', mergeState: 'UNKNOWN' }, { mergeable: 'UNKNOWN', mergeState: 'DIRTY' }])('uses the remaining merge-fix budget for a last-round conflict: %j', (pr) => {
    expect(qaOutcome(lastFail, pr, 3)).toEqual({ status: 'failed', conflictFix: true });
  });

  it('keeps ordinary QA failures and exhausted budgets going to a human', () => {
    expect(qaOutcome(lastFail, null, 3)).toEqual({ status: 'needs-human', conflictFix: false });
    expect(qaOutcome({ ...lastFail, mergeFixes: MAX_MERGE_FIXES }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }, 3))
      .toEqual({ status: 'needs-human', conflictFix: false });
  });

  it.each([
    [{ security: true }, 'needs-human'], [{ incomplete: true }, 'needs-human'],
    [{ pass: true, escalate: true }, 'queued'], [{ pass: true }, 'passed'], [{ qaRounds: 2 }, 'failed'],
  ] as const)('preserves existing outcomes ahead of conflict recovery: %j', (patch, status) => {
    expect(qaOutcome({ ...lastFail, ...patch }, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }, 3))
      .toEqual({ status, conflictFix: false });
  });
});
