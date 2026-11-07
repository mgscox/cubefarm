// Score eligibility is separate from QA verdicts and merge decisions.
import type { QaOutcomeView } from './types.ts';

/** Stale, unknown, worker and unconfirmed evidence can never authorize score changes. */
export function scoringFindings(outcome: QaOutcomeView) {
  if (outcome.revision !== 'exact' || outcome.verdict !== 'fail') return [];
  return outcome.findings.filter((f) => {
    const correction = outcome.corrections.findLast((c) => c.findingId === f.id);
    return (correction?.classification ?? f.classification) === 'code' && f.confirmed && f.attributableTo !== null;
  });
}
