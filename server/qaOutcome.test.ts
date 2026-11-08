import { describe, expect, it } from 'vitest';
import { qaOutcome } from './qaOutcome.ts';

describe('qaOutcome', () => {
  const lastFail = { pass: false, incomplete: false, escalate: false, qaRounds: 3 };

  it('hands off a third failure regardless of mergeability', () => {
    expect(qaOutcome(lastFail, 3)).toBe('needs-human');
  });

  it.each([
    [{ incomplete: true }, 'needs-human'],
    [{ pass: true, escalate: true }, 'queued'], [{ pass: true }, 'passed'], [{ qaRounds: 2 }, 'failed'],
  ] as const)('handles other QA outcomes: %j', (patch, status) => {
    expect(qaOutcome({ ...lastFail, ...patch }, 3)).toBe(status);
  });
});
