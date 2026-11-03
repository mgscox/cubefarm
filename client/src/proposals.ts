// What the approval card says about an Idea's Proposals: its stage, the review outcome and unresolved findings.
import type { IdeaView, ProposalView } from '../../shared/types';

/** An Idea's Proposals, oldest first; the last one is what the card shows. */
export function ideaProposals(all: ProposalView[], ideaId: string): ProposalView[] {
  return all.filter((p) => p.ideaId === ideaId).sort((a, b) => a.createdAt - b.createdAt);
}

export function ideaStage(idea: IdeaView, proposals: ProposalView[]): string {
  if (idea.status === 'archived') return 'Archived';
  const latest = proposals[proposals.length - 1];
  if (!latest) return 'Queued';
  const d = latest.decision;
  if (!d) return 'Awaiting decision';
  if (d.action === 'approve') return d.publication?.status === 'accepted' ? 'Approved · handed to publication' : 'Approved · queued for publication';
  if (d.action === 'refine') return d.wordingOnly ? 'Refining wording' : 'Refining · fresh review';
  return 'Archived';
}

export interface Finding { reviewer: string; focus: string; text: string }

/** Findings from the latest review round that the reviewers didn't withdraw by endorsing. */
export function unresolvedFindings(p: ProposalView): Finding[] {
  const round = Math.max(0, ...p.reviews.map((r) => r.round));
  return p.reviews.filter((r) => r.round === round && !r.endorsed)
    .flatMap((r) => r.findings.map((text) => ({ reviewer: r.reviewer, focus: r.focus, text })));
}

export function reviewSummary(p: ProposalView): string {
  if (p.reviewSkipped) return 'Wording revision — returned without a fresh review';
  const round = Math.max(0, ...p.reviews.map((r) => r.round));
  const last = p.reviews.filter((r) => r.round === round && r.prdRevision === p.prd.revision);
  if (last.length >= 2 && last.every((r) => r.endorsed)) return `Endorsed by both reviewers in round ${round}`;
  const open = unresolvedFindings(p).length;
  return `Promoted after ${round} review round${round === 1 ? '' : 's'} with ${open} unresolved finding${open === 1 ? '' : 's'}`;
}

/** Floors the plan touches, in plan order. */
export function targetFloors(p: ProposalView): string[] {
  return [...new Set(p.plan.issues.map((i) => i.repo))];
}

export function newerDraftNote(p: ProposalView): string | null {
  const d = p.newerDraft;
  if (!d || p.decision) return null;
  const parts = [d.prdRevision > p.prd.revision && `PRD v${d.prdRevision}`, d.planRevision > p.plan.revision && `Issue Plan v${d.planRevision}`].filter(Boolean);
  return `A newer draft exists (${parts.join(' · ')}). Approving still publishes exactly this card: PRD v${p.prd.revision} · Issue Plan v${p.plan.revision}.`;
}
