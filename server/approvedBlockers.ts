// The dispatch guard for issues published from an Idea: an approved prerequisite holds its dependent on both start
// paths (auto-assign and the manager's explicit start) until a fresh tracker read confirms it was delivered. The
// prerequisites come from the approved plan and the issues publication recorded, not from the issue's mutable body or
// a cached native-dependency read. Ordinary issues have no origin and keep their usual rules.
import type { TrackedIssue } from './github.ts';
import type { PublishedStep } from '../shared/types.ts';

/** An approved prerequisite resolved to the issue publication recorded for it (repo/number null: not created yet). */
export interface ResolvedBlocker {
  ref: string; // owner/name#number, or "plan entry <id>" while it has no issue
  repo: string | null;
  number: number | null;
}

/** What dispatch knows about an issue published from an Idea. */
export interface IdeaIssueOrigin {
  proposalId: string;
  entryId: string;
  step: PublishedStep;
  tracking: boolean;
  blockers: ResolvedBlocker[];
}

/** The latest read of a prerequisite. A failed read replaces an earlier answer: an unreadable one never counts as delivered. */
export type BlockerReading = { state: 'OPEN' | 'CLOSED'; stateReason: string | null } | 'missing' | 'unreadable';

export const blockerKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** A prerequisite is delivered once it is closed as completed; closed as not planned or a duplicate is not delivery. */
export const delivered = (r: BlockerReading | undefined) => typeof r === 'object' && r.state === 'CLOSED' && r.stateReason === 'completed';

/** Read one prerequisite back from the tracker, failing closed. */
export async function readBlocker(read: () => Promise<TrackedIssue | null>): Promise<BlockerReading> {
  try {
    const got = await read();
    return got ? { state: got.state, stateReason: got.stateReason ?? null } : 'missing';
  } catch {
    return 'unreadable';
  }
}

function blockerNote(b: ResolvedBlocker, r: BlockerReading | undefined) {
  if (b.number === null) return `${b.ref} (not published yet)`;
  if (r === undefined) return `${b.ref} (not read yet)`;
  if (r === 'unreadable') return `${b.ref} (unreadable)`;
  if (r === 'missing') return `${b.ref} (missing)`;
  if (r.state === 'OPEN') return `${b.ref} (open)`;
  return `${b.ref} (closed${r.stateReason ? ` as ${r.stateReason.replace(/_/g, ' ')}` : ''}, delivery not confirmed)`;
}

/**
 * Why an Idea issue must wait (null: it may start, and the ordinary readiness rules take over). A Tracking Parent
 * never starts; any other issue waits until each approved prerequisite reads back closed as completed.
 */
export function approvedHold(origin: IdeaIssueOrigin | null, readings: ReadonlyMap<string, BlockerReading>): string | null {
  if (!origin) return null;
  if (origin.tracking) return 'Tracking Parent: groups planned work, never dispatched';
  const waits = origin.blockers
    .map((b) => ({ b, r: b.repo === null || b.number === null ? undefined : readings.get(blockerKey(b.repo, b.number)) }))
    .filter(({ b, r }) => b.number === null || !delivered(r))
    .map(({ b, r }) => blockerNote(b, r));
  return waits.length ? `waits for approved prerequisite ${waits.join(', ')}` : null;
}
