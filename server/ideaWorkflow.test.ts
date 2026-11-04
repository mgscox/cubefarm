// Production handoffs retain the reviewed graph and publish only the manager's displayed pair.
import { expect, it } from 'vitest';
import { approvedProposal, planForProposal, nextIdeaWork } from './ideaWorkflow.ts';
import { demoHandoff } from './proposalFixture.ts';
import { proposalFromHandoff, decideProposal } from './proposals.ts';
import type { IdeaView, IssuePlanView } from '../shared/types.ts';

const idea: IdeaView = { id: 'i1', description: 'Improve onboarding', links: [], constraints: '', floorHints: [], status: 'researched', createdAt: 1,
  research: { leadAgentId: 'lead', questions: [], requests: [], prdRevisionId: 'i1-prd-1' } };
const floors = ['demo-co/pixel-todo', 'demo-co/weather-api'];

it('continues a saved PRD into planning without a fixture command', () => {
  expect(nextIdeaWork(idea, [], undefined, [], [{ id: 'qa', role: 'qa' }, { id: 'dev', role: 'dev' }], 1)).toMatchObject({ ideaId: 'i1', agentId: 'lead', ideaPhase: 'plan' });
});

it('retains parents, reuse, gap context, specialties and cross-floor blockers on the displayed plan and approval', () => {
  const plan: IssuePlanView = { id: 'plan', ideaId: 'i1', revision: 2, prdRevision: 1, createdAt: 1,
    parents: [{ key: 'parent', repo: floors[0], title: 'Track onboarding', summary: 'Grouped progress' }],
    entries: [
      { key: 'api', kind: 'new', repo: floors[1], title: 'Add onboarding endpoint', brief: 'Return the checklist.', acceptance: ['Returns 200'], requirement: { id: 'R1', text: 'Show checklist' }, specialty: 'backend', parent: 'parent' },
      { key: 'ui', kind: 'new', repo: floors[0], title: 'Show onboarding checklist', brief: 'Show remaining steps.', acceptance: ['Shows steps'], requirement: { id: 'R1', text: 'Show checklist' }, issue: { number: 8, url: `https://github.com/${floors[0]}/issues/8`, title: 'Existing steps' } },
      { key: 'existing', kind: 'existing', repo: floors[1], title: 'Existing delivery', brief: '', acceptance: [], requirement: { id: 'R1', text: 'Show checklist' }, issue: { number: 3, url: `https://github.com/${floors[1]}/issues/3`, title: 'Existing delivery' } },
    ], dependencies: [{ issue: 'ui', blockedBy: 'api' }] };
  const handoff = { ...demoHandoff('i1', floors.map((id) => ({ id, fullName: id }))), prd: { revision: 1, title: 'PRD', body: 'Reviewed scope' }, plan: { revision: 2, issues: planForProposal(plan) }, reviews: [
    { reviewer: 'qa', focus: 'evidence' as const, prdRevision: 1, planRevision: 2, round: 1, endorsed: true, findings: [] },
    { reviewer: 'dev', focus: 'feasibility' as const, prdRevision: 1, planRevision: 2, round: 1, endorsed: true, findings: [] },
  ] };
  const p = proposalFromHandoff(handoff, { idea, floors, proposals: [] }, 'p1', 1);
  const approved = decideProposal(p, idea, { action: 'approve', prdRevision: 1, planRevision: 2 }, 2).proposal;
  const snapshot = approvedProposal({ ...approved, newerDraft: { prdRevision: 9, planRevision: 9, at: 3 } });
  expect(snapshot.approval).toMatchObject({ proposalId: 'p1', ideaId: 'i1', prdRevision: 1, planRevision: 2, source: 'manager' });
  expect(snapshot.issues[0]).toMatchObject({ entryId: 'parent', tracking: true });
  expect(snapshot.issues[1]).toMatchObject({ entryId: 'api', parent: 'parent', specialty: 'backend' });
  expect(snapshot.issues[2]).toMatchObject({ entryId: 'ui', blockedBy: [{ entryId: 'api' }] });
  expect(snapshot.issues[2].body).toContain('issues/8');
  expect(snapshot.issues[2].body).toContain('R1');
  expect(snapshot.issues[3].existing?.number).toBe(3);
  expect(() => approvedProposal(p)).toThrow(/approval/i);
});
