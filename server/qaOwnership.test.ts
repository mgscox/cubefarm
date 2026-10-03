import { describe, expect, it } from 'vitest';
import { orphanedQa } from './qaOwnership.ts';

describe('QA task ownership', () => {
  const rec = { repoId: 'r1', prNumber: 13, qaAgentId: 'q1', status: 'testing' as const };
  const tester = { id: 'q1', repoId: 'r1', prNumber: 13, task: 'qa' as const };
  it('keeps a matching QA task', () => expect(orphanedQa(rec, [tester])).toBe(false));
  it('recovers a missing tester', () => expect(orphanedQa(rec, [])).toBe(true));
  it.each([{ prNumber: 14 }, { repoId: 'r2' }, { task: 'fix' as const }, { id: 'q2' }])('recovers mismatched ownership %j', (patch) => {
    expect(orphanedQa(rec, [{ ...tester, ...patch }])).toBe(true);
  });
  it('leaves completed QA alone', () => expect(orphanedQa({ ...rec, status: 'failed' }, [])).toBe(false));
});
