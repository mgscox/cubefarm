// Issue Plan revisions saved through the swarm with the demo fixture, using only an isolated state file and demo backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend } from './demo.ts';
import { STATE_FILE } from './config.ts';
import { DEMO_TODO, DEMO_WEATHER, demoPrd } from './planFixture.ts';
import type { IdeaView, IssueInfo, IssuePlanView, ServerEvent } from '../shared/types.ts';

type Harness = {
  broadcast(event: ServerEvent): void;
  writeState(): Promise<void>;
  state: { repos: { id: string }[]; ideas: IdeaView[]; issuePlans: IssuePlanView[] };
  repoRt: Map<string, { issues: IssueInfo[] }>;
};
let folder: string;
let file: string;
let backend: ReturnType<typeof createDemoBackend>;
let swarm: Swarm;
const read = fs.readFile.bind(fs);
const write = fs.writeFile.bind(fs);
const rename = fs.rename.bind(fs);

const issue = (repo: string, number: number, title: string, body = ''): IssueInfo => ({
  number, title, body, url: `https://github.com/${repo}/issues/${number}`, labels: [], createdAt: '2026-11-01T00:00:00Z',
});

beforeEach(async () => {
  vi.useFakeTimers();
  folder = await fs.mkdtemp(path.join(process.cwd(), '.plan-test-'));
  file = path.join(folder, 'demo-state.json');
  vi.spyOn(fs, 'readFile').mockImplementation((location, ...args) => read(location === STATE_FILE ? file : location, ...args));
  vi.spyOn(fs, 'writeFile').mockImplementation((location, ...args) => write(location === `${STATE_FILE}.tmp` ? `${file}.tmp` : location, ...args));
  vi.spyOn(fs, 'rename').mockImplementation((from, to) => rename(from === `${STATE_FILE}.tmp` ? `${file}.tmp` : from, to === STATE_FILE ? file : to));
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  backend = createDemoBackend();
  swarm = new Swarm(backend);
  // The two demo floors with the open issues the fixture reuses and overlaps.
  const h = swarm as unknown as Harness;
  h.state.repos.push({ id: DEMO_TODO }, { id: DEMO_WEATHER });
  h.repoRt.set(DEMO_TODO, { issues: [issue(DEMO_TODO, 2, 'Todos should support due dates')] });
  h.repoRt.set(DEMO_WEATHER, { issues: [issue(DEMO_WEATHER, 1, 'Add /forecast endpoint', 'Return a 5-day forecast for a city.')] });
});

afterEach(async () => {
  (swarm as unknown as Harness).state.repos.length = 0;
  await swarm.shutdown();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

it('saves each draft as the next plan revision paired with its PRD revision, writing nothing to GitHub', async () => {
  const writes = [vi.spyOn(backend, 'createIssue'), vi.spyOn(backend, 'editIssue')];
  const events: ServerEvent[] = [];
  vi.spyOn(swarm as unknown as Harness, 'broadcast').mockImplementation((event) => events.push(event));
  const idea = await swarm.submitIdea({ description: 'Weather on todos' });
  const first = await swarm.draftDemoIssuePlan(idea.id);
  const second = await swarm.draftDemoIssuePlan(idea.id);
  expect([first.revision, second.revision, first.prdRevision]).toEqual([1, 2, 1]);
  expect(first.entries.filter((e) => e.kind === 'existing').map((e) => e.issue?.number)).toEqual([2]);
  const saved = JSON.parse(await read(file, 'utf8')) as { issuePlans: IssuePlanView[] };
  expect(saved.issuePlans).toEqual([first, second]);
  expect((swarm as unknown as Harness).state.issuePlans).toEqual([first, second]);
  expect(events.filter((e) => e.type === 'issuePlan')).toEqual([{ type: 'issuePlan', plan: first }, { type: 'issuePlan', plan: second }]);
  for (const spy of writes) expect(spy).not.toHaveBeenCalled();
});

it('rejects a cyclic draft before it is saved or presented', async () => {
  const broadcast = vi.spyOn(swarm as unknown as Harness, 'broadcast');
  const idea = await swarm.submitIdea({ description: 'Loops' });
  broadcast.mockClear();
  const work = (key: string) => ({ key, repo: DEMO_TODO, requirement: 'R1', title: `Build ${key} now`, brief: 'Brief.', acceptance: ['Works'] });
  const draft = { entries: [work('a'), work('b')], dependencies: [{ issue: 'a', blockedBy: 'b' }, { issue: 'b', blockedBy: 'a' }] };
  await expect(swarm.draftIssuePlan(idea.id, demoPrd(idea.id), draft)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('cycle (a waits for b waits for a)') });
  await expect(swarm.draftIssuePlan(idea.id, demoPrd('other'), { entries: [work('a')] })).rejects.toMatchObject({ status: 400 });
  await expect(swarm.draftIssuePlan('missing', demoPrd('missing'), { entries: [work('a')] })).rejects.toMatchObject({ status: 404 });
  expect((swarm as unknown as Harness).state.issuePlans).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
});

it('refuses new plan revisions once the Idea is archived', async () => {
  const h = swarm as unknown as Harness;
  const idea = await swarm.submitIdea({ description: 'Rejected idea' });
  const first = await swarm.draftDemoIssuePlan(idea.id);
  h.state.ideas = h.state.ideas.map((i) => (i.id === idea.id ? { ...i, status: 'archived', archivedAt: Date.now() } : i));
  await expect(swarm.draftDemoIssuePlan(idea.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('archived') });
  expect(h.state.issuePlans).toEqual([first]);
  expect((JSON.parse(await read(file, 'utf8')) as { issuePlans: IssuePlanView[] }).issuePlans).toEqual([first]);
});

it('offers the fixture only in the demo', () => {
  swarm = new Swarm({ ...createDemoBackend(), demo: false });
  expect(() => swarm.draftDemoIssuePlan('any')).toThrow('only available in the demo');
});
