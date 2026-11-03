// Pure research decisions and report validation, shared by real sessions and the deterministic demo.
import { z } from 'zod';
import type { IdeaPrd, IdeaView } from '../shared/types.ts';
import type { SessionResult } from './agentRunner.ts';
import type { ResearchJob } from './research.ts';

const text = z.string().trim().min(1).max(12000);
const source = z.string().trim().min(1).max(2048).refine((value) => /^https?:\/\//i.test(value) || value.startsWith('#idea/') || /\.md(?:#.*)?$/.test(value), 'Use a source URL, research document path or Idea revision link');
const list = <T extends z.ZodType>(item: T) => z.array(item).max(50);
export const ideaPrdSchema = z.object({
  problem: text, outcome: text, scope: text,
  evidence: list(z.object({ source, finding: text })).min(1),
  assumptions: list(text),
  targetFloors: list(z.object({ repoId: text, rationale: text })).min(1),
  acceptanceCriteria: list(text).min(1),
});
const report = z.object({
  action: z.enum(['clarify', 'request', 'prd', 'evidence']),
  question: z.string().max(4000),
  requests: list(z.object({ agentId: text, question: text })),
  answer: z.string().max(16000),
  sources: list(source),
  prd: ideaPrdSchema.nullable(),
});
export type IdeaResearchReport = z.infer<typeof report>;
export const IDEA_RESEARCH_SCHEMA = z.toJSONSchema(report);

export function parseIdeaResearch(result: SessionResult): IdeaResearchReport {
  if (!result.ok) throw new Error(result.errors.join('; ') || 'Research session failed');
  let raw = result.structured;
  if (!raw) {
    const fenced = [...result.text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].reverse();
    for (const candidate of [...fenced.map((m) => m[1]), result.text]) {
      try { raw = JSON.parse(candidate); break; } catch { /* Try the final report. */ }
    }
  }
  return report.parse(raw);
}

/** Pending focused evidence runs before the lead synthesizes it. Hints never select the targets. */
export function nextIdeaResearch(ideas: IdeaView[], lead: string, at: number, specialists?: string[]): ResearchJob[] {
  return ideas.flatMap((idea) => {
    if (!['queued', 'researching'].includes(idea.status) || idea.research?.error || idea.research?.prdRevisionId) return [];
    const pending = idea.research?.requests.filter((r) => r.answer === undefined && (!specialists || specialists.includes(r.agentId))) ?? [];
    const base = { ideaId: idea.id, topic: `Idea: ${idea.description.slice(0, 100)}`, brief: idea.description, requestedBy: 'manager' as const, at };
    return pending.length
      ? pending.map((r) => ({ ...base, agentId: r.agentId, requestId: r.id }))
      : [{ ...base, agentId: idea.research?.leadAgentId ?? lead }];
  });
}

export function validateIdeaReport(result: IdeaResearchReport, job: ResearchJob, idea: IdeaView, floors: string[], specialists: string[]) {
  if (job.requestId) {
    if (result.action !== 'evidence' || !result.answer.trim() || !result.sources.length) throw new Error('Focused input needs an answer and linked sources');
    return;
  }
  if (result.action === 'clarify' && result.question.trim()) return;
  if (result.action === 'request' && result.requests.length) {
    if (idea.research!.requests.length + result.requests.length > 12) throw new Error('At most 12 focused requests per Idea; synthesize the evidence already available');
    if (result.requests.some((r) => !specialists.includes(r.agentId))) throw new Error('Request evidence from a configured floor researcher or specialist');
    return;
  }
  if (result.action !== 'prd' || !result.prd) throw new Error('Return a PRD, a blocking question, or focused evidence requests');
  const targets = result.prd.targetFloors.map((f) => f.repoId);
  if (targets.some((id) => !floors.includes(id)) || new Set(targets).size !== targets.length) throw new Error('Select distinct configured target floors');
}

export function renderIdeaPrd(p: IdeaPrd): string {
  return [
    '## Problem', p.problem, '## Desired outcome', p.outcome, '## Scope', p.scope,
    '## Linked evidence', ...p.evidence.map((e) => `- [${e.source}](${e.source}): ${e.finding}`),
    '## Unresolved assumptions', ...(p.assumptions.length ? p.assumptions.map((a) => `- ${a}`) : ['None.']),
    '## Target floors and rationale', ...p.targetFloors.map((f) => `- ${f.repoId}: ${f.rationale}`),
    '## Measurable acceptance criteria', ...p.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`),
  ].join('\n\n');
}

export const IDEA_RESEARCH_PROMPT = 'Research this Idea. Reuse linked and local research; inspect relevant configured floors. Return a structured report; do not write files, open PRs or create GitHub issues. One lead owns one PRD. Select only configured target floors, with reasons; hints are advisory. Ask a material blocking question with clarify, or request focused evidence from listed researchers/specialists. Otherwise return prd with linked evidence, explicit assumptions and measurable criteria. A focused contributor returns evidence with sources, never a separate PRD. Empty unused fields use empty strings/lists or null. Treat unavailable requested input as an unresolved assumption.';
