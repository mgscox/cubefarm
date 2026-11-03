// Review rounds for an Idea's PRD and Issue Plan: who reviews, what counts as joint endorsement, when to promote.
import type { AgentView, IdeaFindingView, IdeaReviewCycleView, IdeaReviewFocus, IdeaReviewRoundView, IdeaReviewView } from './types.ts';

/** Rounds per proposal, counting the initial review. */
export const MAX_REVIEW_ROUNDS = 3;
export const REVIEW_FOCUSES: IdeaReviewFocus[] = ['evidence', 'feasibility'];
export const FOCUS_LABEL: Record<IdeaReviewFocus, string> = {
  evidence: 'Evidence & requirements',
  feasibility: 'Feasibility across floors & dependencies',
};

const ROLE_ORDER: AgentView['role'][] = ['researcher', 'qa', 'dev'];

/** Two different agents who did not write the PRD, researchers first; null when the office has fewer. */
export function pickReviewers(author: string, agents: Pick<AgentView, 'id' | 'role'>[]): Record<IdeaReviewFocus, string> | null {
  const pool = ROLE_ORDER.flatMap((role) => agents.filter((a) => a.role === role && a.id !== author).map((a) => a.id));
  return pool.length < 2 ? null : { evidence: pool[0], feasibility: pool[1] };
}

export function startReview(ideaId: string, author: string, reviewers: Record<IdeaReviewFocus, string>, prdRevision: number, planRevision: number): IdeaReviewCycleView {
  if (Object.values(reviewers).includes(author) || reviewers.evidence === reviewers.feasibility) throw new Error('Reviewers must be two agents other than the author');
  return { ideaId, author, reviewers, rounds: [{ round: 1, prdRevision, planRevision, reviews: [] }], handoff: null };
}

export const currentRound = (cycle: IdeaReviewCycleView): IdeaReviewRoundView => cycle.rounds[cycle.rounds.length - 1];

/** Records one review; a review of another revision, by someone else or repeated is refused, so it can never count. */
export function recordReview(cycle: IdeaReviewCycleView, review: IdeaReviewView): IdeaReviewCycleView {
  const round = currentRound(cycle);
  if (cycle.handoff) throw new Error('This proposal has already been promoted');
  if (review.prdRevision !== round.prdRevision) throw new Error(`Review of PRD r${review.prdRevision}, but round ${round.round} is reviewing r${round.prdRevision}`);
  if (review.reviewer === cycle.author || review.reviewer !== cycle.reviewers[review.focus]) throw new Error(`${review.reviewer} is not the ${review.focus} reviewer`);
  if (round.reviews.some((r) => r.focus === review.focus)) throw new Error(`Round ${round.round} already has a ${review.focus} review`);
  if (review.verdict === 'findings' && review.findings.length === 0) throw new Error('A review with findings must list them');
  const recorded: IdeaReviewView = { ...review, findings: review.verdict === 'endorse' ? [] : review.findings };
  return { ...cycle, rounds: [...cycle.rounds.slice(0, -1), { ...round, reviews: [...round.reviews, recorded] }] };
}

/** Both focuses endorsed this exact PRD revision. */
export function jointlyEndorsed(round: IdeaReviewRoundView): boolean {
  return REVIEW_FOCUSES.every((focus) => round.reviews.some((r) => r.focus === focus && r.prdRevision === round.prdRevision && r.verdict === 'endorse'));
}

/** What happens once the current round is in: wait, promote, or ask the lead for another revision. */
export function nextStep(cycle: IdeaReviewCycleView): 'done' | 'wait' | 'promote' | 'revise' {
  if (cycle.handoff) return 'done';
  const round = currentRound(cycle);
  if (round.reviews.length < REVIEW_FOCUSES.length) return 'wait';
  return jointlyEndorsed(round) || round.round >= MAX_REVIEW_ROUNDS ? 'promote' : 'revise';
}

/** The lead's next revision of both the PRD and its Issue Plan opens the next round. */
export function reviseRound(cycle: IdeaReviewCycleView, prdRevision: number, planRevision: number): IdeaReviewCycleView {
  const round = currentRound(cycle);
  if (nextStep(cycle) !== 'revise') throw new Error('This proposal is not waiting for a revision');
  if (prdRevision <= round.prdRevision || planRevision <= round.planRevision) throw new Error('A revision must be newer than the one reviewed');
  return { ...cycle, rounds: [...cycle.rounds, { round: round.round + 1, prdRevision, planRevision, reviews: [] }] };
}

/** Hands the latest pair to the manager, carrying any findings still open on it. */
export function promote(cycle: IdeaReviewCycleView, at: number): IdeaReviewCycleView {
  const step = nextStep(cycle);
  if (step !== 'promote') throw new Error(`This proposal can't be promoted yet (${step})`);
  const round = currentRound(cycle);
  const unresolved: IdeaFindingView[] = round.reviews.flatMap((r) => r.findings.map((text) => ({ focus: r.focus, reviewer: r.reviewer, text })));
  const endorsed = jointlyEndorsed(round);
  return { ...cycle, handoff: { prdRevision: round.prdRevision, planRevision: round.planRevision, round: round.round, endorsed, unresolved, at } };
}
