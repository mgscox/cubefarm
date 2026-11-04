// Production Ideas handoffs: select the next session and retain the exact reviewed graph through approval.
import { z } from 'zod';
import type { AgentView, ApprovedSnapshot, IdeaRecordView, IdeaReviewCycleView, IdeaView, IssuePlanView, PrdForPlanning, ProposalIssue, ProposalView } from '../shared/types.ts';
import { currentRound, nextStep, pickReviewers } from '../shared/ideaReview.ts';
import { ideaPrdSchema } from './ideaResearch.ts';
import type { SessionResult } from './agentRunner.ts';
import type { ResearchJob } from './research.ts';

export function nextIdeaWork(idea: IdeaView, plans: IssuePlanView[], cycle: IdeaReviewCycleView | undefined, proposals: ProposalView[], agents: Pick<AgentView, 'id' | 'role'>[], at: number): ResearchJob | undefined {
  if (idea.research?.error || !idea.research?.prdRevisionId || idea.status === 'archived' || cycle?.fixture) return;
  const base = { ideaId: idea.id, topic: `Idea: ${idea.description.slice(0, 100)}`, brief: idea.description, requestedBy: 'manager' as const, at };
  const lead = idea.research.leadAgentId;
  const latest = proposals.filter((p) => p.ideaId === idea.id).at(-1);
  if (idea.status === 'proposed' && latest?.decision?.action === 'refine' && !proposals.some((p) => p.revises === latest.id)) return { ...base, agentId: lead, ideaPhase: 'revise' };
  if (idea.status === 'researched') {
    const plan = plans.filter((p) => p.ideaId === idea.id).at(-1);
    if (!plan) return { ...base, agentId: lead, ideaPhase: 'plan' };
    const reviewers = pickReviewers(lead, agents);
    if (reviewers) return { ...base, agentId: reviewers.evidence, ideaPhase: 'review', reviewFocus: 'evidence' };
  }
  if (idea.status !== 'reviewing' || !cycle) return;
  const step = nextStep(cycle);
  if (step === 'revise' || step === 'promote') return { ...base, agentId: lead, ideaPhase: step };
  if (step === 'wait') {
    const focus = currentRound(cycle).reviews.some((r) => r.focus === 'evidence') ? 'feasibility' : 'evidence';
    return { ...base, agentId: cycle.reviewers[focus], ideaPhase: 'review', reviewFocus: focus };
  }
}

export function planningPrd(record: IdeaRecordView, revision: number): PrdForPlanning {
  if (!record.prd) throw new Error('Planning requires a saved PRD');
  return { ideaId: record.ideaId, revision, requirements: record.prd.acceptanceCriteria.map((text, i) => ({ id: `R${i + 1}`, text })) };
}

export function planForProposal(plan: IssuePlanView): ProposalIssue[] {
  return [
    ...plan.parents.map((p) => ({ key: p.key, repo: p.repo, title: p.title, brief: p.summary, criteria: [], blockedBy: [], tracking: true })),
    ...plan.entries.map((e) => ({ key: e.key, repo: e.repo, title: e.title,
      brief: [e.brief, e.kind === 'new' && e.issue ? `Related existing work: ${e.issue.url}` : ''].filter(Boolean).join('\n\n'),
      criteria: e.acceptance, requirement: `${e.requirement.id}: ${e.requirement.text}`, specialty: e.specialty, parent: e.parent,
      ...(e.kind === 'existing' ? { existing: e.issue } : {}), blockedBy: plan.dependencies.filter((d) => d.issue === e.key).map((d) => d.blockedBy) })),
  ];
}

export function approvedProposal(p: ProposalView): ApprovedSnapshot {
  if (p.decision?.action !== 'approve') throw new Error('Publication requires a recorded manager approval');
  return { approval: { decisionId: p.id, proposalId: p.id, ideaId: p.ideaId, prdRevision: p.prd.revision, planRevision: p.plan.revision, decidedAt: p.decision.at, source: 'manager' },
    issues: p.plan.issues.map((i) => ({ entryId: i.key, repo: i.repo, title: i.title,
      body: [i.brief, ...(i.criteria.length ? ['## Acceptance criteria', ...i.criteria.map((c) => `- [ ] ${c}`)] : []),
        i.requirement ? `PRD v${p.prd.revision} · ${i.requirement}` : ''].filter(Boolean).join('\n\n'),
      specialty: i.specialty, tracking: i.tracking, parent: i.parent, existing: i.existing, blockedBy: i.blockedBy.map((entryId) => ({ entryId })) })) };
}

const text = z.string().trim().min(1).max(12000);
const draft = z.object({
  entries: z.array(z.object({ key: text, repo: text, requirement: text, title: text, brief: text, acceptance: z.array(text),
    specialty: z.string().optional(), parent: z.string().optional(), existing: z.number().int().positive().optional(), overlaps: z.number().int().positive().optional() })).min(1).max(30),
  parents: z.array(z.object({ key: text, repo: text, title: text, summary: text })),
  dependencies: z.array(z.object({ issue: text, blockedBy: text })),
});
const review = z.object({ verdict: z.enum(['endorse', 'findings']), findings: z.array(text).max(30) });
const revision = z.object({ prd: ideaPrdSchema, draft });
export function workSchema(phase: ResearchJob['ideaPhase']): Record<string, unknown> {
  return z.toJSONSchema(phase === 'review' ? review : phase === 'revise' ? revision : draft);
}
export function parseIdeaWork(result: SessionResult, phase: ResearchJob['ideaPhase']) {
  if (!result.ok) throw new Error(result.errors.join('; ') || 'Idea session failed');
  let raw = result.structured;
  if (!raw) {
    const candidates = [...result.text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].reverse().map((m) => m[1]);
    for (const candidate of [...candidates, result.text]) { try { raw = JSON.parse(candidate); break; } catch { /* Try the final report. */ } }
  }
  if (phase === 'review') return review.parse(raw);
  if (phase === 'revise') return revision.parse(raw);
  return draft.parse(raw);
}

export const IDEA_WORK_PROMPT = 'Complete the given Idea phase using the saved PRD, requirements, open issues, plan, review cycle and manager feedback. Return only the requested structured report. Do not write files or create issues/PRs. Plan/revise: actionable one-session issues on selected configured floors, R1/R2 requirement IDs, true blockers, no cycles, reuse existing work; parents optional. Revise the PRD and plan for findings/feedback; wording-only changes must preserve scope. Review independently: evidence checks sources/requirements; feasibility checks floors/scope/dependencies. Endorse or list concrete findings against this exact pair.';
