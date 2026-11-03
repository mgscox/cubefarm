// The manager's decision on a Proposal (one exact PRD + Issue Plan pair): handoff checks and decision rules.
// Pure; swarm.ts serializes, persists and hands decisions to the downstream workers.
import type { IdeaView, ProposalDecisionInput, ProposalIssue, ProposalReview, ProposalView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';

export const MAX_REVIEW_ROUNDS = 3;
const MAX_FEEDBACK = 5000;

/** What review hands over when it promotes a Proposal (fresh, or a revision after a refinement request). */
export type ProposalHandoff = Pick<ProposalView, 'ideaId' | 'prd' | 'plan' | 'reviews' | 'reviewSkipped' | 'revises'>;

/** Where decided Proposals go next. Both calls must be idempotent per Proposal: they are repeated after a restart. */
export interface ProposalWorker {
  /** Take an approved Proposal's exact pair for publication. */
  publish(proposal: ProposalView): void;
  /** Ask the lead to revise a Proposal the manager sent back; the revision returns through `submitProposal`. */
  refine(proposal: ProposalView): void;
  stop(): void;
}

const revision = (v: unknown, name: string) => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new HttpError(400, `${name} must be a positive revision number`);
  return v as number;
};

function checkIssues(issues: ProposalIssue[], floors: string[]) {
  if (!Array.isArray(issues) || issues.length === 0) throw new HttpError(400, 'An Issue Plan needs at least one issue');
  const keys = new Set<string>();
  for (const issue of issues) {
    if (!issue.key || keys.has(issue.key)) throw new HttpError(400, `Plan issue keys must be unique: "${issue.key}"`);
    keys.add(issue.key);
    if (!issue.title?.trim()) throw new HttpError(400, `Plan issue ${issue.key} needs a title`);
    if (!floors.includes(issue.repo)) throw new HttpError(400, `Plan issue ${issue.key} targets ${issue.repo}, which is not a configured floor`);
  }
  for (const issue of issues) {
    for (const dep of issue.blockedBy) {
      if (dep === issue.key || !keys.has(dep)) throw new HttpError(400, `Plan issue ${issue.key} waits for unknown issue "${dep}"`);
    }
  }
  // Depth-first: a cycle would hold every issue on it forever.
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const state = new Map<string, 'open' | 'done'>();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'open') throw new HttpError(400, `Plan dependencies form a cycle: ${[...path, key].join(' waits for ')}`);
    state.set(key, 'open');
    for (const dep of byKey.get(key)!.blockedBy) visit(dep, [...path, key]);
    state.set(key, 'done');
  };
  for (const issue of issues) visit(issue.key, []);
}

/**
 * True when `next` changes only wording against `prev`: the same issues on the same floors, with the same reused issues,
 * requirements, dependencies and number of acceptance criteria. Anything else needs a fresh review cycle.
 */
export function wordingOnly(prev: ProposalView['plan'], next: ProposalView['plan']): boolean {
  if (prev.issues.length !== next.issues.length) return false;
  const before = new Map(prev.issues.map((i) => [i.key, i]));
  return next.issues.every((i) => {
    const b = before.get(i.key);
    return !!b && b.repo === i.repo && b.existing?.number === i.existing?.number && b.requirement === i.requirement
      && b.criteria.length === i.criteria.length && [...b.blockedBy].sort().join() === [...i.blockedBy].sort().join();
  });
}

/** Check a review handoff and turn it into an open Proposal awaiting the manager's decision. */
export function proposalFromHandoff(
  handoff: ProposalHandoff,
  ctx: { idea?: IdeaView; proposals: ProposalView[]; floors: string[] },
  id: string,
  at: number,
): ProposalView {
  const { idea } = ctx;
  if (!idea) throw new HttpError(404, 'Unknown Idea');
  if (idea.status === 'archived') throw new HttpError(409, 'This Idea is archived; start a linked Idea instead');
  const mine = ctx.proposals.filter((p) => p.ideaId === idea.id);
  if (mine.some((p) => !p.decision)) throw new HttpError(409, 'This Idea already has a Proposal awaiting a decision; note newer drafts on it instead');
  revision(handoff.prd?.revision, 'The PRD');
  revision(handoff.plan?.revision, 'The Issue Plan');
  if (!handoff.prd.title?.trim() || !handoff.prd.body?.trim()) throw new HttpError(400, 'The PRD revision needs a title and body');
  checkIssues(handoff.plan.issues, ctx.floors);
  const reviews: ProposalReview[] = handoff.reviews ?? [];
  if (reviews.some((r) => !Number.isInteger(r.round) || r.round < 1 || r.round > MAX_REVIEW_ROUNDS)) {
    throw new HttpError(400, `Review rounds run from 1 to ${MAX_REVIEW_ROUNDS}`);
  }
  if (handoff.revises) {
    const prev = mine.find((p) => p.id === handoff.revises);
    if (prev?.decision?.action !== 'refine') throw new HttpError(409, 'A revision must answer a refinement request on the same Idea');
    if (mine.some((p) => p.revises === prev.id)) throw new HttpError(409, 'That refinement request already has a revised Proposal');
    if (handoff.reviewSkipped && !wordingOnly(prev.plan, handoff.plan)) {
      throw new HttpError(400, 'This revision changes issues, floors, dependencies or scope, so it needs a fresh review cycle');
    }
  } else if (handoff.reviewSkipped) {
    throw new HttpError(400, 'Only a wording revision can skip review');
  }
  if (!handoff.reviewSkipped && !reviews.some((r) => r.prdRevision === handoff.prd.revision)) {
    throw new HttpError(400, `No review covers PRD v${handoff.prd.revision}`);
  }
  return {
    id, ideaId: idea.id, prd: handoff.prd, plan: handoff.plan, reviews,
    ...(handoff.reviewSkipped ? { reviewSkipped: true } : {}),
    ...(handoff.revises ? { revises: handoff.revises } : {}),
    createdAt: at,
  };
}

/** Flag a newer draft on an open Proposal; null when there's nothing to change. The displayed pair stays approvable. */
export function withNewerDraft(p: ProposalView, draft: { prdRevision: number; planRevision: number }, at: number): ProposalView | null {
  if (p.decision) return null;
  const { prdRevision, planRevision } = draft;
  if (prdRevision < p.prd.revision || planRevision < p.plan.revision) return null;
  if (prdRevision === p.prd.revision && planRevision === p.plan.revision) return null;
  const seen = p.newerDraft;
  if (seen && prdRevision <= seen.prdRevision && planRevision <= seen.planRevision) return null;
  return { ...p, newerDraft: { prdRevision, planRevision, at } };
}

const PAST: Record<ProposalDecisionInput['action'], string> = { approve: 'approved', refine: 'sent back for refinement', reject: 'rejected' };

/**
 * The manager's decision on the exact pair the card displayed. A repeat of the decision already recorded returns
 * `repeated` (nothing to persist or hand off again); a different second decision is refused.
 */
export function decideProposal(p: ProposalView, idea: IdeaView | undefined, input: unknown, at: number): { proposal: ProposalView; repeated: boolean } {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'A decision is required');
  const body = input as Record<string, unknown>;
  const action = body.action;
  if (action !== 'approve' && action !== 'refine' && action !== 'reject') throw new HttpError(400, 'Decide with approve, refine or reject');
  if (body.prdRevision !== p.prd.revision || body.planRevision !== p.plan.revision) {
    throw new HttpError(409, `This Proposal is PRD v${p.prd.revision} · Issue Plan v${p.plan.revision}; reload the card and decide again`);
  }
  if (p.decision) {
    if (p.decision.action === action) return { proposal: p, repeated: true };
    throw new HttpError(409, `This Proposal was already ${PAST[p.decision.action]}`);
  }
  if (!idea) throw new HttpError(404, 'Unknown Idea');
  if (idea.status === 'archived') throw new HttpError(409, 'This Idea is archived');
  if (body.feedback !== undefined && typeof body.feedback !== 'string') throw new HttpError(400, 'Feedback must be text');
  const feedback = ((body.feedback as string | undefined) ?? '').trim();
  if (feedback.length > MAX_FEEDBACK) throw new HttpError(400, `Feedback must be at most ${MAX_FEEDBACK} characters`);
  if (action === 'approve') return { proposal: { ...p, decision: { action, at, publication: { status: 'queued', at } } }, repeated: false };
  if (action === 'refine') {
    if (!feedback) throw new HttpError(400, 'Say what should change so the agents can refine it');
    return { proposal: { ...p, decision: { action, at, feedback, wordingOnly: body.wordingOnly === true } }, repeated: false };
  }
  return { proposal: { ...p, decision: { action, at, ...(feedback ? { feedback } : {}) } }, repeated: false };
}
