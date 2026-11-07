// Persistent identities for developer rewards, independent of desks and QA record cleanup.
import type { AgentRole } from '../shared/types.ts';

/** `crossRepository`: the PR came from a fork; only a PR confirmed to be from the floor's own repo scores. */
export type FeedbackEvent = { repoId: string; prNumber: number; devAgentId: string | null; crossRepository?: boolean } & (
  | { kind: 'merged' }
  | { kind: 'qa-send-back'; reviewId: string; round: number; findingIds?: string[] }
);

/** Legacy penalties require eligible finding IDs; retries of the same findings are neutral. */
export function developerFeedback(
  event: FeedbackEvent,
  developer: { id: string; repoId: string; role: AgentRole; score?: number } | undefined,
  recorded: Record<string, true>,
): { key: string; keys: string[]; score: number } | null {
  const prefix = `${event.repoId}#${event.prNumber}:${event.kind}`;
  const keys = (event.kind === 'merged' ? [prefix] : (event.findingIds ?? []).map((id) => `${prefix}:${id}`)).filter((key) => !recorded[key]);
  const key = keys[0];
  if (!key) return null;
  if (event.crossRepository !== false || !developer || developer.id !== event.devAgentId || developer.role !== 'dev' || developer.repoId !== event.repoId) return null;
  return { key, keys, score: (developer.score ?? 0) + (event.kind === 'merged' ? 2 : -1) };
}
