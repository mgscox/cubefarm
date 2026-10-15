// PR ownership and bounded retries before a session can start.

import type { AgentStatus, DeskPreparation } from '../shared/types.ts';

/** The parts of the PR's author that decide who gets its fix. */
export interface FixAuthor {
  status: AgentStatus;
  branch: string | null;
  prNumber: number | null;
}

/**
 * Who takes a failed PR's fix: its author when they're free; nobody yet while the author is still in a session on that
 * PR or its branch (they get it when the session ends); anyone free when the author is gone, errored or on other work.
 */
export function fixGoesTo(author: FixAuthor | null, authorFree: boolean, prNumber: number, headRef: string | null): 'author' | 'wait' | 'anyone' {
  if (!author) return 'anyone';
  if (authorFree) return 'author';
  const live = author.status === 'preparing' || author.status === 'working';
  return live && (author.prNumber === prNumber || (!!headRef && author.branch === headRef)) ? 'wait' : 'anyone';
}

/** Two failed desks cause a hold; the second hold requires an explicit handoff. */
export const PREP_HOLD_MS = 10 * 60_000;

export function prepFailure(previous: DeskPreparation | undefined, headSha: string | null, now: number) {
  const prev = previous?.headSha === headSha ? previous : undefined;
  const failures = (prev?.failures ?? 0) + 1;
  const holds = (prev?.holds ?? 0) + (failures >= 2 ? 1 : 0);
  const next = failures < 2 ? 'retry' : holds >= 2 ? 'needs-human' : 'hold';
  return {
    next,
    strikes: { headSha, failures: failures < 2 ? failures : 0, holds, holdUntil: failures < 2 ? 0 : now + PREP_HOLD_MS },
  } as const;
}

export const prepHeld = (strikes: DeskPreparation | undefined, headSha: string | null, now: number) =>
  strikes?.headSha === headSha && now < strikes.holdUntil;
