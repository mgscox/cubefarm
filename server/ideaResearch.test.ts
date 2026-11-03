import { describe, expect, it } from 'vitest';
import { nextIdeaResearch, parseIdeaResearch, renderIdeaPrd, validateIdeaReport, type IdeaResearchReport } from './ideaResearch.ts';
import { queuedIdea } from './ideas.ts';
import { demoIdeaResearch } from './demo.ts';
import type { IdeaView } from '../shared/types.ts';

const idea = (): IdeaView => ({ ...queuedIdea({ description: 'Improve onboarding', links: ['https://example.com/prior-research'] }, [], 'i1', 1),
  research: { leadAgentId: 'lead', questions: [], requests: [] } });
const context = (i = idea()) => ({ idea: i, floors: [{ id: 'a/b' }], specialists: [], records: [], request: null });
const prd = () => demoIdeaResearch(context());
const job = { ideaId: 'i1', agentId: 'lead', topic: 'Idea', brief: '', at: 1, requestedBy: 'manager' as const };
const parse = (structured: unknown) => parseIdeaResearch({ structured, ok: true, errors: [], text: '', costUsd: 0, turns: 1 });

describe('Idea research decisions', () => {
  it('assigns a queued Idea with no hints to one lead and uses explicit focused requests before synthesis', () => {
    const i = idea();
    expect(nextIdeaResearch([i], 'lead', 123)).toMatchObject([{ ideaId: 'i1', agentId: 'lead' }]);
    i.status = 'researching';
    i.research!.requests.push({ id: 'q1', agentId: 'floor-researcher', question: 'Feasible?' });
    expect(nextIdeaResearch([i], 'lead', 123)).toMatchObject([{ agentId: 'floor-researcher', requestId: 'q1' }]);
    expect(nextIdeaResearch([i], 'lead', 123, [])).toMatchObject([{ agentId: 'lead' }]);
    i.research!.requests[0].answer = 'Yes, with sources';
    expect(nextIdeaResearch([i], 'lead', 123)).toMatchObject([{ agentId: 'lead' }]);
  });

  it('does not schedule blocked, completed or failed research', () => {
    const i = idea();
    for (const status of ['needs-clarification', 'researched'] as const) {
      expect(nextIdeaResearch([{ ...i, status }], 'lead', 1)).toEqual([]);
    }
    i.research!.error = 'Invalid report';
    expect(nextIdeaResearch([i], 'lead', 1)).toEqual([]);
  });

  it('treats floor hints as context and validates actual targets against current configuration', () => {
    const i = idea();
    i.floorHints = ['removed/repo'];
    const report = demoIdeaResearch(context(i));
    expect(report.prd!.targetFloors.map((f) => f.repoId)).toEqual(['a/b']);
    expect(() => validateIdeaReport(report, job, i, ['a/b'], [])).not.toThrow();
    expect(() => validateIdeaReport(report, job, i, [], [])).toThrow('configured');
    report.prd!.targetFloors.push(report.prd!.targetFloors[0]);
    expect(() => validateIdeaReport(report, job, i, ['a/b'], [])).toThrow('distinct');
  });

  it('accepts SDK and CLI reports and rejects incomplete evidence or PRDs', () => {
    const report = prd();
    expect(parse(report)).toEqual(report);
    expect(parseIdeaResearch({ ok: true, errors: [], text: `Result:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``, turns: 1, costUsd: 0 })).toEqual(report);
    expect(() => parse({ ...report, prd: { ...report.prd, evidence: [] } })).toThrow();
    expect(() => parse({ ...report, prd: { ...report.prd, acceptanceCriteria: [] } })).toThrow();
    expect(() => parse({ ...report, prd: { ...report.prd, targetFloors: [] } })).toThrow();
    expect(() => parse({ ...report, sources: ['javascript:alert(1)'] })).toThrow();
    expect(() => parseIdeaResearch({ ok: false, errors: ['Session failed'], text: '', turns: 0, costUsd: 0 })).toThrow('Session failed');
  });

  it('keeps contributors focused on evidence and restricts requests to configured specialists', () => {
    const request: IdeaResearchReport = { ...prd(), action: 'request', requests: [{ agentId: 'specialist', question: 'Feasibility?' }], prd: null };
    expect(() => validateIdeaReport(request, job, idea(), ['a/b'], [])).toThrow('configured');
    expect(() => validateIdeaReport(request, job, idea(), ['a/b'], ['specialist'])).not.toThrow();
    expect(() => validateIdeaReport(prd(), { ...job, requestId: 'q1' }, idea(), ['a/b'], [])).toThrow('Focused input');
    const evidence = demoIdeaResearch({ ...context(), request: { question: 'Feasibility?' } });
    expect(() => validateIdeaReport(evidence, { ...job, requestId: 'q1' }, idea(), ['a/b'], [])).not.toThrow();
    expect(() => validateIdeaReport({ ...evidence, sources: [] }, { ...job, requestId: 'q1' }, idea(), ['a/b'], [])).toThrow();
  });

  it('renders every required PRD section and reuses linked research in deterministic demo output', () => {
    expect(prd()).toEqual(prd());
    expect(prd().prd!.evidence).toContainEqual({ source: 'https://example.com/prior-research', finding: 'Illustrative demo evidence; no live research was performed.' });
    const body = renderIdeaPrd(prd().prd!);
    for (const section of ['Problem', 'Desired outcome', 'Scope', 'Linked evidence', 'Unresolved assumptions', 'Target floors and rationale', 'Measurable acceptance criteria']) expect(body).toContain(`## ${section}`);
  });

  it('demo clarification resumes from the manager answer and focused evidence without a second PRD owner', () => {
    const i = idea();
    i.description = '[clarify] Improve onboarding';
    expect(demoIdeaResearch(context(i)).action).toBe('clarify');
    i.research!.questions.push({ question: 'Who?', answer: 'New teammates, under 3 minutes' });
    const ctx = { ...context(i), specialists: [{ id: 's1', repoId: 'a/b', title: 'Product researcher' }] };
    const request = demoIdeaResearch(ctx);
    expect(request.action).toBe('request');
    i.research!.requests.push({ ...request.requests[0], id: 'q1', answer: 'Feasible', sources: ['https://example.com/evidence'] });
    const report = demoIdeaResearch(ctx);
    expect(report.action).toBe('prd');
    expect(report.prd!.outcome).toBe('New teammates, under 3 minutes');
    expect(i.research!.leadAgentId).toBe('lead');
    expect(report.prd!.evidence.map((e) => e.source)).toContain('https://example.com/evidence');
  });
});
