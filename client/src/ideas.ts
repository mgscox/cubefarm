// Wording for an Idea's state and its proposal review, kept pure for tests.
import { MAX_REVIEW_ROUNDS, currentRound, nextStep } from '../../shared/ideaReview';
import type { IdeaRecordView, IdeaReviewCycleView, IdeaReviewView, IdeaView, ProposalView } from '../../shared/types';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ideaStatusLabel(idea: IdeaView, cycle?: IdeaReviewCycleView): string {
  if (idea.status === 'proposed' && cycle?.handoff) return cycle.handoff.endorsed ? 'Proposed · endorsed' : `Proposed · ${plural(cycle.handoff.unresolved.length, 'open finding')}`;
  if (idea.status === 'reviewing' && cycle) return `In review · round ${currentRound(cycle).round} of ${MAX_REVIEW_ROUNDS}`;
  return { queued: 'Queued', researching: 'Researching', 'needs-clarification': 'Needs clarification', researched: 'PRD ready', reviewing: 'In review', proposed: 'Proposed', archived: 'Archived' }[idea.status];
}

/** What `#idea/<id>/prd/<revision>` names on this Idea: a Proposal's PRD, a research PRD revision record, or nothing yet. */
export function prdLinkTarget(prd: string | undefined, proposals: ProposalView[], records: IdeaRecordView[]): 'proposal' | 'revision' | 'missing' | null {
  if (!prd) return null;
  if (proposals.some((p) => p.id === prd)) return 'proposal';
  return records.some((r) => r.id === prd && r.prd) ? 'revision' : 'missing';
}

/** What the review is waiting on, or how it ended. */
export function reviewProgress(cycle: IdeaReviewCycleView, name: (id: string) => string): string {
  const round = currentRound(cycle);
  const step = nextStep(cycle);
  if (step === 'revise') return `${name(cycle.author)} is revising after round ${round.round}.`;
  if (step === 'wait' || step === 'promote') return `Round ${round.round}: reviewing PRD r${round.prdRevision} and Issue Plan r${round.planRevision}.`;
  const h = cycle.handoff!;
  return h.endorsed
    ? `Both reviewers endorsed PRD r${h.prdRevision}. Ready for your decision.`
    : `No joint endorsement after ${plural(h.round, 'round')}. Ready for your decision, with the open findings below.`;
}

export function verdictText(review: IdeaReviewView | undefined): string {
  if (!review) return 'Reviewing…';
  return review.verdict === 'endorse' ? `Endorsed r${review.prdRevision}` : `${plural(review.findings.length, 'finding')} on r${review.prdRevision}`;
}
