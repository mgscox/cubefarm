import { describe, expect, it } from 'vitest';
import type { IdeaView, ProposalReview, ProposalView } from '../../shared/types';
import { ideaProposals, ideaStage, newerDraftNote, reviewSummary, targetFloors, unresolvedFindings } from './proposals';

const idea: IdeaView = { id: 'i1', description: 'Idea', links: [], constraints: '', floorHints: [], status: 'queued', createdAt: 1 };
const review = (round: number, focus: ProposalReview['focus'], endorsed: boolean, findings: string[] = []): ProposalReview =>
  ({ reviewer: focus === 'evidence' ? 'Ada' : 'Grace', focus, prdRevision: round, planRevision: 4, round, endorsed, findings });
const proposal = (patch: Partial<ProposalView> = {}): ProposalView => ({
  id: 'p1', ideaId: 'i1', createdAt: 1, prd: { revision: 2, title: 'PRD', body: '' },
  plan: { revision: 4, issues: [
    { key: 'a', title: 'A', repo: 'o/api', brief: '', criteria: [], blockedBy: [] },
    { key: 'b', title: 'B', repo: 'o/app', brief: '', criteria: [], blockedBy: ['a'] },
    { key: 'c', title: 'C', repo: 'o/api', brief: '', criteria: [], blockedBy: [] },
  ] },
  reviews: [review(1, 'evidence', false, ['Old']), review(1, 'feasibility', false, ['Older']), review(2, 'evidence', true), review(2, 'feasibility', false, ['Still slow'])],
  ...patch,
});

describe('approval card', () => {
  it('lists only findings still open after the latest round', () => {
    expect(unresolvedFindings(proposal())).toEqual([{ reviewer: 'Grace', focus: 'feasibility', text: 'Still slow' }]);
    expect(reviewSummary(proposal())).toBe('Promoted after 2 review rounds with 1 unresolved finding');
  });

  it('names joint endorsement and wording-only returns', () => {
    expect(reviewSummary(proposal({ reviews: [review(2, 'evidence', true), review(2, 'feasibility', true)] }))).toBe('Endorsed by both reviewers in round 2');
    expect(reviewSummary(proposal({ reviewSkipped: true }))).toMatch(/without a fresh review/);
  });

  it('shows each target floor once, in plan order', () => {
    expect(targetFloors(proposal())).toEqual(['o/api', 'o/app']);
  });

  it('flags a newer draft while the displayed pair stays the one approved', () => {
    expect(newerDraftNote(proposal())).toBeNull();
    expect(newerDraftNote(proposal({ newerDraft: { prdRevision: 2, planRevision: 5, at: 3 } })))
      .toBe('A newer draft exists (Issue Plan v5). Approving still publishes exactly this card: PRD v2 · Issue Plan v4.');
    expect(newerDraftNote(proposal({ newerDraft: { prdRevision: 3, planRevision: 5, at: 3 }, decision: { action: 'approve', at: 4 } }))).toBeNull();
  });
});

describe('Idea stage', () => {
  it.each<[Partial<ProposalView> | null, string]>([
    [null, 'Queued'],
    [{}, 'Awaiting decision'],
    [{ decision: { action: 'approve', at: 2, publication: { status: 'queued', at: 2 } } }, 'Approved · queued for publication'],
    [{ decision: { action: 'approve', at: 2, publication: { status: 'accepted', at: 3 } } }, 'Approved · handed to publication'],
    [{ decision: { action: 'refine', at: 2, feedback: 'x', wordingOnly: true } }, 'Refining wording'],
    [{ decision: { action: 'refine', at: 2, feedback: 'x' } }, 'Refining · fresh review'],
  ])('follows the latest Proposal: %j', (patch, stage) => {
    expect(ideaStage(idea, patch ? [proposal(patch)] : [])).toBe(stage);
  });

  it('reads as archived once rejected, and orders an Idea\'s Proposals oldest first', () => {
    expect(ideaStage({ ...idea, status: 'archived' }, [proposal()])).toBe('Archived');
    const list = ideaProposals([proposal({ id: 'late', createdAt: 9 }), proposal({ id: 'other', ideaId: 'i2' }), proposal({ id: 'early', createdAt: 2 })], 'i1');
    expect(list.map((p) => p.id)).toEqual(['early', 'late']);
  });
});
