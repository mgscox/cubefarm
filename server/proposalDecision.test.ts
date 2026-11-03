// Manager decisions through the Swarm with the demo backend, its fake downstream worker and an isolated state file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend } from './demo.ts';
import { STATE_FILE } from './config.ts';
import { DEMO_WORK_MS } from './proposalFixture.ts';
import type { ProposalWorker } from './proposals.ts';
import type { IdeaView, ProposalView, ServerEvent } from '../shared/types.ts';

type Harness = {
  broadcast(event: ServerEvent): void;
  writeState(): Promise<void>;
  proposalWorker: ProposalWorker;
  state: { repos: { id: string; fullName: string }[]; proposals: ProposalView[] };
  ideaSubmissions: Promise<unknown>;
};
let folder: string;
let file: string;
let swarm: Swarm;
const read = fs.readFile.bind(fs);
const write = fs.writeFile.bind(fs);
const rename = fs.rename.bind(fs);
const rm = fs.rm.bind(fs);
const FLOORS = ['demo-co/pixel-todo', 'demo-co/weather-api'].map((id) => ({ id, fullName: id }));
const harness = (s = swarm) => s as unknown as Harness;
const saved = async () => JSON.parse(await read(file, 'utf8')) as { ideas: IdeaView[]; proposals: ProposalView[] };
// The fake worker answers on a timer; its save is real disk I/O, so wait for the Idea chain too.
const settle = async () => { await vi.advanceTimersByTimeAsync(DEMO_WORK_MS); await harness().ideaSubmissions; };
const pair = (p: ProposalView) => ({ prdRevision: p.prd.revision, planRevision: p.plan.revision });

function office(backend = createDemoBackend()) {
  const s = new Swarm(backend);
  harness(s).state.repos = FLOORS; // floors are all the decision rules need; no clones or syncs
  return s;
}

async function seeded() {
  const idea = await swarm.submitIdea({ description: 'Weekly plan for new teammates' });
  return { idea, proposal: await swarm.seedDemoProposal(idea.id) };
}

beforeEach(async () => {
  vi.useFakeTimers();
  folder = await fs.mkdtemp(path.join(process.cwd(), '.proposal-test-'));
  file = path.join(folder, 'demo-state.json');
  vi.spyOn(fs, 'readFile').mockImplementation((location, ...args) => read(location === STATE_FILE ? file : location, ...args));
  vi.spyOn(fs, 'writeFile').mockImplementation((location, ...args) => write(location === `${STATE_FILE}.tmp` ? `${file}.tmp` : location, ...args));
  vi.spyOn(fs, 'rename').mockImplementation((from, to) => rename(from === `${STATE_FILE}.tmp` ? `${file}.tmp` : from, to === STATE_FILE ? file : to));
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  swarm = office();
});

afterEach(async () => {
  await swarm.shutdown();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

it('seeds a reviewed handoff with a newer draft flagged and the displayed pair still open', async () => {
  const { proposal } = await seeded();
  expect(proposal).toMatchObject({ prd: { revision: 3 }, plan: { revision: 4 }, newerDraft: { prdRevision: 3, planRevision: 5 } });
  expect(proposal.decision).toBeUndefined();
  expect((await saved()).proposals).toEqual([proposal]);
});

it('hands one approval of the displayed pair to publication, however many times or concurrently it is sent', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  swarm = office(backend);
  const { proposal } = await seeded();
  const publish = vi.spyOn(harness().proposalWorker, 'publish').mockImplementation(async (p) => {
    // Persisted before it is handed on.
    expect((await saved()).proposals.find((x) => x.id === p.id)?.decision?.action).toBe('approve');
  });
  const approve = () => swarm.decideProposal(proposal.id, { action: 'approve', ...pair(proposal) });
  const results = await Promise.all([approve(), approve(), approve()]);
  await approve();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0][0]).toMatchObject({ prd: { revision: 3 }, plan: { revision: 4 } });
  expect(new Set(results.map((r) => r.decision?.at)).size).toBe(1);
  await expect(swarm.decideProposal(proposal.id, { action: 'reject', ...pair(proposal) })).rejects.toThrow(/already approved/);
  expect(createIssue).not.toHaveBeenCalled();
});

it('records the fake publisher taking the approved pair, without tracker writes', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  swarm = office(backend);
  const { proposal } = await seeded();
  await swarm.decideProposal(proposal.id, { action: 'approve', ...pair(proposal) });
  await settle();
  const [after] = (await saved()).proposals;
  expect(after.decision?.publication).toMatchObject({ status: 'accepted', note: expect.stringContaining('PRD v3 · Issue Plan v4') });
  expect(createIssue).not.toHaveBeenCalled();
});

it('resumes a queued publication handoff after a restart', async () => {
  const { proposal } = await seeded();
  vi.spyOn(harness().proposalWorker, 'publish').mockImplementation(() => undefined); // the office stops before it is taken
  await swarm.decideProposal(proposal.id, { action: 'approve', ...pair(proposal) });
  await swarm.shutdown();
  const backend = createDemoBackend();
  vi.spyOn(backend, 'listMyRepos').mockResolvedValue([]);
  swarm = new Swarm(backend);
  const publish = vi.spyOn(harness().proposalWorker, 'publish');
  await swarm.init();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0][0].id).toBe(proposal.id);
});

it('does not hand on a decision whose save failed', async () => {
  const { proposal } = await seeded();
  const publish = vi.spyOn(harness().proposalWorker, 'publish');
  vi.spyOn(harness(), 'writeState').mockRejectedValueOnce(new Error('disk full'));
  await expect(swarm.decideProposal(proposal.id, { action: 'approve', ...pair(proposal) })).rejects.toThrow('disk full');
  expect(harness().state.proposals[0].decision).toBeUndefined();
  expect(publish).not.toHaveBeenCalled();
  await swarm.decideProposal(proposal.id, { action: 'approve', ...pair(proposal) });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('returns a wording refinement directly for a new decision', async () => {
  const { proposal } = await seeded();
  await swarm.decideProposal(proposal.id, { action: 'refine', ...pair(proposal), feedback: 'Say "weekly" not "this week"', wordingOnly: true });
  await settle();
  const [, revised] = (await saved()).proposals;
  expect(revised).toMatchObject({ revises: proposal.id, reviewSkipped: true, prd: { revision: 4 }, plan: { revision: 5 } });
  expect(revised.decision).toBeUndefined();
  expect(revised.prd.body).toContain('Say "weekly" not "this week"');
});

it('sends a substantive refinement through a fresh review cycle', async () => {
  const { proposal } = await seeded();
  await swarm.decideProposal(proposal.id, { action: 'refine', ...pair(proposal), feedback: 'Cache the plan' });
  await settle();
  const [, revised] = (await saved()).proposals;
  expect(revised.reviewSkipped).toBeUndefined();
  expect(revised.reviews.map((r) => [r.round, r.prdRevision, r.endorsed])).toEqual([[1, 4, true], [1, 4, true]]);
  await swarm.decideProposal(revised.id, { action: 'approve', ...pair(revised) });
  expect(harness().state.proposals.map((p) => p.decision?.action)).toEqual(['refine', 'approve']);
});

it('archives a rejected Idea with its history and starts a linked Idea from it', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  swarm = office(backend);
  const { idea, proposal } = await seeded();
  const publish = vi.spyOn(harness().proposalWorker, 'publish');
  await swarm.decideProposal(proposal.id, { action: 'reject', ...pair(proposal), feedback: 'Not this quarter' });
  const state = await saved();
  expect(state.ideas[0]).toMatchObject({ id: idea.id, status: 'archived' });
  expect(state.proposals[0]).toMatchObject({ reviews: proposal.reviews, decision: { action: 'reject', feedback: 'Not this quarter' } });
  await expect(swarm.seedDemoProposal(idea.id)).rejects.toThrow(/archived/);
  const linked = await swarm.submitIdea({ description: idea.description, linkedFrom: idea.id });
  expect(linked).toMatchObject({ status: 'queued', linkedFrom: idea.id });
  await expect(swarm.submitIdea({ description: 'x', linkedFrom: 'unknown' })).rejects.toThrow(/linked Idea/);
  await settle();
  expect(publish).not.toHaveBeenCalled();
  expect(createIssue).not.toHaveBeenCalled();
});

it('offers the demo fixture only in the demo', async () => {
  swarm = office(Object.assign(createDemoBackend(), { demo: false }));
  const idea = await swarm.submitIdea({ description: 'Real office' });
  await expect(swarm.seedDemoProposal(idea.id)).rejects.toThrow(/unavailable/);
});
