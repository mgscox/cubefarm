// Parking preflight is pure so session and repository races can be checked without GitHub.
import { HttpError } from './httpError.ts';

export function checkParkPr(number: number, repo: string, context: {
  merging: boolean;
  syncing: boolean;
  parking: boolean;
  busy: boolean;
}) {
  if (context.merging) throw new HttpError(409, `A merge is in progress on ${repo}; try again once it finishes`);
  if (context.syncing || context.parking) throw new HttpError(409, `${repo} is refreshing or parking a PR; try again once it finishes`);
  if (context.busy) throw new HttpError(409, `PR #${number} is mid-QA or mid-fix; wait until QA or its fix finishes`);
}
