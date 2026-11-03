import { describe, expect, it } from 'vitest';
import type { IdeaView, ProposalView } from '../shared/types.ts';
import { decideProposal, proposalFromHandoff, withNewerDraft, wordingOnly, type ProposalHandoff } from './proposals.ts';
import { demoHandoff, demoRevision } from './proposalFixture.ts';

const floors = [{ id: 'demo-co/weather-api', fullName: 'demo-co/weather-api' }, { id: 'demo-co/pixel-todo', fullName: 'demo-co/pixel-todo' }];
const idea: IdeaView = { id: 'idea-1', description: 'Weekly plan', links: [], constraints: '', floorHints: [], status: 'queued', createdAt: 1 };
const ids = floors.map((f) => f.id);
const open = (handoff: ProposalHandoff = demoHandoff(idea.id, floors), proposals: ProposalView[] = [], forIdea = idea) =>
  proposalFromHandoff(handoff, { idea: forIdea, proposals, floors: ids }, 'p1', 10);
const pair = (p: ProposalView) => ({ prdRevision: p.prd.revision, planRevision: p.plan.revision });

describe('review handoff', () => {
  it('opens a Proposal for the exact pair, with its review history', () => {
    const p = open();
    expect(p).toMatchObject({ id: 'p1', ideaId: idea.id, prd: { revision: 3 }, plan: { revision: 4 }, createdAt: 10 });
    expect(p.decision).toBeUndefined();
    expect(p.reviews).toHaveLength(6);
  });

  it('keeps one open card per Idea and nothing on an archived Idea', () => {
    expect(() => open(undefined, [open()])).toThrow(/awaiting a decision/);
    expect(() => open(undefined, [], { ...idea, status: 'archived' })).toThrow(/archived/);
    expect(() => proposalFromHandoff(demoHandoff('nope', floors), { proposals: [], floors: ids }, 'p', 1)).toThrow(/Unknown Idea/);
  });

  it.each<[string, (h: ProposalHandoff) => void, RegExp]>([
    ['an unconfigured floor', (h) => { h.plan.issues[0].repo = 'someone/else'; }, /not a configured floor/],
    ['an unknown dependency', (h) => { h.plan.issues[2].blockedBy = ['ghost']; }, /unknown issue/],
    ['a self dependency', (h) => { h.plan.issues[0].blockedBy = ['plan-endpoint']; }, /unknown issue/],
    ['a cycle', (h) => { h.plan.issues[0].blockedBy = ['plan-panel']; }, /cycle: plan-endpoint waits for plan-panel waits for plan-endpoint/],
    ['duplicate keys', (h) => { h.plan.issues[1].key = 'plan-endpoint'; }, /unique/],
    ['an empty plan', (h) => { h.plan.issues = []; }, /at least one issue/],
    ['no revision number', (h) => { h.prd.revision = 0; }, /positive revision/],
    ['no review of the PRD revision', (h) => { h.reviews = h.reviews.filter((r) => r.prdRevision !== 3); }, /No review covers PRD v3/],
    ['a fourth round', (h) => { h.reviews[0].round = 4; }, /rounds run from 1 to 3/],
    ['a first Proposal skipping review', (h) => { h.reviewSkipped = true; }, /Only a wording revision/],
  ])('refuses %s', (_, change, error) => {
    const h = demoHandoff(idea.id, floors);
    change(h);
    expect(() => open(h)).toThrow(error);
  });
});

describe('manager decision', () => {
  it('approves the displayed pair once and queues it for publication', () => {
    const p = open();
    const { proposal, repeated } = decideProposal(p, idea, { action: 'approve', ...pair(p) }, 20);
    expect(repeated).toBe(false);
    expect(proposal.decision).toEqual({ action: 'approve', at: 20, publication: { status: 'queued', at: 20 } });
    expect(decideProposal(proposal, idea, { action: 'approve', ...pair(p) }, 30)).toEqual({ proposal, repeated: true });
    expect(() => decideProposal(proposal, idea, { action: 'reject', ...pair(p) }, 30)).toThrow(/already approved/);
  });

  it('approves the displayed pair even when a newer draft exists', () => {
    const p = withNewerDraft(open(), { prdRevision: 3, planRevision: 5 }, 15)!;
    expect(p.newerDraft).toEqual({ prdRevision: 3, planRevision: 5, at: 15 });
    expect(decideProposal(p, idea, { action: 'approve', prdRevision: 3, planRevision: 4 }, 20).proposal.decision?.action).toBe('approve');
    expect(() => decideProposal(p, idea, { action: 'approve', prdRevision: 3, planRevision: 5 }, 20)).toThrow(/PRD v3 · Issue Plan v4; reload/);
  });

  it('records refinement feedback and whether a fresh review is needed', () => {
    const p = open();
    expect(() => decideProposal(p, idea, { action: 'refine', ...pair(p), feedback: '  ' }, 20)).toThrow(/Say what should change/);
    expect(decideProposal(p, idea, { action: 'refine', ...pair(p), feedback: ' Cache it ', wordingOnly: true }, 20).proposal.decision)
      .toEqual({ action: 'refine', at: 20, feedback: 'Cache it', wordingOnly: true });
  });

  it('rejects with an optional reason, and nothing more on an archived Idea', () => {
    const p = open();
    expect(decideProposal(p, idea, { action: 'reject', ...pair(p) }, 20).proposal.decision).toEqual({ action: 'reject', at: 20 });
    expect(() => decideProposal(p, { ...idea, status: 'archived' }, { action: 'approve', ...pair(p) }, 20)).toThrow(/archived/);
  });

  it.each([null, {}, { action: 'merge' }, { action: 'approve' }, { action: 'refine', prdRevision: 3, planRevision: 4, feedback: 7 }])('refuses malformed decision %j', (input) => {
    expect(() => decideProposal(open(), idea, input, 20)).toThrow();
  });
});

describe('newer drafts', () => {
  it('flags only drafts newer than the card, and never after a decision', () => {
    const p = open();
    expect(withNewerDraft(p, { prdRevision: 3, planRevision: 4 }, 1)).toBeNull();
    expect(withNewerDraft(p, { prdRevision: 2, planRevision: 9 }, 1)).toBeNull();
    const flagged = withNewerDraft(p, { prdRevision: 4, planRevision: 4 }, 1)!;
    expect(withNewerDraft(flagged, { prdRevision: 4, planRevision: 4 }, 2)).toBeNull();
    expect(withNewerDraft(flagged, { prdRevision: 4, planRevision: 5 }, 2)?.newerDraft).toEqual({ prdRevision: 4, planRevision: 5, at: 2 });
    const decided = decideProposal(p, idea, { action: 'approve', ...pair(p) }, 3).proposal;
    expect(withNewerDraft(decided, { prdRevision: 9, planRevision: 9 }, 4)).toBeNull();
  });
});

describe('revisions after refinement', () => {
  const sentBack = (wording: boolean) => decideProposal(open(), idea, { action: 'refine', prdRevision: 3, planRevision: 4, feedback: 'Cache it', wordingOnly: wording }, 20).proposal;
  const revise = (prev: ProposalView, h: ProposalHandoff) => proposalFromHandoff(h, { idea, proposals: [prev], floors: ids }, 'p2', 30);

  it('lets a wording revision return directly, needing a new decision', () => {
    const prev = sentBack(true);
    const next = revise(prev, demoRevision(prev));
    expect(next).toMatchObject({ revises: prev.id, reviewSkipped: true, prd: { revision: 4 }, plan: { revision: 5 } });
    expect(next.decision).toBeUndefined();
    expect(() => proposalFromHandoff(demoRevision(prev), { idea, proposals: [prev, next], floors: ids }, 'p3', 40)).toThrow(/awaiting a decision|already has a revised/);
  });

  it('sends a substantive revision through a fresh review cycle', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    expect(h.reviewSkipped).toBeUndefined();
    expect(h.reviews.every((r) => r.round === 1 && r.prdRevision === 4)).toBe(true);
    expect(revise(prev, h).plan.issues[0].criteria).toContain('Addresses: Cache it');
    expect(() => revise(prev, { ...h, reviewSkipped: true })).toThrow(/needs a fresh review cycle/);
  });

  it.each(['requirement', 'brief', 'criterion'] as const)('refuses skipped review when a %s changes without changing plan structure', (field) => {
    const prev = sentBack(true);
    const h = demoRevision(prev);
    if (field === 'requirement') h.prd.body = h.prd.body.replace('The API serves a weekly plan for a team.', 'The API deletes all team data.');
    if (field === 'brief') h.plan.issues[0].brief = 'Delete all team data.';
    if (field === 'criterion') h.plan.issues[0].criteria[0] = 'DELETE /team removes all team data';
    h.reviews = [];
    expect(() => revise(prev, h)).toThrow(/needs a fresh review cycle/);
  });

  it.each(['prd', 'plan'] as const)('requires changed %s content to advance its revision', (field) => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h[field].revision = prev[field].revision;
    expect(() => revise(prev, h)).toThrow(/advance.*revision/);
  });

  it('refuses a substantive revision with the previous pair and reviews', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h.prd.revision = prev.prd.revision;
    h.plan.revision = prev.plan.revision;
    h.reviews = structuredClone(prev.reviews);
    expect(() => revise(prev, h)).toThrow(/advance.*revision/);
  });

  it('refuses reused reviews even alongside a new review of the revised PRD', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h.reviews = [...structuredClone(prev.reviews), ...h.reviews];
    expect(() => revise(prev, h)).toThrow(/fresh review cycle/);
  });

  it.each([2, 3])('refuses a substantive review cycle starting at round %s', (round) => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h.reviews.forEach((r) => { r.round = round; });
    expect(() => revise(prev, h)).toThrow(/start at round 1/);
  });

  it('cannot bypass refinement validation by omitting revises', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    delete h.revises;
    expect(() => revise(prev, h)).toThrow(/refinement request/);
  });

  it('requires reviews of the revised plan even when the PRD did not change', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h.prd = structuredClone(prev.prd);
    h.reviews.forEach((r) => { r.prdRevision = prev.prd.revision; });
    expect(revise(prev, h).prd.revision).toBe(prev.prd.revision);
    h.reviews.forEach((r) => { r.planRevision = prev.plan.revision; });
    expect(() => revise(prev, h)).toThrow(/fresh review cycle/);
  });

  it('allows a PRD-only revision with a fresh review of the unchanged plan', () => {
    const prev = sentBack(false);
    const h = demoRevision(prev);
    h.plan = structuredClone(prev.plan);
    h.reviews.forEach((r) => { r.planRevision = prev.plan.revision; });
    expect(revise(prev, h).plan.revision).toBe(prev.plan.revision);
  });

  it('only accepts a revision of a refinement request', () => {
    const p = open();
    expect(() => revise(p, { ...demoHandoff(idea.id, floors), revises: p.id })).toThrow(/awaiting a decision/);
    const approved = decideProposal(p, idea, { action: 'approve', ...pair(p) }, 20).proposal;
    expect(() => revise(approved, { ...demoHandoff(idea.id, floors), revises: p.id })).toThrow(/answer a refinement request/);
  });

  it('treats floors, reuse, dependencies and scope as substance', () => {
    const original = demoHandoff(idea.id, floors);
    const plan = original.plan;
    const copy = () => structuredClone(plan);
    const reworded = copy();
    reworded.issues[0].title += '  ';
    reworded.issues[0].brief += '  ';
    expect(wordingOnly(original, { ...original, plan: reworded })).toBe(true);
    const changes: ((p: typeof plan) => void)[] = [
      (p) => { p.issues[0].repo = 'demo-co/pixel-todo'; },
      (p) => { p.issues[1].existing = undefined; },
      (p) => { p.issues[2].blockedBy = ['plan-endpoint']; },
      (p) => { p.issues[0].criteria.push('More'); },
      (p) => { p.issues[0].criteria[0] = 'Delete all data'; },
      (p) => { p.issues[0].brief = 'Delete all data'; },
      (p) => { p.issues[0].title = 'Delete all data'; },
      (p) => { p.issues[0].requirement = 'R9'; },
      (p) => { p.issues.pop(); },
    ];
    for (const change of changes) {
      const next = copy();
      change(next);
      expect(wordingOnly(original, { ...original, plan: next })).toBe(false);
    }
  });
});
