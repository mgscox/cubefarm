import { describe, expect, it } from 'vitest';
import { planDevFix } from './fixPlan.ts';

const qa = { status: 'needs-human' as const, round: 7, summary: 'Recovery loses work', checks: [{ name: 'Recovery', result: 'fail' as const, details: 'Missing task' }] };
const pr = { mergeable: 'MERGEABLE', mergeState: 'CLEAN', failedChecks: [{ name: 'Build', url: 'https://example.test/build' }] };

describe('CEO fix plan', () => {
  it('preserves findings and resets budgets without rewinding report rounds', () => {
    const plan = planDevFix(qa, pr, 'main', 'Keep the task');
    expect(plan).toMatchObject({ fixReason: 'qa', retests: 7, sessionFailures: 0, passedSha: null, mergeFixes: 0 });
    expect(plan.fixInstructions).toContain('Recovery loses work');
    expect(plan.fixInstructions).toContain('Recovery: Missing task');
    expect(plan.fixInstructions).toContain('GitHub check failed: Build');
    expect(plan.fixInstructions).toContain('CEO instructions: Keep the task');
    expect(qa.round + 1 - plan.retests).toBe(1);
  });

  it.each(['qa', 'conflict', 'checks', 'other'] as const)('keeps conflict instructions with explicit reason %s', (reason) => {
    const plan = planDevFix(qa, { ...pr, mergeable: 'CONFLICTING' }, 'trunk', undefined, reason);
    expect(plan.fixReason).toBe(reason);
    expect(plan.fixInstructions).toContain('git merge origin/trunk');
    expect(plan.fixInstructions).toContain('fix the QA findings');
  });

  it('infers conflicts before QA, then checks and other when QA passed', () => {
    expect(planDevFix(qa, { ...pr, mergeState: 'DIRTY' }, 'main').fixReason).toBe('conflict');
    const passed = { ...qa, status: 'passed' as const, checks: [] };
    expect(planDevFix(passed, pr, 'main').fixReason).toBe('checks');
    expect(planDevFix(passed, { ...pr, failedChecks: [], mergeable: 'UNKNOWN' }, 'main').fixReason).toBe('other');
  });
});
