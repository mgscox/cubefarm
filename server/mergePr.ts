// CEO merge preflight: the manager can override findings, but never merge an unseen head.
import type { PullInfo, QaView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { checkParkPr } from './parkPr.ts';

export function checkMergePr(number: number, repo: string, context: {
  merging: boolean;
  syncing: boolean;
  parking: boolean;
  busy: boolean;
  qa?: { status: QaView['status']; testedSha?: string | null };
  pull?: Pick<PullInfo, 'state' | 'headSha' | 'mergeable' | 'mergeState'>;
}): string {
  checkParkPr(number, repo, context);
  if (!context.pull || context.pull.state !== 'OPEN') throw new HttpError(404, `PR #${number} is not open on ${repo}`);
  if (context.qa?.status === 'testing' || context.qa?.status === 'fixing') {
    throw new HttpError(409, `PR #${number} is mid-QA or mid-fix; wait until it finishes`);
  }
  const sha = context.qa?.testedSha;
  if (!sha) throw new HttpError(409, `PR #${number} has no tested head; run QA before merging`);
  if (context.pull.headSha !== sha) throw new HttpError(409, `PR #${number}'s head moved since QA; test the new commits before merging`);
  if (context.pull.mergeable === 'CONFLICTING' || context.pull.mergeState === 'DIRTY') {
    throw new HttpError(409, `PR #${number} is conflicting; send it back to a developer before merging`);
  }
  return sha;
}
