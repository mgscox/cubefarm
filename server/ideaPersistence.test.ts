// Real atomic state writes and startup recovery, using only an isolated file and demo backend.
import fs from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend, demoIdeaResearch } from './demo.ts';
import { HOME_DIR, STATE_FILE } from './config.ts';
import { RESEARCHER_ID, type IdeaRecordView, type IdeaView, type ServerEvent } from '../shared/types.ts';
import { nextIdeaResearch } from './ideaResearch.ts';
import type { ResearchJob } from './research.ts';
import type { SessionResult } from './agentRunner.ts';

// A SWARM_HOME of this file's own: the run's shared one is used by other workers' Swarms (state, terminals), and a
// late write from a timed-out test must not land outside it once the test is torn down.
await vi.hoisted(async () => {
  const [{ mkdtemp }, os, path] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')]);
  process.env.SWARM_HOME = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-idea-persistence-'));
});
// Every step is a real disk write: on a busy CI host a handful can take seconds.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Harness = { broadcast(event: ServerEvent): void; writeState(): Promise<void> };
type ResearchHarness = Harness & {
  ensureResearcher(interrupted: unknown[]): void;
  prepareIdeaResearch(agent: unknown, job: ResearchJob): Promise<void>;
  finishIdeaResearch(agent: unknown, job: ResearchJob, result: SessionResult, generation: number | undefined): Promise<void>;
  state: { agents: { id: string }[]; officeHeld: boolean; ideas: IdeaView[]; research: { job: ResearchJob | null; queue: ResearchJob[] } };
  startResearchWork(): void;
  agentRt: Map<string, { generation?: number }>;
};
const file = STATE_FILE;
let swarm: Swarm;

beforeEach(() => {
  vi.useFakeTimers();
  swarm = new Swarm(createDemoBackend());
});

afterEach(async () => {
  await swarm.shutdown();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(HOME_DIR, { recursive: true, force: true, maxRetries: 5 });
});

afterAll(() => fs.rm(HOME_DIR, { recursive: true, force: true, maxRetries: 5 }));

it('acknowledges and broadcasts only after the queued Idea is durable, without creating GitHub issues', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  swarm = new Swarm(backend);
  const events: ServerEvent[] = [];
  vi.spyOn(swarm as unknown as Harness, 'broadcast').mockImplementation((event) => events.push(event));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const realWrite = (swarm as unknown as Harness).writeState.bind(swarm);
  vi.spyOn(swarm as unknown as Harness, 'writeState').mockImplementationOnce(async () => { await gate; await realWrite(); });
  const submissions = [swarm.submitIdea({ description: 'One' }), swarm.submitIdea({ description: 'Two' })];
  await Promise.resolve();
  expect(events).toEqual([]);
  release();
  const ideas = await Promise.all(submissions);
  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { ideas: IdeaView[] };
  expect(saved.ideas).toEqual(ideas);
  expect(new Set(ideas.map((idea) => idea.id)).size).toBe(2);
  expect(events).toEqual(ideas.map((idea) => ({ type: 'idea', idea })));
  expect(createIssue).not.toHaveBeenCalled();
});

it('does not acknowledge a failed save and allows the next submission', async () => {
  const broadcast = vi.spyOn(swarm as unknown as Harness, 'broadcast');
  vi.spyOn(swarm as unknown as Harness, 'writeState').mockRejectedValueOnce(new Error('disk full'));
  await expect(swarm.submitIdea({ description: 'Unsaved' })).rejects.toThrow('disk full');
  expect(swarm.snapshot().ideas).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
  const idea = await swarm.submitIdea({ description: 'Try again' });
  expect(swarm.snapshot().ideas).toEqual([idea]);
});

it('loads the same identity and queued state at startup and tolerates legacy state without Ideas', async () => {
  const idea = await swarm.submitIdea({ description: 'Survive a restart' });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const record = { id: 'research-1', ideaId: idea.id, kind: 'research', title: 'Independent evidence', body: 'A source', createdAt: 1 };
  saved.ideaRecords = [record];
  await fs.writeFile(file, JSON.stringify(saved));
  const backend = createDemoBackend();
  vi.spyOn(backend, 'listMyRepos').mockResolvedValue([]);
  swarm = new Swarm(backend);
  await swarm.init();
  expect(swarm.snapshot().ideas).toEqual([idea]);
  expect(swarm.snapshot().ideaRecords).toEqual([record]);
  await swarm.shutdown();
  await fs.writeFile(file, JSON.stringify({ officeHeld: true, settings: { ceoHeartbeatMin: 0 } }));
  swarm = new Swarm(backend);
  await swarm.init();
  expect(swarm.snapshot().ideas).toEqual([]);
});

it('persists clarification, focused evidence and one lead-authored PRD, then recovers without producing another revision', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  const start = vi.spyOn(backend, 'startSession').mockReturnValue({ send: () => undefined, stop: () => undefined });
  vi.spyOn(backend, 'prepareResearchFolder').mockResolvedValue(undefined);
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  swarm.updateSettings({ runtime: 'sdk' });
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  const specialist = swarm.hireAgent(repo.id, { role: 'researcher', title: 'Product researcher' });
  const submitted = await swarm.submitIdea({ description: '[clarify] Help new teammates', links: ['https://example.com/prior'] });
  const turn = async () => {
    const job = nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)[0];
    const agent = h.state.agents.find((a) => a.id === job.agentId)!;
    await h.prepareIdeaResearch(agent, job);
    const context = JSON.parse(start.mock.lastCall![0].prompt);
    const report = demoIdeaResearch(context);
    await h.finishIdeaResearch(agent, job, { structured: report, ok: true, text: '', errors: [], turns: 1, costUsd: 0 }, h.agentRt.get(agent.id)?.generation);
    return { job, agent, report };
  };
  await turn();
  expect(swarm.snapshot().ideas[0]).toMatchObject({ status: 'needs-clarification', research: { leadAgentId: RESEARCHER_ID } });
  expect(() => swarm.replyToIdea(submitted.id, '   ')).toThrow();
  const replies = await Promise.allSettled([swarm.replyToIdea(submitted.id, 'New teammates finish in 3 minutes'), swarm.replyToIdea(submitted.id, 'Duplicate')]);
  expect(replies.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  await turn();
  const contribution = await turn();
  expect(contribution.job.agentId).toBe(specialist.id);
  const final = await turn();
  const done = swarm.snapshot();
  expect(done.ideas[0]).toMatchObject({ status: 'researched', research: { leadAgentId: RESEARCHER_ID, prdRevisionId: `${submitted.id}-prd-1` } });
  expect(done.ideaRecords).toHaveLength(1);
  expect(done.ideaRecords[0]).toMatchObject({ authorAgentId: RESEARCHER_ID, prd: { outcome: 'New teammates finish in 3 minutes' } });
  // A duplicate or stale session completion cannot append another PRD.
  await h.finishIdeaResearch(final.agent, final.job, { structured: final.report, ok: true, text: '', errors: [], turns: 1, costUsd: 0 }, h.agentRt.get(final.agent.id)?.generation);
  expect(swarm.snapshot().ideaRecords).toHaveLength(1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(saved.research.job).toBeNull();
  expect(saved.ideaRecords).toEqual(done.ideaRecords);
  h.state.officeHeld = true;
  await swarm.shutdown();
  swarm = new Swarm(backend);
  await swarm.init();
  expect(swarm.snapshot().ideas).toEqual(done.ideas);
  expect(swarm.snapshot().ideaRecords).toEqual(done.ideaRecords);
  expect(nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)).toEqual([]);
  expect(createIssue).not.toHaveBeenCalled();
});

it('keeps an invalid research result inspectable and retryable without saving a PRD', async () => {
  const backend = createDemoBackend();
  vi.spyOn(backend, 'startSession').mockReturnValue({ send: () => undefined, stop: () => undefined });
  vi.spyOn(backend, 'prepareResearchFolder').mockResolvedValue(undefined);
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  swarm.updateSettings({ runtime: 'sdk' });
  const idea = await swarm.submitIdea({ description: 'Recover research' });
  const job = nextIdeaResearch([idea], RESEARCHER_ID, 123)[0];
  const agent = h.state.agents.find((a) => a.id === RESEARCHER_ID)!;
  await h.prepareIdeaResearch(agent, job);
  await h.finishIdeaResearch(agent, job, { ok: true, text: 'No structured result', errors: [], turns: 1, costUsd: 0 }, h.agentRt.get(agent.id)?.generation);
  expect(swarm.snapshot().ideas[0].research?.error).toBeTruthy();
  expect(swarm.snapshot().ideaRecords).toEqual([]);
  expect(nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)).toEqual([]);
  const before = swarm.snapshot().ideas[0];
  vi.spyOn(h, 'writeState').mockRejectedValueOnce(new Error('disk full'));
  await expect(swarm.retryIdeaResearch(idea.id)).rejects.toThrow('disk full');
  expect(swarm.snapshot().ideas[0]).toEqual(before);
  await swarm.retryIdeaResearch(idea.id);
  expect(nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)).toHaveLength(1);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).ideas[0].research.error).toBeUndefined();
});

it('requeues an interrupted focused research session at restart and keeps its original lead', async () => {
  const backend = createDemoBackend();
  vi.spyOn(backend, 'startSession').mockReturnValue({ send: () => undefined, stop: () => undefined });
  vi.spyOn(backend, 'prepareResearchFolder').mockResolvedValue(undefined);
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  swarm.updateSettings({ runtime: 'sdk' });
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  const specialist = swarm.hireAgent(repo.id, { role: 'researcher' });
  const submitted = await swarm.submitIdea({ description: 'Research survives restart' });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.ideas[0] = { ...submitted, status: 'researching', research: { leadAgentId: RESEARCHER_ID, questions: [], requests: [{ id: 'q1', agentId: specialist.id, question: 'Check feasibility' }] } };
  saved.research.job = { ideaId: submitted.id, requestId: 'q1', agentId: specialist.id, topic: 'Idea research', brief: '', at: 123, requestedBy: 'manager' };
  saved.agents.find((a: { id: string }) => a.id === specialist.id).status = 'working';
  saved.officeHeld = true;
  await fs.writeFile(file, JSON.stringify(saved));
  swarm = new Swarm(backend);
  await swarm.init();
  const recovered = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(recovered.research.queue).toContainEqual(saved.research.job);
  expect(recovered.research.job).toBeNull();
  expect(swarm.snapshot().agents.find((a) => a.id === specialist.id)?.status).toBe('idle');
  expect(swarm.snapshot().ideas[0].research?.leadAgentId).toBe(RESEARCHER_ID);
  expect(swarm.snapshot().ideaRecords).toEqual([]);
});

it('resumes focused input with a specialist who finished an issue before taking another ordinary brief', async () => {
  const backend = createDemoBackend();
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  const specialist = swarm.hireAgent(repo.id, { role: 'researcher' });
  Object.assign(h.state.agents.find((a) => a.id === specialist.id)!, { status: 'done', task: 'issue', issueNumber: 42 });
  const submitted = await swarm.submitIdea({ description: 'Focused feasibility check' });
  h.state.ideas[0] = { ...submitted, status: 'researching', research: { leadAgentId: RESEARCHER_ID, questions: [], requests: [{ id: 'q1', agentId: specialist.id, question: 'Check feasibility' }] } };
  h.state.research.queue.push({ topic: 'Unrelated brief', brief: 'Background', requestedBy: 'manager', at: 1 });
  const prepare = vi.spyOn(h, 'prepareIdeaResearch').mockResolvedValue(undefined);
  h.startResearchWork();
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: specialist.id }), expect.objectContaining({ ideaId: submitted.id, requestId: 'q1' }));
});

it('stopping Idea preparation requires a retry and never launches a session', async () => {
  const backend = createDemoBackend();
  const start = vi.spyOn(backend, 'startSession');
  vi.spyOn(backend, 'prepareResearchFolder').mockImplementation(async () => { swarm.stopAgent(RESEARCHER_ID); });
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  const idea = await swarm.submitIdea({ description: 'Stop before spending a session' });
  const job = nextIdeaResearch([idea], RESEARCHER_ID, 123)[0];
  await h.prepareIdeaResearch(h.state.agents.find((a) => a.id === RESEARCHER_ID)!, job);
  expect(start).not.toHaveBeenCalled();
  expect(swarm.snapshot().ideas[0].research?.error).toContain('stopped');
  expect(nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)).toEqual([]);
  expect(h.state.research.job).toBeNull();
});

it('removing a focused contributor during preparation never launches a session', async () => {
  const backend = createDemoBackend();
  const start = vi.spyOn(backend, 'startSession').mockReturnValue({ send: () => undefined, stop: () => undefined });
  let release!: () => void;
  let preparing!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { preparing = resolve; });
  vi.spyOn(backend, 'prepareResearchFolder').mockImplementation(async () => { preparing(); await gate; });
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness;
  h.ensureResearcher([]);
  swarm.updateSettings({ runtime: 'sdk' });
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  const specialist = swarm.hireAgent(repo.id, { role: 'researcher' });
  const idea = await swarm.submitIdea({ description: 'Cancel removed contributor before launch' });
  h.state.ideas[0] = { ...idea, status: 'researching', research: { leadAgentId: RESEARCHER_ID, questions: [], requests: [{ id: 'q1', agentId: specialist.id, question: 'Check feasibility' }] } };
  const job = nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)[0];
  expect(job.agentId).toBe(specialist.id);
  const pending = h.prepareIdeaResearch(h.state.agents.find((a) => a.id === specialist.id)!, job);
  await entered;
  swarm.fireAgent(specialist.id);
  release();
  await pending;
  expect(swarm.snapshot().agents.some((a) => a.id === specialist.id)).toBe(false);
  expect(h.state.research.job).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

it('serializes research with Proposal decisions: a rejected Idea stays archived and its linked Idea researches with its history', async () => {
  const backend = createDemoBackend();
  const start = vi.spyOn(backend, 'startSession').mockReturnValue({ send: () => undefined, stop: () => undefined });
  vi.spyOn(backend, 'prepareResearchFolder').mockResolvedValue(undefined);
  swarm = new Swarm(backend);
  const h = swarm as unknown as ResearchHarness & { state: { ideaRecords: IdeaRecordView[] } };
  h.ensureResearcher([]);
  swarm.updateSettings({ runtime: 'sdk' });
  await swarm.connectRepo('demo-co/pixel-todo');
  const idea = await swarm.submitIdea({ description: 'Rejected while researched' });
  const job = nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)[0];
  const agent = h.state.agents.find((a) => a.id === RESEARCHER_ID)!;
  await h.prepareIdeaResearch(agent, job);
  const report = demoIdeaResearch(JSON.parse(start.mock.lastCall![0].prompt));
  const proposal = await swarm.seedDemoProposal(idea.id);
  // The rejection is queued first; the research result waits behind it on the same path and must not revive the Idea.
  await Promise.all([
    swarm.decideProposal(proposal.id, { action: 'reject', prdRevision: proposal.prd.revision, planRevision: proposal.plan.revision }),
    h.finishIdeaResearch(agent, job, { structured: report, ok: true, text: '', errors: [], turns: 1, costUsd: 0 }, h.agentRt.get(agent.id)?.generation),
  ]);
  expect(swarm.snapshot().ideas[0]).toMatchObject({ status: 'archived' });
  expect(swarm.snapshot().ideaRecords.filter((r) => r.prd)).toEqual([]);
  expect(h.state.research.job).toBeNull();
  expect(JSON.parse(await fs.readFile(file, 'utf8')).ideas[0].status).toBe('archived');
  await expect(swarm.retryIdeaResearch(idea.id)).rejects.toThrow(/archived/);
  expect(nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)).toEqual([]);

  h.state.ideaRecords.push({ id: 'earlier-evidence', ideaId: idea.id, kind: 'research', title: 'Earlier evidence', body: 'A source', createdAt: 1 });
  const linked = await swarm.submitIdea({ description: 'Try again', linkedFrom: idea.id });
  const next = nextIdeaResearch(swarm.snapshot().ideas, RESEARCHER_ID, 123)[0];
  expect(next.ideaId).toBe(linked.id);
  await h.prepareIdeaResearch(agent, next);
  expect(JSON.parse(start.mock.lastCall![0].prompt).records.map((r: IdeaRecordView) => r.id)).toContain('earlier-evidence');
});
