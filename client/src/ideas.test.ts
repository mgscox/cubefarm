import { describe, expect, it } from 'vitest';
import { promote, recordReview, reviseRound, startReview } from '../../shared/ideaReview';
import type { IdeaReviewView, IdeaView, ProposalView } from '../../shared/types';
import { ideaStatusLabel, prdLinkTarget, reviewProgress, verdictText } from './ideas';

const idea: IdeaView = { id: 'i1', description: 'x', links: [], constraints: '', floorHints: [], status: 'queued', createdAt: 0 };
const cycle = startReview('i1', 'lead', { evidence: 'ada', feasibility: 'bo' }, 1, 1);
const endorse = (focus: 'evidence' | 'feasibility', reviewer: string, rev = 1): IdeaReviewView => ({ focus, reviewer, prdRevision: rev, verdict: 'endorse', findings: [], at: 0 });
const object = (rev: number, findings = ['Too big']): IdeaReviewView => ({ focus: 'feasibility', reviewer: 'bo', prdRevision: rev, verdict: 'findings', findings, at: 0 });
const name = (id: string) => id.toUpperCase();

describe('Idea review wording', () => {
  it('labels each stage of an Idea', () => {
    expect(ideaStatusLabel(idea)).toBe('Queued');
    expect(ideaStatusLabel({ ...idea, status: 'needs-clarification' })).toBe('Needs clarification');
    expect(ideaStatusLabel({ ...idea, status: 'researched' })).toBe('PRD ready');
    expect(ideaStatusLabel({ ...idea, status: 'archived' })).toBe('Archived');
    expect(ideaStatusLabel({ ...idea, status: 'reviewing' }, cycle)).toBe('In review · round 1 of 3');
    const agreed = promote(recordReview(recordReview(cycle, endorse('evidence', 'ada')), endorse('feasibility', 'bo')), 1);
    expect(ideaStatusLabel({ ...idea, status: 'proposed' }, agreed)).toBe('Proposed · endorsed');
    expect(reviewProgress(agreed, name)).toBe('Both reviewers endorsed PRD r1. Ready for your decision.');
  });

  it('says who is revising and what is still open at the cap', () => {
    let c = recordReview(recordReview(cycle, endorse('evidence', 'ada')), object(1));
    expect(reviewProgress(c, name)).toBe('LEAD is revising after round 1.');
    c = reviseRound(c, 2, 2);
    expect(reviewProgress(c, name)).toBe('Round 2: reviewing PRD r2 and Issue Plan r2.');
    c = reviseRound(recordReview(recordReview(c, endorse('evidence', 'ada', 2)), object(2)), 3, 3);
    c = promote(recordReview(recordReview(c, endorse('evidence', 'ada', 3)), object(3, ['One', 'Two'])), 1);
    expect(ideaStatusLabel({ ...idea, status: 'proposed' }, c)).toBe('Proposed · 2 open findings');
    expect(reviewProgress(c, name)).toMatch(/^No joint endorsement after 3 rounds/);
  });

  it('ties each verdict to its revision', () => {
    expect(verdictText(undefined)).toBe('Reviewing…');
    expect(verdictText(endorse('evidence', 'ada', 2))).toBe('Endorsed r2');
    expect(verdictText(object(3, ['One']))).toBe('1 finding on r3');
  });
});

describe('Idea PRD links', () => {
  const revision = { id: 'i1-prd-1', ideaId: 'i1', kind: 'research' as const, title: 'PRD revision 1', body: '', createdAt: 0,
    prd: { problem: 'p', outcome: 'o', scope: 's', evidence: [], assumptions: [], targetFloors: [], acceptanceCriteria: [] } };
  const proposal = { id: 'p1' } as ProposalView;

  it("tells a Proposal's PRD from a research revision under the same link shape", () => {
    expect(prdLinkTarget(undefined, [proposal], [revision])).toBeNull();
    expect(prdLinkTarget('p1', [proposal], [revision])).toBe('proposal');
    expect(prdLinkTarget('i1-prd-1', [proposal], [revision])).toBe('revision');
    expect(prdLinkTarget('i1-prd-1', [], [{ ...revision, prd: undefined }])).toBe('missing');
    expect(prdLinkTarget('elsewhere', [proposal], [revision])).toBe('missing');
  });
});
