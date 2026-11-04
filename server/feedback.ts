// Persistent identities for developer rewards, independent of desks and QA record cleanup.
import type { AgentRole } from '../shared/types.ts';

export type FeedbackEvent = { repoId: string; prNumber: number; devAgentId: string | null } & (
  | { kind: 'merged' }
  | { kind: 'qa-send-back'; reviewId: string; round: number }
);

/** Only the recorded developer receives feedback; a merge or QA round can count once. */
export function developerFeedback(
  event: FeedbackEvent,
  developer: { id: string; repoId: string; role: AgentRole; score?: number } | undefined,
  recorded: Record<string, true>,
): { key: string; score: number } | null {
  const key = `${event.repoId}#${event.prNumber}:${event.kind}${event.kind === 'qa-send-back' ? `:${event.reviewId}:${event.round}` : ''}`;
  if (recorded[key] || !developer || developer.id !== event.devAgentId || developer.role !== 'dev' || developer.repoId !== event.repoId) return null;
  return { key, score: (developer.score ?? 0) + (event.kind === 'merged' ? 2 : -1) };
}
