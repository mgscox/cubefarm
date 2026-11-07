// CEO merge preflight: the manager can override findings, but never merge an unseen head.
import type { PullInfo, QaOutcomeView, QaView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { checkParkPr } from './parkPr.ts';

export function checkMergePr(number: number, repo: string, context: {
  merging: boolean;
  syncing: boolean;
  parking: boolean;
  busy: boolean;
  qa?: { status: QaView['status']; testedSha?: string | null; passedSha?: string | null; failedSha?: string | null; attempt?: { id: string } };
  /** The record's latest QA outcome: its posted report covers an incomplete verdict, which sets no failedSha. */
  outcome?: Pick<QaOutcomeView, 'id' | 'headSha' | 'commentUrl'> | null;
  pull?: Pick<PullInfo, 'state' | 'headSha' | 'mergeable' | 'mergeState'>;
}): string {
  checkParkPr(number, repo, context);
  if (!context.pull || context.pull.state !== 'OPEN') throw new HttpError(404, `PR #${number} is not open on ${repo}`);
  if (context.qa?.status === 'testing' || context.qa?.status === 'fixing') {
    throw new HttpError(409, `PR #${number} is mid-QA or mid-fix; wait until it finishes`);
  }
  const sha = context.qa?.testedSha;
  // A branch update may advance passedSha; a failed QA attempt then advances testedSha without a report.
  const reported = context.qa?.status === 'passed' ? context.qa.passedSha :
    context.qa?.status === 'failed' || context.qa?.status === 'needs-human' ? context.qa.failedSha : null;
  // Incomplete QA holds the PR for the manager; auto-merge never sees it, only this explicit override does.
  // Only the latest attempt's report counts: an earlier session's report says nothing about the one that stalled.
  const posted = context.qa?.status === 'needs-human' && context.outcome?.commentUrl && !!context.qa.attempt &&
    context.outcome.id === context.qa.attempt.id ? context.outcome.headSha : null;
  if (!sha || (reported !== sha && posted !== sha)) {
    throw new HttpError(409, `PR #${number} has no completed QA report for its tested head; run QA before merging`);
  }
  if (context.pull.headSha !== sha) throw new HttpError(409, `PR #${number}'s head moved since QA; test the new commits before merging`);
  if (context.pull.mergeable === 'CONFLICTING' || context.pull.mergeState === 'DIRTY') {
    throw new HttpError(409, `PR #${number} is conflicting; send it back to a developer before merging`);
  }
  return sha;
}

/**
 * The manager may merge over an incomplete security audit: the audit attempt itself (the record's current attempt,
 * which the audit started) posted its report at exactly this head and base. A failed audit (failedSha), one that never
 * posted a report, or a report from regular QA or an earlier attempt still holds the merge.
 */
export function incompleteAuditOverride(
  qa: { status: QaView['status']; failedSha?: string | null; attempt?: { id: string }; securityReview?: { qaSha: string | null; auditBaseSha?: string } },
  outcome: Pick<QaOutcomeView, 'id' | 'headSha' | 'baseSha' | 'commentUrl'> | null | undefined,
  pr: { headSha: string; baseSha?: string | null },
): boolean {
  const review = qa.securityReview;
  return qa.status === 'needs-human' && !!outcome?.commentUrl && !!qa.attempt && outcome.id === qa.attempt.id &&
    qa.failedSha !== pr.headSha && !!review?.auditBaseSha &&
    review.qaSha === pr.headSha && review.auditBaseSha === pr.baseSha && outcome.headSha === pr.headSha && outcome.baseSha === pr.baseSha;
}
