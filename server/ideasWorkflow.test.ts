// Stateful emulation of the connected production path: no fixture approval or handoff commands.
import fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend, demoTracker } from './demo.ts';
import { HOME_DIR } from './config.ts';
import type { ProposalView } from '../shared/types.ts';

await vi.hoisted(async () => {
  const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  process.env.SWARM_HOME = await fs.mkdtemp(path.join(process.cwd(), '.ideas-workflow-'));
});
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let swarm: Swarm;
let backend: ReturnType<typeof createDemoBackend>;
const pair = (p: ProposalView) => ({ prdRevision: p.prd.revision, planRevision: p.plan.revision });
const until = async (check: () => void) => vi.waitFor(check, { timeout: 120_000, interval: 100 });
const proposal = (id: string) => swarm.snapshot().proposals.filter((p) => p.ideaId === id).at(-1)!;
const ready = async (description: string) => {
  const idea = await swarm.submitIdea({ description });
  await until(() => expect(proposal(idea.id)).toBeDefined());
  return { idea, p: proposal(idea.id) };
};

beforeEach(async () => {
  vi.useFakeTimers();
  backend = createDemoBackend();
  swarm = new Swarm(backend);
  let initialized = false;
  const starting = swarm.init().then(() => { initialized = true; });
  await until(() => expect(initialized).toBe(true));
  await starting;
  for (const repo of swarm.snapshot().repos) swarm.updateRepo(repo.id, { autoAssign: false });
  swarm.updateSettings({ runtime: 'sdk', pacingSessions: 64, tutorialStep: -1 });
});

afterEach(async () => {
  await swarm.closeOffice();
  await vi.advanceTimersByTimeAsync(2000);
  let stopped = false;
  const stopping = swarm.shutdown().then(() => { stopped = true; });
  await until(() => expect(stopped).toBe(true));
  await stopping;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  demoTracker.refusedCreates.clear();
  demoTracker.lostCreates = 0;
  await fs.rm(HOME_DIR, { recursive: true, force: true, maxRetries: 5 });
});

it('takes only a description through two independent reviews and publishes the displayed pair once', async () => {
  const start = vi.spyOn(backend, 'startSession');
  const { idea, p } = await ready('Help teammates finish onboarding');
  const reviewInputs = start.mock.calls.filter(([opts]) => opts.outputSchema && 'verdict' in (opts.outputSchema.properties as object ?? {})).map(([opts]) => JSON.parse(opts.prompt));
  expect(reviewInputs.map((c) => c.focus)).toEqual(['evidence', 'feasibility']);
  expect(reviewInputs.every((c) => !c.cycle && !c.previous && !c.records && c.floors.every((f: { openIssues?: unknown }) => !f.openIssues))).toBe(true);
  expect(idea.floorHints).toEqual([]);
  expect(p.prd.recordId).toBe(`${idea.id}-prd-1`);
  expect(p.reviews.map((r) => [r.focus, r.round, r.endorsed])).toEqual([['evidence', 1, true], ['feasibility', 1, true]]);
  expect(new Set(p.reviews.map((r) => r.reviewer)).size).toBe(2);
  expect(swarm.snapshot().publications).toEqual([]);
  await swarm.draftIssuePlan(idea.id, { ideaId: idea.id, revision: 1, requirements: [{ id: 'R1', text: 'Show onboarding' }] }, {
    entries: [{ key: 'newer', repo: p.plan.issues[0].repo, requirement: 'R1', title: 'An alternative onboarding draft', brief: 'Changed scope waiting for a future decision.', acceptance: ['Shows a different workflow'] }],
  });
  expect(proposal(idea.id).newerDraft).toMatchObject({ prdRevision: 1, planRevision: 2 });
  await Promise.all([1, 2, 3].map(() => swarm.decideProposal(p.id, { action: 'approve', ...pair(p) })));
  await until(() => expect(swarm.snapshot().publications?.[0]?.status).toBe('complete'));
  const published = swarm.snapshot().publications![0];
  expect(published.snapshot.approval).toMatchObject({ source: 'manager', prdRevision: 1, planRevision: 1 });
  expect(published.issues).toHaveLength(1);
  const written = await backend.readIssue(published.issues[0].repo, published.issues[0].number!);
  expect(written?.title).toBe(p.plan.issues[0].title);
  expect(written?.body).toContain(p.plan.issues[0].brief);
  await swarm.decideProposal(p.id, { action: 'approve', ...pair(p) });
  expect(swarm.snapshot().publications).toHaveLength(1);
});

it('caps disagreement at three rounds and gives substantive refinement a fresh reviewed decision before rejection', async () => {
  const { idea, p } = await ready('[disagree] Improve the onboarding outcome');
  expect(p.reviews.map((r) => r.round)).toEqual([1, 1, 2, 2, 3, 3]);
  expect(p.reviews.at(-1)?.findings).not.toEqual([]);
  await swarm.decideProposal(p.id, { action: 'refine', ...pair(p), feedback: 'Include keyboard onboarding' });
  await until(() => expect(proposal(idea.id).revises).toBe(p.id));
  const revised = proposal(idea.id);
  expect(revised.reviews.map((r) => r.round)).toEqual([1, 1, 2, 2, 3, 3]);
  expect(revised.prd.body).toContain('Include keyboard onboarding');
  expect(revised.decision).toBeUndefined();
  expect(swarm.snapshot().publications).toEqual([]);
  await swarm.decideProposal(revised.id, { action: 'reject', ...pair(revised) });
  expect(swarm.snapshot().ideas.find((i) => i.id === idea.id)?.status).toBe('archived');
  const linked = await swarm.submitIdea({ description: 'Try a smaller onboarding improvement', linkedFrom: idea.id });
  expect(linked.linkedFrom).toBe(idea.id);
  expect(swarm.snapshot().publications).toEqual([]);
});

it('returns a cosmetic refinement directly, preserving the exact scope for a new decision', async () => {
  const { idea, p } = await ready('Improve onboarding wording');
  await swarm.decideProposal(p.id, { action: 'refine', ...pair(p), feedback: 'Remove trailing spaces', wordingOnly: true });
  await until(() => expect(proposal(idea.id).revises).toBe(p.id));
  const revised = proposal(idea.id);
  expect(revised.reviewSkipped).toBe(true);
  expect(revised.prd.body).toBe(p.prd.body);
  expect(revised.plan.issues).toEqual(p.plan.issues);
  expect(revised.decision).toBeUndefined();
  expect(swarm.snapshot().publications).toEqual([]);
});

it('recovers refused cross-floor writes and an uncertain create with one approval and stable identities', async () => {
  const { p } = await ready('[cross-floor] Connect onboarding across floors');
  const second = p.plan.issues.find((i) => i.repo !== p.plan.issues[0].repo)!;
  demoTracker.refusedCreates.set(second.repo, Date.now() + 600_000);
  demoTracker.lostCreates = 1;
  await swarm.decideProposal(p.id, { action: 'approve', ...pair(p) });
  const current = () => swarm.snapshot().publications!.find((x) => x.proposalId === p.id)!;
  await until(() => expect(current()?.status).toBe('blocked'));
  const held = structuredClone(current());
  expect(held.issues.filter((i) => i.number !== null)).toHaveLength(2);
  expect(held.issues.every((i) => i.step !== 'released')).toBe(true);
  demoTracker.refusedCreates.clear();
  swarm.retryPublication(p.id);
  await until(() => expect(current().status).toBe('complete'));
  expect(current().issues.slice(0, 2).map((i) => i.number)).toEqual(held.issues.slice(0, 2).map((i) => i.number));
  expect(current().issues.map((i) => i.step)).toEqual(['held', 'released', 'released']);
  expect(current().snapshot.issues.find((i) => i.entryId === 'work2')?.blockedBy).toEqual([{ entryId: 'work1' }]);
});

it('resumes a restart during release using the persisted approval and finds the lost release response', async () => {
  const { p } = await ready('[cross-floor] Recover release after restarting');
  const edit = backend.editIssue;
  let interrupted = false;
  vi.spyOn(backend, 'editIssue').mockImplementation(async (repo, number, patch) => {
    await edit(repo, number, patch);
    if (!interrupted && patch.removeLabels?.includes('held-for-publication')) {
      interrupted = true;
      throw new Error('connection reset during release');
    }
  });
  await swarm.decideProposal(p.id, { action: 'approve', ...pair(p) });
  const current = () => swarm.snapshot().publications!.find((x) => x.proposalId === p.id)!;
  await until(() => expect(current()?.note).toContain('connection reset during release'));
  const identities = current().issues.map((i) => i.number);
  await swarm.closeOffice();
  let stopped = false;
  const stopping = swarm.shutdown().then(() => { stopped = true; });
  await until(() => expect(stopped).toBe(true));
  await stopping;
  vi.clearAllTimers();
  swarm = new Swarm(backend);
  let initialized = false;
  const starting = swarm.init().then(() => { initialized = true; });
  await until(() => expect(initialized).toBe(true));
  await starting;
  await until(() => expect(current()?.status).toBe('complete'));
  expect(current().issues.map((i) => i.number)).toEqual(identities);
  expect(swarm.snapshot().proposals.find((x) => x.id === p.id)?.decision?.action).toBe('approve');
  for (const entry of current().issues) {
    expect(await backend.findIssuesByMarker(entry.repo, entry.marker, new Date(0).toISOString())).toHaveLength(1);
  }
});

it('uses the published graph on both start paths despite stale metadata, then automatically starts after confirmed delivery', async () => {
  const { p } = await ready('[cross-floor] Gate the connected dispatch graph');
  await swarm.decideProposal(p.id, { action: 'approve', ...pair(p) });
  await until(() => expect(swarm.snapshot().publications?.[0]?.status).toBe('complete'));
  const publication = swarm.snapshot().publications![0];
  const prerequisite = publication.issues.find((i) => i.entryId === 'work1')!;
  const dependent = publication.issues.find((i) => i.entryId === 'work2')!;
  // Leave only the published implementation leaves in automatic dispatch.
  for (const floor of swarm.snapshot().repos) {
    for (const issue of await backend.listIssues(floor.fullName)) {
      if (!publication.issues.some((i) => i.repo === floor.fullName && i.number === issue.number)) await backend.editIssue(floor.fullName, issue.number, { addLabels: ['needs-info'] });
    }
  }
  const read = backend.readIssue;
  const list = backend.listIssues;
  let answer: 'open' | 'unreadable' | 'missing' | 'not-planned' | 'delivered' = 'open';
  vi.spyOn(backend, 'readIssue').mockImplementation(async (repo, number) => {
    const got = await read(repo, number);
    if (repo !== prerequisite.repo || number !== prerequisite.number) return got;
    if (answer === 'unreadable') throw new Error('HTTP 502');
    if (answer === 'missing') return null;
    return answer === 'not-planned' || answer === 'delivered' ? { ...got!, state: 'CLOSED', stateReason: answer === 'delivered' ? 'completed' : 'not_planned' } : got;
  });
  vi.spyOn(backend, 'listIssues').mockImplementation(async (repo) => (await list(repo)).map((i) => ({ ...i,
    // Both mutable metadata sources falsely claim delivery from the start.
    ...(repo === dependent.repo && i.number === dependent.number ? { nativeBlockers: [], bodyBlockers: [{ repo: prerequisite.repo, number: prerequisite.number!, state: 'CLOSED' as const }] } : {}),
  })));
  const dev = swarm.snapshot().agents.find((a) => a.repoId === dependent.repo && a.role === 'dev')!;
  for (const floor of swarm.snapshot().repos) await swarm.syncRepo(floor.id);
  const start = vi.spyOn(backend, 'startSession');
  for (const floor of swarm.snapshot().repos) swarm.updateRepo(floor.id, { autoAssign: true });
  for (const state of ['open', 'unreadable', 'missing', 'not-planned'] as const) {
    answer = state;
    await swarm.syncRepo(dependent.repo);
    await expect(swarm.assign(dev.id, dependent.number!)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('approved plan') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(swarm.snapshot().agents.some((a) => a.repoId === dependent.repo && a.issueNumber === dependent.number)).toBe(false);
  }
  await until(() => expect(start.mock.calls.some(([opts]) => opts.prompt.includes(p.plan.issues.find((i) => i.key === 'work1')!.title))).toBe(true));
  answer = 'delivered';
  await swarm.syncRepo(dependent.repo);
  await until(() => expect(swarm.snapshot().agents.some((a) => a.repoId === dependent.repo && a.issueNumber === dependent.number)).toBe(true));
});
