import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError, Swarm } from './swarm.ts';
import { CEO_ID, type IssueInfo, type QaView, type PullInfo, type RequestedStart, type ParkedBranch, type ServerEvent } from '../shared/types.ts';
import type { OfficeTools } from './ceo.ts';
import type { SessionOptions, SessionCallbacks, SessionResult } from './agentRunner.ts';

// A Swarm that is never init()ed: no state file, scheduler timers or real sessions.

type RunTask = (agent: unknown, repo: Repo, issue: IssueInfo, note?: string) => Promise<void>;
type Repo = { id: string; fullName: string; floor: number; autoAssign: boolean; requestedStarts: RequestedStart[]; parkedBranches?: ParkedBranch[]; preview: { command: null; env: object } };
type Backend = ReturnType<typeof createDemoBackend>;
type QaRec = QaView & { issueNumber?: number | null; sessionFailures: number; retests?: number; testedSha?: string | null; failedSha?: string | null; fixCrashes?: string[] };
interface Internals {
  backend: Backend;
  state: { repos: Repo[]; agents: Record<string, unknown>[]; qa: QaRec[] };
  repoRt: Map<string, { issues: IssueInfo[]; pulls: PullInfo[]; lastSync?: number; cloneStatus?: string }>;
  agentRt: Map<string, { log: unknown[]; pending: unknown[]; terminal: null; shots?: unknown[] }>;
  pausedUntil: number;
  readyIssues(repo: Repo): { issue: IssueInfo }[];
  startIssueWork(repo: Repo): boolean;
  companyStatus(a?: { floor?: number; verbose?: boolean }): string;
  officeTools(): OfficeTools;
  startPipelineWork(repo: Repo): boolean;
  runQa(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  runFix(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  onQaFinished(agent: unknown, repo: Repo, result: SessionResult): Promise<void>;
  onFixFinished(agent: unknown, repo: Repo, result: SessionResult): void;
  postMessage(from: string, text: string): void;
  broadcast(event: ServerEvent): void;
  save(): void;
  schedule(): void;
  recover(agents: Record<string, unknown>[]): void;
  maybeHeartbeat(): void;
  startCeoWork(): void;
  officeUpdateTick(): boolean;
  beginTask(...args: unknown[]): void;
  clearTask(agent: unknown): void;
  prepare(...args: unknown[]): Promise<string>;
  startAgentSession(...args: unknown[]): void;
  runTask: RunTask;
  repoView(repo: Repo): unknown;
}

const issue = (number: number, labels: string[] = [], body = ''): IssueInfo => ({ number, title: `Issue ${number}`, body, url: '', labels, createdAt: '' });

let swarm: Swarm;
let s: Internals;
let repo: Repo;
let runTask: Mock<RunTask>;

const ready = () => s.readyIssues(repo).map((r) => r.issue.number);
const setIssues = (...issues: IssueInfo[]) => (s.repoRt.get(repo.id)!.issues = issues); // what the next poll would bring

beforeEach(() => {
  vi.useFakeTimers();
  swarm = new Swarm(createDemoBackend());
  s = swarm as unknown as Internals;
  vi.spyOn(s, 'save').mockImplementation(() => {});
  vi.spyOn(s, 'schedule').mockImplementation(() => {});
  repo = { id: 'r1', fullName: 'demo-co/pixel-todo', floor: 1, autoAssign: true, requestedStarts: [], preview: { command: null, env: {} } };
  s.state.repos.push(repo);
  s.state.agents.push({ id: 'a1', name: 'Ada', repoId: repo.id, role: 'dev', specialty: '', status: 'idle', task: null, issueNumber: null, desk: 0, endedAt: null });
  s.agentRt.set('a1', { log: [], pending: [], terminal: null });
  s.state.agents.push({ id: CEO_ID, name: 'Joi', repoId: '', role: 'ceo', status: 'idle' });
  s.repoRt.set(repo.id, { issues: [], pulls: [] });
  runTask = vi.fn<RunTask>(async () => {});
  s.runTask = runTask;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('explicit issue starts across office restarts', () => {
  beforeEach(() => {
    s.backend.demo = false; // Fake backend, but exercise the real missing-session recovery condition.
    repo.autoAssign = false;
    Object.assign(s.repoRt.get(repo.id)!, { lastSync: Date.now(), cloneStatus: 'ready' });
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    vi.spyOn(s, 'officeUpdateTick').mockReturnValue(false);
    runTask.mockImplementation(async (agent, _repo, issue) => {
      Object.assign(agent as object, { status: 'preparing', task: 'issue', issueNumber: issue.number, sessionId: null, branch: null });
    });
    setIssues(issue(66), issue(67));
  });

  const restart = () => {
    // Only JSON state survives the restart; recover sees a stopped, unresumable task.
    const persisted = JSON.parse(JSON.stringify(s.state)) as Internals['state'];
    s.state = persisted;
    repo = persisted.repos[0];
    const a = persisted.agents[0];
    a.status = 'stopped';
    runTask.mockClear();
    s.recover([a]);
  };

  it('keeps the issue, preferred desk and manager note while auto-assign remains off', async () => {
    const events = vi.spyOn(s, 'broadcast');
    await swarm.assign('a1', 66, 'Finish the recovery fix');
    expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', note: 'Finish the recovery fix', restartPending: false }]);
    restart();
    expect(repo.requestedStarts[0].restartPending).toBe(true);
    expect(events).toHaveBeenCalledWith({ type: 'repo', repo: expect.objectContaining({ requestedStarts: repo.requestedStarts }) });
    expect(s.agentRt.get('a1')!.log).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Restarting #66 when a desk is free') })]));
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(s.state.agents[0], repo, issue(66), 'Finish the recovery fix');
    expect(repo.autoAssign).toBe(false);
    expect(repo.requestedStarts[0].restartPending).toBe(false);
    // A second restart in preparation also preserves the explicit start.
    restart();
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(s.state.agents[0], repo, issue(66), 'Finish the recovery fix');
  });

  it('restarts the real preparing task before any session id is captured', async () => {
    s.runTask = (Swarm.prototype as unknown as Pick<Internals, 'runTask'>).runTask;
    runTask = vi.spyOn(s, 'runTask');
    vi.spyOn(s, 'prepare').mockImplementation(() => new Promise(() => {}));
    await swarm.assign('a1', 66);
    expect(s.state.agents[0]).toMatchObject({ status: 'preparing', branch: 'swarm/issue-66-ada', sessionId: null });
    restart();
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(s.state.agents[0], repo, issue(66), undefined);
    expect(s.state.agents[0]).toMatchObject({ status: 'preparing', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: null });
  });

  it('also retains explicit starts in demo recovery', async () => {
    s.backend.demo = true;
    await swarm.assign('a1', 66);
    restart();
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(s.state.agents[0], repo, issue(66), undefined);
  });

  it('waits for a free desk and uses another developer when the preferred one is busy', async () => {
    await swarm.assign('a1', 66);
    restart();
    Object.assign(s.state.agents[0], { status: 'working', task: 'issue', issueNumber: 67 });
    s.schedule();
    expect(runTask).not.toHaveBeenCalled();
    expect(repo.requestedStarts[0].restartPending).toBe(true);
    const other = { id: 'a2', name: 'Barbara', repoId: repo.id, role: 'dev', specialty: '', status: 'idle', task: null, issueNumber: null, desk: 1 };
    s.state.agents.push(other);
    s.agentRt.set('a2', { log: [], pending: [], terminal: null });
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(other, repo, issue(66), undefined);
  });

  it.each(['closed', 'ready-for-human', 'PR'] as const)('drops a requested start that now has status %s', async (status) => {
    await swarm.assign('a1', 66);
    restart();
    if (status === 'closed') setIssues(issue(67));
    if (status === 'ready-for-human') setIssues(issue(66, ['Ready-For-Human']), issue(67));
    if (status === 'PR') s.repoRt.get(repo.id)!.pulls = [{ headRefName: 'swarm/issue-66-ada', closesIssues: [] } as unknown as PullInfo];
    s.schedule();
    expect(runTask).not.toHaveBeenCalled();
    expect(repo.requestedStarts).toEqual([]);
  });

  it.each(['stop', 'reset', 'stop-pending', 'reset-pending'] as const)('cancels the explicit start on manager %s', async (action) => {
    await swarm.assign('a1', 66);
    if (action.endsWith('pending')) restart();
    if (action.startsWith('stop')) swarm.stopAgent('a1');
    else {
      s.state.agents[0].status = 'stopped';
      swarm.resetAgent('a1');
    }
    expect(repo.requestedStarts).toEqual([]);
    runTask.mockClear();
    s.schedule();
    expect(runTask).not.toHaveBeenCalled();
  });

  it('keeps automatic floors using normal backlog ordering after a restart', async () => {
    repo.autoAssign = true;
    await swarm.assign('a1', 66, 'Explicit note');
    restart();
    expect(repo.requestedStarts).toEqual([]);
    setIssues(issue(1), issue(66));
    s.schedule();
    expect(runTask).toHaveBeenCalledExactlyOnceWith(s.state.agents[0], repo, issue(1), undefined);
    expect(repo.requestedStarts).toEqual([]); // automatic starts are not explicit requests
    expect(s.agentRt.get('a1')!.log).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Back to the queue') })]));
  });

  it('does not start arbitrary backlog work when auto-assign is off', () => {
    s.schedule();
    expect(runTask).not.toHaveBeenCalled();
  });

  it.each(['qa', 'fix'] as const)('keeps %s tasks on the existing pipeline recovery path', (task) => {
    const a = s.state.agents[0];
    Object.assign(a, { task, status: 'stopped', issueNumber: 66, sessionId: null, branch: null });
    s.state.qa.push({
      repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', round: 1, sessionFailures: 0,
      devAgentId: 'a1', qaAgentId: 'a1', summary: '', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
    });
    s.recover([a]);
    expect(s.state.qa[0].status).toBe(task === 'qa' ? 'queued' : 'failed');
    expect(repo.requestedStarts).toEqual([]);
    expect(a).toMatchObject({ status: 'idle', task: null });
  });
});

describe('CEO rerun_qa', () => {
  const rerun = (args = { floor: 1, number: 13 }) => s.officeTools().call('rerun_qa', args);
  const pull = (state: PullInfo['state'] = 'OPEN'): PullInfo => ({
    number: 13, title: 'Recovery', url: '', headRefName: 'swarm/13', state,
    isDraft: false, closesIssues: [], checks: 'passing', mergeable: 'MERGEABLE', headSha: 'sha',
    reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
    mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  });
  beforeEach(() => {
    s.repoRt.get(repo.id)!.pulls = [pull()];
    s.state.qa.push({
      repoId: repo.id, prNumber: 13, status: 'needs-human', round: 1, sessionFailures: 2,
      devAgentId: 'a1', qaAgentId: null, summary: 'Session failed', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
    });
  });

  it('queues a fresh round, broadcasts it and lets a QA tester pick it up', async () => {
    const events = vi.spyOn(s, 'broadcast');
    expect(await rerun()).toBe('PR #13 on floor 1 is queued for QA (round 2).');
    expect(s.state.qa[0]).toMatchObject({ status: 'queued', round: 2, sessionFailures: 0 });
    expect(events).toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ status: 'queued', round: 2 }) });
    s.state.agents.push({ id: 'q1', name: 'Grace', repoId: repo.id, role: 'qa', status: 'idle', desk: 0 });
    const runQa = vi.spyOn(s, 'runQa').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(runQa).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }), repo, s.state.qa[0]);
  });

  it('stores instructions for only the requested round', async () => {
    await s.officeTools().call('rerun_qa', { floor: 1, number: 13, note: 'Check recovery' });
    expect(s.state.qa[0].rerunNote).toEqual({ round: 2, text: 'Check recovery' });
    s.state.qa[0].status = 'failed';
    await rerun();
    expect(s.state.qa[0]).toMatchObject({ round: 3, sessionFailures: 0 });
    expect(s.state.qa[0].rerunNote).toBeUndefined();
  });

  it('passes the note to the tester only in its QA round', async () => {
    const backend = createDemoBackend();
    backend.prDetails = async () => ({ ...pull(), body: 'Test recovery', isCrossRepository: false });
    const qaSwarm = new Swarm(backend) as unknown as Internals;
    vi.spyOn(qaSwarm, 'save').mockImplementation(() => {});
    vi.spyOn(qaSwarm, 'beginTask').mockImplementation(() => {});
    vi.spyOn(qaSwarm, 'prepare').mockResolvedValue('demo-worktree');
    const session = vi.spyOn(qaSwarm, 'startAgentSession').mockImplementation(() => {});
    const rec = s.state.qa[0];
    rec.round = 2;
    rec.rerunNote = { round: 2, text: 'Check recovery' };
    const tester = s.state.agents[0];
    await qaSwarm.runQa(tester, repo, rec);
    expect(session.mock.calls[0][3]).toContain('Note from the manager: Check recovery');
    rec.round = 3;
    await qaSwarm.runQa(tester, repo, rec);
    expect(session.mock.calls[1][3]).not.toContain('Note from the manager:');
  });

  it('lets the fake CEO rerun QA from a manager message', async () => {
    const finished = vi.fn();
    const callbacks: SessionCallbacks = {
      log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished,
    };
    const options: SessionOptions = {
      role: 'ceo', cwd: '', prompt: 'Manager asks:\nRerun QA on PR #13 on floor 1 with Check recovery',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools(),
    };
    const handle = createDemoBackend().startSession(options, callbacks);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'PR #13 on floor 1 is queued for QA (round 2).' }));
    expect(s.state.qa[0]).toMatchObject({ status: 'queued', round: 2, sessionFailures: 0, rerunNote: { round: 2, text: 'Check recovery' } });
    handle.stop();
  });

  it.each([
    ['Why is #13 stuck on pixel-todo?', 'PR #13 on floor 1 is needs-human. QA said: Session failed. QA sessions failed 2 times. It needs your call: fix it by hand, close it, or rerun QA.'],
    ['Why is #14 stuck on floor 99?', 'Refused: There is no floor 99.'],
    ['Why is #8 stuck on missing-repo?', 'Refused: No floor for "missing-repo".'],
    ['Why is #8 stuck?', "I can't find an open PR #8 on floor 1."],
  ])('lets the fake CEO answer "%s"', async (message, reply) => {
    Object.assign(s.state.qa[0], { retests: 0 });
    const finished = vi.fn();
    const callbacks: SessionCallbacks = {
      log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished,
    };
    const options: SessionOptions = {
      role: 'ceo', cwd: '', prompt: `Manager asks:\n${message}`,
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools(),
    };
    const handle = createDemoBackend().startSession(options, callbacks);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: reply }));
    handle.stop();
  });

  it.each(['testing', 'fixing'] as const)('refuses a PR that is already %s with 409', async (status) => {
    s.state.qa[0].status = status;
    await expect(swarm.sendToQa(repo.id, 13)).rejects.toMatchObject({ status: 409 });
    expect(await rerun()).toBe(`Refused: PR #13 is already ${status}`);
    expect(s.state.qa[0]).toMatchObject({ status, round: 1, sessionFailures: 2 });
  });

  it.each(['CLOSED', 'MERGED', null] as const)('refuses a closed or unknown PR (%s) with 404', async (state) => {
    s.repoRt.get(repo.id)!.pulls = state ? [pull(state)] : [];
    await expect(swarm.sendToQa(repo.id, 13)).rejects.toMatchObject({ status: 404 });
    expect(await rerun()).toBe('Refused: PR #13 is not open on demo-co/pixel-todo');
    expect(s.state.qa[0]).toMatchObject({ status: 'needs-human', round: 1, sessionFailures: 2 });
  });

  it('explains unknown floors', async () => {
    expect(await rerun({ floor: 8, number: 13 })).toContain('Refused: There is no floor 8.');
  });
});

describe('orphaned QA recovery', () => {
  let rec: QaRec;
  beforeEach(() => {
    rec = { repoId: repo.id, prNumber: 13, status: 'testing', round: 2, retests: 1, sessionFailures: 1,
      devAgentId: null, qaAgentId: 'a1', summary: '', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 };
    s.state.qa.push(rec);
    Object.assign(s.state.agents[0], { status: 'working', task: 'qa', prNumber: 14 });
  });

  it.each(['other-pr', 'missing', 'other-repo', 'other-task'] as const)('requeues %s on a scheduler tick without spending a round or failure', (condition) => {
    if (condition === 'missing') rec.qaAgentId = 'missing';
    if (condition === 'other-repo') Object.assign(s.state.agents[0], { repoId: 'r2', prNumber: 13 });
    if (condition === 'other-task') Object.assign(s.state.agents[0], { task: 'fix', prNumber: 13 });
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'officeUpdateTick').mockReturnValue(true); // Recovery also works while new sessions are drained.
    const events = vi.spyOn(s, 'broadcast');
    const message = vi.spyOn(s, 'postMessage');
    s.schedule();
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, retests: 1, sessionFailures: 1 });
    expect(events).toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ status: 'queued', qaAgentId: null }) });
    expect(message).toHaveBeenCalledWith('office', expect.stringContaining('Requeued orphaned QA for PR #13'));
  });

  it('keeps a tester preparing or working on this PR', () => {
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'officeUpdateTick').mockReturnValue(true);
    for (const status of ['preparing', 'working']) {
      Object.assign(s.state.agents[0], { status, prNumber: 13 });
      s.schedule();
      expect(rec.status).toBe('testing');
    }
  });

  it('recovers records after a restart even without an interrupted QA task', () => {
    s.recover([]);
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, retests: 1, sessionFailures: 1 });
  });

  it.each(['clear', 'replace'] as const)('releases QA when a task is %s', (action) => {
    const a = s.state.agents[0];
    a.prNumber = 13;
    if (action === 'clear') s.clearTask(a);
    else s.beginTask(a, { task: 'qa', prNumber: 14 }, 'Other QA', 'Preparing');
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, retests: 1, sessionFailures: 1 });
  });
});

describe('CEO park_pr', () => {
  const args = { floor: 1, number: 13, reason: 'Placeholder waits on #66' };
  let pull: PullInfo;
  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    setIssues(issue(66), { ...issue(67), nativeBlockers: [{ number: 66, state: 'OPEN' }] });
    pull = {
      number: 13, title: 'Blocker record', url: '', headRefName: 'swarm/issue-67-ada', state: 'OPEN',
      isDraft: true, closesIssues: [67], checks: 'none', mergeable: 'MERGEABLE', headSha: 'sha',
      reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
      mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
    };
    s.repoRt.get(repo.id)!.pulls = [pull];
    s.backend.prDetails = async () => ({ ...pull, body: '', isCrossRepository: false });
    vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment-url');
    vi.spyOn(s.backend, 'closePull').mockResolvedValue();
    s.state.qa.push({ repoId: repo.id, prNumber: 13, issueNumber: 67, status: 'needs-human', round: 3, sessionFailures: 2,
      devAgentId: 'a1', qaAgentId: null, summary: 'Implements none of the issue', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 });
    Object.assign(s.state.agents[0], { status: 'done', task: 'issue', issueNumber: 67, prNumber: 13, branch: pull.headRefName });
  });

  it('comments, closes without deleting the branch, removes QA and releases the blocked issue', async () => {
    const events = vi.spyOn(s, 'broadcast');
    const message = vi.spyOn(s, 'postMessage');
    repo.requestedStarts = [{ issueNumber: 67, preferredAgentId: 'a1', restartPending: true }];
    expect(await s.officeTools().call('park_pr', args)).toContain('branch swarm/issue-67-ada was kept');
    expect(s.backend.commentPull).toHaveBeenCalledWith(repo.fullName, 13, args.reason);
    expect(s.backend.closePull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13);
    expect(vi.mocked(s.backend.commentPull).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.backend.closePull).mock.invocationCallOrder[0]);
    expect(pull).toMatchObject({ state: 'CLOSED', headRefName: 'swarm/issue-67-ada' });
    expect(s.state.qa).toEqual([]);
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', issueNumber: null, prNumber: null });
    expect(repo.requestedStarts).toEqual([]);
    expect(events).toHaveBeenCalledWith({ type: 'qaRemoved', repoId: repo.id, prNumber: 13 });
    expect(events).toHaveBeenCalledWith({ type: 'repo', repo: expect.objectContaining({ parkedBranches: [{ issueNumber: 67, prNumber: 13, branch: pull.headRefName }] }) });
    expect(message).toHaveBeenCalledWith('office', 'Joi parked PR #13: Placeholder waits on #66');
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.pullRequests).toEqual([]);
    expect(floor.backlog.find((i: { number: number }) => i.number === 67)).toMatchObject({ waitsFor: [66] });
    expect(floor.backlog.find((i: { number: number }) => i.number === 67).inProgress).toBeUndefined();
    expect(ready()).not.toContain(67);
    // The next refresh reports the native blocker closed; only then is the issue ready.
    setIssues({ ...issue(67), nativeBlockers: [{ number: 66, state: 'CLOSED' }] });
    expect(ready()).toContain(67);
  });

  it.each(['queued', 'failed', 'fixing', 'passed', 'needs-human'] as const)('allows %s without a live session', async (status) => {
    s.state.qa[0].status = status;
    await swarm.parkPr(args);
    expect(s.state.qa).toEqual([]);
  });

  it('allows an open placeholder with no QA record or closing keyword', async () => {
    s.state.qa = [];
    pull.closesIssues = [];
    await swarm.parkPr(args);
    expect(repo.parkedBranches).toEqual([{ issueNumber: 67, prNumber: 13, branch: pull.headRefName }]);
  });

  it('releases a holder linked only through the QA issue number', async () => {
    pull.headRefName = 'placeholder/custom-branch';
    pull.closesIssues = [];
    Object.assign(s.state.agents[0], { prNumber: null, branch: null });
    await swarm.parkPr(args);
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', issueNumber: null });
    const backlog = JSON.parse(s.companyStatus()).floors[0].backlog;
    expect(backlog.find((i: { number: number }) => i.number === 67).inProgress).toBeUndefined();
    expect(repo.parkedBranches).toEqual([{ issueNumber: 67, prNumber: 13, branch: 'placeholder/custom-branch' }]);
  });

  it('releases a completed holder linked only through fresh closing references', async () => {
    s.state.qa = [];
    pull.headRefName = 'placeholder/custom-branch';
    pull.closesIssues = [];
    Object.assign(s.state.agents[0], { prNumber: null, branch: null });
    s.backend.prDetails = async () => ({ ...pull, closesIssues: [67], body: '', isCrossRepository: false });
    repo.requestedStarts = [{ issueNumber: 67, preferredAgentId: 'a1', restartPending: true }];

    await swarm.parkPr(args);

    expect(s.backend.commentPull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, args.reason);
    expect(s.backend.closePull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13);
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null, issueNumber: null, prNumber: null });
    expect(repo.requestedStarts).toEqual([]);
    expect(repo.parkedBranches).toEqual([{ issueNumber: 67, prNumber: 13, branch: pull.headRefName }]);
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.pullRequests).toEqual([]);
    const parkedIssue = floor.backlog.find((i: { number: number }) => i.number === 67);
    expect(parkedIssue).toMatchObject({ waitsFor: [66] });
    expect(parkedIssue.inProgress).toBeUndefined();
    expect(ready()).not.toContain(67);
  });

  it('refuses a live holder linked only through fresh closing references before GitHub mutations', async () => {
    s.state.qa = [];
    pull.headRefName = 'placeholder/custom-branch';
    pull.closesIssues = [];
    Object.assign(s.state.agents[0], { status: 'working', prNumber: null, branch: null });
    Object.assign(s.agentRt.get('a1')!, { session: {} });
    s.backend.prDetails = async () => ({ ...pull, closesIssues: [67], body: '', isCrossRepository: false });

    await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });

    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.closePull).not.toHaveBeenCalled();
    expect(pull.state).toBe('OPEN');
    expect(s.state.agents[0]).toMatchObject({ status: 'working', task: 'issue', issueNumber: 67 });
    expect(repo.parkedBranches).toEqual([]);
    expect(s.repoRt.get(repo.id)).toMatchObject({ parking: false });
  });

  it.each(['testing', 'busy', 'live-session', 'merging', 'syncing'] as const)('refuses %s with 409 and no GitHub mutations', async (condition) => {
    if (condition === 'testing') {
      s.state.qa[0].status = 'testing';
      Object.assign(s.state.agents[0], { task: 'qa', status: 'working' });
    }
    if (condition === 'busy') s.state.agents[0].status = 'preparing';
    if (condition === 'live-session') Object.assign(s.agentRt.get('a1')!, { session: {} });
    if (condition === 'merging' || condition === 'syncing') Object.assign(s.repoRt.get(repo.id)!, { [condition]: true });
    await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });
    expect(await s.officeTools().call('park_pr', args)).toContain('Refused:');
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.closePull).not.toHaveBeenCalled();
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses freshly %s PRs with 404 despite stale cache', async (state) => {
    s.backend.prDetails = async () => ({ ...pull, state, body: '', isCrossRepository: false });
    await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 404 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
  });

  it('refuses unknown PRs and floors', async () => {
    await expect(swarm.parkPr({ ...args, number: 99 })).rejects.toMatchObject({ status: 404 });
    expect(await s.officeTools().call('park_pr', { ...args, floor: 99 })).toContain('Refused: There is no floor 99');
  });

  it('reserves the repo across GitHub awaits and releases the reservation on failure', async () => {
    s.backend.commentPull = vi.fn(async () => {
      expect(s.startPipelineWork(repo)).toBe(false);
      expect(s.startIssueWork(repo)).toBe(false);
      await expect(swarm.sendToQa(repo.id, 13)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.mergePull(repo.id, 13)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.closePull(repo.id, 13)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.message('a1', 'Continue')).rejects.toMatchObject({ status: 409 });
      await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
      await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });
      throw new Error('GitHub unavailable');
    });
    await expect(swarm.parkPr(args)).rejects.toThrow('GitHub unavailable');
    expect(s.state.qa).toHaveLength(1);
    expect(pull.state).toBe('OPEN');
    s.backend.commentPull = vi.fn(async () => 'ok');
    await swarm.parkPr(args);
    expect(pull.state).toBe('CLOSED');
  });

  it('refuses while a manual merge is in progress and releases its merge flag on failure', async () => {
    s.backend.mergePull = vi.fn(async () => {
      await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });
      throw new Error('Merge failed');
    });
    await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('Merge failed');
    await swarm.parkPr(args);
    expect(pull.state).toBe('CLOSED');
  });

  it('keeps local state intact when closing fails', async () => {
    vi.mocked(s.backend.closePull).mockRejectedValueOnce(new Error('Close failed'));
    await expect(swarm.parkPr(args)).rejects.toThrow('Close failed');
    expect(s.state.qa).toHaveLength(1);
    expect(repo.parkedBranches).toEqual([]);
    expect(pull.state).toBe('OPEN');
  });

  it('rechecks session guards after reading GitHub', async () => {
    s.backend.prDetails = async () => {
      s.state.qa[0].status = 'testing';
      Object.assign(s.state.agents[0], { task: 'qa', status: 'working' });
      return { ...pull, body: '', isCrossRepository: false };
    };
    await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });
    expect(s.backend.closePull).not.toHaveBeenCalled();
  });

  it('parks an orphaned testing record while its tester works on another PR', async () => {
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'q1' });
    s.state.agents.push({ id: 'q1', name: 'Poirot', repoId: repo.id, task: 'qa', prNumber: 14, issueNumber: 67, status: 'working' });
    expect(await s.officeTools().call('park_pr', args)).toContain('is parked');
    expect(s.state.qa).toEqual([]);
    expect(s.state.agents.at(-1)).toMatchObject({ task: 'qa', prNumber: 14, status: 'working' });
  });

  it('retains the branch hint through JSON persistence and includes it in restarted developer work', async () => {
    await swarm.parkPr(args);
    const restored = JSON.parse(JSON.stringify(repo));
    vi.spyOn(s, 'beginTask').mockImplementation(() => {});
    vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
    const session = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    // Restore the real implementation replaced by the scheduling fixture.
    const actual = new Swarm(s.backend) as unknown as Internals;
    await actual.runTask.call(s, s.state.agents[0], restored, issue(67));
    expect(session.mock.calls[0][3]).toContain('reuse work from remote branch swarm/issue-67-ada');
    expect(s.repoView(restored)).toMatchObject({ parkedBranches: repo.parkedBranches });
  });

  it('lets the demo CEO park from a manager message', async () => {
    const finished = vi.fn();
    const handle = createDemoBackend().startSession({ role: 'ceo', cwd: '', prompt: 'Manager asks:\nPark PR #13 on floor 1 because Placeholder waits on #66',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
    { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('is parked') }));
    expect(s.state.qa).toEqual([]);
    handle.stop();
  });
});

describe('CEO send_back_to_dev', () => {
  const send = (extra: Record<string, unknown> = {}) => s.officeTools().call('send_back_to_dev', { floor: 1, number: 13, ...extra });
  let pull: PullInfo;
  beforeEach(() => {
    repo.autoAssign = false;
    Object.assign(repo, { defaultBranch: 'trunk', links: [] });
    pull = {
      number: 13, title: 'Recovery', url: '', headRefName: 'swarm/13', state: 'OPEN',
      isDraft: false, closesIssues: [], checks: 'failing', mergeable: 'MERGEABLE', headSha: 'sha',
      reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
      mergeState: 'CLEAN', failedChecks: [{ name: 'Build', url: null }], pendingChecks: [],
    };
    s.repoRt.get(repo.id)!.pulls = [pull];
    s.backend.prDetails = async () => ({ ...pull, body: '', isCrossRepository: false });
    s.state.qa.push({
      repoId: repo.id, prNumber: 13, status: 'needs-human', round: 3, sessionFailures: 2,
      devAgentId: 'a1', qaAgentId: null, summary: 'Recovery loses work',
      checks: [{ name: 'Recovery', result: 'fail', details: 'Missing task' }], commentUrl: null, mergeNote: null, updatedAt: 0,
    });
    Object.assign(s.state.qa[0], { retests: 0, devSessionId: 'old-session', passedSha: 'old-sha', mergeFixes: 3, testedSha: 'old-sha', failedSha: 'old-sha', fixCrashes: ['a1'] });
    vi.spyOn(s, 'beginTask').mockImplementation((agent, patch) => Object.assign(agent as object, patch, { status: 'preparing' }));
    vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
  });

  it.each(['needs-human', 'failed', 'passed'] as const)('hands a %s PR to a developer with findings and the CEO note', async (status) => {
    s.state.qa[0].status = status;
    const session = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    const message = vi.spyOn(s, 'postMessage');
    await send({ note: 'Keep the queued task', reason: 'qa' });
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', round: 3, retests: 3, sessionFailures: 0, passedSha: null, fixCrashes: [] });
    expect(message).toHaveBeenCalledWith('office', 'Joi sent PR #13 back to Ada: qa');
    expect(s.startPipelineWork(repo)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const prompt = session.mock.calls[0][3] as string;
    expect(prompt).toContain('Recovery loses work');
    expect(prompt).toContain('Missing task');
    expect(prompt).toContain('GitHub check failed: Build');
    expect(prompt).toContain('Keep the queued task');
    expect(prompt).toContain('git push origin HEAD:swarm/13');
  });

  it.each([undefined, 'qa', 'checks', 'other'] as const)('includes conflicts and QA fixes together for reason %s', async (reason) => {
    pull.mergeable = 'CONFLICTING';
    const session = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    await send({ reason, note: 'Preserve recovery' });
    expect(s.state.qa[0]).toMatchObject({ fixReason: reason ?? 'conflict' });
    await s.runFix(s.state.agents[0], repo, s.state.qa[0]);
    const prompt = session.mock.calls[0][3] as string;
    expect(prompt).toContain('git merge origin/trunk');
    expect(prompt).toContain('Recovery loses work');
    expect(prompt).toContain('Preserve recovery');
    expect(prompt).not.toContain('QA passed');
  });

  it.each(['testing', 'fixing', 'queued'] as const)('refuses %s with 409', async (status) => {
    s.state.qa[0].status = status;
    if (status === 'testing' || status === 'fixing') {
      s.state.qa[0].qaAgentId = 'a1';
      Object.assign(s.state.agents[0], { task: status === 'testing' ? 'qa' : 'fix', prNumber: 13, status: 'working' });
    }
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
    expect(await send()).toContain(`Refused: PR #13 is ${status}`);
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses a freshly %s PR with 404 even with a stale open cache', async (state) => {
    s.backend.prDetails = async () => ({ ...pull, state, body: '', isCrossRepository: false });
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 404 });
    expect(s.state.qa[0].status).toBe('needs-human');
  });

  it('refuses unknown PRs and rechecks QA status after querying GitHub', async () => {
    await expect(swarm.sendBackToDev({ floor: 1, number: 99 })).rejects.toMatchObject({ status: 404 });
    s.backend.prDetails = async () => {
      s.state.qa[0].status = 'testing';
      s.state.qa[0].qaAgentId = 'a1';
      Object.assign(s.state.agents[0], { task: 'qa', prNumber: 13, status: 'working' });
      return { ...pull, body: '', isCrossRepository: false };
    };
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
  });

  it('sends orphaned QA back to development while the tester works on another PR', async () => {
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'q1' });
    s.state.agents.push({ id: 'q1', name: 'Poirot', repoId: repo.id, task: 'qa', prNumber: 14, status: 'working' });
    expect(await send()).toContain('queued for fixes');
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', qaAgentId: null });
    expect(s.state.agents.at(-1)).toMatchObject({ task: 'qa', prNumber: 14, status: 'working' });
  });

  it.each(['testing', 'fixing'] as const)('accepts stale %s work after its session has ended', async (status) => {
    Object.assign(s.state.qa[0], { status, qaAgentId: 'a1' });
    Object.assign(s.state.agents[0], { task: status === 'testing' ? 'qa' : 'fix', prNumber: 13, status: 'done' });
    expect(await send()).toContain('queued for fixes');
  });

  it.each(['qa', 'fix'] as const)('refuses a live %s session even with a stale finished agent status', async (task) => {
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'a1' });
    Object.assign(s.state.agents[0], { task, prNumber: 13, status: 'done' });
    Object.assign(s.agentRt.get('a1')!, { session: {} });
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
  });

  it('uses another free developer, queues when all are busy, and accepts a named developer', async () => {
    const other = { id: 'a2', name: 'Barbara', repoId: repo.id, role: 'dev', status: 'idle', desk: 1, specialty: '' };
    s.state.agents.push(other);
    s.agentRt.set('a2', { log: [], pending: [], terminal: null });
    s.state.agents[0].status = 'working';
    await send();
    expect(s.state.qa[0]).toMatchObject({ devAgentId: 'a2', devSessionId: null });
    other.status = 'working';
    await send();
    expect(s.startPipelineWork(repo)).toBe(false);
    other.status = 'idle';
    const fix = vi.spyOn(s, 'runFix').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(fix).toHaveBeenCalledWith(other, repo, s.state.qa[0]);
    s.state.agents[0].status = 'idle';
    await send({ agent: 'ada' });
    expect(s.state.qa[0].devAgentId).toBe('a1');
    expect(await send({ agent: 'Joi' })).toContain('Refused: Choose a developer');
  });

  it.each(['qa', 'conflict', 'checks', 'other'] as const)('re-tests a %s fix and sends another QA failure to a developer', async (reason) => {
    vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    await send({ reason });
    const dev = s.state.agents[0];
    await s.runFix(dev, repo, s.state.qa[0]);
    s.onFixFinished(dev, repo, { ok: true, text: '', errors: [], costUsd: 0, turns: 0 });
    expect(s.state.qa[0]).toMatchObject({ status: 'queued', round: 4, retests: 3 });
    const tester = { id: 'q1', name: 'Grace', repoId: repo.id, role: 'qa', task: 'qa', status: 'working', prNumber: 13 };
    s.state.agents.push(tester);
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: tester.id });
    s.agentRt.set('q1', { log: [], pending: [], terminal: null, shots: [] });
    s.backend.commentPull = vi.fn(async () => 'comment');
    await s.onQaFinished(tester, repo, { ok: true, text: '', errors: [], costUsd: 0, turns: 0, structured: {
      verdict: 'fail', summary: 'Still missing task', checks: [{ name: 'Recovery', result: 'fail', details: 'Missing task' }], commands: [], screenshots: [],
    } });
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', round: 4, fixReason: 'qa' });
    const fix = vi.spyOn(s, 'runFix').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(fix).toHaveBeenCalledWith(dev, repo, s.state.qa[0]);
  });

  it('lets the demo CEO send a PR to a developer', async () => {
    const finished = vi.fn();
    const callbacks: SessionCallbacks = { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished };
    const handle = createDemoBackend().startSession({
      role: 'ceo', cwd: '', prompt: 'Manager asks:\nSend PR #13 back to dev on floor 1 with Keep the task',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools(),
    }, callbacks);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('queued for fixes with Ada') }));
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', sessionFailures: 0, fixInstructions: expect.stringContaining('Keep the task') });
    handle.stop();
  });
});

describe('native issue dependencies', () => {
  it('never auto-assigns an open native blocker, then starts after a sync sees it closed', () => {
    const blocked = { ...issue(2), nativeBlockers: [{ number: 1, state: 'OPEN' as const }] };
    setIssues(issue(1, ['ready-for-human']), blocked);
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
    setIssues({ ...blocked, nativeBlockers: [{ number: 1, state: 'CLOSED' }] });
    expect(ready()).toEqual([2]);
    s.startIssueWork(repo);
    expect(runTask.mock.calls[0][2].number).toBe(2);
  });

  it('unions blockers in CEO status, ready counts and longest chain, and ranks the foundation first', () => {
    setIssues(issue(1), issue(2), { ...issue(3, [], 'Depends on #2'), nativeBlockers: [{ number: 2, state: 'OPEN' }] },
      { ...issue(4), nativeBlockers: [{ number: 3, state: 'OPEN' }] });
    expect(ready()).toEqual([2, 1]);
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.capacity).toMatchObject({ issuesReadyToStart: 2, issuesWaitingOnOthers: 2, longestDependencyChain: 2 });
    expect(floor.backlog[2].waitsFor).toEqual([2]);
    expect(floor.backlog[3].waitsFor).toEqual([3]);
  });

  it('blocks on external native issues independently of same-number local issues', () => {
    setIssues({ ...issue(2), nativeBlockers: [{ number: 2, state: 'OPEN', repo: 'other/repo' }] });
    expect(ready()).toEqual([]);
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.backlog[0].waitsFor).toEqual(['other/repo#2']);
    expect(floor.capacity.longestDependencyChain).toBe(1);
  });
});

describe('ready-for-human issues', () => {
  it('are never ready to start, in any letter case', () => {
    setIssues(issue(1), issue(2, ['ready-for-human']), issue(3, ['swarm:server', 'Ready-For-Human']), issue(4, ['READY-FOR-HUMAN']));
    expect(ready()).toEqual([1]);
  });

  it('still hold up the issues that depend on them', () => {
    setIssues(issue(1, ['ready-for-human']), issue(2, [], 'Depends on #1'));
    expect(ready()).toEqual([]);
    setIssues(issue(2, [], 'Depends on #1')); // #1 closed by the person
    expect(ready()).toEqual([2]);
  });

  it('become schedulable on the next poll once the label is removed', () => {
    setIssues(issue(1, ['ready-for-human']));
    expect(ready()).toEqual([]);
    setIssues(issue(1));
    expect(ready()).toEqual([1]);
  });

  it('are refused by assign with a 409 that says how to release them', async () => {
    setIssues(issue(7, ['Ready-for-Human']));
    const err = await swarm.assign('a1', 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toBe("#7 is labelled ready-for-human: an agent can't complete it. Remove the label to hand it to a developer.");
    expect(runTask).not.toHaveBeenCalled();

    setIssues(issue(7));
    await swarm.assign('a1', 7);
    expect(runTask).toHaveBeenCalledOnce();
  });

  it('are left in the backlog by auto-assign while free developers take other work', () => {
    setIssues(issue(1, ['ready-for-human']));
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();

    setIssues(issue(1, ['ready-for-human']), issue(2));
    s.startIssueWork(repo);
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask.mock.calls[0][2].number).toBe(2);
  });

  it('are marked in company_status and left out of its capacity', () => {
    setIssues(issue(1, ['ready-for-human']), issue(2));
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.capacity.issuesReadyToStart).toBe(1);
    expect(floor.backlog).toEqual([
      expect.objectContaining({ number: 1, readyForHuman: true }),
      expect.not.objectContaining({ readyForHuman: expect.anything() }),
    ]);
  });
});

describe('a developer session that ends without a PR after pushing commits', () => {
  type Backend = ReturnType<typeof createDemoBackend>;
  type Fake = Internals & {
    syncRepo(id: string): Promise<void>;
    buildSystemAppend(...args: unknown[]): string;
    issueTaken(repo: Repo, n: number): boolean;
    pausedUntil: number;
    nudged: Set<string>;
    state: { messages: { text: string }[]; settings: { sessionLimit: number } };
  };
  let sessions: { opts: SessionOptions; cb: SessionCallbacks }[];
  let ahead: Mock<Backend['branchAhead']>;
  let f: Fake;
  let backend: Backend;
  const ada = () => s.state.agents[0];
  const cut = { ok: false, text: '', errors: ['Codex was stopped (SIGTERM) before finishing.'], costUsd: 0, turns: 0 };
  /** The office follows a session, and the CLI behind it ends with this result. */
  const end = async (result: typeof cut) => {
    const n = sessions.length;
    sessions[n - 1].cb.finished(result);
    await vi.waitFor(() => expect(ada().status).not.toBe('working'), { timeout: 500 }).catch(() => undefined);
    return sessions.length > n;
  };

  beforeEach(() => {
    f = s as unknown as Fake;
    backend = (s as unknown as { backend: Backend }).backend;
    Object.assign(repo, { defaultBranch: 'main', links: [], browserTesting: false });
    Object.assign(ada(), { model: '', effort: '', cli: '', task: 'issue', issueNumber: 66, issueTitle: 'Issue 66', branch: 'swarm/issue-66-ada', sessionId: null, prNumber: null, startedAt: Date.now(), turns: 0, costUsd: 0 });
    sessions = [];
    vi.spyOn(backend, 'startSession').mockImplementation((opts, cb) => {
      sessions.push({ opts, cb });
      return { send: () => undefined, stop: () => undefined };
    });
    ahead = vi.spyOn(backend, 'branchAhead').mockResolvedValue(3);
    vi.spyOn(backend, 'prForBranch').mockResolvedValue(null);
    vi.spyOn(f, 'syncRepo').mockResolvedValue();
    vi.spyOn(f, 'buildSystemAppend').mockReturnValue('');
    s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
  });

  it('is retried once on the same desk and branch, then reported with its branch', async () => {
    expect(await end(cut)).toBe(true);
    expect(ahead).toHaveBeenCalledWith('demo-co/pixel-todo', 'main', 'swarm/issue-66-ada');
    expect(ada()).toMatchObject({ status: 'working', task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada' });
    const retry = sessions[1].opts;
    expect(retry.cwd).toBe(backend.deskDir(repo.fullName, 'ada-a1')); // the desk as it was left: not prepared (reset) again
    expect(retry.resumeSessionId).toBeUndefined(); // Codex never said which thread it was on
    expect(retry.prompt).toContain('swarm/issue-66-ada has 3 pushed commits ahead of main');
    expect(retry.prompt).toContain('SIGTERM');

    // The retry is cut off too: no third session, and the office says where the work is.
    expect(await end(cut)).toBe(false);
    expect(ada()).toMatchObject({ status: 'error', lastError: cut.errors[0] });
    expect(f.state.messages.at(-1)?.text).toContain('Its branch swarm/issue-66-ada has 3 pushed commits on GitHub');
  });

  it('resumes the session it has, and names the branch when the issue goes back on the board', async () => {
    ada().sessionId = 'thread-1';
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(sessions[1].opts.resumeSessionId).toBe('thread-1');
    expect(sessions[1].opts.prompt).toContain('ended without opening a pull request');
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(false);
    expect(ada()).toMatchObject({ status: 'idle', task: null });
    expect(f.state.messages.at(-1)?.text).toContain('Its branch swarm/issue-66-ada has 3 pushed commits to pick up from.');
  });

  it('starts the retry only once the desk it left is cleaned up', async () => {
    let cleaned!: () => void;
    const release = vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((r) => (cleaned = r)));
    sessions[0].cb.finished(cut);
    await vi.waitFor(() => expect(ahead).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(50);
    expect(release).toHaveBeenCalledWith('demo-co/pixel-todo', 'ada-a1', expect.any(Number));
    expect(sessions).toHaveLength(1); // the clean-up could otherwise kill the new CLI's processes
    cleaned();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[1].opts.cwd).toBe(backend.deskDir(repo.fullName, 'ada-a1'));
    expect(sessions[1].opts.prompt).toContain('swarm/issue-66-ada');
    await vi.advanceTimersByTimeAsync(50);
    expect(sessions).toHaveLength(2);
  });

  it('starts no retry when the manager stops them during the clean-up', async () => {
    let cleaned!: () => void;
    vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((r) => (cleaned = r)));
    sessions[0].cb.finished(cut);
    await vi.waitFor(() => expect(ahead).toHaveBeenCalled());
    swarm.stopAgent(String(ada().id));
    cleaned();
    await vi.advanceTimersByTimeAsync(50);
    expect(sessions).toHaveLength(1);
    expect(ada().status).toBe('stopped');
  });

  describe('during a usage pause', () => {
    beforeEach(() => {
      vi.mocked(f.schedule).mockRestore();
      vi.spyOn(f, 'maybeHeartbeat').mockImplementation(() => {});
      vi.spyOn(f, 'startCeoWork').mockImplementation(() => {});
      vi.spyOn(f, 'officeUpdateTick').mockReturnValue(false);
    });
    const pause = () => sessions[0].cb.limited?.(Date.now() + 60_000);
    const pauseEnds = () => {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      f.schedule();
    };

    it('holds the retry when the limit is hit during the desk clean-up, then starts it once', async () => {
      let cleaned!: () => void;
      vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((r) => (cleaned = r)));
      sessions[0].cb.finished(cut);
      await vi.waitFor(() => expect(ahead).toHaveBeenCalled());
      pause();
      cleaned();
      await vi.advanceTimersByTimeAsync(50);
      f.schedule();
      expect(sessions).toHaveLength(1);
      expect(ada()).toMatchObject({ status: 'error', task: 'issue', issueNumber: 66 }); // not left 'working' with no session
      pauseEnds();
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.cwd).toBe(backend.deskDir(repo.fullName, 'ada-a1'));
      expect(sessions[1].opts.prompt).toContain('swarm/issue-66-ada has 3 pushed commits');
      f.schedule();
      expect(sessions).toHaveLength(2);
    });

    it('holds the retry of a session that ends while paused, then resumes that session', async () => {
      ada().sessionId = 'thread-1';
      pause();
      sessions[0].cb.finished({ ...cut, ok: true, errors: [] });
      await vi.advanceTimersByTimeAsync(50);
      f.schedule();
      expect(sessions).toHaveLength(1);
      expect(ada()).toMatchObject({ status: 'done', task: 'issue', issueNumber: 66 });
      pauseEnds();
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.resumeSessionId).toBe('thread-1');
      expect(sessions[1].opts.prompt).toContain('swarm/issue-66-ada has 3 pushed commits');
    });

    it('waits for a free session slot like any other start', async () => {
      f.state.settings.sessionLimit = 1;
      pause();
      sessions[0].cb.finished(cut);
      await vi.advanceTimersByTimeAsync(50);
      const barbara = { ...ada(), id: 'a2', name: 'Barbara', desk: 1, status: 'working', issueNumber: 67, heldRetry: null };
      f.state.agents.push(barbara);
      pauseEnds();
      expect(sessions).toHaveLength(1); // Barbara has the only slot
      expect(ada()).toMatchObject({ status: 'error', heldRetry: { issueNumber: 66, ahead: 3 } });
      expect(f.issueTaken(repo, 66)).toBe(true);
      barbara.status = 'done';
      f.schedule();
      expect(sessions).toHaveLength(2);
      expect(ada()).toMatchObject({ status: 'working', heldRetry: null });
    });

    it('survives an office restart', async () => {
      ada().sessionId = 'thread-1';
      pause();
      sessions[0].cb.finished({ ...cut, ok: true, errors: [] });
      await vi.advanceTimersByTimeAsync(50);
      // Only the state file survives: the pause and the nudges were in memory.
      f.state = JSON.parse(JSON.stringify(f.state)) as Fake['state'];
      Object.assign(f, { pausedUntil: 0, nudged: new Set() });
      expect(ada()).toMatchObject({ status: 'done', task: 'issue', issueNumber: 66, heldRetry: { issueNumber: 66, ahead: 3 } });
      expect(f.issueTaken(repo, 66)).toBe(true);
      f.schedule();
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.resumeSessionId).toBe('thread-1');
      expect(sessions[1].opts.prompt).toContain('swarm/issue-66-ada has 3 pushed commits');
      expect(ada().heldRetry).toBeNull();
    });
  });

  describe('when the manager takes over during the desk clean-up', () => {
    let cleaned!: () => void;
    beforeEach(() => {
      const cleanup = new Promise<void>((r) => (cleaned = r));
      vi.spyOn(backend, 'releaseDesk').mockReturnValue(cleanup);
    });
    const stopDuringCleanup = async () => {
      sessions[0].cb.finished(cut);
      await vi.waitFor(() => expect(ahead).toHaveBeenCalled());
      swarm.stopAgent('a1');
    };

    it('Stop then Clear desk: the old session starts no retry', async () => {
      await stopDuringCleanup();
      swarm.resetAgent('a1');
      cleaned();
      await vi.advanceTimersByTimeAsync(50);
      expect(sessions).toHaveLength(1);
      expect(ada()).toMatchObject({ status: 'idle', task: null, issueNumber: null, branch: null, heldRetry: null, lastError: null });
    });

    it('Stop then Assign another issue: the old session leaves the new task alone', async () => {
      s.runTask = (Swarm.prototype as unknown as { runTask: RunTask }).runTask; // the real one: prepares the desk and starts the session
      Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready' });
      setIssues(issue(66), issue(67));
      await stopDuringCleanup();
      await swarm.assign('a1', 67);
      cleaned();
      await vi.advanceTimersByTimeAsync(1000); // the demo desk takes 900ms to prepare
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.prompt).toContain('Please resolve GitHub issue #67');
      expect(sessions[1].opts.prompt).not.toContain('#66');
      expect(ada()).toMatchObject({ status: 'working', task: 'issue', issueNumber: 67, branch: 'swarm/issue-67-ada', prNumber: null, heldRetry: null, lastError: null });
    });
  });

  describe("when a stopped session's end arrives after the manager took over", () => {
    const late = { ...cut, costUsd: 2, turns: 5 };
    const rt = () => f.agentRt.get('a1') as unknown as { session: unknown };

    it('Stop then Clear desk: changes nothing', async () => {
      swarm.stopAgent('a1');
      swarm.resetAgent('a1');
      const release = vi.spyOn(backend, 'releaseDesk');
      sessions[0].cb.finished(late);
      await vi.advanceTimersByTimeAsync(50);
      expect(release).not.toHaveBeenCalled();
      expect(ahead).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(1);
      expect(ada()).toMatchObject({ status: 'idle', task: null, issueNumber: null, lastError: null, costUsd: 0, turns: 0, endedAt: null });
      expect(rt().session).toBeNull(); // the stopped session's handle doesn't linger
    });

    it('Stop then Assign another issue: the new task and its session are left alone', async () => {
      s.runTask = (Swarm.prototype as unknown as { runTask: RunTask }).runTask;
      Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready' });
      setIssues(issue(66), issue(67));
      swarm.stopAgent('a1');
      await swarm.assign('a1', 67);
      await vi.advanceTimersByTimeAsync(1000); // the demo desk takes 900ms to prepare
      expect(sessions).toHaveLength(2);
      const replacement = rt().session;
      expect(replacement).not.toBeNull();
      const release = vi.spyOn(backend, 'releaseDesk');
      sessions[0].cb.finished(late);
      await vi.advanceTimersByTimeAsync(50);
      expect(release).not.toHaveBeenCalled();
      expect(ahead).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(2);
      expect(rt().session).toBe(replacement);
      expect(ada()).toMatchObject({ status: 'working', task: 'issue', issueNumber: 67, branch: 'swarm/issue-67-ada', lastError: null, costUsd: 0, turns: 0, endedAt: null });
    });
  });

  it('fails as before when nothing was pushed', async () => {
    ahead.mockRejectedValue(new Error('gh api failed: HTTP 404'));
    expect(await end(cut)).toBe(false);
    expect(ada()).toMatchObject({ status: 'error', branch: 'swarm/issue-66-ada' });
  });
});

describe('company_status size', () => {
  const pr = (number: number): PullInfo => ({
    number, title: `Pull request ${number} with a reasonably long descriptive title`, url: '', headRefName: `swarm/${number}`, state: 'OPEN',
    isDraft: false, closesIssues: [], checks: 'passing', mergeable: 'CONFLICTING', headSha: 'f'.repeat(40),
    reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0, mergeState: 'DIRTY', failedChecks: [], pendingChecks: [],
  });
  beforeEach(() => {
    // A little bigger than the live office: 8 floors of 4 people with long job descriptions and QA briefs, a backlog and a stuck PR each.
    s.state.repos.length = 0;
    s.state.agents = s.state.agents.filter((a) => a.role === 'ceo');
    for (let f = 1; f <= 8; f++) {
      const r = { ...repo, id: `r${f}`, floor: f, fullName: `demo-co/project-${f}`, qaBrief: 'Check '.repeat(300), summary: 'A web app', mission: 'Build it. '.repeat(20), preview: { command: 'npm run dev -- --port {port}', env: {} } } as unknown as Repo;
      s.state.repos.push(r);
      for (let d = 0; d < 4; d++) {
        s.state.agents.push({ id: `a${f}-${d}`, name: `Dev ${f}-${d}`, repoId: r.id, role: d < 3 ? 'dev' : 'qa', specialty: 'frontend', status: 'idle', desk: d, brief: 'Owns the frontend. '.repeat(100), hiredBy: 'ceo' });
      }
      s.repoRt.set(r.id, { issues: Array.from({ length: 10 }, (_, i) => ({ ...issue(i + 1, ['swarm:frontend']), title: `Issue ${i + 1}: a typical title of about fifty chars` })), pulls: [pr(100), pr(101)] });
      for (const n of [100, 101]) {
        s.state.qa.push({
          repoId: r.id, prNumber: n, status: n === 100 ? 'needs-human' : 'passed', round: 3, retests: 0, sessionFailures: 0, testedSha: 'e'.repeat(40), fixReason: 'qa',
          devAgentId: `a${f}-0`, qaAgentId: null, summary: 'The toolbar overflows on phones. '.repeat(30), commentUrl: 'https://github.com/x/y/pull/1#c',
          checks: [{ name: 'Mobile layout', result: 'fail', details: 'long details '.repeat(20) }], mergeNote: null, updatedAt: 0,
        } as Internals['state']['qa'][number]);
      }
    }
  });

  it('stays well under the CEO tool-result limit by default', () => {
    const out = s.companyStatus();
    expect(out.length).toBeLessThan(25_000);
    const status = JSON.parse(out);
    expect(status.floors).toHaveLength(8);
    expect(status.floors[0]).not.toHaveProperty('qaBrief');
    expect(status.floors[0].team[0]).not.toHaveProperty('jobDescription');
    expect(status.floors[0].pullRequests[0]).toMatchObject({ mergeable: 'conflicting', failedChecks: ['Mobile layout'], qaRoundsLeft: 0, newCommitsSinceQa: true });
  });

  it('returns one floor in full, or every floor with verbose', () => {
    const one = JSON.parse(s.companyStatus({ floor: 3 }));
    expect(one.floors).toHaveLength(1);
    expect(one.floors[0]).toMatchObject({ floor: 3, qaBrief: expect.stringContaining('Check'), preview: expect.objectContaining({ command: 'npm run dev -- --port {port}' }) });
    expect(one.floors[0].team[0].jobDescription).toMatch(/^Owns the frontend\..*see agent_detail\)$/);
    const all = JSON.parse(s.companyStatus({ verbose: true }));
    expect(all.floors.every((f: { qaBrief?: string }) => f.qaBrief)).toBe(true);
    expect(() => s.companyStatus({ floor: 9 })).toThrow(/no floor 9/);
  });
});

describe('QA rounds', () => {
  const pull: PullInfo = {
    number: 13, title: 'Chaser', url: '', headRefName: 'swarm/13', state: 'OPEN',
    isDraft: false, closesIssues: [], checks: 'passing', mergeable: 'MERGEABLE', headSha: 'sha-1',
    reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
    mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  };
  const result = (ok: boolean, structured?: unknown): SessionResult => ({ ok, text: '', costUsd: 0, turns: 1, errors: ok ? [] : ['Claude Code exited with code 1'], structured });
  const failReport = { verdict: 'fail', summary: 'Still broken', checks: [{ name: 'Chaser', result: 'fail', details: 'never catches up' }] };
  const addAgent = (id: string, name: string, role: string, desk: number) => {
    const a: Record<string, unknown> = { id, name, repoId: repo.id, role, specialty: '', status: 'idle', task: null, issueNumber: null, desk, endedAt: null };
    s.state.agents.push(a);
    s.agentRt.set(id, { log: [], pending: [], terminal: null, shots: [] });
    return a;
  };
  let ada: Record<string, unknown>;
  let rec: QaRec;
  let runFix: Mock;

  beforeEach(() => {
    ada = s.state.agents[0];
    s.agentRt.get('a1')!.shots = [];
    s.repoRt.get(repo.id)!.pulls = [pull];
    rec = {
      repoId: repo.id, prNumber: 13, status: 'failed', round: 2, sessionFailures: 0, retests: 0, testedSha: 'sha-0', failedSha: 'sha-0', fixCrashes: [],
      devAgentId: 'a1', qaAgentId: 'q1', summary: 'Broken', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
    };
    s.state.qa.push(rec);
    runFix = vi.spyOn(s, 'runFix').mockResolvedValue() as Mock;
  });

  const qaFails = async (tester: Record<string, unknown>) => {
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    rec.status = 'testing';
    rec.testedSha = 'sha-1';
    await s.onQaFinished(tester, repo, result(true, failReport));
  };
  const fixCrashes = (dev: Record<string, unknown>) => {
    Object.assign(dev, { status: 'working', task: 'fix', prNumber: 13 });
    rec.status = 'fixing';
    rec.devAgentId = dev.id as string;
    s.onFixFinished(dev, repo, result(false));
  };

  it("doesn't spend QA's budget on a manager re-run: a fail after it goes back to the developer", async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    const comment = vi.spyOn(s.backend, 'commentPull');
    await swarm.sendToQa(repo.id, 13);
    expect(rec).toMatchObject({ status: 'queued', round: 3, retests: 1 });
    await qaFails(tester);
    expect(rec).toMatchObject({ status: 'failed', failedSha: 'sha-1' });
    expect(comment.mock.calls[0][2]).toContain('sent back to the developer for fixes');
  });

  it('still hands a PR to a human after three QA rounds of its own fail', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    const comment = vi.spyOn(s.backend, 'commentPull');
    rec.round = 3;
    await qaFails(tester);
    expect(rec.status).toBe('needs-human');
    expect(comment.mock.calls[0][2]).toContain('needs a human decision');
  });

  it('keeps the tester on the first PR until its delayed QA comment is recorded', async () => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(ada, { status: 'working', task: 'issue' }); // Only one tester can take the next PR.
    s.state.qa.push({ ...rec, prNumber: 14, status: 'queued', qaAgentId: null });
    let posted!: (url: string) => void;
    const comment = vi.spyOn(s.backend, 'commentPull').mockImplementation(() => new Promise<string>((resolve) => { posted = resolve; }));
    const nextQa = vi.spyOn(s, 'runQa').mockImplementation(async (agent, _repo, record) => {
      Object.assign(agent as object, { status: 'preparing', task: 'qa', prNumber: (record as QaRec).prNumber });
      Object.assign(record as object, { status: 'testing', qaAgentId: (agent as Record<string, unknown>).id });
    });
    const finishing = qaFails(tester);
    await vi.advanceTimersByTimeAsync(0);
    expect(comment).toHaveBeenCalledOnce();
    vi.mocked(s.schedule).mockRestore();
    Object.assign(s.repoRt.get(repo.id)!, { lastSync: Date.now(), cloneStatus: 'ready' });
    vi.spyOn(s, 'officeUpdateTick').mockReturnValue(false);
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    expect(nextQa).not.toHaveBeenCalled();
    expect(tester).toMatchObject({ status: 'working', task: 'qa', prNumber: 13 });
    expect(rec.status).toBe('testing');
    posted('comment-url');
    await finishing;
    expect(rec).toMatchObject({ status: 'failed', commentUrl: 'comment-url' });
    expect(tester.status).toBe('done');
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(nextQa).toHaveBeenCalledWith(tester, repo, s.state.qa[1]);
  });

  it('ignores an old report after its task is cleared during comment posting', async () => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    let posted!: (url: string) => void;
    vi.spyOn(s.backend, 'commentPull').mockImplementation(() => new Promise<string>((resolve) => { posted = resolve; }));
    const finishing = qaFails(tester);
    await vi.advanceTimersByTimeAsync(0);
    s.clearTask(tester);
    posted('comment-url');
    await finishing;
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, retests: 0, sessionFailures: 0 });
    expect(tester).toMatchObject({ task: null, status: 'idle' });
  });

  it.each(['send-back', 'park'] as const)('preserves an accepted %s after Stop during a delayed passing report', async (handoff) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(repo, { autoMerge: true, defaultBranch: 'main', links: [], parkedBranches: [] });
    s.repoRt.get(repo.id)!.pulls = [{ ...pull }];
    Object.assign(rec, { status: 'testing', testedSha: 'sha-1', retests: 1, sessionFailures: 1, passedSha: null });
    s.backend.prDetails = async () => ({ ...pull, body: '', isCrossRepository: false });
    let posted!: (url: string) => void;
    const comment = vi.spyOn(s.backend, 'commentPull').mockResolvedValue('park-comment')
      .mockImplementationOnce(() => new Promise<string>((resolve) => { posted = resolve; }));
    const events = vi.spyOn(s, 'broadcast');
    const finishing = s.onQaFinished(tester, repo, result(true, {
      verdict: 'pass', summary: 'Passed before Stop', checks: [{ name: 'Recovery', result: 'pass', details: 'OK' }],
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(comment).toHaveBeenCalledOnce();
    swarm.stopAgent('q1');
    if (handoff === 'send-back') {
      await swarm.sendBackToDev({ floor: 1, number: 13, reason: 'other', note: 'Preserve the accepted fix request' });
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'other', passedSha: null });
    } else {
      await swarm.parkPr({ floor: 1, number: 13, reason: 'Wait for the dependency' });
      expect(s.state.qa).toEqual([]);
    }
    const accepted = structuredClone(rec);
    const agentAfterHandoff = structuredClone(tester);
    events.mockClear();
    posted('old-passing-comment');
    await finishing;
    expect(rec).toEqual(accepted);
    expect(tester).toEqual(agentAfterHandoff);
    expect(events).not.toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ status: 'passed' }) });
    if (handoff === 'park') expect(s.state.qa).toEqual([]);
  });

  it('leaves stopped report posting for a human without spending a round or failure', async () => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', retests: 1, sessionFailures: 1, passedSha: null });
    let posted!: (url: string) => void;
    vi.spyOn(s.backend, 'commentPull').mockImplementation(() => new Promise<string>((resolve) => { posted = resolve; }));
    const finishing = s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Passed before Stop', checks: [] }));
    await vi.advanceTimersByTimeAsync(0);
    swarm.stopAgent('q1');
    posted('old-passing-comment');
    await finishing;
    expect(rec).toMatchObject({ status: 'needs-human', qaAgentId: null, passedSha: null, round: 2, retests: 1, sessionFailures: 1 });
    expect(tester).toMatchObject({ status: 'stopped', lastError: 'Stopped by manager' });
  });

  it('requeues a QA session that throws before it starts without charging a failure', async () => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
    vi.spyOn(s, 'startAgentSession').mockImplementation(() => { throw new Error('Runner could not start'); });
    rec.sessionFailures = 1;
    rec.retests = 1;
    await s.runQa(tester, repo, rec);
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, retests: 1, sessionFailures: 1 });
    expect(tester).toMatchObject({ status: 'error', lastError: 'Runner could not start' });
  });

  describe('re-testing an unchanged commit', () => {
    let session: Mock;
    beforeEach(() => {
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
      vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
      session = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {}) as Mock;
    });

    it('sends it straight to a developer with the last findings instead of starting a QA session', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      rec.failedSha = 'sha-1'; // QA failed the current head; the fix crashed before pushing anything
      await swarm.sendToQa(repo.id, 13);
      await s.runQa(tester, repo, rec);
      expect(session).not.toHaveBeenCalled();
      expect(rec).toMatchObject({ status: 'failed', qaAgentId: 'q1', summary: 'Broken' });
      expect(tester).toMatchObject({ status: 'idle', task: null });
      expect(s.agentRt.get('q2')!.log).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('no new commits since QA failed it') })]));
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledWith(ada, repo, rec);
    });

    it.each(['CLOSED', 'MERGED'] as const)('drops a %s PR rather than sending its unchanged commit to a developer', async (state) => {
      vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, state, body: '', isCrossRepository: false });
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      rec.failedSha = 'sha-1';
      await swarm.sendToQa(repo.id, 13); // the polled pull list still says OPEN
      await s.runQa(tester, repo, rec);
      expect(session).not.toHaveBeenCalled();
      expect(s.state.qa).toEqual([]);
      expect(tester).toMatchObject({ status: 'idle', task: null });
      ada.status = 'idle';
      expect(s.startPipelineWork(repo)).toBe(false);
      expect(runFix).not.toHaveBeenCalled();
    });

    it('tests a commit QA has not failed', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      rec.status = 'queued';
      await s.runQa(tester, repo, rec);
      expect(session).toHaveBeenCalledOnce();
      expect(rec).toMatchObject({ status: 'testing', testedSha: 'sha-1' });
    });
  });

  describe('a crashed fix', () => {
    it('goes to another developer next, and to a human once they crash too', () => {
      const barbara = addAgent('a2', 'Barbara', 'dev', 1);
      fixCrashes(ada);
      expect(rec).toMatchObject({ status: 'failed', fixCrashes: ['a1'] });
      ada.status = 'idle'; // free again, but it crashed on this PR
      Object.assign(barbara, { status: 'working' });
      expect(s.startPipelineWork(repo)).toBe(false); // waits for someone who hasn't crashed on it
      barbara.status = 'idle';
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledExactlyOnceWith(barbara, repo, rec);
      fixCrashes(barbara);
      expect(rec).toMatchObject({ status: 'needs-human', fixCrashes: ['a1', 'a2'] });
    });

    it('is retried by the only developer on the floor, then needs a human', () => {
      fixCrashes(ada);
      expect(rec.status).toBe('failed');
      ada.status = 'idle';
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledWith(ada, repo, rec);
      fixCrashes(ada);
      expect(rec).toMatchObject({ status: 'needs-human', fixCrashes: ['a1', 'a1'] });
    });

    it("doesn't count a stop for Claude's usage limit", () => {
      s.pausedUntil = Date.now() + 60_000;
      fixCrashes(ada);
      fixCrashes(ada);
      expect(rec).toMatchObject({ status: 'failed', fixCrashes: [] });
    });

    it('starts a fresh count once a fix is pushed', () => {
      addAgent('a2', 'Barbara', 'dev', 1);
      fixCrashes(ada);
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      rec.status = 'fixing';
      s.onFixFinished(ada, repo, result(true));
      expect(rec).toMatchObject({ status: 'queued', round: 3, fixCrashes: [] });
    });
  });
});

describe('manual office closure', () => {
  type LifecycleInternals = Internals & {
    state: { officeHeld: boolean; deferredResumes: string[]; ceo: { queue: unknown[]; job: unknown }; settings: { autoUpdate: boolean }; messages: unknown[] };
    officeLifecycleView(): { state: string; running: number };
    refreshOfficeLifecycle(): Promise<void>;
    writeState(): Promise<void>;
    buildSystemAppend(...args: unknown[]): string;
    syncRepo(id: string): Promise<void>;
    newTerminal(id: string): { allowInput(): boolean; dispose(): void };
    officeHead: string | null;
    officeUpdate: { behind: number; drainingSince: number | null; requested: boolean };
    setOfficeBehind(n: number): void;
    officeUpdateView(): { state: string; drainingSince: number | null };
    onCeoFinished(agent: unknown, result: SessionResult): Promise<void>;
    runCeoJob(agent: unknown, job: unknown): Promise<void>;
    advanceMerges(repo: Repo): Promise<void>;
  };
  let f: LifecycleInternals;
  let writes: Mock;
  let sessions: { opts: SessionOptions; cb: SessionCallbacks; stop: Mock }[];
  const result: SessionResult = { ok: true, text: '', errors: [], turns: 2, costUsd: 1 };
  const ada = () => s.state.agents[0];
  const drain = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await f.refreshOfficeLifecycle();
  };

  beforeEach(() => {
    f = s as unknown as LifecycleInternals;
    writes = vi.spyOn(f, 'writeState').mockResolvedValue();
    vi.spyOn(f, 'buildSystemAppend').mockReturnValue('');
    vi.spyOn(f, 'syncRepo').mockResolvedValue();
    Object.assign(repo, { defaultBranch: 'main', links: [], browserTesting: false });
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready', lastSync: Date.now() });
    Object.assign(ada(), { model: '', effort: '', cli: '', costUsd: 0, turns: 0 });
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    sessions = [];
    vi.spyOn(s.backend, 'startSession').mockImplementation((opts, cb) => {
      const stop = vi.fn();
      sessions.push({ opts, cb, stop });
      return { stop, send: vi.fn() };
    });
    vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
    s.runTask = (Swarm.prototype as unknown as Pick<Internals, 'runTask'>).runTask;
    setIssues(issue(66), issue(67));
  });

  it('closes an idle office durably, is idempotent, and snapshots reconnect with the hold', async () => {
    const events = vi.spyOn(s, 'broadcast');
    expect(await swarm.closeOffice()).toEqual({ state: 'closed', running: 0 });
    expect(writes).toHaveBeenCalled();
    expect(f.state.officeHeld).toBe(true);
    expect(swarm.snapshot().officeLifecycle).toEqual({ state: 'closed', running: 0 });
    expect(await swarm.closeOffice()).toEqual({ state: 'closed', running: 0 });
    expect(events).toHaveBeenCalledWith({ type: 'officeLifecycle', officeLifecycle: { state: 'closed', running: 0 } });
    expect(repo.autoAssign).toBe(true);
  });

  it('establishes admission before the close command finishes writing', async () => {
    let saved!: () => void;
    writes.mockReturnValueOnce(new Promise<void>((r) => { saved = r; }));
    const closing = swarm.closeOffice();
    const before = JSON.stringify(f.state);
    await expect(swarm.assign('a1', 66)).rejects.toThrow('Reopen Office in Settings');
    expect(JSON.stringify(f.state)).toBe(before);
    expect(sessions).toHaveLength(0);
    expect(f.officeLifecycleView().state).toBe('closing');
    saved();
    await closing;
    expect(f.officeLifecycleView().state).toBe('closed');
  });

  it.each([false, true])('defers preparation preserving desk and note with auto-assign %s', async (autoAssign) => {
    let prepared!: (cwd: string) => void;
    vi.mocked(s.prepare).mockReturnValueOnce(new Promise<string>((r) => { prepared = r; }));
    repo.autoAssign = autoAssign;
    setIssues(issue(66));
    await swarm.assign('a1', 66, 'Preserve this note');
    expect(await swarm.closeOffice()).toEqual({ state: 'closing', running: 1 });
    prepared('/fake-desk');
    await drain();
    expect(sessions).toHaveLength(0);
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', note: 'Preserve this note', restartPending: true }]);
    await swarm.reopenOffice();
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    await drain();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.prompt).toContain('Preserve this note');
    s.schedule();
    expect(sessions).toHaveLength(1);
    expect(repo.autoAssign).toBe(autoAssign);
  });

  it('counts developer, QA and CEO work across floors, and ignores the self-update timeout', async () => {
    await swarm.assign('a1', 66);
    await drain();
    s.state.agents.push({ id: 'q2', repoId: 'r2', role: 'qa', task: 'qa', status: 'working' });
    Object.assign(s.state.agents.find((a) => a.id === CEO_ID)!, { status: 'working' });
    f.officeHead = 'old';
    s.backend.office.launcher = true;
    const update = vi.spyOn(s.backend.office, 'update');
    f.officeUpdate.drainingSince = Date.now();
    f.setOfficeBehind(3);
    expect(await swarm.closeOffice()).toEqual({ state: 'closing', running: 3 });
    f.officeUpdate.requested = true;
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    expect(s.officeUpdateTick()).toBe(true);
    expect(f.officeLifecycleView()).toEqual({ state: 'closing', running: 3 });
    expect(update).not.toHaveBeenCalled();
    expect(sessions[0].stop).not.toHaveBeenCalled();
    expect(f.officeUpdateView()).toMatchObject({ state: 'available', drainingSince: null });
    await swarm.reopenOffice();
    expect(f.officeLifecycleView()).toEqual({ state: 'open', running: 3 });
    s.officeUpdateTick();
    expect(f.officeUpdate.drainingSince).toBe(Date.now());
    expect(update).not.toHaveBeenCalled();
    expect(sessions[0].stop).not.toHaveBeenCalled();
  });

  it('records developer results and queues QA, waiting for cleanup and disk before reporting safe', async () => {
    await swarm.assign('a1', 66);
    await drain();
    await swarm.closeOffice();
    let released!: () => void;
    vi.spyOn(s.backend, 'releaseDesk').mockReturnValueOnce(new Promise<void>((r) => { released = r; }));
    sessions[0].cb.finished({ ...result, text: 'https://github.com/demo-co/pixel-todo/pull/13' });
    await drain();
    expect(s.state.qa[0]).toMatchObject({ prNumber: 13, status: 'queued' });
    expect(ada()).toMatchObject({ status: 'done', costUsd: 1, turns: 2 });
    expect(f.officeLifecycleView()).toEqual({ state: 'closing', running: 1 });
    released();
    await drain();
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(sessions).toHaveLength(1);
    expect(s.startPipelineWork(repo)).toBe(false);
  });

  it('holds completion retries and resumes them once, retaining pushed work', async () => {
    vi.spyOn(s.backend, 'prForBranch').mockResolvedValue(null);
    vi.spyOn(s.backend, 'branchAhead').mockResolvedValue(3);
    await swarm.assign('a1', 66);
    await drain();
    sessions[0].cb.sessionId('thread-1');
    await swarm.closeOffice();
    sessions[0].cb.finished(result);
    await drain();
    expect(ada()).toMatchObject({ status: 'done', heldRetry: { issueNumber: 66, ahead: 3 } });
    expect(sessions).toHaveLength(1);
    expect(f.officeLifecycleView().state).toBe('closed');
    await swarm.reopenOffice();
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    s.schedule();
    expect(sessions).toHaveLength(2);
    expect(sessions[1].opts.resumeSessionId).toBe('thread-1');
  });

  it('rejects manual, follow-up, idle-terminal and CEO starts without mutating submitted work', async () => {
    Object.assign(ada(), { task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'old' });
    await swarm.closeOffice();
    const before = JSON.stringify(f.state);
    await expect(swarm.assign('a1', 67)).rejects.toThrow('Reopen Office');
    await expect(swarm.message('a1', 'follow up')).rejects.toThrow('Reopen Office');
    await expect(swarm.messageCeo('Start another job')).rejects.toThrow('Reopen Office');
    expect(() => swarm.requestReview()).toThrow('Reopen Office');
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 67 })).toContain('Reopen Office');
    const terminal = f.newTerminal('a1');
    expect(terminal.allowInput()).toBe(false);
    terminal.dispose();
    expect(JSON.stringify(f.state)).toBe(before);
    expect(sessions).toHaveLength(0);
  });

  const qaRecord = (): QaRec => ({
    repoId: repo.id, prNumber: 13, status: 'queued', round: 1, sessionFailures: 0, retests: 0,
    devAgentId: 'a1', qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
  });
  const qaPull = (): PullInfo => ({
    number: 13, title: 'Feature', url: '', headRefName: 'swarm/13', state: 'OPEN', isDraft: false,
    closesIssues: [], checks: 'passing', mergeable: 'MERGEABLE', headSha: 'sha-1', reviewDecision: null,
    createdAt: '', mergedAt: null, additions: 0, deletions: 0, mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  });

  it.each(['qa', 'fix'] as const)('leaves a preparing %s stage queued on closure', async (task) => {
    s.backend.prDetails = async () => ({ ...qaPull(), body: '', isCrossRepository: false });
    const rec = qaRecord();
    s.state.qa.push(rec);
    let prepared!: (cwd: string) => void;
    vi.mocked(s.prepare).mockReturnValueOnce(new Promise<string>((r) => { prepared = r; }));
    const preparing = task === 'qa' ? s.runQa(ada(), repo, rec) : s.runFix(ada(), repo, rec);
    await vi.advanceTimersByTimeAsync(0);
    expect(await swarm.closeOffice()).toEqual({ state: 'closing', running: 1 });
    prepared('/fake-desk');
    await preparing;
    expect(sessions).toHaveLength(0);
    expect(rec.status).toBe(task === 'qa' ? 'queued' : 'failed');
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
  });

  it('records a QA failure before reporting safe and leaves the fix queued', async () => {
    s.backend.prDetails = async () => ({ ...qaPull(), body: '', isCrossRepository: false });
    s.repoRt.get(repo.id)!.pulls = [qaPull()];
    const rec = qaRecord();
    s.state.qa.push(rec);
    s.state.agents.push({ ...ada(), id: 'q1', name: 'Poirot', role: 'qa' });
    s.agentRt.set('q1', { log: [], pending: [], terminal: null, shots: [] });
    await s.runQa(s.state.agents[2], repo, rec);
    await swarm.closeOffice();
    let posted!: (url: string) => void;
    const comment = vi.spyOn(s.backend, 'commentPull').mockReturnValueOnce(new Promise<string>((r) => { posted = r; }));
    sessions[0].cb.finished({ ...result, text: JSON.stringify({ verdict: 'fail', summary: 'Needs a fix', checks: [{ name: 'Flow', result: 'fail', details: 'Broken' }], commands: [], screenshots: [] }) });
    await drain();
    expect(comment).toHaveBeenCalled();
    expect(f.officeLifecycleView()).toEqual({ state: 'closing', running: 1 });
    posted('fake-comment');
    await drain();
    expect(rec).toMatchObject({ status: 'failed', summary: 'Needs a fix', failedSha: 'sha-1', commentUrl: 'fake-comment' });
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(s.startPipelineWork(repo)).toBe(false);
    expect(sessions).toHaveLength(1);
  });

  it('finishes an active CEO job without starting its queued successor', async () => {
    const ceo = s.state.agents.find((a) => a.id === CEO_ID)!;
    Object.assign(ceo, { status: 'working', costUsd: 0, turns: 0 });
    f.state.ceo.job = { kind: 'chat', text: 'Current', at: Date.now() };
    f.state.ceo.queue.push({ kind: 'chat', text: 'Next', at: Date.now() });
    await swarm.closeOffice();
    await f.onCeoFinished(ceo, result);
    s.startCeoWork();
    expect(ceo).toMatchObject({ status: 'done', costUsd: 1, turns: 2 });
    expect(f.state.ceo.job).toBeNull();
    expect(f.state.ceo.queue).toHaveLength(1);
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(sessions).toHaveLength(0);
  });

  it('returns a preparing CEO job to the queue without opening a session', async () => {
    let ready!: () => void;
    vi.spyOn(fs, 'mkdir').mockReturnValueOnce(new Promise<undefined>((resolve) => { ready = () => resolve(undefined); }));
    const ceo = s.state.agents.find((a) => a.id === CEO_ID)!;
    const job = { kind: 'chat', text: 'Read the office', at: Date.now() };
    const preparing = f.runCeoJob(ceo, job);
    expect(await swarm.closeOffice()).toEqual({ state: 'closing', running: 1 });
    ready();
    await preparing;
    expect(f.state.ceo.queue).toContainEqual(job);
    expect(f.state.ceo.job).toBeNull();
    expect(sessions).toHaveLength(0);
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
  });

  it('keeps restart recovery queued under the hold and resumes once on reopen', async () => {
    s.backend.demo = false; // Still the fake backend; exercise session-resume recovery.
    Object.assign(ada(), { status: 'stopped', task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'old-thread' });
    await swarm.closeOffice();
    s.recover([ada()]);
    expect(f.state.deferredResumes).toEqual(['a1']);
    expect(sessions).toHaveLength(0);
    await swarm.reopenOffice();
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    s.schedule();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.resumeSessionId).toBe('old-thread');
    expect(f.state.deferredResumes).toEqual([]);
  });

  it('keeps passed PRs queued for automatic merge until reopened', async () => {
    Object.assign(repo, { autoMerge: true });
    Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now(), syncing: false, merging: false });
    s.repoRt.get(repo.id)!.pulls = [qaPull()];
    const rec = qaRecord();
    Object.assign(rec, { status: 'passed', passedSha: 'sha-1' });
    s.state.qa.push(rec);
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    await swarm.closeOffice();
    await f.advanceMerges(repo);
    expect(merge).not.toHaveBeenCalled();
    expect(rec.status).toBe('passed');
    await swarm.reopenOffice();
    await f.advanceMerges(repo);
    expect(merge).toHaveBeenCalledOnce();
  });

  it('round-trips the hold through atomic persistence and startup before scheduling', async () => {
    writes.mockRestore();
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = vi.spyOn(fs, 'rename').mockResolvedValue();
    await swarm.closeOffice();
    expect(mkdir).toHaveBeenCalled();
    expect(rename).toHaveBeenCalled();
    const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
    expect(persisted.officeHeld).toBe(true);
    // Startup without floors isolates the hold load from unrelated demo onboarding.
    persisted.repos = [];
    persisted.agents = [];
    const fresh = new Swarm(createDemoBackend());
    const restored = fresh as unknown as LifecycleInternals;
    restored.backend.demo = false;
    vi.spyOn(restored, 'save').mockImplementation(() => {});
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
    await fresh.init();
    await restored.refreshOfficeLifecycle();
    expect(fresh.snapshot().officeLifecycle).toEqual({ state: 'closed', running: 0 });
    expect(restored.state.officeHeld).toBe(true);
    const start = vi.spyOn(restored.backend, 'startSession');
    restored.schedule();
    expect(start).not.toHaveBeenCalled();
    await fresh.reopenOffice();
    expect(restored.state.officeHeld).toBe(false);
  });

  it('does not advertise safe if completion state cannot be saved', async () => {
    await swarm.assign('a1', 66);
    await drain();
    await swarm.closeOffice();
    writes.mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sessions[0].cb.finished({ ...result, text: 'https://github.com/demo-co/pixel-todo/pull/13' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.officeLifecycleView()).toEqual({ state: 'closing', running: 1 });
    writes.mockResolvedValue(undefined);
    await f.refreshOfficeLifecycle();
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
  });
});
