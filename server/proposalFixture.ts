// Demo only: a seeded review handoff and a fake downstream worker, so manager decisions can be tried without the
// research, review or publication workers and without any tracker writes.
import type { ProposalIssue, ProposalReview, ProposalView } from '../shared/types.ts';
import type { ProposalHandoff, ProposalWorker } from './proposals.ts';

const PRD_BODY = `## Problem
New teammates can't tell what's planned for the week.

## Outcome
Everyone sees upcoming work and its dependencies in the apps they already use.

## Requirements
- **R1** The API serves a weekly plan for a team.
- **R2** The todo app shows the weekly plan next to the todo list.
- **R3** Plan items link to their source issues.

## Unresolved assumptions
- Weekly granularity is enough for the first release.

## Floors
- **weather-api** owns the shared REST surface.
- **pixel-todo** is where teammates already look every day.

## Acceptance criteria
- A teammate opening the todo app sees this week's plan within 2 seconds.`;

/** A Proposal promoted at the review cap: PRD v3 with Issue Plan v4, one reviewer still unconvinced. */
export function demoHandoff(ideaId: string, floors: { id: string; fullName: string }[]): ProposalHandoff {
  const api = floors.find((f) => f.id.endsWith('weather-api')) ?? floors[0];
  const app = floors.find((f) => f.id.endsWith('pixel-todo')) ?? floors[floors.length - 1];
  const issues: ProposalIssue[] = [
    { key: 'plan-endpoint', title: 'Serve the weekly plan at /plan', repo: api.id, requirement: 'R1',
      brief: 'Add a read-only `/plan?team=` endpoint returning this week\'s items with their source issue links.',
      criteria: ['GET /plan?team=x returns this week\'s items as JSON', 'Each item carries its source issue URL', 'Unknown teams return 404'], blockedBy: [] },
    { key: 'due-dates', title: 'Todos should support due dates', repo: app.id, requirement: 'R2',
      existing: { number: 2, url: `https://github.com/${app.fullName}/issues/2` },
      brief: 'Already on the backlog; the weekly panel groups items by due date.', criteria: [], blockedBy: [] },
    { key: 'plan-panel', title: 'Show the weekly plan beside the todo list', repo: app.id, requirement: 'R2',
      brief: 'A collapsible panel reading /plan, grouped by day, linking each item to its source.',
      criteria: ['The panel lists this week\'s items grouped by day', 'Items link to their source issues', 'The panel hides itself when /plan is unreachable'],
      blockedBy: ['plan-endpoint', 'due-dates'] },
  ];
  const reviews: ProposalReview[] = [
    { reviewer: 'Ada', focus: 'evidence', prdRevision: 1, planRevision: 2, round: 1, endorsed: false, findings: ['R3 has no evidence teammates follow links from plans.'] },
    { reviewer: 'Grace', focus: 'feasibility', prdRevision: 1, planRevision: 2, round: 1, endorsed: false, findings: ['The panel needs the endpoint first; say so in the plan.'] },
    { reviewer: 'Ada', focus: 'evidence', prdRevision: 2, planRevision: 3, round: 2, endorsed: true, findings: [] },
    { reviewer: 'Grace', focus: 'feasibility', prdRevision: 2, planRevision: 3, round: 2, endorsed: false, findings: ['Two-second load time is untested on the demo API.'] },
    { reviewer: 'Ada', focus: 'evidence', prdRevision: 3, planRevision: 4, round: 3, endorsed: true, findings: [] },
    { reviewer: 'Grace', focus: 'feasibility', prdRevision: 3, planRevision: 4, round: 3, endorsed: false, findings: ['Two-second load time is still untested; add a cached response or relax the target.'] },
  ];
  return { ideaId, prd: { revision: 3, title: 'Weekly plan for new teammates', body: PRD_BODY }, plan: { revision: 4, issues }, reviews };
}

/** The lead's revision after a refinement request: a wording revision returns directly, anything else is re-reviewed. */
export function demoRevision(prev: ProposalView): ProposalHandoff {
  const feedback = prev.decision?.feedback ?? '';
  const prd = { revision: prev.prd.revision + 1, title: prev.prd.title, body: `${prev.prd.body}\n\n## Revision note\nAddressed the manager's feedback: ${feedback}` };
  const base = { ideaId: prev.ideaId, prd, revises: prev.id };
  if (prev.decision?.wordingOnly) {
    // Cosmetic-only demo: free-text edits conservatively take the substantive path.
    prd.body = prev.prd.body.replace(/\n/g, '  \r\n');
    const issues = structuredClone(prev.plan.issues).map((i) => ({ ...i, brief: `${i.brief}  ` }));
    return { ...base, plan: { revision: prev.plan.revision + 1, issues }, reviews: prev.reviews, reviewSkipped: true };
  }
  const issues = structuredClone(prev.plan.issues).map((i, n) => (n === 0 ? { ...i, criteria: [...i.criteria, `Addresses: ${feedback}`] } : i));
  // A fresh review cycle starts at round one again.
  const reviews: ProposalReview[] = [
    { reviewer: 'Ada', focus: 'evidence', prdRevision: prd.revision, planRevision: prev.plan.revision + 1, round: 1, endorsed: true, findings: [] },
    { reviewer: 'Grace', focus: 'feasibility', prdRevision: prd.revision, planRevision: prev.plan.revision + 1, round: 1, endorsed: true, findings: [] },
  ];
  return { ...base, plan: { revision: prev.plan.revision + 1, issues }, reviews };
}

export const DEMO_WORK_MS = 1500;

/** Fake publisher and lead: each answers once per Proposal, a moment later, without touching the tracker. */
export function createDemoProposalWorker(office: {
  acceptPublication(proposalId: string, note: string): Promise<unknown>;
  submitProposal(handoff: ProposalHandoff): Promise<unknown>;
  proposal(id: string): ProposalView | undefined;
}): ProposalWorker {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const later = (key: string, fn: () => Promise<unknown>) => {
    if (timers.has(key)) return;
    timers.set(key, setTimeout(() => {
      void fn().catch((err) => console.warn(`demo proposal worker: ${(err as Error).message}`)).finally(() => timers.delete(key));
    }, DEMO_WORK_MS));
  };
  return {
    publish: (p) => later(`publish:${p.id}`, () => office.acceptPublication(p.id,
      `Demo publisher took PRD v${p.prd.revision} · Issue Plan v${p.plan.revision}; no tracker writes.`)),
    refine: (p) => later(`refine:${p.id}`, async () => {
      const current = office.proposal(p.id);
      if (current) await office.submitProposal(demoRevision(current));
    }),
    stop: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
