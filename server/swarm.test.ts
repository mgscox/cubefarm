import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError, Swarm } from './swarm.ts';
import { CEO_ID, type IssueInfo, type QaView, type PullInfo, type RequestedStart, type ServerEvent } from '../shared/types.ts';
import type { OfficeTools } from './ceo.ts';
import type { SessionOptions, SessionCallbacks, SessionResult } from './agentRunner.ts';

// A Swarm that is never init()ed: no state file, scheduler timers or real sessions.

type RunTask = (agent: unknown, repo: Repo, issue: IssueInfo, note?: string) => Promise<void>;
type Repo = { id: string; fullName: string; floor: number; autoAssign: boolean; requestedStarts: RequestedStart[]; preview: { command: null; env: object } };
type Backend = ReturnType<typeof createDemoBackend>;
type QaRec = QaView & { sessionFailures: number; retests?: number; testedSha?: string | null; failedSha?: string | null; fixCrashes?: string[] };
interface Internals {
  backend: Backend;
  state: { repos: Repo[]; agents: Record<string, unknown>[]; qa: QaRec[] };
  repoRt: Map<string, { issues: IssueInfo[]; pulls: PullInfo[]; lastSync?: number; cloneStatus?: string }>;
  agentRt: Map<string, { log: unknown[]; pending: unknown[]; terminal: null; shots?: unknown[] }>;
  pausedUntil: number;
  readyIssues(repo: Repo): { issue: IssueInfo }[];
  startIssueWork(repo: Repo): boolean;
  companyStatus(): string;
  officeTools(): OfficeTools;
  startPipelineWork(repo: Repo): boolean;
  runQa(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  runFix(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  onQaFinished(agent: unknown, repo: Repo, result: SessionResult): Promise<void>;
  onFixFinished(agent: unknown, repo: Repo, result: SessionResult): void;
  broadcast(event: ServerEvent): void;
  save(): void;
  schedule(): void;
  recover(agents: Record<string, unknown>[]): void;
  maybeHeartbeat(): void;
  startCeoWork(): void;
  officeUpdateTick(): boolean;
  beginTask(...args: unknown[]): void;
  prepare(...args: unknown[]): Promise<string>;
  startAgentSession(...args: unknown[]): void;
  runTask: RunTask;
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
