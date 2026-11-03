// The demo review fixture through the Swarm: rounds, handoff and restart, using only an isolated state file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend } from './demo.ts';
import { STATE_FILE } from './config.ts';
import { RESEARCHER_ID, type IdeaRecordView, type IdeaReviewCycleView, type IdeaView } from '../shared/types.ts';

type Harness = { state: { agents: { id: string; role: string }[]; ideas: IdeaView[]; ideaReviews: IdeaReviewCycleView[]; ideaRecords: IdeaRecordView[] } };
let folder: string;
let file: string;
let swarm: Swarm;
let createIssue: ReturnType<typeof vi.fn>;
const read = fs.readFile.bind(fs);
const write = fs.writeFile.bind(fs);
const rename = fs.rename.bind(fs);

const office = (agents = true) => {
  const backend = createDemoBackend();
  createIssue = vi.spyOn(backend, 'createIssue') as unknown as ReturnType<typeof vi.fn>;
  vi.spyOn(backend, 'listMyRepos').mockResolvedValue([]);
  const s = new Swarm(backend);
  if (agents) (s as unknown as Harness).state.agents.push(
    { id: RESEARCHER_ID, role: 'researcher' }, { id: 'floor-researcher', role: 'researcher' }, { id: 'qa-1', role: 'qa' }, { id: 'dev-1', role: 'dev' },
  );
  return s;
};
const state = () => (swarm as unknown as Harness).state;
const reviewOf = (ideaId: string) => state().ideaReviews.find((r) => r.ideaId === ideaId)!;
const runOut = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(2500); };

beforeEach(async () => {
  vi.useFakeTimers();
  folder = await fs.mkdtemp(path.join(process.cwd(), '.idea-review-test-'));
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
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

it('promotes a first-round joint endorsement without creating issues', async () => {
  const idea = await swarm.submitIdea({ description: 'Agreeable' });
  const cycle = await swarm.demoIdeaReview(idea.id, 'agree');
  expect(cycle.reviewers).toEqual({ evidence: 'floor-researcher', feasibility: 'qa-1' });
  expect(state().ideas[0].status).toBe('reviewing');
  await expect(swarm.demoIdeaReview(idea.id, 'agree')).rejects.toThrow(/already/);
  await runOut();
  const done = reviewOf(idea.id);
  expect(done.rounds).toHaveLength(1);
  expect(done.handoff).toMatchObject({ prdRevision: 1, planRevision: 1, endorsed: true, unresolved: [] });
  expect(state().ideas[0].status).toBe('proposed');
  expect(createIssue).not.toHaveBeenCalled();
});

it('leaves an Idea under research alone', async () => {
  const idea = await swarm.submitIdea({ description: 'Still being researched' });
  state().ideas[0].status = 'researching';
  await expect(swarm.demoIdeaReview(idea.id, 'agree')).rejects.toThrow(/being researched/);
  expect(state().ideaReviews).toEqual([]);
  expect(state().ideas[0].status).toBe('researching');
});

it('promotes the third revision with its findings when reviewers keep disagreeing', async () => {
  const idea = await swarm.submitIdea({ description: 'Contested' });
  await swarm.demoIdeaReview(idea.id, 'disagree');
  await runOut();
  const done = reviewOf(idea.id);
  expect(done.rounds.map((r) => [r.round, r.prdRevision, r.planRevision])).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  expect(done.rounds.every((r) => r.reviews.every((v) => v.prdRevision === r.prdRevision && v.reviewer !== RESEARCHER_ID))).toBe(true);
  expect(done.handoff).toMatchObject({ prdRevision: 3, planRevision: 3, round: 3, endorsed: false });
  expect(done.handoff!.unresolved).toHaveLength(1);
  expect(state().ideaRecords.filter((r) => r.ideaId === idea.id).map((r) => r.id)).toEqual(
    ['demo-prd-r1', 'demo-plan-r1', 'demo-prd-r2', 'demo-plan-r2', 'demo-prd-r3', 'demo-plan-r3'],
  );
  expect(createIssue).not.toHaveBeenCalled();
});

it('carries a review on after a restart', async () => {
  const idea = await swarm.submitIdea({ description: 'Interrupted' });
  await swarm.demoIdeaReview(idea.id, 'disagree');
  await vi.advanceTimersByTimeAsync(2500);
  await swarm.shutdown();
  const saved = JSON.parse(await read(file, 'utf8')) as { agents: unknown[]; ideaReviews: IdeaReviewCycleView[] };
  expect(saved.ideaReviews[0].rounds[0].reviews).toHaveLength(1);
  saved.agents = []; // the stand-ins above aren't whole agents; the cycle already names its reviewers
  await write(file, JSON.stringify(saved));
  swarm = office(false);
  await swarm.init();
  await runOut();
  expect(reviewOf(idea.id).handoff).toMatchObject({ prdRevision: 3, endorsed: false });
});

it('refuses the fixture outside the demo and for unknown Ideas', async () => {
  await expect(swarm.demoIdeaReview('missing', 'agree')).rejects.toThrow(/No such Idea/);
  const idea = await swarm.submitIdea({ description: 'x' });
  await expect(swarm.demoIdeaReview(idea.id, 'maybe')).rejects.toThrow(/fixture/);
  (swarm as unknown as { backend: { demo: boolean } }).backend.demo = false;
  await expect(swarm.demoIdeaReview(idea.id, 'agree')).rejects.toThrow(/demo office/);
});
