// Durable authorship decisions, independent of the current QA owner.
import type { PrContributionView } from '../shared/types.ts';
import type { PrDetails } from './github.ts';

/** Branch identity, repository origin and task timing must all verify a developer handoff. */
export function submittedContribution(
  history: PrContributionView,
  pr: PrDetails,
  agent: { id: string; name: string; task: string | null; branch: string | null; startedAt: number | null },
  now: number,
): PrContributionView {
  const created = Date.parse(pr.createdAt ?? '');
  if (history.original || history.repairs.length || agent.task !== 'issue' || !agent.startedAt ||
    pr.state !== 'OPEN' || pr.isCrossRepository !== false || pr.headRefName !== agent.branch || !pr.headSha ||
    !Number.isFinite(created) || created < agent.startedAt) return history;
  return { ...history, original: { agentId: agent.id, name: agent.name, submittedSha: pr.headSha, at: now } };
}

/** A late callback cannot submit a revision for an earlier owner's repair. */
export function finishedContribution(history: PrContributionView, attemptId: string, agentId: string, sha: string | null, now: number): PrContributionView {
  const attempt = history.repairs.find((r) => r.id === attemptId && r.agentId === agentId && r.finishedAt === null);
  if (!attempt) return history;
  return { ...history, repairs: history.repairs.map((r) => r === attempt ? { ...r, submittedSha: sha, finishedAt: now } : r) };
}
