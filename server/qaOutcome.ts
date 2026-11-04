// QA's outcome keeps its own round limit; a final ordinary failure can still use the conflict-fix budget.
import type { PullInfo, QaStatus } from '../shared/types.ts';
import { MAX_MERGE_FIXES } from './mergeGate.ts';

interface QaResult {
  pass: boolean;
  incomplete: boolean;
  escalate: boolean;
  security: boolean;
  qaRounds: number;
  mergeFixes: number;
}

export function qaOutcome(result: QaResult, pr: Pick<PullInfo, 'mergeable' | 'mergeState'> | null, maxQaRounds: number): { status: QaStatus; conflictFix: boolean } {
  if (result.escalate) return { status: 'queued', conflictFix: false };
  if (result.pass) return { status: 'passed', conflictFix: false };
  if (result.incomplete) return { status: 'needs-human', conflictFix: false };
  if (result.qaRounds < maxQaRounds) return { status: 'failed', conflictFix: false };
  if (!result.security && result.mergeFixes < MAX_MERGE_FIXES && (pr?.mergeable === 'CONFLICTING' || pr?.mergeState === 'DIRTY')) {
    return { status: 'failed', conflictFix: true };
  }
  return { status: 'needs-human', conflictFix: false };
}
