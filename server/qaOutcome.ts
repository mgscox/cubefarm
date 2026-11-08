// QA's failure limit is independent of merge repair.
import type { QaStatus } from '../shared/types.ts';

interface QaResult {
  pass: boolean;
  incomplete: boolean;
  escalate: boolean;
  qaRounds: number;
}

export function qaOutcome(result: QaResult, maxQaRounds: number): QaStatus {
  if (result.escalate) return 'queued';
  if (result.pass) return 'passed';
  return result.incomplete || result.qaRounds >= maxQaRounds ? 'needs-human' : 'failed';
}
