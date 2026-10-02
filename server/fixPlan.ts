import type { PullInfo, QaView } from '../shared/types.ts';

// A CEO handoff starts a fresh QA budget without losing the PR's report history.
export type FixReason = 'qa' | 'conflict' | 'checks' | 'other';

export function planDevFix(qa: Pick<QaView, 'status' | 'round' | 'summary' | 'checks'>, pr: Pick<PullInfo, 'mergeable' | 'mergeState' | 'failedChecks'>, defaultBranch: string, note?: string, reason?: FixReason) {
  const conflict = pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY';
  return {
    fixReason: reason ?? (conflict ? 'conflict' : qa.status !== 'passed' || qa.checks.some((c) => c.result === 'fail') ? 'qa' : pr.failedChecks.length ? 'checks' : 'other'),
    fixInstructions: [
      qa.summary ? `Last QA summary: ${qa.summary}` : '',
      ...qa.checks.filter((c) => c.result === 'fail').map((c) => `QA failed: ${c.name}: ${c.details}`),
      ...pr.failedChecks.map((c) => `GitHub check failed: ${c.name}${c.url ? ` (${c.url})` : ''}`),
      note ? `CEO instructions: ${note}` : '',
      conflict ? `Also run git fetch origin and git merge origin/${defaultBranch}, resolve conflicts while preserving both changes, and fix the QA findings above.` : '',
    ].filter(Boolean).join('\n'),
    sessionFailures: 0,
    retests: qa.round,
    passedSha: null,
    mergeFixes: 0,
    mergeNote: null,
    pendingSince: null,
    mergeRetryAt: null,
    alerted: false,
  };
}
