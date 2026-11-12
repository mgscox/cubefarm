import syncFs from 'node:fs';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CommandError, ghJson, run } from './exec.ts';
import { branchAhead, listIssues, listPulls } from './github.ts';
import { launchArgs, LOST_CONVERSATION, STUCK_MS } from './clis.ts';
import { opencodeTurn } from './opencodeTranscript.ts';
import { OPENCODE_IDLE_WITH_USAGE } from './fixtures/opencodeScreens.ts';
import { handleHook, reconnectClis, startCliSession } from './cliRunner.ts';
import type { BoxConnection, CliHost } from './machine.ts';
import { BOX_CLI_CHECK_MS } from './fleet.ts';
import type { AgentTerminal } from './terminal.ts';
import { createDemoBackend, demoApprovedProposal, demoForkPull, demoPull } from './demo.ts';
import { newPublication } from './publication.ts';
import type { TrackedIssue } from './github.ts';
import { HttpError, resourceNote, resourceOnlyAudit, securityReportOutcome, Swarm } from './swarm.ts';
import { RUN_HISTORY_FILE, STATE_FILE, VERSION } from './config.ts';
import { operationSignal } from './operation.ts';
import { CEO_ID, type ApprovedSnapshot, type IssueInfo, type PublicationView, type PrContributionView, type QaCheck, type QaView, type PullInfo, type RequestedStart, type ParkedBranch, type ServerEvent } from '../shared/types.ts';
import { ceoSystemPrompt, type OfficeTools } from './ceo.ts';
import { researcherSystemPrompt } from './research.ts';
import { ONE_TURN } from './clis.ts';
import { QA_RESUME_PROMPT } from './qaRetry.ts';
import { CHECK_RERUN_GRACE_MS, MAX_MERGE_FIXES } from './mergeGate.ts';
import { AGENT_COMMENT_MARKER, issueWorkNote, READY_FOR_SECURITY_REVIEW } from '../shared/issues.ts';
import type { SessionOptions, SessionCallbacks, SessionResult } from './agentRunner.ts';

// A Swarm that is never init()ed: no state file, scheduler timers or real sessions.

type RunTask = (agent: unknown, repo: Repo, issue: IssueInfo, note?: string) => Promise<void>;
type Repo = { noWorkEndings?: import('../shared/types.ts').NoWorkEnding[]; id: string; fullName: string; floor: number; autoAssign: boolean; requestedStarts: RequestedStart[]; parkedBranches?: ParkedBranch[]; preview: { command: null; env: object } };
type Backend = ReturnType<typeof createDemoBackend>;
type QaRec = QaView & { devSessionCli?: SessionOptions['cli'] | null; attempt?: { id: string; startedAt: number; headSha: string; baseSha: string | null }; reviewId?: string; crossRepository?: boolean; issueNumber?: number | null; sessionFailures: number; retests?: number; testedSha?: string | null; passedSha?: string | null; failedSha?: string | null; fixCrashes?: string[] };
interface Internals {
  backend: Backend;
  state: { repos: Repo[]; agents: Record<string, unknown>[]; qa: QaRec[]; prContributions: PrContributionView[]; qaOutcomes: import('../shared/types.ts').QaOutcomeView[]; feedbackEvents: Record<string, true> };
  writeState(): Promise<void>;
  repoRt: Map<string, { issues: IssueInfo[]; pulls: PullInfo[]; lastSync?: number; cloneStatus?: string; issuesFetchedAt?: number }>;
  agentRt: Map<string, { log: unknown[]; pending: unknown[]; terminal: null; shots?: unknown[]; qaResume?: unknown }>;
  scoreTotals: Map<string, import('../shared/types.ts').DeveloperScoresView>;
  issueFailures: Map<string, number>;
  pausedUntil: number;
  readyIssues(repo: Repo): { issue: IssueInfo }[];
  startIssueWork(repo: Repo): boolean;
  companyStatus(a?: { floor?: number; verbose?: boolean }): string;
  officeTools(): OfficeTools;
  startPipelineWork(repo: Repo): boolean;
  advanceMerge(repo: Repo, rec: QaRec, pull: PullInfo): Promise<boolean>;
  queueQa(repo: Repo, prNumber: number, dev: unknown, issueNumber: number | null): QaRec;
  runQa(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  runFix(agent: unknown, repo: Repo, rec: unknown): Promise<void>;
  recordFinished(agent: unknown, repo: Repo, result: SessionResult, generation: number | undefined, session: undefined): Promise<void>;
  onQaFinished(agent: unknown, repo: Repo, result: SessionResult, released?: Promise<void>): Promise<void>;
  jobDeskFailed(agent: unknown, repo: Repo, job: { rec: unknown; task: 'qa' | 'fix' }, error: string): void;
  recordResearchFinished(agent: unknown, job: unknown, repo: Repo, fullName: string, result: SessionResult): Promise<void>;
  onIssueFinished(agent: unknown, repo: Repo, result: SessionResult, released: Promise<void>, generation: number | undefined): Promise<void>;
  onFixFinished(agent: unknown, repo: Repo, result: SessionResult): Promise<void>;
  startRepairContribution(dev: unknown, repo: Repo, rec: unknown, startingSha: string | null): void;
  syncScores(repoId: string, prNumber: number): void;
  postMessage(from: string, text: string): void;
  sessionStarted(agent: unknown, how: { cli?: string }, mode: null): void;
  broadcast(event: ServerEvent): void;
  save(): void;
  schedule(): void;
  reconcilePulls(repo: Repo, pulls: PullInfo[]): void;
  recoverDesks(): void;
  recover(agents: Record<string, unknown>[], preparing?: Set<unknown>): void;
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
  // These tests inject synthetic desks without preparing the demo backend's in-memory worktrees.
  vi.spyOn(s.backend, 'deskExists').mockResolvedValue(true);
  vi.spyOn(s.backend, 'deskHead').mockImplementation(async (fullName) => {
    const r = s.state.repos.find((r) => r.fullName === fullName);
    const pr = r && s.repoRt.get(r.id)?.pulls.find((p) => p.state === 'OPEN');
    const number = pr?.number ?? s.state.qa.find((q) => q.repoId === r?.id)?.prNumber;
    return number ? (await s.backend.prDetails(fullName, number)).headSha : 'demo-head';
  });
  repo = { id: 'r1', fullName: 'demo-co/pixel-todo', floor: 1, autoAssign: true, requestedStarts: [], preview: { command: null, env: {} } };
  s.state.repos.push(repo);
  s.state.agents.push({ id: 'a1', name: 'Ada', repoId: repo.id, role: 'dev', specialty: '', score: 0, status: 'idle', task: null, issueNumber: null, desk: 0, endedAt: null });
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

describe('automatic desk recovery', () => {
  const a = () => s.state.agents[0];
  const cooldown = async () => {
    await vi.advanceTimersByTimeAsync(120_000);
    s.recoverDesks();
  };
  beforeEach(() => {
    vi.spyOn(s as unknown as { syncRepo(id: string): Promise<void> }, 'syncRepo').mockResolvedValue();
    Object.assign(repo, { defaultBranch: 'main', links: [] });
    Object.assign(a(), { model: '', effort: '', cli: '', deskBox: '' });
    setIssues(issue(66), issue(67));
  });

  it('clears an expired error and stale task claim while retaining its cause', () => {
    Object.assign(a(), { status: 'error', endedAt: Date.now() - 120_000, lastError: 'Box disconnected', task: 'issue', issueNumber: 66, prNumber: 13 });
    s.recoverDesks();
    expect(a()).toMatchObject({ status: 'idle', task: null, issueNumber: null, prNumber: null, lastError: 'Box disconnected', lastErrorAt: expect.any(Number) });
    expect(JSON.parse(s.companyStatus()).floors[0].team[0]).toMatchObject({ status: 'idle', lastError: { message: 'Box disconnected', at: expect.any(Number) } });
    expect(s.startIssueWork(repo)).toBe(true);
    expect(a().lastError).toBe('Box disconnected');
  });

  it.each(['issue', 'qa', 'fix'] as const)('requeues office-stopped %s work without spending a QA round', async (task) => {
    s.beginTask(a(), { task, issueNumber: 66, prNumber: task === 'issue' ? null : 13 }, 'Working', 'Preparing');
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), lastError: 'Office updated', task, issueNumber: 66, prNumber: task === 'issue' ? null : 13 });
    s.state.qa.push({ repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', round: 2, sessionFailures: 0, devAgentId: 'a1', qaAgentId: 'a1', summary: 'Existing findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 });
    s.recover([a()]);
    expect(swarm.runHistory().attempts[0].outcome).toMatchObject({ result: 'interrupted', cause: 'office' });
    expect(a().status).toBe('error');
    expect(s.startIssueWork(repo)).toBe(false);
    await cooldown();
    expect(a()).toMatchObject({ status: 'idle', task: null, issueNumber: null, prNumber: null });
    if (task !== 'issue') expect(s.state.qa[0]).toMatchObject({ status: task === 'qa' ? 'queued' : 'failed', round: 2, sessionFailures: 0, summary: 'Existing findings' });
  });

  it('keeps manager Stop stopped through recovery ticks', async () => {
    Object.assign(a(), { status: 'working', task: 'issue', issueNumber: 66 });
    swarm.stopAgent('a1');
    s.recover([a()]);
    await cooldown();
    expect(a()).toMatchObject({ status: 'stopped', stoppedBy: 'manager', issueNumber: 66 });
    expect(s.startIssueWork(repo)).toBe(false);
  });

  it('honours manager Stop while an office retry is cooling down', async () => {
    s.backend.demo = false;
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'old', prNumber: null });
    s.recover([a()]);
    swarm.stopAgent('a1');
    await cooldown();
    expect(a()).toMatchObject({ status: 'stopped', stoppedBy: 'manager', heldRetry: null });
  });

  it('requeues a legacy recovery-failed QA hold without spending a round', async () => {
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now() - 120_000, task: 'qa', prNumber: 13, lastError: 'Unreadable transcript' });
    const rec = { repoId: repo.id, prNumber: 13, status: 'needs-human', round: 2, sessionFailures: 0, qaAgentId: null, devAgentId: 'a1', summary: 'Unreadable transcript', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 } as QaRec;
    s.state.qa.push(rec);
    s.recover([a()]);
    s.recoverDesks();
    expect(rec).toMatchObject({ status: 'queued', round: 2, sessionFailures: 0 });
    expect(a()).toMatchObject({ status: 'idle', task: null });
  });

  it.each(['startupFailed', 'recoveryFailed'] as const)('retains QA evidence through %s and automatic recovery', async (failure) => {
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    const startedAt = Date.now() - 1000;
    Object.assign(a(), { status: 'working', task: 'qa', prNumber: 13, startedAt, costUsd: 0, turns: 0 });
    const rec = { repoId: repo.id, prNumber: 13, reviewId: 'review-13', status: 'testing', round: 2, sessionFailures: 0,
      qaAgentId: 'a1', devAgentId: null, summary: 'Keep findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
      attempt: { id: 'attempt-13', startedAt, headSha: 'head-13', baseSha: 'base-13' } } as QaRec;
    s.state.qa.push(rec);
    const generation = (s.agentRt.get('a1') as unknown as { generation: number | undefined }).generation;
    await s.recordFinished(a(), repo, { ok: false, [failure]: true, text: '', errors: ['Worker disconnected'], costUsd: 0, turns: 0 }, generation, undefined);
    expect(swarm.snapshot().qaOutcomes).toEqual([expect.objectContaining({ id: 'attempt-13', headSha: 'head-13', baseSha: 'base-13',
      reviewer: { agentId: 'a1', name: 'Ada' }, classification: 'worker', verdict: 'incomplete', terminalReason: 'Worker disconnected' })]);
    await cooldown();
    expect(a()).toMatchObject({ status: 'idle', task: null, lastError: 'Worker disconnected', lastErrorAt: expect.any(Number) });
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, sessionFailures: 0, summary: 'Keep findings' });
    expect(swarm.snapshot().qaOutcomes).toHaveLength(1);
  });

  it('retains a branch resume through cooldown and a full session limit', async () => {
    s.backend.demo = false;
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), task: 'issue', issueNumber: 66, prNumber: null, branch: 'swarm/issue-66-ada', sessionId: 'session' });
    s.recover([a()]);
    expect(a()).toMatchObject({ heldRetry: { issueNumber: 66, resume: true } });
    await cooldown();
    expect(a()).toMatchObject({ status: 'idle', heldRetry: { issueNumber: 66 } });
    expect(s.startIssueWork(repo)).toBe(false);
  });

  it('links a cooldown resume to the interrupted run attempt', async () => {
    s.backend.demo = false;
    s.beginTask(a(), { task: 'issue', issueNumber: 66, prNumber: null, branch: 'swarm/issue-66-ada', sessionId: 'thread' }, 'Working', 'Preparing');
    const parent = a().attemptId;
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now() });
    s.recover([a()]);
    await cooldown();
    const message = vi.spyOn(swarm, 'message').mockResolvedValue();
    (s as Internals & { runHeldRetries(): void }).runHeldRetries();
    expect(message).toHaveBeenCalledOnce();
    expect(swarm.runHistory().attempts).toEqual([
      expect.objectContaining({ parentId: parent, assignment: expect.objectContaining({ reason: 'retry' }), outcome: null }),
      expect.objectContaining({ id: parent, outcome: expect.objectContaining({ result: 'interrupted', cause: 'office' }) }),
    ]);
  });

  it.each(['worker', 'pull'] as const)('does not resume issue work already owned by another %s', async (owner) => {
    s.backend.demo = false;
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'session' });
    if (owner === 'worker') s.state.agents.push({ id: 'other', repoId: repo.id, role: 'dev', task: 'issue', issueNumber: 66, status: 'working' });
    else s.repoRt.get(repo.id)!.pulls = [{ number: 13, state: 'OPEN', headRefName: 'swarm/issue-66-ada', closesIssues: [66] } as PullInfo];
    s.recover([a()]);
    await cooldown();
    expect(a()).toMatchObject({ status: 'idle', task: null, heldRetry: null });
    expect(s.state.agents.find((x) => x.id === 'other')?.status ?? 'working').toBe('working');
  });

  it('retries CLI startup with persisted backoff, then emits one actionable hold', async () => {
    const post = vi.spyOn(s, 'postMessage');
    for (const delay of [120_000, 600_000, 1_800_000, null]) {
      Object.assign(a(), { status: 'working', task: 'issue', issueNumber: 66, costUsd: 0, turns: 0 });
      const generation = (s.agentRt.get('a1') as unknown as { generation: number | undefined }).generation;
      await s.recordFinished(a(), repo, { ok: false, startupFailed: true, text: '', errors: ['CLI executable temporarily unavailable'], costUsd: 0, turns: 0 }, generation, undefined);
      const retry = a().startupRetry as { retryAt: number | null };
      expect(retry.retryAt).toBe(delay === null ? null : Date.now() + delay);
      expect(a()).toMatchObject({ startupFailed: true, task: null });
      if (delay !== null) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        s.recoverDesks();
        expect(a().startupFailed).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        s.recoverDesks();
        expect(a()).toMatchObject({ status: 'idle', startupFailed: false });
        a().startupRetry = JSON.parse(JSON.stringify(a().startupRetry));
      }
    }
    expect(post.mock.calls.filter(([, text]) => text.includes('Repair'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    s.recoverDesks();
    expect(a().startupFailed).toBe(true);
  });

  it('shows the sign-in action once when rejecting work on a held desk', async () => {
    Object.assign(a(), { status: 'working', task: 'issue', issueNumber: 66, costUsd: 0, turns: 0 });
    const generation = (s.agentRt.get('a1') as { generation?: number }).generation;
    await s.recordFinished(a(), repo, { ok: false, startupFailed: true, text: '', errors: ['Not logged in'], costUsd: 0, turns: 0 }, generation, undefined);
    await expect(swarm.assign('a1', 66)).rejects.toThrow("Ada's CLI is waiting: Not logged in. Sign in to Claude Code, then Clear desk to retry.");
  });

  it.each(['issue', 'qa', 'fix'] as const)('backs off a thrown %s CLI spawn without spending QA budget', async (task) => {
    Object.assign(a(), { status: 'preparing', task, issueNumber: 66, prNumber: task === 'issue' ? null : 13, branch: 'swarm/issue-66-ada', sessionId: null });
    const rec = { repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', round: 1, sessionFailures: 0, devAgentId: 'a1', qaAgentId: 'a1', summary: 'Keep findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 } as QaRec;
    if (task !== 'issue') s.state.qa.push(rec);
    vi.spyOn(s.backend, 'startSession').mockImplementation(() => { throw new Error('spawn EAGAIN'); });
    await s.startAgentSession(a(), repo, '/fake-desk', 'Continue', '');
    expect(s.backend.startSession).toHaveBeenCalledOnce();
    expect(swarm.runHistory().attempts[0].outcome).toMatchObject({ result: 'start-failed', cause: 'worker' });
    expect(a()).toMatchObject({ status: 'error', task: null, lastError: 'spawn EAGAIN', startupFailed: true, startupRetry: { failures: 1, retryAt: Date.now() + 120_000 } });
    if (task !== 'issue') expect(rec).toMatchObject({ status: task === 'qa' ? 'queued' : 'failed', round: 1, sessionFailures: 0, summary: 'Keep findings' });
  });

  it.each([false, true])('checks for an existing PR during recovery without a session id (manager stops: %s)', async (stop) => {
    Object.assign(a(), { status: 'error', task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', prNumber: null, sessionId: null });
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...issue(66), repo: repo.fullName, state: 'OPEN' });
    let resolve!: (value: null) => void;
    const lookup = vi.spyOn(s.backend, 'prForBranch').mockImplementation(() => new Promise<null>((r) => { resolve = r; }));
    const start = vi.spyOn(s.backend, 'startSession').mockReturnValue({ send: vi.fn(), stop: vi.fn() });
    const recover = (swarm.message as (id: string, text: string, typed: boolean, recovering: boolean) => Promise<void>)('a1', 'Recover', false, true);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    if (stop) swarm.stopAgent('a1');
    resolve(null);
    await recover;
    expect(start).toHaveBeenCalledTimes(stop ? 0 : 1);
    if (stop) expect(a()).toMatchObject({ status: 'stopped', stoppedBy: 'manager' });
    else expect(start.mock.calls[0][0]).toMatchObject({ resumeSessionId: undefined });
  });

  it('keeps offline keeper work claimed until the box reconnects', async () => {
    const f = s as unknown as { state: { boxes: { id: string }[] } };
    f.state.boxes = [{ id: 'remote' }];
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', task: 'qa', prNumber: 13, deskBox: 'remote', endedAt: Date.now() - 120_000 });
    const rec = { repoId: repo.id, prNumber: 13, status: 'testing', round: 1, sessionFailures: 0, qaAgentId: 'a1', devAgentId: null, summary: '', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 } as QaRec;
    s.state.qa.push(rec);
    s.recover([a()]);
    s.recoverDesks();
    expect(a()).toMatchObject({ status: 'stopped', task: 'qa', prNumber: 13 });
    expect(rec.status).toBe('testing');
  });

  it('revokes a late pre-update completion before preserving its branch retry', async () => {
    s.backend.demo = false;
    Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), task: 'issue', issueNumber: 66, prNumber: null, branch: 'swarm/issue-66-ada', sessionId: 'old', costUsd: 0, turns: 0 });
    const oldGeneration = (s.agentRt.get('a1') as unknown as { generation: number | undefined }).generation;
    s.recover([a()]);
    const before = JSON.stringify(a());
    await s.recordFinished(a(), repo, { ok: false, text: '', errors: ['late callback'], costUsd: 0, turns: 1 }, oldGeneration, undefined);
    expect(JSON.stringify(a())).toBe(before);
  });

  it.each(['qa', 'fix'] as const)('parks repeated office interruptions of %s with a reason and frees the desk', async (task) => {
    const rec = { repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', round: 2, sessionFailures: 0, qaAgentId: 'a1', devAgentId: 'a1', summary: 'Keep findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 } as QaRec;
    s.state.qa.push(rec);
    for (let n = 0; n < 3; n++) {
      Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), task, prNumber: 13, lastError: 'Recovery failed' });
      Object.assign(rec, { status: task === 'qa' ? 'testing' : 'fixing', qaAgentId: 'a1' });
      s.recover([a()]);
      await cooldown();
    }
    expect(rec).toMatchObject({ status: 'needs-human', round: 2, sessionFailures: 0, summary: expect.stringContaining('failed this task 3 times') });
    expect(a()).toMatchObject({ status: 'idle', task: null });
  });

  it('parks repeatedly interrupted work and frees the desk for another issue', async () => {
    for (let n = 0; n < 3; n++) {
      Object.assign(a(), { status: 'stopped', stoppedBy: 'office', endedAt: Date.now(), lastError: 'Keeper recovery failed', task: 'issue', issueNumber: 66 });
      s.recover([a()]);
      await cooldown();
      a().taskFailures = JSON.parse(JSON.stringify(a().taskFailures));
    }
    repo.noWorkEndings = JSON.parse(JSON.stringify(repo.noWorkEndings));
    expect(s.repoView(repo)).toMatchObject({ issues: [expect.objectContaining({ number: 66, stalled: expect.stringContaining('failed this task 3 times') }), expect.anything()] });
    expect(a()).toMatchObject({ status: 'idle', task: null });
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenLastCalledWith(a(), repo, expect.objectContaining({ number: 67 }), undefined);
  });
});

describe('durable PR contribution workflow', () => {
  beforeEach(() => {
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    Object.assign(repo, { links: [], defaultBranch: 'main' });
  });
  it('keeps the original handoff and each repair through sync, cleanup and restart', async () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-ada', false);
    try {
      const pull = fixture.pull;
      pull.createdAt = new Date(Date.now()).toISOString();
      const ada = s.state.agents[0];
      Object.assign(ada, { task: 'issue', branch: pull.headRefName, startedAt: Date.now() - 1000, status: 'working', issueNumber: 66 });
      const result = { ok: true, text: '', errors: [], turns: 0, costUsd: 0 };
      await s.onIssueFinished(ada, repo, result, Promise.resolve(), undefined);
      const original = { agentId: 'a1', name: 'Ada', submittedSha: pull.headSha, at: Date.now() };
      expect(swarm.snapshot().prContributions).toEqual([expect.objectContaining({ original })]);
      s.reconcilePulls(repo, [pull]);
      s.reconcilePulls(repo, [pull]);
      expect(swarm.snapshot().prContributions).toHaveLength(1);
      expect(swarm.snapshot().prContributions![0].original).toEqual(original);

      s.repoRt.get(repo.id)!.pulls = [pull];
      const rec = s.state.qa[0];
      Object.assign(rec, { status: 'failed', fixReason: 'qa', fixInstructions: 'Toolbar overflows', commentUrl: 'https://example.test/review/1' });
      const barbara = { id: 'a2', name: 'Barbara', repoId: repo.id, role: 'dev', status: 'idle', desk: 1, specialty: '' };
      s.state.agents.push(barbara);
      s.agentRt.set('a2', { log: [], pending: [], terminal: null });
      vi.spyOn(s, 'prepare').mockResolvedValue('fake-desk');
      vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
      const details = await s.backend.prDetails(repo.fullName, pull.number);
      vi.spyOn(s.backend, 'prDetails').mockImplementationOnce(async () => {
        s.repoRt.get(repo.id)!.pulls = [{ ...pull, headSha: 'stale-before-preflight' }];
        return details;
      });
      await s.runFix(barbara, repo, rec);
      const startingSha = pull.headSha;
      pull.headSha = 'barbara-fix';
      await s.onFixFinished(barbara, repo, result);
      Object.assign(rec, { status: 'failed', fixReason: 'conflict', fixInstructions: 'Resolve main conflict' });
      await s.runFix(ada, repo, rec);
      pull.headSha = 'ada-fix';
      await s.onFixFinished(ada, repo, result);
      const history = swarm.snapshot().prContributions![0];
      expect(history.original).toEqual(original);
      expect(history.repairs).toEqual([
        expect.objectContaining({ agentId: 'a2', reason: 'qa', startingSha, submittedSha: 'barbara-fix', commentUrl: 'https://example.test/review/1', findings: 'Toolbar overflows' }),
        expect.objectContaining({ agentId: 'a1', reason: 'conflict', startingSha: 'barbara-fix', submittedSha: 'ada-fix', findings: 'Resolve main conflict' }),
      ]);
      Object.assign(ada, { sessionId: 'followup-session', status: 'done' });
      s.repoRt.get(repo.id)!.pulls = [{ ...pull }];
      await swarm.message('a1', 'Also fix the review follow-up');
      pull.headSha = 'followup-fix';
      await s.onFixFinished(ada, repo, result);
      expect(swarm.snapshot().prContributions![0].repairs).toHaveLength(3);
      expect(swarm.snapshot().prContributions![0].repairs[2]).toMatchObject({ agentId: 'a1', startingSha: 'ada-fix', submittedSha: 'followup-fix', findings: 'Also fix the review follow-up' });
      const finalHistory = swarm.snapshot().prContributions![0];
      s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
      expect(swarm.snapshot().qa).toHaveLength(0);
      expect(swarm.snapshot().prContributions![0]).toEqual({ ...finalHistory, state: 'MERGED' });

      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
      vi.spyOn(fs, 'rename').mockResolvedValue();
      await s.writeState();
      const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
      Object.assign(persisted, { repos: [], agents: [] });
      const fresh = new Swarm(createDemoBackend());
      const restored = fresh as unknown as Internals;
      restored.backend.demo = false;
      vi.spyOn(restored, 'save').mockImplementation(() => {});
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
      await fresh.init();
      expect(fresh.snapshot().prContributions).toEqual(swarm.snapshot().prContributions);
    } finally {
      fixture.remove();
    }
  });

  it('does not infer authorship from sync, manual QA or legacy QA owners', () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-ada', false);
    try {
      Object.assign(s.state.agents[0], { branch: fixture.pull.headRefName, prNumber: fixture.pull.number });
      s.queueQa(repo, fixture.pull.number, s.state.agents[0], 66);
      s.reconcilePulls(repo, [fixture.pull]);
      expect(swarm.snapshot().prContributions![0]).toMatchObject({ original: null, repairs: [] });
    } finally { fixture.remove(); }
  });
});

describe('run history', () => {
  beforeEach(() => {
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    Object.assign(repo, { links: [], defaultBranch: 'main' });
  });
  const generation = (id: string) => (s.agentRt.get(id) as { generation?: number }).generation as never;
  const ok: SessionResult = { ok: true, text: '', errors: [], turns: 7, costUsd: 0.5 };

  it.each(['stop', 'clear', 'fire', 'close'] as const)('ends queued attempts when the manager chooses %s', async (action) => {
    const events = vi.spyOn(s, 'broadcast');
    const box = swarm.addBox('Attic', 'offline-attic');
    await vi.advanceTimersByTimeAsync(1600);
    swarm.updateAgent('a1', { box: box.id });
    const number = await swarm.createIssue(repo.id, 'Queued work', '');
    await swarm.assign('a1', number);
    const pending = swarm.runHistory({ issue: number }).attempts[0];
    expect(pending).toMatchObject({ outcome: null, times: { startedAt: null } });
    if (action === 'stop') swarm.stopAgent('a1');
    if (action === 'clear') swarm.resetAgent('a1');
    if (action === 'fire') swarm.fireAgent('a1');
    if (action === 'close') await swarm.closeDemoIssue(repo.id, number);
    expect(repo.requestedStarts).toEqual([]);
    expect(swarm.runHistory({ issue: number }).attempts[0]).toMatchObject({
      id: pending.id,
      times: { startedAt: null, endedAt: expect.any(Number) },
      outcome: { result: action === 'clear' ? 'cleared' : action === 'close' ? 'closed' : 'stopped', cause: action === 'close' ? 'external' : 'manager' },
    });
    expect(swarm.snapshot().runAttempts).toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.id, outcome: expect.any(Object) })]));
    expect(events).toHaveBeenCalledWith({ type: 'runAttempt', attempt: expect.objectContaining({ id: pending.id, outcome: expect.any(Object) }) });
  });

  it('reuses a pending request and links its handoff when a desk becomes available', async () => {
    const box = swarm.addBox('Attic', 'offline-attic');
    await vi.advanceTimersByTimeAsync(1600);
    swarm.updateAgent('a1', { box: box.id });
    const number = await swarm.createIssue(repo.id, 'Wait for a desk', '');
    await swarm.assign('a1', number);
    const pending = swarm.runHistory({ issue: number }).attempts[0];
    await swarm.assign('a1', number);
    expect(swarm.runHistory({ issue: number }).attempts).toHaveLength(1);
    expect(repo.requestedStarts[0].attemptId).toBe(pending.id);
    swarm.updateAgent('a1', { box: '' });
    await swarm.assign('a1', number);
    const [started, waiting] = swarm.runHistory({ issue: number }).attempts;
    expect(started).toMatchObject({ parentId: pending.id, outcome: null });
    expect(waiting).toMatchObject({ id: pending.id, outcome: { result: 'superseded', cause: 'office' } });
  });

  it('keeps a successful repair joined to the review round it repaired', async () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-ada', false);
    try {
      const ada = s.state.agents[0];
      Object.assign(ada, { model: '', effort: '', cli: '' });
      const pull = fixture.pull;
      s.repoRt.get(repo.id)!.pulls = [pull];
      const rec = s.queueQa(repo, pull.number, ada, 66);
      Object.assign(rec, { status: 'failed', round: 1, fixReason: 'qa', fixInstructions: 'Fix overflow' });
      vi.spyOn(s, 'prepare').mockResolvedValue('fake-desk');
      vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      await s.runFix(ada, repo, rec);
      s.sessionStarted(ada, {}, null);
      pull.headSha = 'repaired-sha';
      await s.recordFinished(ada, repo, ok, generation('a1'), undefined);
      expect(rec.round).toBe(2);
      const repair = swarm.snapshot().prContributions![0].repairs[0];
      expect(swarm.runHistory({ pr: pull.number }).attempts[0]).toMatchObject({
        outcome: { result: 'repaired', cause: 'agent' },
        review: { reviewId: repair.reviewId, round: 1, repairId: repair.id },
        revisions: { start: repair.startingSha, submitted: 'repaired-sha' },
      });
    } finally { fixture.remove(); }
  });

  it('links a delivered PR, a worker-blocked QA retry and a no-PR run, and keeps them through merge and restart', async () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-ada', false);
    try {
      const pull = fixture.pull;
      const ada = s.state.agents[0];
      Object.assign(ada, { model: '', effort: 'high', cli: '' });
      s.beginTask(ada, { task: 'issue', issueNumber: 66, issueTitle: 'Feature', branch: pull.headRefName, prNumber: null, prUrl: null, sessionId: null }, 'Issue #66', 'Preparing…', { reason: 'auto', factors: { specialtyMatch: false } });
      s.sessionStarted(ada, { cli: 'codex' }, null);
      Object.assign(ada, { sessionId: 'ada-session' });
      vi.advanceTimersByTime(1000);
      pull.createdAt = new Date(Date.now()).toISOString();
      await s.recordFinished(ada, repo, { ...ok, costReported: false }, generation('a1'), undefined);
      const delivered = swarm.runHistory().attempts[0];
      expect(delivered).toMatchObject({
        task: 'issue', issueNumber: 66, prNumber: pull.number, parentId: null,
        assignment: { reason: 'auto', factors: { specialtyMatch: false } },
        runtime: { cli: 'codex', playbook: expect.stringMatching(/^developer@/) },
        sessionIds: ['ada-session'], revisions: { submitted: pull.headSha },
        usage: { sessions: 1, costUsd: null, turns: 7 }, runMs: 1000,
        outcome: { result: 'delivered', cause: 'agent' },
      });

      // The first QA desk fails on the worker; the retry is its child.
      s.state.agents.push({ id: 'q1', name: 'Sherlock', repoId: repo.id, role: 'qa', specialty: '', status: 'idle', task: null, desk: 0, endedAt: null });
      s.agentRt.set('q1', { log: [], pending: [], terminal: null });
      const tester = s.state.agents.at(-1)!;
      const rec = s.state.qa.find((q) => q.prNumber === pull.number)!;
      s.repoRt.get(repo.id)!.cloneStatus = 'ready';
      vi.spyOn(s.backend, 'prepareDesk').mockRejectedValueOnce(new Error('ENOSPC: no space left on device')).mockResolvedValueOnce('qa-desk');
      await s.runQa(tester, repo, rec);
      vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
      await s.runQa(tester, repo, rec);
      const [retry, blocked] = swarm.runHistory({ pr: pull.number }).attempts;
      expect(blocked).toMatchObject({ task: 'qa', parentId: delivered.id, outcome: { result: 'prepare-failed', cause: 'worker', excerpt: expect.stringContaining('ENOSPC') }, review: { reviewId: rec.reviewId } });
      expect(retry).toMatchObject({ task: 'qa', parentId: blocked.id, assignment: { reason: 'qa-queue' }, outcome: null });

      // A run that never opened a PR goes back to the backlog.
      vi.mocked(s.startAgentSession).mockRestore();
      Object.assign(ada, { status: 'idle', task: null, prNumber: null });
      vi.spyOn(s as unknown as { syncRepo(): Promise<void> }, 'syncRepo').mockResolvedValue();
      s.beginTask(ada, { task: 'issue', issueNumber: 67, issueTitle: 'Other', branch: 'swarm/issue-67-ada', prNumber: null, prUrl: null, sessionId: null }, 'Issue #67', 'Preparing…');
      s.sessionStarted(ada, {}, null);
      await s.recordFinished(ada, repo, ok, generation('a1'), undefined);
      expect(swarm.runHistory({ issue: 67 }).attempts).toEqual([expect.objectContaining({ assignment: expect.objectContaining({ reason: 'manager' }), prNumber: null, outcome: expect.objectContaining({ result: 'no-pr', cause: 'agent' }), usage: { sessions: 1, costUsd: 0.5, turns: 7 } })]);

      // Merging the PR removes its QA card, not its history.
      swarm.stopAgent('q1');
      expect(swarm.runHistory({ pr: pull.number }).attempts[0].outcome).toMatchObject({ result: 'stopped', cause: 'manager' });
      rec.status = 'passed';
      s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
      expect(swarm.snapshot().qa).toHaveLength(0);
      expect(swarm.runHistory({ pr: pull.number }).attempts.map((x) => x.prState)).toEqual(['MERGED', 'MERGED', 'MERGED']);

      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
      vi.spyOn(fs, 'rename').mockResolvedValue();
      await s.writeState();
      const written = (file: string) => String(write.mock.calls.find((c) => c[0] === `${file}.tmp`)![1]);
      const persisted = { ...JSON.parse(written(STATE_FILE)), repos: [], agents: [] };
      const files: Record<string, string> = { [STATE_FILE]: JSON.stringify(persisted), [RUN_HISTORY_FILE]: written(RUN_HISTORY_FILE) };
      const fresh = new Swarm(createDemoBackend());
      (fresh as unknown as Internals).backend.demo = false;
      vi.spyOn(fresh as unknown as Internals, 'save').mockImplementation(() => {});
      vi.spyOn(fs, 'readFile').mockImplementation(async (file) => files[String(file)] ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
      await fresh.init();
      const strip = (x: ReturnType<Swarm['runHistory']>['attempts'][number]) => ({ ...x, prState: undefined });
      expect(fresh.runHistory().attempts.map(strip)).toEqual(swarm.runHistory().attempts.map(strip));
      expect(fresh.runHistory({ pr: pull.number }).attempts[2].prState).toBe('MERGED');
    } finally {
      fixture.remove();
    }
  });

  it('records a manager stop while the desk is still being prepared', async () => {
    const ada = s.state.agents[0];
    s.beginTask(ada, { task: 'issue', issueNumber: 70, issueTitle: 'Stop me', branch: 'swarm/issue-70-ada', prNumber: null, prUrl: null, sessionId: null }, 'Issue #70', 'Preparing…');
    swarm.stopAgent('a1');
    expect(swarm.runHistory({ issue: 70 }).attempts[0].outcome).toMatchObject({ result: 'stopped', cause: 'manager' });
  });
});

describe('lessons', () => {
  beforeEach(() => s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null }));
  const report = (pass: boolean): SessionResult => ({ ok: true, text: '', errors: [], costUsd: 0, turns: 1, structured: pass
    ? { verdict: 'pass', summary: 'Wraps now.', checks: [{ name: 'Mobile layout (375px)', result: 'pass', details: 'Layout wraps correctly' }] }
    : { verdict: 'fail', summary: 'Toolbar overflows.', checks: [{ name: 'Mobile layout (375px)', result: 'fail', failureKind: 'code', findingKey: 'toolbar-overflow', confirmed: true,
      details: 'Toolbar overflows at 375px; the base wraps. Authorization: Bearer abcdefghijklmnop' }] } });

  it('turns a regression confirmed on two PRs into an approved lesson that survives a restart', async () => {
    const tester = swarm.hireAgent(repo.id, { name: 'Quinn', role: 'qa' });
    const testerRecord = s.state.agents.find((a) => a.id === tester.id)!;
    const review = async (prNumber: number, round: number, pass: boolean) => {
      const headSha = `head-${prNumber}-${round}`;
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...demoPull(repo.fullName, `swarm/issue-${prNumber}`, false).pull, number: prNumber, headSha, baseSha: 'base', state: 'OPEN', body: '', isCrossRepository: false } as never);
      s.state.qa = s.state.qa.filter((q) => q.prNumber !== prNumber);
      s.state.qa.push({ repoId: repo.id, prNumber, reviewId: `review-${prNumber}`, crossRepository: false, status: 'testing', round, retests: 0, sessionFailures: 0,
        testedSha: headSha, passedSha: null, devAgentId: 'a1', qaAgentId: tester.id, summary: null, checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 });
      Object.assign(testerRecord, { task: 'qa', status: 'working', prNumber });
      await s.onQaFinished(testerRecord, repo, report(pass));
      vi.advanceTimersByTime(1000);
    };
    await review(21, 1, false);
    await review(21, 2, true);
    await review(22, 1, false);
    await review(22, 2, true);

    const { recurringFindings } = await import('../shared/lessons.ts');
    const [suggestion] = recurringFindings(swarm.snapshot().qaOutcomes!, []);
    expect(suggestion).toMatchObject({ key: 'toolbar-overflow', kind: 'agent', fix: { prNumber: 22 } });
    const events = vi.spyOn(s, 'broadcast');
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    vi.spyOn(fs, 'rename').mockResolvedValue();
    const lesson = await swarm.draftLesson(repo.id, {
      kind: 'agent', specialty: 'frontend', title: 'Check the toolbar at 375px', guidance: 'Load the page at 375px before handing off.',
      sources: suggestion.findings.map((f) => ({ qaOutcomeId: f.qaOutcomeId, findingId: f.findingId })),
      verification: { kind: 'fix', qaOutcomeId: suggestion.fix!.qaOutcomeId },
    });
    expect(lesson.versions[0].sources.map((x) => x.summary).join(' ')).not.toContain('abcdefghijklmnop');
    expect(swarm.lessons({ repoId: repo.id }).lessons).toEqual([]);
    await swarm.reviewLesson(lesson.id, { action: 'approve', reason: 'Seen twice.' });
    expect(events).toHaveBeenLastCalledWith({ type: 'lesson', lesson: expect.objectContaining({ id: lesson.id }) });
    expect(swarm.lessons({ repoId: repo.id, specialty: 'frontend' }).lessons).toMatchObject([{ id: lesson.id, version: 1, approvedBy: 'manager', revisions: ['head-21-1', 'head-22-1', 'head-22-2'] }]);
    expect(swarm.lessons({ repoId: repo.id, specialty: 'server' }).lessons).toEqual([]);
    await expect(swarm.reviewLesson(lesson.id, { action: 'approve' })).rejects.toMatchObject({ status: 409 });

    const persisted = String(write.mock.calls.findLast((c) => c[0] === `${STATE_FILE}.tmp`)![1]);
    const fresh = new Swarm(createDemoBackend());
    (fresh as unknown as Internals).backend.demo = false;
    vi.spyOn(fresh as unknown as Internals, 'save').mockImplementation(() => {});
    vi.spyOn(fs, 'readFile').mockImplementation(async (file) => String(file) === STATE_FILE ? persisted : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
    await fresh.init();
    expect(fresh.snapshot().lessons).toEqual(swarm.snapshot().lessons);
    expect(fresh.lessons({ repoId: repo.id }).lessons.map((l) => l.id)).toEqual([lesson.id]);
  });

  it('undoes a lesson change the office could not save', async () => {
    s.state.qaOutcomes.push({ id: 'pass', repoId: repo.id, prNumber: 5, verdict: 'pass', findings: [], corrections: [], attemptId: 'pass', round: 1, summary: 'ok', headSha: 'h', commentUrl: null } as never);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('EACCES'));
    await expect(swarm.draftLesson(repo.id, { kind: 'agent', title: 'T', guidance: 'G', sources: [{ url: 'https://example.com/ci/1', summary: 'CI log' }], verification: { kind: 'fix', qaOutcomeId: 'pass' } }))
      .rejects.toThrow('EACCES');
    expect(swarm.snapshot().lessons).toEqual([]);
    await expect(swarm.draftLesson('nope', {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('playbook evaluations', () => {
  beforeEach(() => s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null }));
  it('saves a demo comparison, broadcasts it and restores the same report after restart', async () => {
    const events = vi.spyOn(s, 'broadcast');
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    vi.spyOn(fs, 'rename').mockResolvedValue();
    const evaluation = await swarm.demoPlaybookEvaluation(repo.id);
    expect(events).toHaveBeenCalledWith({ type: 'evaluation', evaluation });
    expect(swarm.snapshot().evaluations).toEqual([evaluation]);
    expect(swarm.evaluationExport(repo.id).evaluations).toEqual([evaluation]);
    expect(swarm.evaluationExport('other/repo').evaluations).toEqual([]);
    const persisted = String(write.mock.calls.findLast((c) => c[0] === `${STATE_FILE}.tmp`)![1]);
    const fresh = new Swarm(createDemoBackend());
    (fresh as unknown as Internals).backend.demo = false;
    vi.spyOn(fresh as unknown as Internals, 'save').mockImplementation(() => {});
    vi.spyOn(fs, 'readFile').mockImplementation(async (file) => String(file) === STATE_FILE ? persisted : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
    await fresh.init();
    expect(fresh.snapshot().evaluations).toEqual([evaluation]);
    expect(fresh.evaluationExport(repo.id)).toEqual(swarm.evaluationExport(repo.id));
  });

  it('does not publish an evaluation that could not be saved or expose demo fixtures in real mode', async () => {
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'writeFile').mockResolvedValue();
    vi.spyOn(fs, 'rename').mockResolvedValue();
    const e = await swarm.demoPlaybookEvaluation(repo.id);
    const events = vi.spyOn(s, 'broadcast');
    vi.spyOn(s, 'writeState').mockRejectedValue(new Error('EACCES'));
    await expect(swarm.evaluatePlaybook(repo.id, {
      lessonId: e.lesson.id, basePlaybook: e.report.basePlaybook, candidatePlaybook: e.report.candidatePlaybook,
      cases: e.cases.map((c) => ({ ...c, baseAttemptId: c.base.attemptId, candidateAttemptId: c.candidate.attemptId })),
    })).rejects.toThrow('EACCES');
    expect(swarm.snapshot().evaluations).toEqual([e]);
    expect(events).not.toHaveBeenCalled();
    s.backend.demo = false;
    await expect(swarm.demoPlaybookEvaluation(repo.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('specialty-first assignment', () => {
  const addDev = (id: string, specialty: string, authorship: number, repair: number, desk: number) => {
    const a: Record<string, unknown> = { ...s.state.agents[0], id, name: id, specialty, desk, score: 100 - desk };
    s.state.agents.push(a);
    s.agentRt.set(id, { log: [], pending: [], terminal: null });
    scores(id, authorship, repair);
    return a;
  };
  const scores = (id: string, authorship: number, repair: number) => s.scoreTotals.set(id, {
    authorship: { points: authorship, events: 2 }, repair: { points: repair, events: 2 }, neutral: 0,
  });
  beforeEach(() => {
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    Object.assign(s.state.agents[0], { specialty: 'server', score: -100 });
    scores('a1', -1, 10);
  });

  describe.each(['backlog', 'ceo'] as const)('%s', (source) => {
    it.each([
      { name: 'specialist beats a higher Authorship generalist', want: 'server', other: 'frontend', points: 9, expected: 'a1' },
      { name: 'Authorship breaks a same-specialty tie', want: 'server', other: 'server', points: 2, expected: 'a2' },
      { name: 'desk breaks a same-specialty score tie', want: 'server', other: 'server', points: -1, expected: 'a1' },
      { name: 'no specialist falls back by Authorship', want: 'engine', other: 'frontend', points: 2, expected: 'a2' },
      { name: 'unlabelled work is open to any specialty', want: '', other: '', points: 2, expected: 'a2' },
      { name: 'legacy points do not break score ties', want: '', other: 'frontend', points: -1, expected: 'a1' },
      { name: 'unavailable specialists permit fallback', want: 'server', other: 'frontend', points: 2, expected: 'a2', unavailable: true },
    ])('$name', async ({ want, other, points, expected, unavailable }) => {
      addDev('a2', other, points, -10, 1);
      if (unavailable) s.state.agents[0].startupFailed = true;
      setIssues(issue(66, want ? [`swarm:${want}`] : []));
      if (source === 'backlog') expect(s.startIssueWork(repo)).toBe(true);
      else expect(await s.officeTools().call('start_issue', { floor: 1, number: 66 })).toContain('started #66');
      expect(runTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: expected }), repo, expect.objectContaining({ number: 66 }), undefined);
      const attempt = swarm.runHistory({ issue: 66 }).attempts[0];
      const match = !!want && (expected === 'a1' ? 'server' : other) === want;
      expect(attempt.assignment).toMatchObject({
        reason: source === 'backlog' ? 'auto' : 'ceo',
        factors: { policyVersion: 'specialty-first-v2', specialty: want || null, specialtyMatch: match,
          specialtyFallback: !!want && !match, scoreKind: 'authorship', score: expected === 'a1' ? -1 : points },
      });
    });
  });

  it('honours an explicit CEO pick ahead of an available specialist', async () => {
    addDev('a2', '', -5, 0, 1);
    setIssues(issue(66, ['swarm:server']));
    await s.officeTools().call('start_issue', { floor: 1, number: 66, agent: 'a2' });
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2' }), repo, expect.anything(), undefined);
    expect(swarm.runHistory({ issue: 66 }).attempts[0].assignment.factors).toMatchObject({ pickedBy: 'ceo', specialtyFallback: true });
  });

  it.each(['specialist', 'repair score', 'no specialist', 'same-agent', 'explicit'] as const)('repair takeover respects %s', async (scenario) => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-author', false);
    try {
      const { pull } = fixture;
      s.repoRt.get(repo.id)!.pulls = [pull];
      setIssues(issue(66, ['swarm:server']));
      const rec = s.queueQa(repo, pull.number, null, 66);
      Object.assign(rec, { status: 'failed', fixReason: 'qa', fixInstructions: 'Repair this defect', fixCrashes: [] });
      const other = addDev('a2', scenario === 'repair score' ? 'server' : 'frontend', 20, scenario === 'repair score' ? 11 : -2, 1);
      if (scenario === 'no specialist') s.state.agents[0].specialty = 'engine';
      if (scenario === 'same-agent') rec.devAgentId = 'a2';
      if (scenario === 'explicit') rec.devAgentId = 'a1';
      if (scenario === 'explicit') await swarm.sendBackToDev({ floor: 1, number: pull.number, agent: 'a2' });
      const chosen = ['repair score', 'same-agent', 'explicit'].includes(scenario) ? other : s.state.agents[0];
      vi.spyOn(s, 'prepare').mockResolvedValue('fake-desk');
      vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
      expect(s.startPipelineWork(repo)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(rec).toMatchObject({ status: 'fixing', devAgentId: chosen.id });
      expect(swarm.runHistory({ pr: pull.number }).attempts[0].assignment).toMatchObject({
        reason: 'repair', factors: { policyVersion: 'specialty-first-v2', specialty: 'server', scoreKind: 'repair',
          score: chosen.id === 'a1' ? 10 : scenario === 'repair score' ? 11 : -2,
          specialtyMatch: ['specialist', 'repair score'].includes(scenario),
          specialtyFallback: !['specialist', 'repair score'].includes(scenario) },
      });
    } finally { fixture.remove(); }
  });

  it('refuses an unavailable explicit repair owner instead of silently assigning a teammate', async () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-author', false);
    try {
      s.repoRt.get(repo.id)!.pulls = [fixture.pull];
      setIssues(issue(66, ['swarm:server']));
      const rec = s.queueQa(repo, fixture.pull.number, null, 66);
      rec.status = 'failed';
      Object.assign(addDev('a2', 'frontend', 20, 20, 1), { status: 'working', issueNumber: 70 });
      await expect(swarm.sendBackToDev({ floor: 1, number: fixture.pull.number, agent: 'a2' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('not available') });
      expect(rec.devAgentId).toBeNull();
    } finally { fixture.remove(); }
  });

  it('CEO repair handoff ranks a new owner by specialty and Repair', async () => {
    const fixture = demoPull(repo.fullName, 'swarm/issue-66-author', false);
    try {
      s.repoRt.get(repo.id)!.pulls = [fixture.pull];
      setIssues(issue(66, ['swarm:server']));
      const rec = s.queueQa(repo, fixture.pull.number, null, 66);
      rec.status = 'failed';
      addDev('a2', 'frontend', 20, 20, 1);
      await swarm.sendBackToDev({ floor: 1, number: fixture.pull.number });
      expect(rec.devAgentId).toBe('a1');
    } finally { fixture.remove(); }
  });

  it.each(['suitability', 'ready workload', 'open workload', 'desk'] as const)('QA fallback uses %s and excludes the owner regardless of scores', (criterion) => {
    const owner = s.state.agents[0];
    Object.assign(owner, { specialty: 'qa', desk: -1 });
    const other = addDev('a2', 'frontend', 100, 100, 1);
    const cover = addDev('a3', criterion === 'suitability' ? 'testing' : 'server', -10, -10, criterion === 'desk' ? 0 : 2);
    const rec = s.queueQa(repo, 13, owner, 66);
    if (criterion === 'ready workload') setIssues(issue(70, ['swarm:frontend']));
    if (criterion === 'open workload') setIssues(issue(70, ['swarm:frontend'], 'Depends on #71'), issue(71, ['swarm:skip']));
    const qa = vi.spyOn(s, 'runQa').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(qa).toHaveBeenCalledExactlyOnceWith(cover, repo, rec);
    expect(other.status).toBe('idle');
  });
});

describe('developer scores', () => {
  const pull: PullInfo = {
    number: 13, title: 'Feature', url: '', headRefName: 'swarm/issue-66-ada', isCrossRepository: false, state: 'MERGED',
    isDraft: false, closesIssues: [], checks: 'passing', mergeable: 'MERGEABLE', headSha: 'sha',
    reviewDecision: null, createdAt: '', mergedAt: '2026-11-04', additions: 1, deletions: 0,
    mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  };
  const dev = () => s.state.agents[0];
  const qa = (): QaRec => ({
    repoId: repo.id, prNumber: 13, reviewId: 'review-13', crossRepository: false, status: 'passed', round: 1, retests: 0, sessionFailures: 0,
    testedSha: 'sha', passedSha: 'sha', devAgentId: 'a1', qaAgentId: null, summary: null,
    checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
  });

  it('initializes hires at zero and retains scores through clearing a desk', () => {
    const hired = swarm.hireAgent(repo.id, { name: 'Barbara' });
    expect(hired.score).toBe(0);
    dev().score = 7;
    swarm.resetAgent('a1');
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    expect(swarm.snapshot().agents.find((a) => a.id === 'a1')?.score).toBe(7);
  });

  it('rewards the recorded owner after their desk is cleared, once across repeated refreshes', () => {
    s.state.qa.push(qa());
    Object.assign(dev(), { prNumber: null, task: null, score: -1 });
    const tester = swarm.hireAgent(repo.id, { name: 'Barbara' });
    Object.assign(s.state.agents.find((a) => a.id === tester.id)!, { prNumber: 13, task: 'qa', status: 'done' });
    const events = vi.spyOn(s, 'broadcast');
    s.reconcilePulls(repo, [pull]);
    s.reconcilePulls(repo, [pull]);
    expect(dev().score).toBe(1);
    expect(s.state.agents.find((a) => a.id === tester.id)?.score).toBe(0);
    expect(s.state.qa).toEqual([]);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent', agent: expect.objectContaining({ id: 'a1', score: 1 }) }));
  });

  it('rewards an office merge immediately and does not reward its later refresh again', async () => {
    const rec = qa();
    s.state.qa.push(rec);
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, state: 'OPEN', body: '', isCrossRepository: false });
    vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    expect(await s.advanceMerge(repo, rec, { ...pull, state: 'OPEN' })).toBe(true);
    expect(dev().score).toBe(2);
    s.reconcilePulls(repo, [pull]);
    expect(dev().score).toBe(2);
  });

  it('rewards a merge found by pruning PRs outside the recent listing', async () => {
    s.state.qa.push(qa());
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    await (s as unknown as { pruneUnlistedQa(repo: Repo, pulls: PullInfo[]): Promise<void> }).pruneUnlistedQa(repo, []);
    expect(dev().score).toBe(2);
  });

  it.each(['CLOSED', 'MERGED'] as const)('handles %s desk reconciliation without rewarding testers or other roles', (state) => {
    Object.assign(dev(), { prNumber: 13, task: 'issue', status: 'done', branch: pull.headRefName });
    s.reconcilePulls(repo, [{ ...pull, state }]);
    expect(dev().score).toBe(state === 'MERGED' ? 2 : 0);
    expect(dev().prNumber).toBeNull();
    s.reconcilePulls(repo, [{ ...pull, state }]);
    expect(dev().score).toBe(state === 'MERGED' ? 2 : 0);
  });

  it.each([
    { status: 'working' }, { status: 'preparing' }, { status: 'stopped' },
    { startupFailed: true }, { status: 'error', endedAt: Date.now() },
    { heldRetry: { issueNumber: 67, ahead: 1, why: 'retry' } }, { repoId: 'elsewhere' },
  ])('skips an unavailable higher-scoring developer: %j', (unavailable) => {
    const higher = { ...dev(), id: 'a2', name: 'Barbara', score: 10, desk: 1, ...unavailable };
    s.state.agents.push(higher);
    s.agentRt.set('a2', { log: [], pending: [], terminal: null });
    setIssues(issue(66));
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledWith(dev(), repo, issue(66), undefined);
  });

  it('chooses a free specialist ahead of a higher-scoring generalist', () => {
    dev().specialty = 'server';
    const higher = { ...dev(), id: 'a2', name: 'Barbara', specialty: '', score: 2, desk: 1 };
    s.state.agents.push(higher);
    s.agentRt.set('a2', { log: [], pending: [], terminal: null });
    setIssues(issue(66, ['swarm:server']));
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledWith(dev(), repo, expect.objectContaining({ number: 66 }), undefined);
  });

  describe('PR attribution', () => {
    const url = (number: number) => `https://github.com/${repo.fullName}/pull/${number}`;
    const details = (pr: PullInfo) => ({ ...pr, url: url(pr.number), body: '', isCrossRepository: false });
    const finish = (agent: Record<string, unknown>, number: number) => s.onIssueFinished(agent, repo,
      { ok: true, text: url(number), errors: [], costUsd: 0, turns: 1 }, Promise.resolve(), undefined);
    const claimant = (role: 'dev' | 'researcher' = 'dev') => {
      const hired = swarm.hireAgent(repo.id, { name: 'Eve', role });
      return Object.assign(s.state.agents.find((a) => a.id === hired.id)!, {
        status: 'working', task: 'issue', issueNumber: 67, branch: 'swarm/issue-67-eve',
      });
    };
    beforeEach(() => {
      Object.assign(repo, { defaultBranch: 'main' });
      Object.assign(dev(), { status: 'done', task: 'issue', prNumber: 13, branch: pull.headRefName });
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      vi.spyOn(s.backend, 'prForBranch').mockResolvedValue(null);
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(details({ ...pull, state: 'OPEN' }));
    });

    it('steal: a teammate PR URL cannot re-point QA or take its merge reward', async () => {
      const rec = { ...qa(), status: 'queued' as const };
      s.state.qa.push(rec);
      const eve = claimant();
      await finish(eve, 13);
      expect(eve.prNumber).toBeNull();
      expect(rec.devAgentId).toBe('a1');
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
      expect(eve.score).toBe(0);
    });

    it.each(['MERGED', 'CLOSED'] as const)('farm: an already %s PR cannot mint a crediting record, even on the issued branch', async (state) => {
      s.state.qa.push(qa());
      const eve = claimant();
      vi.mocked(s.backend.prForBranch).mockResolvedValue({ number: 3, url: url(3) });
      vi.mocked(s.backend.prDetails).mockResolvedValue(details({ ...pull, number: 3, state, headRefName: String(eve.branch) }));
      await finish(eve, 3);
      expect(eve.prNumber).toBeNull();
      expect(s.state.qa.some((q) => q.prNumber === 3)).toBe(false);
      await (s as unknown as { pruneUnlistedQa(repo: Repo, pulls: PullInfo[]): Promise<void> }).pruneUnlistedQa(repo, [{ ...pull, state: 'OPEN' }]);
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
      expect(eve.score).toBe(0);
    });

    it('deny: a researcher cannot fill an unknown author and suppress the actual author reward', async () => {
      const rec = { ...qa(), devAgentId: null, status: 'failed' as const };
      s.state.qa.push(rec);
      const eve = claimant('researcher');
      await finish(eve, 13);
      expect(eve.prNumber).toBeNull();
      expect(rec.devAgentId).toBeNull();
      s.reconcilePulls(repo, [pull]);
      expect(dev().prNumber).toBeNull();
      expect(dev().score).toBe(2);
      expect(eve.score).toBe(0);
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
    });

    it('researcher-first: a foreign report URL cannot claim QA before the author finishes', async () => {
      const eve = claimant('researcher');
      Object.assign(dev(), { status: 'working', prNumber: null });
      await s.recordResearchFinished(eve, { topic: 'Research brief' }, repo, repo.fullName,
        { ok: true, text: url(13), errors: [], costUsd: 0, turns: 1 });
      expect(eve.prNumber).toBeNull();
      expect(s.state.qa).toEqual([]);
      vi.mocked(s.backend.prForBranch).mockResolvedValue({ number: 13, url: url(13) });
      await finish(dev(), 13);
      expect(s.state.qa[0]).toMatchObject({ prNumber: 13, devAgentId: 'a1' });
      s.clearTask(dev());
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
      expect(eve.score).toBe(0);
    });

    it('still files research from its verified branch when the report cites another PR', async () => {
      const eve = claimant('researcher');
      vi.mocked(s.backend.prForBranch).mockResolvedValue({ number: 14, url: url(14) });
      vi.mocked(s.backend.prDetails).mockResolvedValue(details({ ...pull, number: 14, state: 'OPEN', headRefName: String(eve.branch) }));
      await s.recordResearchFinished(eve, { topic: 'Research brief' }, repo, repo.fullName,
        { ok: true, text: url(13), errors: [], costUsd: 0, turns: 1 });
      expect(eve.prNumber).toBe(14);
      expect(s.state.qa[0]).toMatchObject({ prNumber: 14, devAgentId: eve.id, status: 'passed' });
    });

    it('does not attach a legacy researcher desk to an author-less failed record', async () => {
      const rec = { ...qa(), devAgentId: null, status: 'failed' as const };
      s.state.qa.push(rec);
      const eve = claimant('researcher');
      Object.assign(eve, { branch: null, prNumber: 13 });
      await finish(eve, 13);
      expect(rec.devAgentId).toBeNull();
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
      expect(eve.score).toBe(0);
    });

    it.each(['queued', 'passed', 'failed', 'needs-human', 'fixing', 'testing'] as const)('queueQa preserves another developer attribution in status %s', (status) => {
      const rec = { ...qa(), status };
      s.state.qa.push(rec);
      s.queueQa(repo, 13, claimant(), 67);
      expect(rec.devAgentId).toBe('a1');
    });

    it('queueQa leaves an unknown developer unset when a researcher adopts it', () => {
      const rec = { ...qa(), status: 'queued' as const, devAgentId: null };
      s.state.qa.push(rec);
      s.queueQa(repo, 13, claimant('researcher'), 67);
      expect(rec.devAgentId).toBeNull();
    });

    it('uses the open PR on the issued branch even when the message cites another PR', async () => {
      Object.assign(dev(), { status: 'working', prNumber: null });
      vi.mocked(s.backend.prForBranch).mockResolvedValue({ number: 13, url: url(13) });
      await finish(dev(), 3);
      expect(dev().prNumber).toBe(13);
      expect(s.state.qa[0]).toMatchObject({ prNumber: 13, devAgentId: 'a1' });
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(2);
    });

    it.each(['unavailable', 'details unavailable', 'wrong branch'] as const)('does not trust a session PR claim when verification is %s', async (failure) => {
      Object.assign(dev(), { status: 'working', prNumber: null });
      vi.mocked(s.backend.prForBranch).mockResolvedValue({ number: 13, url: url(13) });
      if (failure === 'unavailable') vi.mocked(s.backend.prForBranch).mockRejectedValue(new Error('offline'));
      else if (failure === 'details unavailable') vi.mocked(s.backend.prDetails).mockRejectedValue(new Error('offline'));
      else vi.mocked(s.backend.prDetails).mockResolvedValue(details({ ...pull, state: 'OPEN', headRefName: 'another-branch' }));
      vi.spyOn(swarm, 'message').mockResolvedValue(undefined as never);
      await finish(dev(), 13);
      expect(dev().prNumber).toBeNull();
      expect(s.state.qa).toEqual([]);
      s.reconcilePulls(repo, [pull]);
      expect(dev().score).toBe(0);
    });

    it('fork: a cross-repository PR on a same-named branch is not adopted and earns no score', async () => {
      vi.mocked(s.backend.prForBranch).mockRestore();
      vi.mocked(s.backend.prDetails).mockRestore();
      const eve = claimant();
      const fork = demoForkPull(repo.fullName, String(eve.branch));
      try {
        vi.spyOn(swarm, 'message').mockResolvedValue(undefined as never);
        await finish(eve, fork.pull.number);
        expect(eve.prNumber).toBeNull();
        expect(s.state.qa.some((q) => q.prNumber === fork.pull.number)).toBe(false);
        s.reconcilePulls(repo, [{ ...fork.pull, state: 'MERGED', mergedAt: '2026-11-04' }]);
        expect(eve.score).toBe(0);
      } finally {
        fork.remove();
      }
    });

    it('fork: the periodic refresh queues a cross-repository PR on a same-named branch with no owner', async () => {
      Object.assign(dev(), { prNumber: null }); // demo PR numbers run on across tests
      const eve = claimant();
      const fork = demoForkPull(repo.fullName, String(eve.branch));
      try {
        const { pulls } = await s.backend.listPulls(repo.fullName);
        const listed = pulls.find((p) => p.number === fork.pull.number)!;
        s.reconcilePulls(repo, [listed]);
        expect(s.state.qa.find((q) => q.prNumber === listed.number)).toMatchObject({ devAgentId: null });
        s.reconcilePulls(repo, [{ ...listed, state: 'MERGED', mergedAt: '2026-11-04' }]);
        expect(eve.score).toBe(0);
      } finally {
        fork.remove();
      }
    });

    it.each(['OPEN', 'CLOSED'] as const)('shadow: a newer %s fork PR on the desk branch does not hide the desk PR', async (state) => {
      vi.mocked(s.backend.prForBranch).mockRestore();
      vi.mocked(s.backend.prDetails).mockRestore();
      Object.assign(dev(), { prNumber: null }); // demo PR numbers run on across tests
      const eve = claimant();
      const own = demoPull(repo.fullName, String(eve.branch), false);
      const fork = demoForkPull(repo.fullName, String(eve.branch));
      fork.pull.state = state;
      try {
        vi.spyOn(swarm, 'message').mockResolvedValue(undefined as never);
        await finish(eve, own.pull.number);
        expect(eve.prNumber).toBe(own.pull.number);
        expect(s.state.qa.find((q) => q.prNumber === own.pull.number)).toMatchObject({ devAgentId: eve.id, crossRepository: false });
        s.clearTask(eve);
        s.reconcilePulls(repo, [{ ...own.pull, state: 'MERGED', mergedAt: '2026-11-04' }]);
        expect(eve.score).toBe(2);
      } finally {
        own.remove();
        fork.remove();
      }
    });

    it('shadow: a newer fork PR on a researcher branch does not hide the filed research', async () => {
      vi.mocked(s.backend.prForBranch).mockRestore();
      vi.mocked(s.backend.prDetails).mockRestore();
      Object.assign(dev(), { prNumber: null });
      const eve = claimant('researcher');
      const own = demoPull(repo.fullName, String(eve.branch), false);
      const fork = demoForkPull(repo.fullName, String(eve.branch));
      try {
        await s.recordResearchFinished(eve, { topic: 'Research brief' }, repo, repo.fullName, { ok: true, text: '', errors: [], costUsd: 0, turns: 1 });
        expect(eve.prNumber).toBe(own.pull.number);
        expect(s.state.qa.find((q) => q.prNumber === own.pull.number)).toMatchObject({ devAgentId: eve.id, status: 'passed', crossRepository: false });
        expect(s.state.qa.some((q) => q.prNumber === fork.pull.number)).toBe(false);
      } finally {
        own.remove();
        fork.remove();
      }
    });

    it.each([true, false])('send to QA credits a desk by branch name only for a same-repo PR (fork: %s)', async (fromFork) => {
      Object.assign(dev(), { prNumber: null }); // demo PR numbers run on across tests
      const eve = claimant();
      const fork = demoForkPull(repo.fullName, String(eve.branch));
      try {
        if (fromFork) vi.mocked(s.backend.prDetails).mockRestore();
        s.repoRt.get(repo.id)!.pulls = [fork.pull];
        await swarm.sendToQa(repo.id, fork.pull.number);
        expect(s.state.qa.find((q) => q.prNumber === fork.pull.number)?.devAgentId).toBe(fromFork ? null : eve.id);
      } finally {
        fork.remove();
      }
    });
  });

  it.each([false, true])('loads scores and event identities across restart (legacy: %s)', async (legacy) => {
    dev().score = 4;
    const tester = swarm.hireAgent(repo.id, { name: 'Grace', role: 'qa' });
    const testerRecord = s.state.agents.find((a) => a.id === tester.id)!;
    Object.assign(testerRecord, { task: 'qa', status: 'working', prNumber: 13 });
    const rec = { ...qa(), status: 'testing' as const, qaAgentId: tester.id };
    s.state.qa.push(rec);
    const failure: SessionResult = { ok: true, text: '', errors: [], costUsd: 0, turns: 1, structured: {
      verdict: 'fail', summary: 'Broken', checks: [{ name: 'Feature', result: 'fail', details: 'Broken' }],
    } };
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, state: 'OPEN', body: '', isCrossRepository: false });
    await s.onQaFinished(testerRecord, repo, failure);
    expect(dev().score).toBe(4);
    s.reconcilePulls(repo, [pull]);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    vi.spyOn(fs, 'rename').mockResolvedValue();
    await s.writeState();
    const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
    if (legacy) {
      delete persisted.agents[0].score;
      delete persisted.feedbackEvents;
    }
    // No floors: startup exercises migration without onboarding or scheduling work.
    persisted.repos = [];
    const fresh = new Swarm(createDemoBackend());
    const restored = fresh as unknown as Internals;
    restored.backend.demo = false;
    vi.spyOn(restored, 'save').mockImplementation(() => {});
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
    await fresh.init();
    expect(fresh.snapshot().agents.find((a) => a.id === 'a1')?.score).toBe(legacy ? 0 : 6);
    if (!legacy) {
      const replay = { ...rec, status: 'testing' as const };
      restored.state.qa.push(replay);
      const restoredTester = restored.state.agents.find((a) => a.id === tester.id)!;
      Object.assign(restoredTester, { task: 'qa', status: 'working', prNumber: 13 });
      vi.spyOn(restored.backend, 'prDetails').mockResolvedValue({ ...pull, state: 'OPEN', body: '', isCrossRepository: false });
      await restored.onQaFinished(restoredTester, repo, failure);
      restored.reconcilePulls(repo, [pull]);
      expect(restored.state.agents[0].score).toBe(6);
    }
    await fresh.shutdown();
  });
});

describe('closing issues', () => {
  const args = { floor: 1, number: 66, reason: 'Superseded by #67' };
  let pull: PullInfo;
  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [] });
    pull = {
      number: 13, title: 'Feature', url: '', isCrossRepository: false, headRefName: 'swarm/issue-66-ada', state: 'OPEN', isDraft: false,
      closesIssues: [66, 67], checks: 'passing', mergeable: 'MERGEABLE', headSha: 'tested', reviewDecision: null,
      createdAt: '', mergedAt: null, additions: 0, deletions: 0, mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
    };
    setIssues(issue(66), issue(67), issue(68));
    s.repoRt.get(repo.id)!.pulls = [pull];
    vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pull, body: '', isCrossRepository: false }));
    vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    vi.spyOn(s.backend, 'closeIssue').mockResolvedValue();
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
  });

  it.each(['manual', 'automatic'] as const)('closes all resolved issues after %s merge and broadcasts their removal', async (mode) => {
    const events = vi.spyOn(s, 'broadcast');
    if (mode === 'manual') await swarm.mergePull(repo.id, 13);
    else {
      const rec: QaRec = { repoId: repo.id, prNumber: 13, status: 'passed', round: 1, retests: 0, passedSha: 'tested',
        sessionFailures: 0, devAgentId: null, qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 };
      expect(await s.advanceMerge(repo, rec, pull)).toBe(true);
    }
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(2);
    for (const number of [66, 67]) {
      expect(s.backend.closeIssue).toHaveBeenCalledWith(repo.fullName, number, 'completed', `Completed by PR #13.\n\n${AGENT_COMMENT_MARKER}`);
    }
    expect(vi.mocked(s.backend.mergePull).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.backend.closeIssue).mock.invocationCallOrder[0]);
    expect(s.repoRt.get(repo.id)!.issues.map((i) => i.number)).toEqual([68]);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'repo', repo: expect.objectContaining({ issues: [expect.objectContaining({ number: 68 })] }) }));
    expect(pull.state).toBe('OPEN'); // Updating the cache must not mutate a previous snapshot.
  });

  it('keeps merged work taken and closes other issues if one closure fails', async () => {
    vi.mocked(s.backend.closeIssue).mockRejectedValueOnce(new Error('GitHub denied closure'));
    const messages = vi.spyOn(s, 'postMessage');
    await swarm.mergePull(repo.id, 13);
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(2);
    expect(s.repoRt.get(repo.id)!.issues.map((i) => i.number)).toEqual([66, 68]);
    expect(ready()).toEqual([68]);
    expect(messages).toHaveBeenCalledWith('office', expect.stringContaining('closing issue #66 failed'));
  });

  it('does not close issues when merging fails', async () => {
    vi.mocked(s.backend.mergePull).mockRejectedValue(new Error('Merge refused'));
    await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('Merge refused');
    expect(s.backend.closeIssue).not.toHaveBeenCalled();
    expect(s.repoRt.get(repo.id)!.issues).toHaveLength(3);
  });

  it.each([null, 'CLOSED'] as const)('refuses unavailable issues: %s', async (state) => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue(state ? { ...issue(66), repo: repo.fullName, state } : null);
    expect(await s.officeTools().call('close_issue', args)).toContain(state ? 'already closed' : 'Unknown issue');
    expect(s.backend.closeIssue).not.toHaveBeenCalled();
  });

  it('checks fresh PRs before closing and identifies the blocking PR', async () => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...issue(66), repo: repo.fullName, state: 'OPEN' });
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [pull] });
    s.repoRt.get(repo.id)!.pulls = []; // The new PR has not reached the floor's cache yet.
    expect(await s.officeTools().call('close_issue', args)).toContain('Open PR #13 closes #66. Merge or park that PR first.');
    expect(s.backend.closeIssue).not.toHaveBeenCalled();
  });

  it('does not remove issues if GitHub refuses closure', async () => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...issue(66), repo: repo.fullName, state: 'OPEN' });
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    vi.mocked(s.backend.closeIssue).mockRejectedValue(new Error('HTTP 403'));
    expect(await s.officeTools().call('close_issue', args)).toContain('HTTP 403');
    expect(s.repoRt.get(repo.id)!.issues).toHaveLength(3);
  });

  it('surfaces GitHub read failures instead of reporting an unknown issue', async () => {
    vi.spyOn(s.backend, 'readIssue').mockRejectedValue(new Error('GitHub rate limit exceeded; retry later'));
    expect(await s.officeTools().call('close_issue', args)).toContain('GitHub rate limit exceeded; retry later');
    expect(s.backend.closeIssue).not.toHaveBeenCalled();
  });

  it.each([[undefined, 'not planned'], [false, 'not planned'], [true, 'completed']] as const)('completed: %s closes as %s', async (completed, as) => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...issue(66), repo: repo.fullName, state: 'OPEN' });
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    expect(await s.officeTools().call('close_issue', { ...args, completed })).toContain(`Closed #66 on floor 1 as ${as}: Superseded by #67`);
    expect(s.backend.closeIssue).toHaveBeenCalledWith(repo.fullName, 66, as, `Superseded by #67\n\n${AGENT_COMMENT_MARKER}`);
  });

  it('closes unwanted issues as not planned through the demo CEO', async () => {
    vi.mocked(s.backend.closeIssue).mockRestore();
    const number = await s.backend.createIssue(repo.fullName, 'Unwanted task', 'Superseded');
    setIssues(issue(number), issue(68));
    const finished = vi.fn();
    const handle = s.backend.startSession({ role: 'ceo', cwd: '', prompt: `Manager asks:\nClose issue #${number} on floor 1 because Superseded by #67`,
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
      { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining(`Closed #${number}`) }));
    expect(await s.backend.readIssue(repo.fullName, number)).toMatchObject({ state: 'CLOSED', stateReason: 'not_planned' });
    expect(s.repoRt.get(repo.id)!.issues.map((i) => i.number)).toEqual([68]);
    handle.stop();
  });
});

describe('commenting on issues', () => {
  const args = { floor: 1, number: 66, body: 'Also handle empty titles.' };
  const open = { ...issue(66), repo: 'demo-co/pixel-todo', state: 'OPEN' } as TrackedIssue;
  beforeEach(() => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue(open);
    vi.spyOn(s.backend, 'commentIssue').mockResolvedValue('https://github.com/demo-co/pixel-todo/issues/66#issuecomment-1');
  });

  it('posts on an open issue and says nobody was notified when no session runs on it', async () => {
    const messages = vi.spyOn(s, 'postMessage');
    const out = await s.officeTools().call('comment_issue', args);
    expect(s.backend.commentIssue).toHaveBeenCalledWith(repo.fullName, 66, `Also handle empty titles.\n\n---\n_Added by Joi, the cubefarm CEO._\n\n${AGENT_COMMENT_MARKER}`);
    expect(out).toContain('Commented on #66 on floor 1: https://github.com/demo-co/pixel-todo/issues/66#issuecomment-1.');
    expect(out).toContain('nobody was notified');
    expect(messages).toHaveBeenCalledWith('office', 'Joi commented on #66 (floor 1): Also handle empty titles.');
  });

  it('passes the comment into a running session on that issue', async () => {
    const send = vi.fn();
    Object.assign(s.state.agents[0], { task: 'issue', issueNumber: 66, status: 'working' });
    Object.assign(s.agentRt.get('a1')!, { session: { send, stop: vi.fn() } });
    const out = await s.officeTools().call('comment_issue', args);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Also handle empty titles.'));
    expect(out).toContain("Passed to Ada's running session.");
  });

  it('does not notify sessions on other issues', async () => {
    const send = vi.fn();
    Object.assign(s.state.agents[0], { task: 'issue', issueNumber: 67, status: 'working' });
    Object.assign(s.agentRt.get('a1')!, { session: { send, stop: vi.fn() } });
    expect(await s.officeTools().call('comment_issue', args)).toContain('nobody was notified');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([null, 'CLOSED'] as const)('refuses unavailable issues: %s', async (state) => {
    vi.mocked(s.backend.readIssue).mockResolvedValue(state ? { ...open, state } : null);
    expect(await s.officeTools().call('comment_issue', args)).toContain(state ? 'is closed' : 'Unknown issue');
    expect(s.backend.commentIssue).not.toHaveBeenCalled();
  });

  it('comments through the demo CEO', async () => {
    vi.mocked(s.backend.readIssue).mockRestore();
    vi.mocked(s.backend.commentIssue).mockRestore();
    const number = await s.backend.createIssue(repo.fullName, 'Work in progress', 'Build it');
    setIssues(issue(number));
    const finished = vi.fn();
    const handle = s.backend.startSession({ role: 'ceo', cwd: '', prompt: `Manager asks:\nComment on #${number} on floor 1: Also export to CSV`,
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
      { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining(`Commented on #${number}`) }));
    handle.stop();
  });
});

describe('exclusive issue sessions', () => {
  let starts: Mock;
  const dev = () => s.state.agents[0];
  const other = () => s.state.agents.find((a) => a.id === 'a2')!;
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [{ issueNumber: 66, prNumber: 13, branch: 'swarm/issue-66-barbara' }] });
    Object.assign(dev(), { model: '', effort: '', cli: '' });
    s.state.agents.push({ ...dev(), id: 'a2', name: 'Barbara', desk: 1 });
    s.agentRt.set('a2', { log: [], pending: [], terminal: null });
    s.runTask = (Swarm.prototype as unknown as Pick<Internals, 'runTask'>).runTask;
    vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
    vi.spyOn(s.backend, 'deskHead').mockResolvedValue('base');
    starts = vi.spyOn(s.backend, 'startSession').mockReturnValue({ send: vi.fn(), stop: vi.fn() });
    setIssues(issue(66), issue(67));
  });

  it('gives two newly ready issues to one developer each, including parked work', async () => {
    const waiting = [issue(66, [], 'Depends on #65'), issue(67, [], 'Depends on #65')];
    setIssues(issue(65), ...waiting);
    expect(ready()).toEqual([65]);
    setIssues(...waiting); // one refresh sees their common prerequisite close
    expect(s.startIssueWork(repo)).toBe(true);
    expect(s.startIssueWork(repo)).toBe(true);
    expect(s.startIssueWork(repo)).toBe(false);
    await flush();
    expect([dev().issueNumber, other().issueNumber]).toEqual([66, 67]);
    expect(starts).toHaveBeenCalledTimes(2);
    expect(starts.mock.calls[0][0].prompt).toContain('Parked PR #13');
  });

  it.each([
    ['opencode', 'deepseek/deepseek-v4.1-flash-1017'],
    ['claude', 'sonnet'],
    ['codex', 'gpt-6-astra'],
  ] as const)('passes the per-agent %s model from Settings when assigning work', async (cli, model) => {
    Object.assign(s.backend, { terminals: true });
    swarm.updateSettings({ runtime: 'terminal' });
    swarm.updateAgent('a1', { cli, model });
    await swarm.assign('a1', 67);
    await flush();
    expect(starts.mock.calls[0][0]).toMatchObject({ cli, model });
  });

  it.each(['explicit', 'automatic'] as const)('reserves before preparation when %s assignment wins', async (first) => {
    let prepared!: (cwd: string) => void;
    vi.mocked(s.prepare).mockReturnValue(new Promise((resolve) => { prepared = resolve; }));
    setIssues(issue(66));
    if (first === 'explicit') {
      const assigning = swarm.assign('a2', 66);
      expect(s.startIssueWork(repo)).toBe(false);
      await assigning;
    } else {
      expect(s.startIssueWork(repo)).toBe(true);
      await expect(swarm.assign('a2', 66)).rejects.toMatchObject({ status: 409 });
    }
    expect(s.state.agents.filter((a) => a.issueNumber === 66 && a.status === 'preparing')).toHaveLength(1);
    expect(starts).not.toHaveBeenCalled();
    prepared('/fake-desk');
    await flush();
    expect(starts).toHaveBeenCalledOnce();
  });

  it('rejects an old parked-PR session resuming after automatic assignment', async () => {
    Object.assign(other(), { status: 'error', task: 'issue', issueNumber: 66, prNumber: 13, sessionId: 'old-session', branch: 'swarm/issue-66-barbara' });
    expect(s.startIssueWork(repo)).toBe(true);
    await expect(swarm.message('a2', 'Continue the parked work')).rejects.toMatchObject({ status: 409 });
    await flush();
    expect(starts).toHaveBeenCalledOnce();
  });

  it('reserves requested restarts before an explicit assignment can take them', async () => {
    repo.requestedStarts = [{ issueNumber: 66, preferredAgentId: 'a2', restartPending: true }];
    expect(s.startIssueWork(repo)).toBe(true);
    await expect(swarm.assign('a1', 66)).rejects.toMatchObject({ status: 409 });
    await flush();
    expect(other()).toMatchObject({ issueNumber: 66, status: 'working' });
    expect(starts).toHaveBeenCalledOnce();
  });

  it('makes a fix wait while another developer holds its issue', async () => {
    await swarm.assign('a1', 66);
    const rec = { repoId: repo.id, prNumber: 13, issueNumber: 66, devAgentId: 'a2', status: 'failed', checks: [], fixCrashes: [], round: 1 } as unknown as QaRec;
    s.state.qa.push(rec);
    expect(s.startPipelineWork(repo)).toBe(false);
    await expect(s.runFix(other(), repo, rec)).rejects.toMatchObject({ status: 409 });
    await flush();
    expect(rec.status).toBe('failed');
    expect(other().status).toBe('idle');
    expect(starts).toHaveBeenCalledOnce();
  });

  it('preserves a held retry against explicit assignment', async () => {
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'error', heldRetry: { issueNumber: 66, ahead: 1, why: 'cut off' } });
    await expect(swarm.assign('a1', 66)).rejects.toMatchObject({ status: 409 });
    expect(starts).not.toHaveBeenCalled();
  });

  it('repairs a late reconnect before following its CLI, retaining its linked PR', async () => {
    await swarm.assign('a1', 66);
    await flush();
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'stopped', prNumber: 13, startedAt: 100, sessionId: 'kept-session', branch: 'swarm/issue-66-barbara' });
    const reconnect = s as unknown as { reattachSession(a: unknown): void };
    reconnect.reattachSession(other());
    await flush();
    expect(dev()).toMatchObject({ status: 'idle', issueNumber: null });
    expect(other()).toMatchObject({ status: 'working', issueNumber: 66, prNumber: 13 });
    expect(starts.mock.calls[1][0].reattach).toBe(true);
  });

  it('revokes a duplicate that is still reading its starting head', async () => {
    let head!: (value: string) => void;
    vi.mocked(s.backend.deskHead).mockReturnValueOnce(new Promise((resolve) => { head = resolve; }));
    await swarm.assign('a1', 66);
    await flush();
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'working', prNumber: 13 });
    (s as unknown as { repairDuplicateIssues(): void }).repairDuplicateIssues();
    head('base');
    await flush();
    expect(dev()).toMatchObject({ status: 'idle', issueNumber: null });
    expect(other().status).toBe('working');
    expect(starts).not.toHaveBeenCalled();
  });

  it.each([true, false])('reconciles an errored held retry with a reconnecting CLI (linked reconnect: %s)', async (linked) => {
    Object.assign(dev(), { task: 'issue', issueNumber: 66, status: 'error', startedAt: 100, heldRetry: { issueNumber: 66, ahead: 1, why: 'cut off' } });
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'stopped', startedAt: 200, prNumber: linked ? 13 : null, sessionId: 'kept-session', branch: 'swarm/issue-66-barbara' });
    const loser = dev();
    const stop = vi.fn();
    const releaseIdle = vi.fn();
    Object.assign(s.agentRt.get(String(loser.id))!, { session: { stop }, terminal: { write: vi.fn(), releaseIdle } });
    const feed = vi.spyOn(s, 'postMessage');
    (s as unknown as { reattachSession(a: unknown): void }).reattachSession(other());
    await flush();
    expect(loser).toMatchObject({ status: 'idle', task: null, issueNumber: null, heldRetry: null, sessionId: null });
    expect(s.agentRt.get(String(loser.id))).toMatchObject({ session: null });
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(feed).toHaveBeenCalledWith('office', expect.stringContaining('duplicate session on #66'));
    expect(s.state.agents.filter((a) => a.issueNumber === 66 && (a.heldRetry || a.status === 'working'))).toHaveLength(1);
    expect(other()).toMatchObject({ status: 'working', prNumber: linked ? 13 : null });
    expect(starts).toHaveBeenCalledOnce();
    expect(starts.mock.calls[0][0].reattach).toBe(true);
  });

  it('handles a reconnect startup conflict without an unhandled rejection or phantom worker', async () => {
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'stopped', sessionId: 'kept-session' });
    const claim = s as unknown as { checkIssueClaim(a: unknown, n: number | null): void; reattachSession(a: unknown): void };
    vi.spyOn(claim, 'checkIssueClaim').mockImplementationOnce(() => { throw new HttpError(409, 'Ada is already working on #66'); });
    claim.reattachSession(other());
    await flush();
    expect(other()).toMatchObject({ status: 'stopped', lastError: 'Ada is already working on #66' });
    expect(starts).not.toHaveBeenCalled();
    expect(s.save).toHaveBeenCalled();
  });

  it('stops a failed reconnect and preserves its recovery details', async () => {
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'stopped', sessionId: 'kept-session', branch: 'swarm/issue-66-barbara' });
    const stop = vi.fn();
    const releaseIdle = vi.fn();
    Object.assign(s.agentRt.get('a2')!, { session: { stop }, terminal: { write: vi.fn(), releaseIdle } });
    starts.mockImplementationOnce(() => { throw new Error('Runner unavailable'); });
    (s as unknown as { reattachSession(a: unknown): void }).reattachSession(other());
    await flush();
    expect(other()).toMatchObject({ status: 'stopped', task: 'issue', issueNumber: 66, sessionId: 'kept-session', branch: 'swarm/issue-66-barbara', lastError: 'Runner unavailable' });
    expect(s.agentRt.get('a2')).toMatchObject({ session: null });
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseIdle).toHaveBeenCalledOnce();
  });

  it('does not let a stale reconnect rejection stop a replacement task', async () => {
    Object.assign(other(), { task: 'issue', issueNumber: 66, status: 'stopped' });
    let read!: (issue: TrackedIssue | null) => void;
    vi.spyOn(s.backend, 'readIssue').mockImplementationOnce(() => new Promise((resolve) => { read = resolve; }));
    (s as unknown as { reattachSession(a: unknown): void }).reattachSession(other());
    s.clearTask(other());
    await swarm.assign('a2', 67);
    read(null);
    await flush();
    expect(other()).toMatchObject({ status: 'working', issueNumber: 67, lastError: null });
    expect(starts).toHaveBeenCalledOnce();
  });

  it.each([true, false])('repairs duplicate sessions, preferring a linked PR then the older start (PR: %s)', async (linkedPr) => {
    Object.assign(dev(), { status: 'working', task: 'issue', issueNumber: 66, startedAt: 100, prNumber: null });
    Object.assign(other(), { status: 'working', task: 'issue', issueNumber: 66, startedAt: 200, prNumber: linkedPr ? 13 : null });
    const loser = linkedPr ? dev() : other();
    const keeper = linkedPr ? other() : dev();
    const stop = vi.fn();
    const rt = s.agentRt.get(String(loser.id))!;
    Object.assign(rt, { session: { stop, send: vi.fn() }, generation: 1 });
    const feed = vi.spyOn(s, 'postMessage');
    const repair = s as unknown as { repairDuplicateIssues(): void };
    repair.repairDuplicateIssues();
    repair.repairDuplicateIssues();
    expect(keeper.status).toBe('working');
    expect(loser).toMatchObject({ status: 'idle', task: null, issueNumber: null });
    expect(stop).toHaveBeenCalledOnce();
    expect(feed).toHaveBeenCalledWith('office', expect.stringContaining('duplicate session on #66'));
    expect(starts).not.toHaveBeenCalled();
  });
});

describe('PR fixes with an occupied author branch', () => {
  it.each([false, true])('prepares the PR branch and explicitly pushes HEAD (recorded developer: %s)', async (recordedDeveloper) => {
    Object.assign(repo, { links: [] });
    const dev = s.state.agents[0];
    const headRef = 'swarm/issue-120-barbara';
    s.repoRt.get(repo.id)!.pulls = [{ number: 204, headRefName: headRef, title: 'Fix recovery', url: '' } as PullInfo];
    const rec = { repoId: repo.id, prNumber: 204, devAgentId: recordedDeveloper ? 'a1' : 'barbara', devSessionId: null, round: 2, checks: [], status: 'failed' } as unknown as QaRec;
    s.state.qa.push(rec);
    const prepare = vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
    const start = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});

    await s.runFix(dev, repo, rec);

    const localBranch = prepare.mock.calls[0][3];
    expect(localBranch).toBe(headRef);
    expect(start).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0][2]).toEqual({ pr: 204 });
    expect(start.mock.calls[0][4]).toContain(`git push origin HEAD:${headRef}`);
    expect(dev.branch).toBe(headRef);
    Object.assign(dev, { sessionId: 'fix-session', status: 'stopped' });
    await swarm.message('a1', 'Continue fixing');
    expect(start.mock.calls[1][4]).toContain(`git push origin HEAD:${headRef}`);
  });
});

describe('desk reset and the CLI waiting at the prompt', () => {
  let rec: QaRec;
  let steps: string[];
  const agent = () => s.state.agents[0];
  const host = (pty: unknown): CliHost => ({
    prepare: vi.fn(), recoverTurn: () => null, hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null,
    codexThread: async () => undefined, removeDir: vi.fn(), reconnect: async () => [], adopt: () => pty as never,
    discard: vi.fn(), hooksReady: vi.fn(), leave: vi.fn(), protect: () => ({ pids: [], markers: [] }),
  });

  /** A CLI waiting at a1's prompt on the office's machine; it exits only on exit(). */
  async function waiting(resumeId: string, cli: NonNullable<SessionOptions['cli']> = 'claude', model = 'claude-opus-5-5') {
    const exits: ((code: number) => void)[] = [];
    const pty = {
      pid: 7, write: vi.fn(), resize: vi.fn(), setMeta: vi.fn(), onData: vi.fn(),
      kill: vi.fn(() => steps.push('kill')), onExit: vi.fn((fn: (code: number) => void) => exits.push(fn)),
    };
    const h = { ...host(pty), reconnect: async () => [{ id: 'held', pid: 7, exit: null, meta: { agentId: 'a1', cli, model, token: `t-${resumeId}`, dir: 'sessions/t', resumeId, busy: false } }] };
    const term = { cols: 100, rows: 30, note: vi.fn(), bind: vi.fn(), write: vi.fn(), screen: () => '❯', releaseIdle: null, closing: null } as unknown as AgentTerminal;
    await reconnectClis(() => term, h);
    Object.assign(s.agentRt.get('a1')!, { terminal: term });
    Object.assign(s.backend, { terminals: true, cliHost: h });
    return { term, pty, exit: () => (steps.push('exited'), exits.forEach((fn) => fn(0))) };
  }

  beforeEach(() => {
    steps = [];
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    Object.assign(agent(), { model: '', effort: '', cli: 'claude', deskBox: '' });
    (s as unknown as { state: { settings: { runtime: string } } }).state.settings.runtime = 'terminal';
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready', pulls: [{ number: 204, headRefName: 'swarm/issue-9-ada', headSha: 'sha-1', closesIssues: [] } as unknown as PullInfo] });
    rec = { repoId: repo.id, prNumber: 204, devAgentId: 'a1', devSessionId: 'conv-a', devSessionCli: 'claude', qaAgentId: 'q1', sessionFailures: 0, round: 1,
      status: 'failed', summary: 'Fix it', checks: [], fixCrashes: [] } as unknown as QaRec;
    s.state.qa.push(rec);
    vi.spyOn(s.backend, 'releaseDesk').mockImplementation(async () => void steps.push('releaseDesk'));
    vi.spyOn(s.backend, 'prepareDesk').mockImplementation(async () => (steps.push('prepareDesk'), 'demo-worktree'));
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ number: 204, state: 'OPEN', headSha: 'sha-1', closesIssues: [], body: '', title: 'Fix it', url: '' } as never);
    vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
  });

  it('waits for a CLI that Clear desk closed before new work resets the desk', async () => {
    const cli = await waiting('conv-a');
    swarm.resetAgent('a1');
    expect(cli.term.releaseIdle).toBeNull(); // nothing left to close: only the pending exit tells
    const task = s.runQa(agent(), repo, rec);
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual(['kill']);
    cli.exit();
    await task;
    expect(steps).toEqual(['kill', 'exited', 'releaseDesk', 'prepareDesk']);
    expect(cli.term.closing).toBeNull();
  });

  it("closes an author's waiting CLI on another conversation, and waits for it, before their fix round resets the desk", async () => {
    const cli = await waiting('conv-b');
    const task = s.runFix(agent(), repo, rec);
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual(['kill']);
    cli.exit();
    await task;
    expect(steps).toEqual(['kill', 'exited', 'releaseDesk', 'prepareDesk']);
  });

  it("keeps the author's waiting CLI open for the fix round that resumes its conversation", async () => {
    const cli = await waiting('conv-a');
    const task = s.runFix(agent(), repo, rec);
    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(steps).toEqual(['releaseDesk', 'prepareDesk']);
    expect(cli.pty.kill).not.toHaveBeenCalled();
    expect(cli.term.releaseIdle).toEqual(expect.any(Function));
    expect(vi.mocked(s.startAgentSession).mock.calls[0][5]).toBe('conv-a');
  });

  it.each([
    ['opencode', 'openrouter/z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash-1017'],
    ['claude', 'sonnet', 'opus'],
    ['codex', 'gpt-6-sol', 'gpt-6-astra'],
  ] as const)('closes an idle %s terminal when its Settings override changes before a fix', async (kind, oldModel, model) => {
    Object.assign(rec, { devSessionCli: kind });
    swarm.updateAgent('a1', { cli: kind, model });
    const cli = await waiting('conv-a', kind, oldModel);
    const task = s.runFix(agent(), repo, rec);
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual(['kill']);
    cli.exit();
    await task;
    expect(steps).toEqual(['kill', 'exited', 'releaseDesk', 'prepareDesk']);
    expect(vi.mocked(s.startAgentSession).mock.calls[0][5]).toBe('conv-a');
  });

  it('closes the same conversation when the fix round would start it on another machine', async () => {
    const cli = await waiting('conv-a');
    Object.assign(s.backend, { cliHost: host({}) });
    const task = s.runFix(agent(), repo, rec);
    await vi.advanceTimersByTimeAsync(1000);
    expect(steps).toEqual(['kill']);
    cli.exit();
    await task;
    expect(steps).toEqual(['kill', 'exited', 'releaseDesk', 'prepareDesk']);
  });
});

describe('PR desk preparation recovery', () => {
  let rec: QaRec;
  beforeEach(() => {
    Object.assign(repo, { links: [] });
    Object.assign(s.state.agents[0], { model: '', effort: '', cli: '' });
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready', pulls: [{ number: 204, headRefName: 'feature', headSha: 'sha-1', closesIssues: [] } as unknown as PullInfo] });
    rec = { repoId: repo.id, prNumber: 204, devAgentId: 'a1', qaAgentId: 'q1', sessionFailures: 0, round: 2,
      status: 'failed', summary: 'Keep findings', checks: [{ name: 'Bug', result: 'fail', details: 'Fix it' }], fixCrashes: [] } as unknown as QaRec;
    s.state.qa.push(rec);
    vi.spyOn(s.backend, 'prepareDesk').mockRejectedValue(new Error('Desk locked'));
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ number: 204, state: 'OPEN', headSha: 'sha-1', closesIssues: [], body: '', title: 'Keep findings', url: '' } as never);
    vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
  });

  it.each(['prepareDesk', 'releaseDesk'] as const)('aborts a hung %s, frees QA and counts strikes without accepting late results', async (method) => {
    let finish!: (dir?: string) => void;
    let signal: AbortSignal | undefined;
    vi.spyOn(s.backend, method).mockImplementation(() => {
      signal ??= operationSignal();
      return new Promise<string>((resolve) => { finish = resolve as typeof finish; });
    });
    const agent = s.state.agents[0];
    const task = s.runQa(agent, repo, rec);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(agent.status).toBe('preparing');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await task;
    expect(signal?.aborted).toBe(true);
    expect(agent).toMatchObject({ status: 'idle', task: null, sessionId: null, lastError: expect.stringContaining('Session never started on office: desk preparation') });
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, sessionFailures: 0, summary: 'Keep findings', preparation: { qa: { failures: 1, holds: 0 } } });
    finish('late-desk');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.startAgentSession).not.toHaveBeenCalled();
    expect(agent.status).toBe('idle');
  });

  it.each(['qa', 'fix'] as const)('frees a %s CLI that never starts, preserving findings and ignoring its late callbacks', async (task) => {
    vi.mocked(s.startAgentSession).mockRestore();
    vi.mocked(s.backend.prepareDesk).mockResolvedValue('demo-worktree');
    const stop = vi.fn();
    const start = vi.spyOn(s.backend, 'startSession').mockReturnValue({ stop, send: vi.fn() });
    const agent = s.state.agents[0];
    if (task === 'fix') {
      rec.devAgentId = 'author';
      s.state.agents.push({ id: 'author', name: 'Author', repoId: repo.id, role: 'dev', status: 'stopped' });
    }
    if (task === 'qa') await s.runQa(agent, repo, rec);
    else await s.runFix(agent, repo, rec);
    expect(agent.status).toBe('working');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stop).toHaveBeenCalledOnce();
    expect(agent).toMatchObject({ status: 'error', task: null, sessionId: null });
    expect(rec).toMatchObject({ status: task === 'qa' ? 'queued' : 'failed', summary: 'Keep findings' });
    expect(agent).toMatchObject({ startupFailed: true, startupRetry: { failures: 1, retryAt: expect.any(Number) } });
    const callbacks = start.mock.calls[0][1];
    callbacks.sessionId('late-thread');
    callbacks.log([{ kind: 'text', text: 'late output' }]);
    callbacks.finished({ ok: true, text: '', errors: [], costUsd: 0, turns: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent).toMatchObject({ status: 'error', task: null, sessionId: null, turns: 0 });
    expect(s.agentRt.get('a1')!.log).not.toContainEqual(expect.objectContaining({ text: 'late output' }));
  });

  it.each(['session', 'log', 'terminal'] as const)('keeps a real startup alive on recent %s activity', async (activity) => {
    vi.mocked(s.startAgentSession).mockRestore();
    vi.mocked(s.backend.prepareDesk).mockResolvedValue('demo-worktree');
    const stop = vi.fn();
    const start = vi.spyOn(s.backend, 'startSession').mockReturnValue({ stop, send: vi.fn() });
    const agent = s.state.agents[0];
    await s.runQa(agent, repo, rec);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    if (activity === 'session') start.mock.calls[0][1].sessionId('running-thread');
    else if (activity === 'log') start.mock.calls[0][1].log([{ kind: 'text', text: 'Working' }]);
    else Object.assign(s.agentRt.get('a1')!, { terminal: { lastOutputAt: Date.now() } });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(agent.status).toBe('working');
    expect(rec.status).toBe('testing');
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(['fix', 'qa'] as const)('releases failed %s desks, preserves findings and holds repeated failures', async (task) => {
    const messages = vi.spyOn(s, 'postMessage').mockImplementation(() => {});
    const events = vi.spyOn(s, 'broadcast');
    const agent = s.state.agents[0];
    if (task === 'fix') {
      const author = { id: 'author', repoId: repo.id, role: 'dev', name: 'Author', status: 'stopped' };
      s.state.agents.push(author);
      rec.devAgentId = 'author';
    }
    const owner = rec.devAgentId;
    const run = () => task === 'fix' ? s.runFix(agent, repo, rec) : s.runQa(agent, repo, rec);
    for (let attempt = 0; attempt < 4; attempt++) {
      await run();
      expect(agent).toMatchObject({ status: 'idle', task: null, prNumber: null });
      expect(rec).toMatchObject({ devAgentId: owner, summary: 'Keep findings', checks: [{ name: 'Bug', result: 'fail', details: 'Fix it' }], fixCrashes: [], sessionFailures: 0 });
      if (attempt === 1) {
        expect(s.startPipelineWork(repo)).toBe(false);
        expect(messages).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      }
    }
    expect(rec.status).toBe('needs-human');
    expect(s.startPipelineWork(repo)).toBe(false);
    expect(messages).toHaveBeenCalledTimes(2);
    expect(s.startAgentSession).not.toHaveBeenCalled();
    expect(rec.preparation?.[task]).toMatchObject({ holds: 2 });
    expect(events).toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ preparation: rec.preparation }) });
  });

  it('clears preparation holds on an explicit QA handoff', async () => {
    const agent = s.state.agents[0];
    await s.runFix(agent, repo, rec);
    await s.runFix(agent, repo, rec);
    expect(rec.preparation?.fix).toBeDefined();
    s.repoRt.get(repo.id)!.pulls[0].state = 'OPEN';
    await swarm.sendToQa(repo.id, rec.prNumber);
    expect(rec.preparation).toBeUndefined();
    expect(rec.status).toBe('queued');
  });

  it('allows a changed head during a hold and clears strikes after successful preparation', async () => {
    const agent = s.state.agents[0];
    await s.runFix(agent, repo, rec);
    await s.runFix(agent, repo, rec);
    expect(s.startPipelineWork(repo)).toBe(false);
    s.repoRt.get(repo.id)!.pulls[0].headSha = 'sha-2';
    const fix = vi.spyOn(s, 'runFix').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    fix.mockRestore();
    vi.mocked(s.backend.prepareDesk).mockResolvedValue('demo-worktree');
    await s.runFix(agent, repo, rec);
    expect(rec.preparation?.fix).toBeUndefined();
  });
});

describe('issue startup watchdog', () => {
  it.each([false, true])('returns a silent issue start to its queue with auto-assign %s', async (autoAssign) => {
    repo.autoAssign = autoAssign;
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready' });
    setIssues(issue(66));
    s.runTask = (Swarm.prototype as unknown as Pick<Internals, 'runTask'>).runTask;
    vi.spyOn(s.backend, 'prepareDesk').mockReturnValue(new Promise(() => {}));
    if (autoAssign) expect(s.startIssueWork(repo)).toBe(true);
    else await swarm.assign('a1', 66, 'Keep this note');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null, issueNumber: null });
    if (autoAssign) {
      expect(repo.requestedStarts).toEqual([]);
      expect(ready()).toContain(66);
    } else expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', note: 'Keep this note', restartPending: true }]);
  });
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
    const preparing = a.status === 'preparing';
    a.status = 'stopped';
    a.endedAt = Date.now() - 120_000;
    runTask.mockClear();
    s.recover([a], preparing ? new Set([a]) : undefined);
    s.recoverDesks();
  };

  it('keeps the issue, preferred desk and manager note while auto-assign remains off', async () => {
    const events = vi.spyOn(s, 'broadcast');
    await swarm.assign('a1', 66, 'Finish the recovery fix');
    expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', note: 'Finish the recovery fix', restartPending: false }]);
    restart();
    expect(repo.requestedStarts[0].restartPending).toBe(true);
    expect(events).toHaveBeenCalledWith({ type: 'repo', repo: expect.objectContaining({ requestedStarts: repo.requestedStarts }) });
    expect(s.agentRt.get('a1')!.log).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Office interruption') })]));
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

  it.each(['closed', 'ready-for-human', 'needs-triage', 'Needs-Info', '[Draft]', 'Draft:', 'PR'] as const)('drops a requested start that now has status %s', async (status) => {
    await swarm.assign('a1', 66);
    restart();
    if (status === 'closed') setIssues(issue(67));
    if (status === 'ready-for-human') setIssues(issue(66, ['Ready-For-Human']), issue(67));
    if (status === 'needs-triage' || status === 'Needs-Info') setIssues(issue(66, [status]), issue(67));
    if (status === '[Draft]' || status === 'Draft:') setIssues({ ...issue(66), title: `${status} Foo` }, issue(67));
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
    expect(s.agentRt.get('a1')!.log).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Office interruption') })]));
  });

  it('does not start arbitrary backlog work when auto-assign is off', () => {
    s.schedule();
    expect(runTask).not.toHaveBeenCalled();
  });

  it.each(['qa', 'fix'] as const)('keeps %s tasks on the existing pipeline recovery path', (task) => {
    const a = s.state.agents[0];
    Object.assign(a, { task, status: 'stopped', issueNumber: 66, prNumber: 13, sessionId: null, branch: null, endedAt: Date.now() - 120_000 });
    s.state.qa.push({
      repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', round: 1, sessionFailures: 0,
      devAgentId: 'a1', qaAgentId: 'a1', summary: '', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
    });
    s.recover([a]);
    s.recoverDesks();
    expect(s.state.qa[0].status).toBe(task === 'qa' ? 'queued' : 'failed');
    expect(repo.requestedStarts).toEqual([]);
    expect(a).toMatchObject({ status: 'idle', task: null });
  });
});

describe('CEO connect_floor', () => {
  beforeEach(() => s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null }));

  it('creates a floor with the requested settings and reports its clone path and status', async () => {
    const events = vi.spyOn(s, 'broadcast');
    const output = await s.officeTools().call('connect_floor', {
      repo: 'demo-co/weather-api', auto_assign: true, auto_merge: false, reason: 'Add weather-api with auto-assign on and auto-merge off',
    });
    const floor = swarm.snapshot().repos.find((r) => r.fullName === 'demo-co/weather-api')!;
    expect(floor).toMatchObject({ floor: 2, autoAssign: true, autoMerge: false });
    expect(output).toContain('floor 2');
    expect(output).toContain(floor.checkoutPath);
    expect(output).toContain('clone: cloning');
    expect(output).toContain('sync: pending');
    expect(events).toHaveBeenCalledWith({ type: 'repo', repo: expect.objectContaining({ floor: 2, autoAssign: true, autoMerge: false }) });
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.objectContaining({ text: expect.stringContaining('Add weather-api with auto-assign on and auto-merge off') }) }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(swarm.snapshot().repos.find((r) => r.floor === 2)).toMatchObject({ cloneStatus: 'ready', lastSync: expect.any(Number) });
  });

  it('keeps the console defaults when automation options are omitted', async () => {
    await s.officeTools().call('connect_floor', { repo: 'demo-co/weather-api', reason: 'Add weather-api' });
    expect(swarm.snapshot().repos.find((r) => r.floor === 2)).toMatchObject({ autoAssign: false, autoMerge: true });
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('returns the existing floor number without changing its settings, regardless of casing', async () => {
    const before = swarm.snapshot().repos;
    const meta = vi.spyOn(s.backend, 'repoMeta');
    expect(await s.officeTools().call('connect_floor', {
      repo: 'Demo-Co/Pixel-Todo', auto_assign: false, auto_merge: false, reason: 'Add pixel-todo',
    })).toContain('Refused: Demo-Co/Pixel-Todo is already floor 1; settings unchanged.');
    expect(swarm.snapshot().repos).toEqual(before);
    expect(meta).not.toHaveBeenCalled();
  });

  it.each(['weather-api', 'owner/repo/extra', 'https://github.com/owner/repo', '../repo', 'owner/..', 'owner/repo name', '-owner/repo'])('refuses malformed repo %s before contacting GitHub', async (name) => {
    const meta = vi.spyOn(s.backend, 'repoMeta');
    expect(await s.officeTools().call('connect_floor', { repo: name, reason: 'Add this repo' })).toBe('Refused: Give a GitHub repo as owner/name.');
    expect(swarm.snapshot().repos).toHaveLength(1);
    expect(meta).not.toHaveBeenCalled();
  });

  it('reports GitHub access errors without creating a floor', async () => {
    vi.spyOn(s.backend, 'repoMeta').mockRejectedValue(new Error('gh: HTTP 404 repository not found or inaccessible'));
    expect(await s.officeTools().call('connect_floor', { repo: 'demo-co/private', reason: 'Add our private repo' })).toBe('Refused: gh: HTTP 404 repository not found or inaccessible');
    expect(swarm.snapshot().repos).toHaveLength(1);
  });

  it('lets the demo CEO connect a floor from a manager message', async () => {
    const finished = vi.fn();
    const handle = s.backend.startSession({
      role: 'ceo', cwd: '', prompt: 'Manager asks:\nAdd demo-co/weather-api as a new floor with auto-assign on and auto-merge off',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools(),
    }, { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('connected as floor 2') }));
    expect(swarm.snapshot().repos.find((r) => r.floor === 2)).toMatchObject({ autoAssign: true, autoMerge: false, cloneStatus: 'ready' });
    handle.stop();
  });
});

describe('CEO rerun_qa', () => {
  const rerun = (args = { floor: 1, number: 13 }) => s.officeTools().call('rerun_qa', args);
  const pull = (state: PullInfo['state'] = 'OPEN'): PullInfo => ({
    number: 13, title: 'Recovery', url: '', isCrossRepository: false, headRefName: 'swarm/13', state,
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
    backend.deskHead = async () => pull().headSha;
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

describe('QA records for PRs the sync no longer lists', () => {
  const record = (prNumber: number, status: QaRec['status']): QaRec => ({ repoId: repo.id, prNumber, issueNumber: null, status, round: 1, sessionFailures: 0,
    devAgentId: null, qaAgentId: null, summary: '', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 });
  let states: Record<number, PullInfo['state'] | Error>;

  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    Object.assign(s.repoRt.get(repo.id)!, { lastMergedAt: null });
    vi.spyOn(s.backend, 'listIssues').mockResolvedValue([]);
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    states = {};
    vi.spyOn(s.backend, 'prDetails').mockImplementation(async (_name, n) => {
      const state = states[n];
      if (state instanceof Error) throw state;
      return { number: n, title: '', body: '', url: '', headRefName: `swarm/issue-${n}-ada`, headSha: 'sha', isCrossRepository: false, closesIssues: [], state, mergeable: 'MERGEABLE', mergeState: 'CLEAN' };
    });
  });

  it('removes finished PRs and keeps open ones, failed lookups and running QA', async () => {
    s.state.qa.push(record(45, 'passed'), record(56, 'queued'), record(70, 'passed'), record(82, 'passed'), record(90, 'testing'));
    Object.assign(states, { 45: 'MERGED', 56: 'CLOSED', 70: new Error('HTTP 502'), 82: 'OPEN', 90: 'MERGED' });
    const events = vi.spyOn(s, 'broadcast');
    await swarm.syncRepo(repo.id);
    expect(s.state.qa.map((q) => q.prNumber)).toEqual([70, 82, 90]);
    expect(events).toHaveBeenCalledWith({ type: 'qaRemoved', repoId: repo.id, prNumber: 45 });
    expect(events).toHaveBeenCalledWith({ type: 'qaRemoved', repoId: repo.id, prNumber: 56 });
    expect(s.backend.prDetails).not.toHaveBeenCalledWith(repo.fullName, 90);

    // The failed lookup is retried on the next sync.
    states[70] = 'MERGED';
    await swarm.syncRepo(repo.id);
    expect(s.state.qa.map((q) => q.prNumber)).toEqual([82, 90]);
  });

  it('does not look up records whose PR is listed', async () => {
    s.state.qa.push(record(13, 'passed'));
    vi.mocked(s.backend.listPulls).mockResolvedValue({ pulls: [{
      number: 13, title: '', url: '', isCrossRepository: false, headRefName: 'swarm/issue-67-ada', state: 'OPEN', isDraft: false, closesIssues: [67], checks: 'none',
      mergeable: 'MERGEABLE', headSha: 'sha', reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
      mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
    }] });
    await swarm.syncRepo(repo.id);
    expect(s.backend.prDetails).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
  });
});

describe('CEO merge_pr', () => {
  const args = { floor: 1, number: 13, reason: 'Manager requested merge; remaining findings filed as #66' };
  let pull: PullInfo;
  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [] });
    pull = {
      number: 13, title: 'Fix recovery', url: '', isCrossRepository: false, headRefName: 'swarm/issue-67-ada', state: 'OPEN',
      isDraft: false, closesIssues: [67], checks: 'failing', mergeable: 'MERGEABLE', headSha: 'tested',
      reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
      mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
    };
    s.repoRt.get(repo.id)!.pulls = [pull];
    s.backend.prDetails = vi.fn(async () => ({ ...pull, body: '', isCrossRepository: false }));
    s.backend.listPulls = vi.fn(async () => ({ pulls: [pull] }));
    s.backend.listIssues = vi.fn(async () => []);
    vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment-url');
    vi.spyOn(s.backend, 'mergePull').mockImplementation(async (_repo, _number, _method, sha) => {
      if (sha && sha !== pull.headSha) throw new Error('Head branch was modified');
      pull.state = 'MERGED';
    });
    s.state.qa.push({ repoId: repo.id, prNumber: 13, issueNumber: 67, status: 'needs-human', round: 3, sessionFailures: 2,
      testedSha: 'tested', failedSha: 'tested', devAgentId: 'a1', qaAgentId: null, summary: 'Remaining findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0 });
    Object.assign(s.state.agents[0], { status: 'done', task: 'issue', issueNumber: 67, prNumber: 13, branch: pull.headRefName });
  });

  it('posts the reason before merging at the tested SHA and removes QA through the normal refresh', async () => {
    const events = vi.spyOn(s, 'broadcast');
    expect(await s.officeTools().call('merge_pr', args)).toContain('Merged PR #13');
    expect(s.backend.commentPull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, args.reason);
    expect(s.backend.mergePull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', 'tested');
    expect(vi.mocked(s.backend.commentPull).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.backend.mergePull).mock.invocationCallOrder[0]);
    expect(s.state.qa).toEqual([]);
    expect(events).toHaveBeenCalledWith({ type: 'qaRemoved', repoId: repo.id, prNumber: 13 });
    expect(s.state.agents[0]).toMatchObject({ task: null, prNumber: null });
    expect(s.repoRt.get(repo.id)).toMatchObject({ merging: false, parking: false });
  });

  it.each(['head', 'conflicting', 'dirty', 'closed'] as const)('refuses a freshly %s PR despite stale cache', async (condition) => {
    s.backend.prDetails = vi.fn(async () => ({ ...pull, body: '', isCrossRepository: false,
      ...(condition === 'head' ? { headSha: 'unseen' } : condition === 'conflicting' ? { mergeable: 'CONFLICTING' } :
        condition === 'dirty' ? { mergeState: 'DIRTY' } : { state: 'CLOSED' as const }),
    }));
    await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: condition === 'closed' ? 404 : 409 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
    expect(s.repoRt.get(repo.id)).toMatchObject({ merging: false, parking: false });
  });

  it.each(['testing', 'fixing', 'busy', 'live-session', 'merging', 'parking', 'syncing', 'untested'] as const)('refuses %s before GitHub work', async (condition) => {
    if (condition === 'testing' || condition === 'fixing') s.state.qa[0].status = condition;
    if (condition === 'busy') Object.assign(s.state.agents[0], { prNumber: null, status: 'preparing', task: 'fix' });
    if (condition === 'live-session') Object.assign(s.agentRt.get('a1')!, { session: {} });
    if (condition === 'merging' || condition === 'parking' || condition === 'syncing') Object.assign(s.repoRt.get(repo.id)!, { [condition]: true });
    if (condition === 'untested') s.state.qa[0].testedSha = null;
    await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: 409 });
    expect(s.backend.prDetails).not.toHaveBeenCalled();
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it.each(['checkout', 'session-start'] as const)('rejects an auto-merge branch update followed by a failed QA %s', async (failure) => {
    const { tester, rec, checkout, start, sessions } = qaSession();
    await s.runQa(tester, repo, rec);
    sessions[0].finished({ ok: true, text: '', errors: [], turns: 1, costUsd: 0, structured: {
      verdict: 'pass', summary: 'Older completed QA', checks: [],
    } });
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(pull, { checks: 'passing', hasSuccessfulChecks: true, mergeState: 'BEHIND', baseSha: 'new-base' });
    const update = vi.spyOn(s.backend, 'rebasePull').mockImplementation(async () => {
      Object.assign(pull, { headSha: 'updated-never-tested-head', mergeState: 'CLEAN' });
      return pull.headSha;
    });
    expect(await s.advanceMerge(repo, rec, pull)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(rec).toMatchObject({ status: 'passed', testedSha: 'tested', passedSha: 'tested', mergeCandidate: { headSha: pull.headSha } });
    if (failure === 'checkout') checkout.mockRejectedValue(new Error('Checkout failed'));
    else start.mockImplementation(() => { throw new Error('Runner could not start'); });
    await s.runQa(tester, repo, rec);
    expect(rec).toMatchObject({ status: 'queued', testedSha: pull.headSha, passedSha: 'tested' });
    vi.mocked(s.backend.commentPull).mockClear();
    await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: 409 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it.each(['', '  ', 'x'.repeat(1001)])('refuses an invalid reason', async (reason) => {
    await expect(swarm.mergePr({ ...args, reason })).rejects.toMatchObject({ status: 400 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it('holds the reservation across reads/comments and releases it after a failed comment', async () => {
    s.backend.commentPull = vi.fn(async () => {
      expect(s.startPipelineWork(repo)).toBe(false);
      expect(s.startIssueWork(repo)).toBe(false);
      await expect(swarm.sendToQa(repo.id, 13)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.parkPr(args)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: 409 });
      await expect(swarm.mergePull(repo.id, 13)).rejects.toMatchObject({ status: 409 });
      throw new Error('Comment failed');
    });
    await expect(swarm.mergePr(args)).rejects.toThrow('Comment failed');
    expect(s.backend.mergePull).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
    expect(s.repoRt.get(repo.id)).toMatchObject({ merging: false, parking: false });
  });

  it('never merges commits pushed after the comment and keeps QA on merge failure', async () => {
    s.backend.commentPull = vi.fn(async () => {
      pull.headSha = 'unseen';
      return 'comment-url';
    });
    await expect(swarm.mergePr(args)).rejects.toThrow('Head branch was modified');
    expect(s.backend.mergePull).toHaveBeenCalledWith(repo.fullName, 13, 'squash', 'tested');
    expect(pull.state).toBe('OPEN');
    expect(s.state.qa).toHaveLength(1);
    expect(s.repoRt.get(repo.id)).toMatchObject({ merging: false, parking: false });
  });

  it('holds a CEO merge when security review is requested while its comment is posted', async () => {
    s.backend.commentPull = vi.fn(async () => {
      pull.labels = ['ready-for-review'];
      return 'comment-url';
    });
    await expect(swarm.mergePr(args)).rejects.toThrow('requires a passing security review');
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it('preserves manager-facing merge behavior without tested QA or a CEO comment', async () => {
    s.state.qa = [];
    await swarm.mergePull(repo.id, 13, 'rebase');
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'rebase');
  });

  it.each(['needs-review', 'needs-human'])('holds manual and CEO merges when the fresh PR has %s', async (label) => {
    vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, labels: [label], body: '', isCrossRepository: false });
    await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow(`Remove ${label}`);
    await expect(swarm.mergePr(args)).rejects.toThrow(`Remove ${label}`);
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  const qaSession = () => {
    const tester = { id: 'q1', name: 'Poirot', repoId: repo.id, role: 'qa', specialty: '', status: 'idle', task: null, issueNumber: null, desk: 0, endedAt: null, model: '', effort: '', cli: '' };
    s.state.agents.push(tester);
    s.agentRt.set(tester.id, { log: [], pending: [], terminal: null, shots: [] });
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready' });
    Object.assign(repo, { browserTesting: false });
    // Keep the actual QA preparation/session lifecycle; replace only disk and runner boundaries.
    vi.spyOn(s.backend, 'releaseDesk').mockResolvedValue();
    const checkout = vi.spyOn(s.backend, 'prepareDesk').mockResolvedValue('demo-worktree');
    const sessions: SessionCallbacks[] = [];
    const start = vi.spyOn(s.backend, 'startSession').mockImplementation((_opts, cb) => {
      sessions.push(cb);
      return { stop: vi.fn(), send: vi.fn() };
    });
    const rec = s.state.qa[0];
    Object.assign(rec, { status: 'queued', testedSha: null, passedSha: null, failedSha: null, retests: 0, fixCrashes: [] });
    return { tester, rec, checkout, start, sessions };
  };

  it.each(['checkout', 'session-start'] as const)('refuses a head whose QA %s failed before any completed report', async (failure) => {
    const { tester, rec, checkout, start, sessions } = qaSession();
    pull.headSha = 'new-never-tested-head';
    if (failure === 'checkout') checkout.mockRejectedValue(new Error('Checkout failed'));
    else start.mockImplementation(() => { throw new Error('Runner could not start'); });
    await s.runQa(tester, repo, rec);
    expect(rec).toMatchObject({ status: 'queued', testedSha: pull.headSha, passedSha: null, failedSha: null });
    expect(tester).toMatchObject({ status: failure === 'checkout' ? 'idle' : 'error' });
    expect(tester).toMatchObject({ lastError: failure === 'checkout' ? null : 'Runner could not start' });
    expect(sessions).toHaveLength(0);
    if (failure === 'checkout') expect(start).not.toHaveBeenCalled();
    else expect(start).toHaveBeenCalledOnce();
    await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: 409 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it.each(['pass', 'fail'] as const)('allows a manager override backed by a completed %s report', async (verdict) => {
    const { tester, rec, sessions } = qaSession();
    await s.runQa(tester, repo, rec);
    expect(sessions).toHaveLength(1);
    sessions[0].finished({ ok: true, text: '', errors: [], turns: 1, costUsd: 0, structured: {
      verdict, summary: 'Completed QA', checks: [],
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(rec).toMatchObject({ status: verdict === 'pass' ? 'passed' : 'needs-human', [verdict === 'pass' ? 'passedSha' : 'failedSha']: pull.headSha });
    vi.mocked(s.backend.commentPull).mockClear();
    expect(await swarm.mergePr(args)).toContain('Merged PR #13');
    expect(s.backend.commentPull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, args.reason);
    expect(s.backend.mergePull).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', 'tested');
  });

  it.each([
    ['pass', 'checkout'], ['fail', 'checkout'], ['pass', 'session-start'], ['fail', 'session-start'],
  ] as const)('rejects a new head after an older completed %s report and a failed %s attempt', async (verdict, failure) => {
    const { tester, rec, checkout, start, sessions } = qaSession();
    await s.runQa(tester, repo, rec);
    sessions[0].finished({ ok: true, text: '', errors: [], turns: 1, costUsd: 0, structured: {
      verdict, summary: 'Older completed QA', checks: [],
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(rec).toMatchObject({ [verdict === 'pass' ? 'passedSha' : 'failedSha']: 'tested' });
    pull.headSha = 'new-never-tested-head';
    if (failure === 'checkout') checkout.mockRejectedValue(new Error('Checkout failed'));
    else start.mockImplementation(() => { throw new Error('Runner could not start'); });
    await s.runQa(tester, repo, rec);
    expect(rec).toMatchObject({ status: 'queued', testedSha: pull.headSha, [verdict === 'pass' ? 'passedSha' : 'failedSha']: 'tested' });
    expect(sessions).toHaveLength(1); // Only the old head ever reached a QA session.
    vi.mocked(s.backend.commentPull).mockClear();
    await expect(swarm.mergePr(args)).rejects.toMatchObject({ status: 409 });
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.mergePull).not.toHaveBeenCalled();
  });

  it('lets the demo CEO merge from an explicit manager message', async () => {
    const finished = vi.fn();
    const handle = createDemoBackend().startSession({ role: 'ceo', cwd: '', prompt: `Manager asks:\nmerge PR #13 on floor 1 with ${args.reason}`,
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
      { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('Merged PR #13') }));
    expect(s.backend.commentPull).toHaveBeenCalledWith(repo.fullName, 13, args.reason);
    handle.stop();
  });
});

describe('CEO park_pr', () => {
  const args = { floor: 1, number: 13, reason: 'Placeholder waits on #66' };
  let pull: PullInfo;
  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    setIssues(issue(66), { ...issue(67), nativeBlockers: [{ number: 66, state: 'OPEN' }] });
    pull = {
      number: 13, title: 'Blocker record', url: '', isCrossRepository: false, headRefName: 'swarm/issue-67-ada', state: 'OPEN',
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

  it('stops a tester stuck starting before parking, and says so', async () => {
    const stop = vi.fn();
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'q1' });
    const tester = { id: 'q1', name: 'Grace', repoId: repo.id, role: 'qa', task: 'qa', prNumber: 13, status: 'working', sessionId: null, startedAt: Date.now() - 11 * 60_000 };
    s.state.agents.push(tester);
    s.agentRt.set('q1', { log: [], pending: [], terminal: null });
    Object.assign(s.agentRt.get('q1')!, { session: { stop } });
    expect(await s.officeTools().call('park_pr', args)).toContain("Stopped Grace's stuck starting task");
    expect(stop).toHaveBeenCalledOnce();
    expect(tester).toMatchObject({ status: 'error', task: null });
    expect(pull.state).toBe('CLOSED');
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

  it('writes gate dependencies before releasing an auto-assign issue to a free developer', async () => {
    setIssues(issue(66, ['ready-for-human']), issue(67, [], 'Keep the brief'), issue(68, [], 'Depends on #67'), issue(69, [], 'Depends on #68'));
    let edited = false;
    const edit = vi.spyOn(s.backend, 'editIssue').mockImplementation(async () => {
      expect(s.startIssueWork(repo)).toBe(false);
      expect(pull.state).toBe('OPEN');
      expect(s.state.qa).toHaveLength(1);
      edited = true;
    });
    vi.mocked(s.backend.closePull).mockImplementation(async () => {
      expect(edited).toBe(true);
      expect(s.repoRt.get(repo.id)!.issues.find((i) => i.number === 67)?.body).toBe('Depends on #66\n\nKeep the brief');
      expect(s.startIssueWork(repo)).toBe(false);
    });
    expect(await s.officeTools().call('park_pr', { ...args, depends_on: [66] })).toContain('is parked');
    expect(edit).toHaveBeenCalledExactlyOnceWith(repo.fullName, 67, { body: 'Depends on #66\n\nKeep the brief' });
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', issueNumber: null });
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
    const parked = JSON.parse(s.companyStatus()).floors[0].backlog.find((i: { number: number }) => i.number === 67);
    expect(parked).toMatchObject({ waitsFor: [66] });
    expect(parked.inProgress).toBeUndefined();
  });

  it('routes a backlog issue behind a human gate while refusing the equivalent ordinary chain', async () => {
    s.state.qa = [];
    s.repoRt.get(repo.id)!.pulls = [];
    Object.assign(s.state.agents[0], { status: 'idle', task: null, issueNumber: null, prNumber: null, branch: null });
    setIssues(issue(66), issue(67), issue(68, [], 'Depends on #67'), issue(69, [], 'Depends on #68'));
    const edit = vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 67, depends_on: [66] })).toContain('3 steps deep');
    expect(edit).not.toHaveBeenCalled();
    s.repoRt.get(repo.id)!.issues[0].labels = ['ready-for-human'];
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 67, depends_on: [66] })).toContain('depends on #66');
    expect(edit).toHaveBeenCalledWith(repo.fullName, 67, expect.objectContaining({ body: 'Depends on #66' }));
  });

  it('refuses invalid parking dependencies before editing or closing anything', async () => {
    const edit = vi.spyOn(s.backend, 'editIssue');
    expect(await s.officeTools().call('park_pr', { ...args, depends_on: [67] })).toContain("can't depend on itself");
    expect(edit).not.toHaveBeenCalled();
    expect(s.backend.commentPull).not.toHaveBeenCalled();
    expect(s.backend.closePull).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
  });

  it('refuses parking with an ordinary dependency that would make a three-step chain', async () => {
    setIssues(issue(66), issue(67), issue(68, [], 'Depends on #67'), issue(69, [], 'Depends on #68'));
    const edit = vi.spyOn(s.backend, 'editIssue');
    await expect(swarm.parkPr({ ...args, depends_on: [66] })).rejects.toThrow('3 steps deep');
    expect(edit).not.toHaveBeenCalled();
    expect(s.backend.closePull).not.toHaveBeenCalled();
  });

  it('keeps saved dependencies and the PR assignment if closing fails', async () => {
    setIssues(issue(66, ['ready-for-human']), issue(67));
    vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    vi.mocked(s.backend.closePull).mockRejectedValueOnce(new Error('Close failed'));
    await expect(swarm.parkPr({ ...args, depends_on: [66] })).rejects.toThrow('Close failed');
    expect(s.repoRt.get(repo.id)!.issues[1].body).toBe('Depends on #66');
    expect(pull.state).toBe('OPEN');
    expect(s.state.agents[0].issueNumber).toBe(67);
    await swarm.parkPr({ ...args, depends_on: [66] });
    expect(s.startIssueWork(repo)).toBe(false);
  });

  it('keeps the PR and assignment when saving the dependencies fails', async () => {
    vi.spyOn(s.backend, 'editIssue').mockRejectedValue(new Error('Edit failed'));
    await expect(swarm.parkPr({ ...args, depends_on: [66] })).rejects.toThrow('Edit failed');
    expect(pull.state).toBe('OPEN');
    expect(s.backend.closePull).not.toHaveBeenCalled();
    expect(s.state.qa).toHaveLength(1);
    expect(s.state.agents[0].issueNumber).toBe(67);
    expect(s.repoRt.get(repo.id)).toMatchObject({ parking: false });
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
    Object.assign(s.state.agents[0], { status: 'preparing' }); // what the mocked beginTask would set
    // Restore the real implementation replaced by the scheduling fixture.
    const actual = new Swarm(s.backend) as unknown as Internals;
    await actual.runTask.call(s, s.state.agents[0], restored, issue(67));
    expect(session.mock.calls[0][3]).toContain('reuse work from remote branch swarm/issue-67-ada');
    expect(s.repoView(restored)).toMatchObject({ parkedBranches: repo.parkedBranches });
  });

  it('lets the demo CEO park with dependencies from a manager message', async () => {
    const edit = vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    const finished = vi.fn();
    const handle = createDemoBackend().startSession({ role: 'ceo', cwd: '', prompt: 'Manager asks:\nPark PR #13 on floor 1 because Placeholder waits on #66; depends on #66',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
    { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('is parked') }));
    expect(s.state.qa).toEqual([]);
    expect(edit).toHaveBeenCalledWith(repo.fullName, 67, { body: 'Depends on #66' });
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
      number: 13, title: 'Recovery', url: '', isCrossRepository: false, headRefName: 'swarm/13', state: 'OPEN',
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

  it.each(['preparing', 'working'] as const)('stops QA stuck %s, reports it in status and sends the PR to a developer', async (status) => {
    vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    const stop = vi.fn();
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'q1' });
    const tester = { id: 'q1', name: 'Grace', repoId: repo.id, role: 'qa', task: 'qa', prNumber: 13, status, sessionId: null, startedAt: Date.now() - 16 * 60_000, deskBox: '' };
    s.state.agents.push(tester);
    s.agentRt.set('q1', { log: [], pending: [], terminal: null });
    Object.assign(s.agentRt.get('q1')!, { session: { stop } });
    expect(JSON.parse(s.companyStatus()).floors[0].team.find((a: { id: string }) => a.id === 'q1').doing).toBe('stuck starting (16m, office)');
    expect(await send()).toContain("Stopped Grace's stuck starting task");
    expect(stop).toHaveBeenCalledOnce();
    expect(tester).toMatchObject({ status: status === 'working' ? 'error' : 'idle', task: null });
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', devAgentId: 'a1', qaAgentId: null, summary: 'Recovery loses work' });
    expect(s.startPipelineWork(repo)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.agents[0]).toMatchObject({ task: 'fix', prNumber: 13 });
  });

  it.each(['session', 'output'] as const)('refuses to stop a tester with a live %s', async (activity) => {
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: 'a1' });
    Object.assign(s.state.agents[0], { status: 'working', task: 'qa', prNumber: 13, startedAt: Date.now() - 60 * 60_000, sessionId: activity === 'session' ? 'live' : null });
    if (activity === 'output') s.agentRt.get('a1')!.log.push({ t: Date.now() - 1000 });
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
    expect(s.state.agents[0].status).toBe('working');
    expect(s.state.qa[0].status).toBe('testing');
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

  it('clears preparation holds on a CEO fix handoff', async () => {
    s.state.qa[0].preparation = { fix: { headSha: pull.headSha, failures: 0, holds: 2, holdUntil: Date.now() + 600_000 } };
    await send();
    expect(s.state.qa[0].preparation).toBeUndefined();
    expect(s.state.qa[0].status).toBe('failed');
  });

  it('waits for an author still working on the PR branch before accepting a CEO handoff', async () => {
    Object.assign(s.state.agents[0], { status: 'working', task: 'issue', prNumber: null, branch: pull.headRefName });
    await expect(swarm.sendBackToDev({ floor: 1, number: 13 })).rejects.toMatchObject({ status: 409 });
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
    await s.onFixFinished(dev, repo, { ok: true, text: '', errors: [], costUsd: 0, turns: 0 });
    expect(s.state.qa[0]).toMatchObject({ status: 'queued', round: 4, retests: 3 });
    const tester = { id: 'q1', name: 'Grace', repoId: repo.id, role: 'qa', task: 'qa', status: 'working', prNumber: 13 };
    s.state.agents.push(tester);
    Object.assign(s.state.qa[0], { status: 'testing', qaAgentId: tester.id, testedSha: (await s.backend.prDetails(repo.fullName, 13)).headSha });
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

describe('issue baseline admission', () => {
  it.each(['handover', 'stop', 'hold'] as const)('does not launch after %s while reading the baseline', async (action) => {
    Object.assign(repo, { defaultBranch: 'main', links: [] });
    const dev = s.state.agents[0];
    Object.assign(dev, { task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', model: '', effort: '', cli: '' });
    let read!: (head: string) => void;
    vi.spyOn(s.backend, 'deskHead').mockReturnValue(new Promise<string>((resolve) => { read = resolve; }));
    const launch = vi.spyOn(s.backend, 'startSession');
    const starting = s.startAgentSession(dev, repo, '/desk', 'Please resolve issue #66', '');
    expect(dev.status).toBe('working');
    if (action === 'handover') (s as unknown as { officeUpdate: { handedOver: boolean } }).officeUpdate.handedOver = true;
    if (action === 'stop') swarm.stopAgent('a1');
    if (action === 'hold') (s.state as unknown as { officeHeld: boolean }).officeHeld = true;
    read('base');
    await starting;
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('native parent issues', () => {
  it('never auto-starts a parent, but manual starts warn', async () => {
    setIssues({ ...issue(49), subIssues: { total: 8, completed: 8 } });
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    const status = JSON.parse(s.companyStatus());
    expect(status.floors[0].capacity.issuesReadyToStart).toBe(0);
    expect(status.floors[0].backlog[0].parent).toBe('8/8 sub-issues done');
    const result = await swarm.assign('a1', 49);
    expect(result.warning).toContain('parent: 8/8');
    expect(runTask).toHaveBeenCalledOnce();
    s.clearTask(s.state.agents[0]);
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 49 })).toContain('Warning: parent: 8/8');
  });

  it('preserves a parent through failed and incomplete summary queries; new unread issues wait', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = issue(49);
    const query = vi.fn().mockResolvedValue([raw]);
    const blockedBy = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const api = vi.fn().mockResolvedValueOnce({ data: { repository: { i49: { blockedBy, subIssuesSummary: { total: 8, completed: 8 } } } } }).mockRejectedValueOnce(new Error('network')).mockResolvedValue({ data: { repository: { i49: { blockedBy }, i50: { blockedBy } } } });
    setIssues(...await listIssues(repo.fullName, query, api));
    expect(api.mock.calls[0][0].join(' ')).toContain('subIssuesSummary { total completed }');
    query.mockResolvedValue([raw, issue(50)]);
    for (let n = 0; n < 2; n++) {
      setIssues(...await listIssues(repo.fullName, query, api));
      expect(s.repoRt.get(repo.id)!.issues[0].subIssues).toEqual({ total: 8, completed: 8 });
      expect(s.repoRt.get(repo.id)!.issues[1].subIssues).toBeNull();
      expect(ready()).toEqual([]);
      expect(s.startIssueWork(repo)).toBe(false);
    }
  });

  it('still reads parent summaries when native blockers are explicitly unsupported', async () => {
    const raw = issue(49);
    const query = vi.fn().mockResolvedValue([raw]);
    const api = vi.fn().mockRejectedValueOnce([{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }]).mockResolvedValue({ data: { repository: { i49: { subIssuesSummary: { total: 8, completed: 8 } } } } });
    setIssues(...await listIssues(repo.fullName, query, api));
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[1][0].join(' ')).not.toContain('blockedBy');
    expect(ready()).toEqual([]);
    expect(s.repoRt.get(repo.id)!.issues[0].nativeBlockers).toBeUndefined();
    expect(s.repoRt.get(repo.id)!.issues[0].subIssues).toEqual({ total: 8, completed: 8 });
  });

  it('reads only new owner comments as reset markers, retaining markers through query failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([issue(49)]);
    const node = {
      blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      subIssuesSummary: { total: 0, completed: 0 },
      comments: { nodes: [
        { author: { login: 'DEMO-CO' }, createdAt: '2026-10-08T01:00:00Z' },
        { author: { login: 'developer' }, createdAt: '2026-10-08T02:00:00Z' },
        { author: null, createdAt: '2026-10-08T03:00:00Z' },
      ] },
    };
    const api = vi.fn().mockResolvedValueOnce({ data: { repository: { i49: node } } }).mockRejectedValue(new Error('network'));
    const first = await listIssues(repo.fullName, query, api);
    expect(first[0].ownerCommentAt).toBe('2026-10-08T01:00:00Z');
    expect((await listIssues(repo.fullName, query, api))[0].ownerCommentAt).toBe(first[0].ownerCommentAt);
  });

  it('demo supplies a parent that stays out of ready capacity', async () => {
    setIssues(...await s.backend.listIssues(repo.fullName));
    const parent = s.repoRt.get(repo.id)!.issues.find((i) => i.title === 'Sharing plan');
    expect(parent).toBeDefined();
    expect(ready()).not.toContain(parent!.number);
    expect(JSON.parse(s.companyStatus()).floors[0].backlog.find((i: { number: number }) => i.number === parent!.number).parent).toBe('2/4 sub-issues done');
  });

  it('demo closes its finished parent as completed on a sync and keeps the partly done one', async () => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    vi.spyOn(swarm as unknown as { syncFolder(): Promise<void> }, 'syncFolder').mockResolvedValue();
    await swarm.syncRepo(repo.id);
    const issues = s.repoRt.get(repo.id)!.issues;
    expect(issues.find((i) => i.title === 'Sharing plan')?.subIssues).toEqual({ total: 4, completed: 2 });
    expect(issues.some((i) => i.subIssues?.total && i.subIssues.completed === i.subIssues.total)).toBe(false);
    expect(await s.backend.findIssuesByMarker(repo.fullName, 'the office closes this parent', ''))
      .toEqual([expect.objectContaining({ title: 'Todo release plan', state: 'CLOSED', stateReason: 'completed' })]);
  });
});

describe('finished parent issues', () => {
  const parent = (number: number, total: number, completed: number, labels: string[] = []): IssueInfo => ({ ...issue(number, labels), subIssues: { total, completed } });
  let listed: IssueInfo[];

  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    Object.assign(s.repoRt.get(repo.id)!, { lastMergedAt: null });
    listed = [parent(10, 6, 6), parent(11, 4, 2), parent(12, 2, 2, ['ready-for-human'])];
    vi.spyOn(s.backend, 'listIssues').mockImplementation(async () => listed);
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    vi.spyOn(s.backend, 'closeIssue').mockImplementation(async (_name, n) => void (listed = listed.filter((i) => i.number !== n)));
  });

  it('closes them as completed once, with a comment, toast and office message, until a reopened count changes', async () => {
    const events = vi.spyOn(s, 'broadcast');
    const messages = vi.spyOn(s, 'postMessage');
    await swarm.syncRepo(repo.id);
    for (const [n, total] of [[10, 6], [12, 2]]) {
      expect(s.backend.closeIssue).toHaveBeenCalledWith(repo.fullName, n, 'completed', `All ${total} sub-issues are done; closed by the office.\n\n${AGENT_COMMENT_MARKER}`);
    }
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(2);
    expect(s.repoRt.get(repo.id)!.issues.map((i) => i.number)).toEqual([11]);
    expect(events).toHaveBeenCalledWith({ type: 'toast', level: 'success', text: `Closed #10 on ${repo.fullName}: all 6 sub-issues are done.` });
    expect(messages).toHaveBeenCalledWith('office', expect.stringContaining(`Closed #10 "Issue 10" on ${repo.fullName} as completed`));

    listed = [parent(10, 6, 6), parent(11, 4, 2)]; // the manager reopens #10
    await swarm.syncRepo(repo.id);
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(2);
    listed = [parent(10, 7, 6), parent(11, 4, 2)];
    await swarm.syncRepo(repo.id);
    listed = [parent(10, 7, 7), parent(11, 4, 2)];
    await swarm.syncRepo(repo.id);
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(3);
    expect(s.backend.closeIssue).toHaveBeenLastCalledWith(repo.fullName, 10, 'completed', expect.stringContaining('All 7 sub-issues'));
  });

  it('leaves them open while a PR closes them or a session works on them', async () => {
    vi.mocked(s.backend.listPulls).mockResolvedValue({ pulls: [{
      number: 13, title: '', url: '', isCrossRepository: false, headRefName: 'feature', state: 'OPEN', isDraft: false, closesIssues: [10], checks: 'none',
      mergeable: 'MERGEABLE', headSha: 'sha', reviewDecision: null, createdAt: '', mergedAt: null, additions: 0, deletions: 0,
      mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
    }] });
    Object.assign(s.state.agents[0], { status: 'working', task: 'issue', issueNumber: 12 });
    await swarm.syncRepo(repo.id);
    expect(s.backend.closeIssue).not.toHaveBeenCalled();
  });

  it('reports a failed close once', async () => {
    vi.mocked(s.backend.closeIssue).mockRejectedValue(new Error('HTTP 403'));
    const messages = vi.spyOn(s, 'postMessage');
    await swarm.syncRepo(repo.id);
    await swarm.syncRepo(repo.id);
    expect(s.backend.closeIssue).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledWith('office', expect.stringContaining('closing it failed: HTTP 403'));
    expect(s.repoRt.get(repo.id)!.issues.map((i) => i.number)).toEqual([10, 11, 12]);
  });
});

describe('native issue dependencies', () => {
  const nativeAnswer = (args: string[]) => ({ data: { repository: Object.fromEntries([...args[3].matchAll(/i(\d+): issue/g)].map((m) => [`i${m[1]}`, {
    ...(args[3].includes('subIssuesSummary') && { subIssuesSummary: { total: 0, completed: 0 } }), comments: { nodes: [] },
  }])) } });

  it.each(['fresh', 'unsupported', 'cached'])('fails closed through a real failed JSON command after %s dependency reads', async (previous) => {
    vi.useRealTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([issue(2)]);
    const denied = 'Resource not accessible by personal access token (repository.i3.blockedBy)';
    const blockedBy = {
      nodes: [{ number: 1, state: 'OPEN', repository: { nameWithOwner: repo.fullName } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    const response = { data: { repository: { i2: { blockedBy, subIssuesSummary: { total: 0, completed: 0 } }, i3: { blockedBy: null } } },
      errors: [{ message: 'Resource not accessible by personal access token', path: ['repository', 'i3', 'blockedBy'] }] };
    const stderr = `gh: GraphQL: ${denied}\n`;
    const command = () => run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`]);
    const api = vi.fn<NonNullable<Parameters<typeof listIssues>[2]>>((args) => ghJson(args, undefined, command));
    if (previous === 'unsupported') api.mockRejectedValueOnce(new CommandError(stderr, stderr, 1));
    if (previous === 'cached') api.mockResolvedValueOnce({ data: { repository: { i2: { blockedBy, subIssuesSummary: { total: 0, completed: 0 } } } } });
    if (previous !== 'fresh') await listIssues(repo.fullName, query, api);
    query.mockResolvedValue([issue(2), issue(3)]);
    const issues = await listIssues(repo.fullName, query, api);
    expect(issues[0].nativeBlockers).toEqual(previous === 'cached' ? [{ number: 1, state: 'OPEN' }] : null);
    expect(issues[1].nativeBlockers).toBeNull();
    expect(issues.every((i) => i.nativeBlockers !== undefined)).toBe(true);
    setIssues(...issues);
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  });

  it.each([
    ["Field 'blockedBy' doesn't exist on type 'Issue'", '\n'],
    ["Field 'blockedBy' doesn't exist on type 'Issue'", '\r\n'],
    ['Resource not accessible by personal access token (repository.i2.blockedBy)', '\n'],
    ['Resource not accessible by personal access token (repository.i2.blockedBy)', '\r\n'],
  ])('schedules body dependencies after newline-terminated unsupported diagnostics: %s %j', async (diagnostic, ending) => {
    vi.useRealTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([issue(1), issue(2, [], 'Depends on #1'), issue(3)]);
    const stderr = `gh: GraphQL: ${diagnostic}${ending}`;
    const stdout = JSON.stringify({ errors: [{ message: diagnostic.split(' (')[0], path: ['repository', 'i2', 'blockedBy'] }] });
    const command = () => run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`]);
    const api = vi.fn((args: string[]) => args[3].includes('blockedBy') ? ghJson(args, undefined, command) : Promise.resolve(nativeAnswer(args)));
    const issues = await listIssues(repo.fullName, query, api);
    expect(api).toHaveBeenCalledTimes(2); // the retry without blockedBy still reads the sub-issue summaries
    expect(issues.every((i) => i.nativeBlockers === undefined && i.subIssues?.total === 0)).toBe(true);
    setIssues({ ...issues[0], labels: ['ready-for-human'] }, ...issues.slice(1));
    expect(ready()).toEqual([3]);
    setIssues(...issues.slice(1));
    expect(ready()).toEqual([2, 3]);
    const mixed = `${stderr}network unavailable${ending}`;
    setIssues(...await listIssues(repo.fullName, query, vi.fn().mockRejectedValue(new CommandError(mixed, mixed, 1))));
    expect(s.repoRt.get(repo.id)!.issues.every((i) => i.nativeBlockers === null)).toBe(true);
    expect(ready()).toEqual([]);
  });

  it.each([
    "Field 'blockedBy' doesn't exist on type 'Issue', Field 'subIssuesSummary' doesn't exist on type 'Issue'",
    "Cannot query field 'subIssuesSummary' on type 'Issue', Cannot query field 'blockedBy' on type 'Issue'",
    'Resource not accessible by personal access token (repository.i2.blockedBy), Resource not accessible by personal access token (repository.i2.subIssuesSummary)',
  ])('schedules issues on hosts without blockers or sub-issues: %s', async (diagnostic) => {
    vi.useRealTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([issue(1), issue(2, [], 'Depends on #1'), issue(3)]);
    const stderr = `gh: GraphQL: ${diagnostic}\n`;
    const command = () => run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`]);
    const api = vi.fn((args: string[]) => /blockedBy|subIssuesSummary/.test(args[3]) ? ghJson(args, undefined, command) : Promise.resolve(nativeAnswer(args)));
    const issues = await listIssues(repo.fullName, query, api);
    expect(api).toHaveBeenCalledTimes(2);
    expect(issues.every((i) => i.nativeBlockers === undefined && i.subIssues === undefined)).toBe(true);
    setIssues(...issues);
    expect(ready()).toEqual([1, 3]);
    // A host that keeps answering with the same diagnostics still schedules from issue bodies.
    const stuck = vi.fn((args: string[]) => ghJson(args, undefined, command));
    setIssues(...await listIssues(repo.fullName, query, stuck));
    expect(stuck).toHaveBeenCalledTimes(2);
    expect(ready()).toEqual([1, 3]);
  });

  it('keeps native blockers through a failed dependency sync and excludes unread new issues', async () => {
    const raw = { ...issue(2), labels: [] };
    const query = vi.fn().mockResolvedValue([raw]);
    const api = vi.fn().mockResolvedValueOnce({ data: { repository: { i2: { blockedBy: {
      nodes: [{ number: 1, state: 'OPEN', repository: { nameWithOwner: repo.fullName } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    }, subIssuesSummary: { total: 0, completed: 0 } } } } }).mockRejectedValue(new Error('network'));
    setIssues(...await listIssues(repo.fullName, query, api));
    expect(ready()).toEqual([]);
    query.mockResolvedValue([raw, { ...raw, number: 3 }]);
    setIssues(...await listIssues(repo.fullName, query, api));
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
  });

  it('fails closed for unread blockers, but schedules unsupported hosts from the body', () => {
    setIssues({ ...issue(1), nativeBlockers: null });
    expect(ready()).toEqual([]);
    setIssues(issue(1, ['ready-for-human']), issue(2, [], 'Depends on #1'), issue(3));
    expect(ready()).toEqual([3]);
    setIssues(issue(2, [], 'Depends on #1'));
    expect(ready()).toEqual([2]);
  });

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

describe('issues awaiting preparation', () => {
  const gates = [
    { labels: ['needs-triage'], title: 'Foo', reason: 'needs triage', release: 'needs-triage label' },
    { labels: ['Needs-Human'], title: 'Foo', reason: 'needs-human', release: 'needs-human label' },
    { labels: ['Needs-Info'], title: 'Foo', reason: 'waiting for info', release: 'needs-info label' },
    { labels: [], title: '[Draft] Foo', reason: 'draft', release: 'title prefix' },
    { labels: [], title: 'dRaFt: Foo', reason: 'draft', release: 'title prefix' },
  ];

  it.each(gates)('never auto-assigns $title ($labels), reports $reason, then starts after a refresh clears the gate', async ({ labels, title, reason }) => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    Object.assign(s.repoRt.get(repo.id)!, { lastMergedAt: null });
    const list = vi.spyOn(s.backend, 'listIssues').mockResolvedValue([{ ...issue(1, labels), title }]);
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    await swarm.syncRepo(repo.id);
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
    const floor = JSON.parse(s.companyStatus()).floors[0];
    expect(floor.capacity.issuesReadyToStart).toBe(0);
    expect(floor.backlog[0]).toMatchObject({ number: 1, waitReason: reason });

    list.mockResolvedValue([issue(1)]);
    await swarm.syncRepo(repo.id);
    expect(ready()).toEqual([1]);
    const refreshed = JSON.parse(s.companyStatus()).floors[0];
    expect(refreshed.capacity.issuesReadyToStart).toBe(1);
    expect(refreshed.backlog[0].waitReason).toBeUndefined();
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledOnce();
  });

  it.each(gates)('refuses manager and CEO starts of $title ($labels) with an actionable 409', async ({ labels, title, reason, release }) => {
    setIssues({ ...issue(1, labels), title });
    await expect(swarm.assign('a1', 1)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(reason) });
    const start = s as unknown as { startIssue(x: { floor: number; number: number }): Promise<string> };
    await expect(start.startIssue({ floor: 1, number: 1 })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(release) });
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 1 })).toContain(reason);
    expect(runTask).not.toHaveBeenCalled();
    expect(repo.requestedStarts).toEqual([]);

    setIssues(issue(1));
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 1 })).toContain('started #1');
    expect(runTask).toHaveBeenCalledOnce();
  });

  it.each(gates)('leaves $title ($labels) in the backlog while starting other ready work', ({ labels, title }) => {
    setIssues({ ...issue(1, labels), title }, issue(2, ['ready-for-agent']));
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask.mock.calls[0][2].number).toBe(2);
  });
});

describe('ready-for-human issues', () => {
  it('files for a person with the specialty and human label atomically, never auto-assigning it', async () => {
    const create = vi.spyOn(s.backend, 'createIssue').mockImplementation(async (_name, _title, _body, labels) => {
      // Simulate the scheduler seeing the issue immediately on creation, before the tool returns.
      setIssues(issue(68, labels));
      expect(s.startIssueWork(repo)).toBe(false);
      return 68;
    });
    const edit = vi.spyOn(s.backend, 'editIssue');
    expect(await s.officeTools().call('file_issue', { floor: 1, title: 'Verify deployment', body: 'Check hardware', specialty: 'server', ready_for_human: true })).toContain('Filed #68 for a person');
    expect(create).toHaveBeenCalledExactlyOnceWith(repo.fullName, 'Verify deployment', expect.stringContaining('Check hardware'), ['swarm:server', 'ready-for-human']);
    expect(edit).not.toHaveBeenCalled();
    expect(ready()).toEqual([]);
    expect(runTask).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('keeps ordinary issue filing schedulable (ready_for_human: %s)', async (ready_for_human) => {
    const create = vi.spyOn(s.backend, 'createIssue').mockImplementation(async (_name, _title, _body, labels) => {
      setIssues(issue(68, labels));
      return 68;
    });
    expect(await s.officeTools().call('file_issue', { floor: 1, title: 'Fix recovery', body: 'Implement it', ready_for_human })).not.toContain('for a person');
    expect(create.mock.calls[0][3]).toEqual([]);
    expect(ready()).toEqual([68]);
  });

  it('lets the demo CEO file an issue for a person from a manager message', async () => {
    const create = vi.spyOn(s.backend, 'createIssue').mockResolvedValue(68);
    const finished = vi.fn();
    const handle = createDemoBackend().startSession({ role: 'ceo', cwd: '', prompt: 'Manager asks:\nFile issue on floor 1 titled Verify deployment for a person: Check hardware',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
      { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('Filed #68 for a person') }));
    expect(create).toHaveBeenCalledWith(repo.fullName, 'Verify deployment', expect.stringContaining('Check hardware'), ['ready-for-human']);
    handle.stop();
  });

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

  it('are set and cleared on an existing issue by route_issue, flipping company_status at once', async () => {
    setIssues(issue(1), issue(2));
    const edit = vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue(); // no refresh: the tool updates the cache itself
    const backlog = () => JSON.parse(s.companyStatus()).floors[0].backlog.find((i: { number: number }) => i.number === 1);
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 1, ready_for_human: true })).toBe('#1 on floor 1: reserved for a person (ready-for-human).');
    expect(edit).toHaveBeenLastCalledWith(repo.fullName, 1, { body: undefined, addLabels: ['ready-for-human'], removeLabels: [] });
    expect(backlog()).toMatchObject({ readyForHuman: true });
    expect(ready()).toEqual([2]);
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 1, ready_for_human: true })).toContain('already ready-for-human, unchanged');
    expect(edit).toHaveBeenCalledOnce();
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 1, ready_for_human: false })).toBe('#1 on floor 1: ready-for-human removed, agents can start it.');
    expect(edit).toHaveBeenLastCalledWith(repo.fullName, 1, { body: undefined, addLabels: [], removeLabels: ['ready-for-human'] });
    expect(backlog().readyForHuman).toBeUndefined();
    expect(ready()).toEqual([1, 2]);
  });

  it('refuses route_issue ready_for_human on an unknown issue without editing', async () => {
    setIssues(issue(1));
    const edit = vi.spyOn(s.backend, 'editIssue');
    vi.spyOn(s.backend, 'issueState').mockResolvedValue(null);
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 42, ready_for_human: false })).toContain('There is no open issue #42 on floor 1.');
    expect(edit).not.toHaveBeenCalled();
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

describe('route_issue triaged', () => {
  it('succeeds without editing when already triaged, and leaves draft titles blocked', async () => {
    setIssues(issue(1), { ...issue(2), title: '[Draft] Still planning' });
    const edit = vi.spyOn(s.backend, 'editIssue');
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 1, triaged: true })).toContain('already triaged, unchanged');
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 2, triaged: true })).toContain('already triaged, unchanged');
    expect(edit).not.toHaveBeenCalled();
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 2 })).toContain('draft');
  });

  it('removes labels through the demo backend and keeps draft titles unchanged', async () => {
    const number = await s.backend.createIssue(repo.fullName, '[Draft] Still planning', 'Body', ['Needs-Triage', 'needs-info', 'bug']);
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    await swarm.syncRepo(repo.id);
    expect(await s.officeTools().call('route_issue', { floor: 1, number, triaged: true })).toContain('marked triaged');
    expect((await s.backend.listIssues(repo.fullName)).find((i) => i.number === number)).toMatchObject({ title: '[Draft] Still planning', body: 'Body', labels: ['bug'] });
    const backlog = JSON.parse(s.companyStatus()).floors[0].backlog.find((i: { number: number }) => i.number === number);
    expect(backlog.waitReason).toBe('draft');
  });

  it('lets the demo CEO triage an issue when the manager asks', async () => {
    setIssues(issue(1, ['needs-triage']));
    const edit = vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
    const finished = vi.fn();
    const handle = createDemoBackend().startSession({ role: 'ceo', cwd: '', prompt: 'Manager asks:\nTriage #1 on floor 1',
      systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [], office: s.officeTools() },
      { log: () => {}, tool: () => {}, sessionId: () => {}, browserUrl: () => {}, screenshot: () => {}, finished });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: expect.stringContaining('marked triaged') }));
    expect(edit).toHaveBeenCalledWith(repo.fullName, 1, { body: undefined, addLabels: [], removeLabels: ['needs-triage'] });
    handle.stop();
  });

  it.each([
    ['needs-triage', 'needs triage'],
    ['needs-info', 'waiting for info'],
    ['NeEdS-TrIaGe', 'needs triage'],
  ])('clears %s and lets start_issue run immediately, even with a stale refresh', async (label, reason) => {
    setIssues(issue(1, [label, 'NEEDS-INFO', 'bug']));
    const edit = vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    const sync = vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
    const backlog = () => JSON.parse(s.companyStatus()).floors[0].backlog[0];
    expect(backlog().waitReason).toBe(reason);
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 1 })).toContain(reason);
    expect(await s.officeTools().call('route_issue', { floor: 1, number: 1, triaged: true })).toContain('marked triaged');
    expect(edit).toHaveBeenCalledWith(repo.fullName, 1, { body: undefined, addLabels: [], removeLabels: [label, 'NEEDS-INFO'] });
    expect(sync).toHaveBeenCalledWith(repo.id);
    expect(backlog().waitReason).toBeUndefined();
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 1 })).toContain('started #1');
    expect(runTask).toHaveBeenCalledOnce();
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
  const end = async (result: SessionResult) => {
    const n = sessions.length;
    sessions[n - 1].cb.finished(result);
    await vi.waitFor(() => expect(ada().status).not.toBe('working'), { timeout: 500 }).catch(() => undefined);
    return sessions.length > n;
  };

  beforeEach(async () => {
    f = s as unknown as Fake;
    backend = (s as unknown as { backend: Backend }).backend;
    Object.assign(repo, { defaultBranch: 'main', links: [], browserTesting: false });
    Object.assign(ada(), { model: '', effort: '', cli: '', task: 'issue', issueNumber: 66, issueTitle: 'Issue 66', branch: 'swarm/issue-66-ada', sessionId: null, prNumber: null, startedAt: Date.now(), turns: 0, costUsd: 0 });
    sessions = [];
    vi.spyOn(backend, 'startSession').mockImplementation((opts, cb) => {
      sessions.push({ opts, cb });
      return { send: () => undefined, stop: () => undefined };
    });
    vi.spyOn(backend, 'deskHead').mockRejectedValue(new Error('baseline unavailable'));
    ahead = vi.spyOn(backend, 'branchAhead').mockResolvedValue(3);
    vi.spyOn(backend, 'prForBranch').mockResolvedValue(null);
    vi.spyOn(f, 'syncRepo').mockResolvedValue();
    vi.spyOn(f, 'buildSystemAppend').mockReturnValue('');
    await s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
  });


  it.each(['issue', 'qa', 'fix'])('surfaces an unreadable reconnected %s result and requeues it after cooldown', async (task) => {
    const error = "Codex's session could not be recovered: no completion signal or readable transcript was available after reconnecting.";
    Object.assign(ada(), { task, prNumber: task === 'issue' ? null : 13 });
    const rec = { repoId: repo.id, prNumber: 13, status: task === 'qa' ? 'testing' : 'fixing', qaAgentId: 'a1', devAgentId: 'a1', sessionFailures: 0, summary: '', checks: [], round: 1 } as unknown as QaRec;
    if (task !== 'issue') s.state.qa.push(rec);
    const before = sessions.length;
    expect(await end({ ...cut, errors: [error], recoveryFailed: true })).toBe(false);
    expect(sessions).toHaveLength(before);
    expect(ada()).toMatchObject({ status: 'stopped', lastError: error });
    await vi.advanceTimersByTimeAsync(120_000);
    s.recoverDesks();
    if (task !== 'issue') expect(rec).toMatchObject({ status: task === 'qa' ? 'queued' : 'failed', sessionFailures: 0 });
    if (task === 'issue') {
      setIssues(issue(66));
      expect(ready()).toContain(66);
    }
    const status = JSON.parse(s.companyStatus());
    expect(status.floors[0].team[0]).toMatchObject({ status: 'idle', lastError: { message: error, at: expect.any(Number) } });
  });

  const emptyEnding = async () => {
    Object.assign(ada(), { status: 'working', task: 'issue', issueNumber: 66, issueTitle: 'Issue 66', branch: 'swarm/issue-66-ada', prNumber: null });
    ahead.mockResolvedValue(0);
    await s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(false);
    expect(ada()).toMatchObject({ status: 'idle', issueNumber: null });
  };

  it('two consecutive no-work endings stop automatic starts, persist and surface a stall without a draft PR nudge', async () => {
    setIssues(issue(66));
    const message = vi.spyOn(swarm, 'message');
    await emptyEnding();
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(repo.noWorkEndings?.[0].count).toBe(1);
    await emptyEnding();
    repo.noWorkEndings = JSON.parse(JSON.stringify(repo.noWorkEndings));
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(message).not.toHaveBeenCalled();
    const status = JSON.parse(s.companyStatus());
    expect(status.floors[0].backlog[0].stalled).toBe('ended twice with no work');
    expect(status.floors[0].capacity.issuesReadyToStart).toBe(0);
    expect(s.repoView(repo)).toMatchObject({ issues: [{ stalled: 'ended twice with no work' }] });
    expect(f.state.messages.at(-1)?.text).toContain('ended twice with no work');
  });

  it('waits for a later successful issue sync, then prefers different ready work', async () => {
    setIssues(issue(66));
    await emptyEnding();
    expect(ready()).toEqual([]);
    vi.mocked(f.syncRepo).mockRestore();
    const list = vi.spyOn(backend, 'listIssues').mockRejectedValue(new Error('offline'));
    vi.spyOn(backend, 'listPulls').mockResolvedValue({ pulls: [] });
    await vi.advanceTimersByTimeAsync(1);
    await f.syncRepo(repo.id);
    expect(ready()).toEqual([]);
    list.mockResolvedValue([issue(66), issue(67)]);
    await f.syncRepo(repo.id);
    expect(ready()).toEqual([67, 66]);
    expect(s.startIssueWork(repo)).toBe(true); // assignment reserves the desk before runTask
    expect(runTask).toHaveBeenLastCalledWith(ada(), repo, expect.objectContaining({ number: 67 }), undefined);
  });

  it('keeps agent owner-account comments from resetting the stall across real refreshes', async () => {
    vi.mocked(f.syncRepo).mockRestore();
    const nodes: { author: { login: string }; createdAt: string; body: string }[] = [];
    const query = vi.fn().mockResolvedValue([{ ...issue(66), labels: [] }]);
    const api = vi.fn().mockImplementation(async () => ({ data: { repository: { i66: {
      blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      subIssuesSummary: { total: 0, completed: 0 }, comments: { nodes: [...nodes] },
    } } } }));
    vi.spyOn(backend, 'listIssues').mockImplementation(() => listIssues(repo.fullName, query, api));
    vi.spyOn(backend, 'listPulls').mockResolvedValue({ pulls: [] });
    await f.syncRepo(repo.id);
    for (let n = 0; n < 2; n++) {
      nodes.push({ author: { login: 'demo-co' }, createdAt: `2026-10-18T12:0${n}:00Z`, body: `Blocked. ${AGENT_COMMENT_MARKER}` });
      await emptyEnding();
      expect(sessions.at(-1)?.opts.systemAppend).toContain(AGENT_COMMENT_MARKER);
      expect(repo.noWorkEndings?.[0].count).toBe(n + 1);
      await vi.advanceTimersByTimeAsync(1);
      await f.syncRepo(repo.id);
    }
    expect(s.repoView(repo)).toMatchObject({ issues: [{ stalled: 'ended twice with no work' }] });
    expect(s.startIssueWork(repo)).toBe(false);
    nodes.push({ author: { login: 'demo-co' }, createdAt: '2026-10-18T12:02:00Z', body: 'The dependency is ready now.' });
    await f.syncRepo(repo.id);
    expect(repo.noWorkEndings).toEqual([]);
    expect(ready()).toEqual([66]);
  });

  it('a manual start clears the consecutive no-work count', async () => {
    setIssues(issue(66));
    await emptyEnding();
    await emptyEnding();
    await swarm.assign('a1', 66);
    expect(repo.noWorkEndings).toEqual([]);
    expect(ready()).toEqual([]); // the issue is already claimed
    await emptyEnding();
    expect(repo.noWorkEndings?.[0].count).toBe(1);
  });

  it.each(['owner comment', 'labels', 'body'] as const)('a new %s clears the stall on sync', async (edit) => {
    setIssues(issue(66));
    await emptyEnding();
    await emptyEnding();
    const changed = issue(66);
    if (edit === 'owner comment') changed.ownerCommentAt = '2026-10-08T12:00:00Z';
    if (edit === 'labels') changed.labels = ['swarm:server'];
    if (edit === 'body') changed.body = 'Clarified work';
    vi.mocked(f.syncRepo).mockRestore();
    vi.spyOn(backend, 'listIssues').mockResolvedValue([changed]);
    vi.spyOn(backend, 'listPulls').mockResolvedValue({ pulls: [] });
    await f.syncRepo(repo.id);
    expect(repo.noWorkEndings).toEqual([]);
    expect(ready()).toEqual([66]);
  });

  it('unpushed local commits are work and retain the finish-PR nudge', async () => {
    setIssues(issue(66));
    ahead.mockResolvedValue(0);
    vi.spyOn(backend, 'deskAhead').mockResolvedValue(1);
    ada().sessionId = 'thread-1';
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(repo.noWorkEndings ?? []).toEqual([]);
    expect(sessions[1].opts.prompt).toContain('open the PR');
  });

  it('failed local commit reads and failed PR lookups do not count as no work', async () => {
    setIssues(issue(66));
    ahead.mockResolvedValue(0);
    vi.spyOn(backend, 'deskAhead').mockRejectedValue(new Error('disk unavailable'));
    vi.spyOn(backend, 'prForBranch').mockRejectedValue(new Error('network'));
    ada().sessionId = 'thread-1';
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(repo.noWorkEndings ?? []).toEqual([]);
  });

  it('unsuccessful empty endings count but manager interruptions do not', async () => {
    setIssues(issue(66));
    ahead.mockResolvedValue(0);
    await end(cut);
    expect(repo.noWorkEndings?.[0].count).toBe(1);
    expect([ada().status, ada().lastError]).toEqual(['error', cut.errors[0]]); // a crash reads as one, not as a quiet hand-back
    Object.assign(ada(), { task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', prNumber: null });
    await s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
    await end({ ...cut, interrupted: true } as typeof cut);
    expect(repo.noWorkEndings?.[0].count).toBe(1);
  });

  it('empty resumed sessions with inherited commits still stall without a draft PR nudge', async () => {
    setIssues(issue(66));
    const message = vi.spyOn(swarm, 'message');
    vi.mocked(backend.deskHead).mockResolvedValue('existing-commit');
    vi.spyOn(backend, 'deskAhead').mockResolvedValue(3);
    for (let n = 0; n < 2; n++) {
      Object.assign(ada(), { task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', prNumber: null });
      await s.startAgentSession(ada(), repo, '/desk', 'Continue issue #66', '', 'thread-1');
      await end({ ...cut, ok: true, errors: [] });
      expect(repo.noWorkEndings?.[0].count).toBe(n + 1);
    }
    expect(ready()).toEqual([]);
    expect(message).not.toHaveBeenCalled();
    expect(f.state.messages.at(-1)?.text).toContain('3 pushed commits');
  });

  it('a work-producing ending breaks the no-work streak', async () => {
    setIssues(issue(66));
    await emptyEnding();
    Object.assign(ada(), { task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'thread-1', prNumber: null });
    ahead.mockResolvedValue(2);
    await s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
    await end({ ...cut, ok: true, errors: [] });
    expect(repo.noWorkEndings).toEqual([]);
  });

  it.each(['native', 'body', 'human', 'parent', 'prd', 'unread', 'unpushed'] as const)('releases zero-commit %s work without a PR nudge and waits for changes', async (kind) => {
    ahead.mockResolvedValue(0);
    if (kind === 'unpushed') {
      const api = vi.fn<NonNullable<Parameters<typeof branchAhead>[3]>>().mockRejectedValueOnce(new CommandError('Not Found', 'HTTP 404', 1)).mockResolvedValueOnce([]);
      ahead.mockImplementation((name, base, branch) => branchAhead(name, base, branch, api));
    }
    const waiting = issue(66);
    if (kind === 'native' || kind === 'unpushed') waiting.nativeBlockers = [{ number: 1, state: 'OPEN' }];
    if (kind === 'body') waiting.body = 'Depends on #1';
    if (kind === 'human') waiting.labels = ['ready-for-human'];
    if (kind === 'parent') waiting.labels = ['parent'];
    if (kind === 'prd') waiting.title = 'PRD: build an app';
    if (kind === 'unread') waiting.nativeBlockers = null;
    setIssues(issue(1, ['ready-for-human']), waiting);
    repo.requestedStarts = [{ issueNumber: 66, preferredAgentId: 'a1', restartPending: false }];
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(false);
    expect(ada()).toMatchObject({ status: 'idle', task: null, issueNumber: null });
    expect(sessions).toHaveLength(1);
    expect(repo.requestedStarts).toEqual([]);
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    setIssues(issue(66));
    s.repoRt.get(repo.id)!.issuesFetchedAt = Date.now() + 1;
    expect(ready()).toEqual([66]);
  });

  it('waits for desk cleanup before releasing blocked work', async () => {
    ahead.mockResolvedValue(0);
    setIssues({ ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    let cleaned!: () => void;
    vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((r) => (cleaned = r)));
    sessions[0].cb.finished({ ...cut, ok: true, errors: [] });
    await vi.waitFor(() => expect(f.syncRepo).toHaveBeenCalled());
    expect(ada().issueNumber).toBe(66);
    cleaned();
    await vi.waitFor(() => expect(ada().status).toBe('idle'));
    expect(sessions).toHaveLength(1);
  });

  it.each(['before', 'after'] as const)('joins an active refresh when cleanup finishes %s the blockers load', async (cleanupOrder) => {
    vi.mocked(f.syncRepo).mockRestore(); // Exercise the real concurrent refresh contract.
    ahead.mockResolvedValue(0);
    ada().sessionId = 'thread-1';
    setIssues(issue(66));
    repo.requestedStarts = [{ issueNumber: 66, preferredAgentId: 'a1', restartPending: false }];
    Object.assign(s.repoRt.get(repo.id)!, { lastSync: null, lastMergedAt: null });
    let refreshed!: (issues: IssueInfo[]) => void;
    const list = vi.spyOn(backend, 'listIssues').mockReturnValue(new Promise((resolve) => (refreshed = resolve)));
    vi.spyOn(backend, 'listPulls').mockResolvedValue({ pulls: [] });
    let cleaned!: () => void;
    const cleanup = vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((resolve) => (cleaned = resolve)));
    const message = vi.spyOn(swarm, 'message');
    const refresh = f.syncRepo(repo.id);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    sessions[0].cb.finished({ ...cut, ok: true, errors: [] });
    await vi.waitFor(() => expect(ahead).toHaveBeenCalled());
    expect(cleanup).toHaveBeenCalledOnce();
    if (cleanupOrder === 'before') cleaned();
    await vi.advanceTimersByTimeAsync(50);
    expect(message).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);

    const blocked = { ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' as const }] };
    refreshed([blocked]);
    await refresh;
    await vi.advanceTimersByTimeAsync(50);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(message).not.toHaveBeenCalled();
    if (cleanupOrder === 'after') {
      expect(ada()).toMatchObject({ status: 'working', issueNumber: 66 });
      cleaned();
    }
    await vi.waitFor(() => expect(ada()).toMatchObject({ status: 'idle', task: null, issueNumber: null }));
    expect(repo.requestedStarts).toEqual([]);
    expect(message).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(ready()).toEqual([]);
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('re-checks dependencies at session end before deciding whether to nudge', async () => {
    ahead.mockResolvedValue(0);
    setIssues(issue(66));
    vi.mocked(f.syncRepo).mockImplementation(async () => {
      setIssues({ ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    });
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(false);
    expect(ada()).toMatchObject({ status: 'idle', issueNumber: null });
    expect(ready()).toEqual([]);
  });

  it('does not release potentially pushed work when its commit read fails', async () => {
    ahead.mockRejectedValue(new Error('network'));
    ada().sessionId = 'thread-1';
    setIssues({ ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(ada().issueNumber).toBe(66);
  });

  it.each(['missing-base', 'inaccessible-repo'])('preserves blocked work and PR recovery after a comparison 404: %s', async (failure) => {
    const comparison = new CommandError('Not Found', 'gh: Not Found (HTTP 404)', 1);
    const api = vi.fn<NonNullable<Parameters<typeof branchAhead>[3]>>().mockRejectedValueOnce(comparison);
    if (failure === 'missing-base') api.mockResolvedValueOnce([{ ref: 'refs/heads/swarm/issue-66-ada', object: { sha: 'existing-pushed-head' } }]);
    else api.mockRejectedValueOnce(new CommandError('Not Found', 'gh: Not Found (HTTP 404)', 1));
    ahead.mockImplementation((name, base, branch) => branchAhead(name, base, branch, api));
    ada().sessionId = 'thread-1';
    setIssues({ ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(ada()).toMatchObject({ status: 'working', task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada' });
    expect(sessions).toHaveLength(2);
    expect(sessions[1].opts.resumeSessionId).toBe('thread-1');
    expect(sessions[1].opts.prompt).toContain('pull request');
    expect(runTask).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('still nudges pushed commits even when the issue is blocked', async () => {
    setIssues({ ...issue(66), nativeBlockers: [{ number: 1, state: 'OPEN' }] });
    expect(await end({ ...cut, ok: true, errors: [] })).toBe(true);
    expect(sessions[1].opts.prompt).toContain('open the PR');
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

  it.each([0, 3])('ends a silent Codex refusal and recovers work with %i pushed commits', async (commits) => {
    const error = 'Codex refused the request (safety filter)';
    const pty = { pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setMeta: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const term = {
      cols: 100, rows: 30, note: vi.fn(), bind: vi.fn(),
      screen: () => "ⓘ This content can't be shown\n1 background terminal running · /ps to view · /stop to close\n› Ask Codex to do anything",
    } as unknown as AgentTerminal;
    const host: CliHost = {
      prepare: (plan) => ({ dir: 'fake-session', prompt: plan.prompt, start: () => pty }),
      recoverTurn: () => null, hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null,
      codexThread: async () => undefined, removeDir: vi.fn(), reconnect: async () => [], adopt: () => pty,
      discard: vi.fn(), hooksReady: vi.fn(), leave: vi.fn(), protect: () => ({ pids: [], markers: [] }),
    };
    ahead.mockResolvedValue(commits);
    setIssues(issue(66));
    vi.spyOn(backend, 'deskAhead').mockResolvedValue(0);
    let cleaned!: () => void;
    const release = vi.spyOn(backend, 'releaseDesk').mockReturnValue(new Promise<void>((resolve) => { cleaned = resolve; }));
    const removeDesk = vi.spyOn(backend, 'removeDesk');
    const prepareDesk = vi.spyOn(backend, 'prepareDesk');
    const finished = vi.fn();
    vi.mocked(backend.startSession).mockImplementationOnce((opts, cb) => startCliSession({ ...opts, cli: 'codex', terminal: term }, {
      ...cb, finished: (result) => { finished(result); cb.finished(result); },
    }, host));
    await s.startAgentSession(ada(), repo, '/desk', 'Please resolve GitHub issue #66', '');
    ada().sessionId = 'running-thread';

    await vi.advanceTimersByTimeAsync(STUCK_MS + 30_000); // the first screen sample is at 30 s
    expect(finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: false, errors: [error] }));
    expect(term.note).toHaveBeenCalledWith(`── ${error} ──`);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(repo.fullName, 'ada-a1', expect.any(Number));
    expect(s.agentRt.get('a1')!.log).toContainEqual(expect.objectContaining({ kind: 'error', text: error }));
    expect(sessions).toHaveLength(1); // retry waits for the background process clean-up

    cleaned();
    await vi.advanceTimersByTimeAsync(50);
    expect(ada().branch).toBe('swarm/issue-66-ada');
    expect(removeDesk).not.toHaveBeenCalled();
    expect(prepareDesk).not.toHaveBeenCalled();
    if (commits) {
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.prompt).toContain(error);
      expect(sessions[1].opts.cwd).toBe(backend.deskDir(repo.fullName, 'ada-a1'));
    } else {
      expect(ada()).toMatchObject({ status: 'error', lastError: error });
      s.repoRt.get(repo.id)!.issuesFetchedAt = Date.now() + 1; // a fresh sync releases the normal retry cooldown
      expect(ready()).toEqual([66]);
      expect(finished).toHaveBeenCalledOnce();
    }
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

  it('retries a resume whose conversation went missing as a new conversation', async () => {
    sessions[0].cb.sessionId('thread-1');
    expect(ada()).toMatchObject({ sessionId: 'thread-1', sessionCli: 'claude' });
    sessions[0].cb.sessionId(null); // the runner found Claude Code's conversation missing
    expect(ada()).toMatchObject({ sessionId: null, sessionCli: null });
    expect(await end({ ...cut, errors: [LOST_CONVERSATION] })).toBe(true);
    expect(sessions[1].opts.resumeSessionId).toBeUndefined();
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
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions).toHaveLength(2);
      expect(sessions[1].opts.cwd).toBe(backend.deskDir(repo.fullName, 'ada-a1'));
      expect(sessions[1].opts.prompt).toContain('swarm/issue-66-ada has 3 pushed commits');
      f.schedule();
      await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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
      expect(ada()).toMatchObject({ status: 'idle', heldRetry: { issueNumber: 66, ahead: 3 } });
      expect(f.issueTaken(repo, 66)).toBe(true);
      barbara.status = 'done';
      f.schedule();
      await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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

  it('preserves failed work when the comparison is unavailable', async () => {
    ahead.mockRejectedValue(new Error('gh api failed: HTTP 404'));
    expect(await end(cut)).toBe(false);
    expect(ada()).toMatchObject({ status: 'error', branch: 'swarm/issue-66-ada' });
  });
});

describe('company_status size', () => {
  const pr = (number: number): PullInfo => ({
    number, title: `Pull request ${number} with a reasonably long descriptive title`, url: '', isCrossRepository: false, headRefName: `swarm/${number}`, state: 'OPEN',
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
    number: 13, title: 'Chaser', url: '', isCrossRepository: false, headRefName: 'swarm/13', state: 'OPEN',
    isDraft: false, closesIssues: [], checks: 'passing', hasSuccessfulChecks: true, mergeable: 'MERGEABLE', headSha: 'sha-1',
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
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    rec = {
      repoId: repo.id, prNumber: 13, reviewId: 'review-13', status: 'failed', round: 2, sessionFailures: 0, retests: 0, testedSha: 'sha-0', failedSha: 'sha-0', fixCrashes: [],
      devAgentId: 'a1', qaAgentId: 'q1', summary: 'Broken', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
    };
    s.state.qa.push(rec);
    runFix = vi.spyOn(s, 'runFix').mockResolvedValue() as Mock;
  });

  it.each(['same head', 'lost response', 'different head', 'closed without merging'] as const)('publishes Codex follow-ups only after a matching merge (%s)', async (outcome) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: 'sha-1' });
    const create = vi.spyOn(s.backend, 'createIssue').mockResolvedValue(99);
    const lookup = vi.spyOn(s.backend, 'findIssuesByMarker').mockResolvedValue([]);
    const internal = s as Internals & { publishQaFollowUps(repo: Repo, pulls: PullInfo[]): Promise<void> };
    await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Passed', checks: [],
      followUps: [{ commentId: '4539173653', title: 'Improve the operator message', details: 'Add context to the optional setting warning.' }] }));
    expect(rec.status).toBe('passed');
    await internal.publishQaFollowUps(repo, [pull]);
    expect(create).not.toHaveBeenCalled();

    const updated: PullInfo = { ...pull, url: 'https://github.com/demo/office/pull/13',
      state: outcome === 'closed without merging' ? 'CLOSED' : 'MERGED', headSha: outcome === 'different head' ? 'sha-2' : 'sha-1' };
    s.reconcilePulls(repo, [updated]);
    if (outcome === 'lost response') create.mockRejectedValueOnce(new Error('lost response'));
    await internal.publishQaFollowUps(repo, [updated]);
    if (outcome === 'lost response') {
      expect(s.state.qa).toContain(rec);
      lookup.mockResolvedValue([{ number: 99 } as Awaited<ReturnType<Backend['findIssuesByMarker']>>[number]]);
    }
    await internal.publishQaFollowUps(repo, [updated]);
    if (outcome === 'same head' || outcome === 'lost response') {
      expect(create).toHaveBeenCalledExactlyOnceWith(repo.fullName, 'Improve the operator message',
        expect.stringContaining('https://github.com/demo/office/pull/13#discussion_r4539173653'), []);
      expect(lookup).toHaveBeenCalledTimes(outcome === 'lost response' ? 2 : 1);
    } else expect(create).not.toHaveBeenCalled();
    expect(s.state.qa).not.toContain(rec);
  });

  it('uses the existing repair path for a confirmed Codex blocker', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: 'sha-1' });
    await s.onQaFinished(tester, repo, result(true, { verdict: 'fail', summary: 'Confirmed the current-head P2', checks: [],
      findings: [{ title: 'Optional value blocks rotation', details: 'The preflight rejects a missing optional value before rotating any other key.' }] }));
    expect(rec).toMatchObject({ status: 'failed', failedSha: 'sha-1', fixReason: 'qa' });
    expect(rec).not.toHaveProperty('followUps', expect.anything());
  });

  const crashCli = async (agent: Record<string, unknown>, ranMs = 2_000, turn = false, session = false, prepareMs = 0, options: Partial<Pick<SessionOptions, 'cli' | 'resumeSessionId'>> & { hooks?: Record<string, unknown>[] } = {}) => {
    let token = '';
    const pty = { pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setMeta: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const term = { cols: 100, rows: 30, note: vi.fn(), bind: vi.fn(), write: vi.fn(), screen: () => '' } as unknown as AgentTerminal;
    const host: CliHost = {
      prepare: (plan) => {
        token = plan.token;
        const prepared = { dir: 'box/sessions/t', prompt: plan.prompt, start: () => pty };
        return prepareMs ? new Promise((resolve) => setTimeout(() => resolve(prepared), prepareMs)) : prepared;
      },
      recoverTurn: async () => null,
      hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null,
      codexThread: async () => undefined, removeDir: vi.fn(), reconnect: async () => [], adopt: () => pty,
      discard: vi.fn(), hooksReady: vi.fn(), leave: vi.fn(), protect: () => ({ pids: [], markers: [] }),
    };
    const finished = vi.fn();
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
    const { hooks = [], ...sessionOptions } = options;
    startCliSession({ cwd: 'desk', cli: 'opencode', ...sessionOptions, terminal: term, role: agent.role as 'qa' | 'dev', prompt: 'Work', systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [] }, {
      log: vi.fn(), tool: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), finished,
      sessionId: (id) => { agent.sessionId = id; },
    }, host);
    await vi.advanceTimersByTimeAsync(prepareMs + ranMs);
    for (const hook of hooks) handleHook(token, hook);
    if (session) handleHook(token, { hook_event_name: 'SessionStart', session_id: 'ses_test' });
    if (turn) handleHook(token, { hook_event_name: 'TurnComplete', session_id: 'ses_test', last_assistant_message: 'Working on it' });
    pty.onData.mock.calls[0][0]('\x1b[31mError: X\x1b[0m\r\n');
    pty.onExit.mock.calls[0][0](1);
    expect(finished).toHaveBeenCalledOnce();
    const result = finished.mock.calls[0][0] as SessionResult;
    await s.recordFinished(agent, repo, result, undefined, undefined);
    return result;
  };

  it.each(['tester', 'developer'] as const)('requeues a startup crash and uses the next free %s without charging the PR', async (replacement) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    Object.assign(rec, { status: 'testing', round: 1 });
    const events = vi.spyOn(s, 'broadcast');
    const result = await crashCli(tester);
    expect(result).toMatchObject({ startupFailed: true, turns: 0 });
    expect(tester).toMatchObject({ status: 'error', startupFailed: true, lastError: expect.stringContaining('Error: X') });
    expect(s.agentRt.get('q1')!.log).toContainEqual(expect.objectContaining({ kind: 'error', text: expect.stringContaining('Error: X') }));
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent', agent: expect.objectContaining({ startupFailed: true }) }));
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 0, qaAgentId: null, round: 1, summary: 'Broken' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const runQa = vi.spyOn(s, 'runQa').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(false);
    const next = addAgent('next', 'Nancy', replacement === 'tester' ? 'qa' : 'dev', 1);
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(runQa).toHaveBeenCalledWith(next, repo, rec);
    expect(() => s.beginTask(tester, {}, '', '')).toThrow(/CLI is waiting/);
    swarm.resetAgent(String(tester.id));
    expect(tester.startupFailed).toBe(false);
    runQa.mockClear();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(runQa).toHaveBeenCalledWith(tester, repo, rec);
  });

  it('keeps a broken developer QA desk blocked when its PR closes', async () => {
    const tester = addAgent('q1', 'Poirot', 'dev', 1);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    rec.status = 'testing';
    await crashCli(tester);
    s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
    expect(tester).toMatchObject({ status: 'error', startupFailed: true, task: null, lastError: expect.stringContaining('Error: X') });
    expect(() => s.beginTask(tester, {}, '', '')).toThrow(/CLI is waiting/);
  });

  it('measures startup from the process launch, after slow box preparation', async () => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    Object.assign(rec, { status: 'testing', sessionFailures: 1 });
    const result = await crashCli(tester, 2_000, false, false, 20_000);
    expect(result.startupFailed).toBe(true);
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 1 });
  });

  it.each([[2_000, true, false], [16_000, false, false], [2_000, false, true]])('still charges a real session failure (%i ms, turn %s, session %s)', async (ms, turn, session) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    rec.status = 'testing';
    const result = await crashCli(tester, ms, turn, session);
    expect(result.startupFailed).toBe(false);
    expect(tester.status).toBe('error');
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 1 });
  });

  it.each(['SessionStart', 'UserPromptSubmit'])('charges a Codex session reported by %s before its first turn', async (event) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    rec.status = 'testing';
    const result = await crashCli(tester, 2_000, false, false, 0, {
      cli: 'codex', hooks: [{ hook_event_name: event, session_id: 'existing-session' }],
    });
    expect(result).toMatchObject({ startupFailed: false, turns: 0, ok: false });
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 1 });
    expect(tester.status).toBe('error');
    expect(tester.startupFailed).not.toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const runQa = vi.spyOn(s, 'runQa').mockResolvedValue();
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(runQa).toHaveBeenCalledWith(tester, repo, rec);
  });

  it.each([
    { cli: 'codex' as const },
    { cli: 'codex' as const, hooks: [{ hook_event_name: 'SessionStart', session_id: 'sub-session', agent_id: 'subagent' }] },
    { cli: 'claude' as const },
  ])('holds a $cli startup failure without a reported main session ($hooks)', async (options) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: null });
    rec.status = 'testing';
    const result = await crashCli(tester, 2_000, false, false, 0, options);
    expect(result).toMatchObject({ startupFailed: true, turns: 0 });
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 0 });
    expect(tester).toMatchObject({ status: 'error', startupFailed: true });
  });

  it.each(['codex', 'claude', 'opencode'] as const)('charges a resumed %s session even without hooks or turns', async (cli) => {
    const tester = addAgent('q1', 'Poirot', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13, sessionId: 'existing-session' });
    rec.status = 'testing';
    const result = await crashCli(tester, 2_000, false, false, 0, { cli, resumeSessionId: 'existing-session' });
    expect(result).toMatchObject({ startupFailed: false, turns: 0 });
    expect(rec).toMatchObject({ status: 'queued', sessionFailures: 1 });
    expect(tester.startupFailed).not.toBe(true);
  });

  it('returns a developer startup crash to the issue queue without failure or no-work charges', async () => {
    setIssues(issue(66));
    Object.assign(ada, { status: 'working', task: 'issue', issueNumber: 66, prNumber: null, sessionId: null });
    await crashCli(ada);
    expect(ada).toMatchObject({ status: 'error', startupFailed: true });
    expect(s.issueFailures.get(`${repo.id}#66`) ?? 0).toBe(0);
    expect(repo.noWorkEndings ?? []).toEqual([]);
    expect(ready()).toEqual([66]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.startIssueWork(repo)).toBe(false);
    const next = addAgent('a2', 'Barbara', 'dev', 1);
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledWith(next, repo, expect.objectContaining({ number: 66 }), undefined);
  });

  it('returns a fix startup crash without charging the PR fix budget', async () => {
    Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13, sessionId: null });
    Object.assign(rec, { status: 'fixing', fixCrashes: [] });
    await crashCli(ada);
    expect(rec).toMatchObject({ status: 'failed', fixCrashes: [], sessionFailures: 0, summary: 'Broken' });
    expect(ada).toMatchObject({ status: 'error', startupFailed: true });
  });

  it.each([false, true])('collects an OpenCode box QA report and leaves testing (lost notification: %s)', async (lost) => {
    const tester = addAgent('q1', 'Nancy', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: 'sha-1' });
    const report = { verdict: 'pass', summary: 'Box QA completed', checks: [{ name: 'Regression', result: 'pass', details: 'Verified' }] };
    const text = 'Finished QA.\n```json\n' + JSON.stringify(report) + '\n```';
    const since = Date.now();
    let token = '';
    const pty = { pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setMeta: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const term = { cols: 100, rows: 30, note: vi.fn(), bind: vi.fn(), lastOutputAt: since, screen: () => OPENCODE_IDLE_WITH_USAGE } as unknown as AgentTerminal;
    const host: CliHost = {
      prepare: async (plan) => { token = plan.token; return { dir: 'box/sessions/t', prompt: plan.prompt, start: () => pty }; },
      recoverTurn: async () => opencodeTurn({ info: { id: 'ses_box', location: { directory: 'desk' } }, messages: [
        { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text }] },
        { id: 'msg_done', type: 'idle', outcome: 'succeeded', time: { created: since + 1 } },
      ] }, 'desk', since, 'ses_box'),
      hasFile: () => false, claudeTurn: () => null, newShots: () => [], savedShot: () => null,
      codexThread: async () => undefined, removeDir: vi.fn(), reconnect: async () => [], adopt: () => pty,
      discard: vi.fn(), hooksReady: vi.fn(), leave: vi.fn(), protect: () => ({ pids: [], markers: [] }),
    };
    const comment = vi.spyOn(s.backend, 'commentPull');
    const finished = vi.fn((result: SessionResult) => { void s.onQaFinished(tester, repo, result); });
    startCliSession({ cwd: 'desk', cli: 'opencode', terminal: term, role: 'qa', prompt: 'Test PR #13', systemAppend: '', model: '', effort: 'low', browserTesting: false, additionalDirectories: [] }, {
      log: vi.fn(), tool: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), finished,
      sessionId: (id) => { tester.sessionId = id; },
    }, host);
    await vi.advanceTimersByTimeAsync(0);
    if (!lost) {
      handleHook(token, { hook_event_name: 'SessionStart', session_id: 'ses_box' });
      expect(tester.sessionId).toBe('ses_box');
      handleHook(token, { hook_event_name: 'TurnComplete', session_id: 'ses_box', turn_id: 'msg_done', last_assistant_message: text });
    }
    await vi.advanceTimersByTimeAsync(STUCK_MS + 33_000);
    expect(finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true, text, turns: 1 }));
    expect(tester).toMatchObject({ status: 'done', sessionId: 'ses_box' });
    expect(rec).toMatchObject({ status: 'passed', summary: report.summary, checks: report.checks, sessionFailures: 0 });
    expect(comment).toHaveBeenCalledOnce();
    handleHook(token, { hook_event_name: 'TurnComplete', session_id: 'ses_box', last_assistant_message: text });
    expect(comment).toHaveBeenCalledOnce();
  });

  it.each(['preparing', 'working'])('waits for its %s author, even when another developer is free', (status) => {
    addAgent('a2', 'Barbara', 'dev', 1);
    Object.assign(ada, { status, task: 'issue', prNumber: null, branch: pull.headRefName });
    expect(s.startPipelineWork(repo)).toBe(false);
    expect(runFix).not.toHaveBeenCalled();
    ada.status = 'done';
    expect(s.startPipelineWork(repo)).toBe(true);
    expect(runFix).toHaveBeenCalledWith(ada, repo, rec);
  });

  it.each(['failed', 'needs-human'] as const)('retains %s findings when the original issue finishes', async (status) => {
    Object.assign(ada, { status: 'working', task: 'issue', prNumber: 13, sessionId: 'original-session' });
    rec.status = status;
    await s.onIssueFinished(ada, repo, result(true, undefined), Promise.resolve(), undefined);
    expect(rec).toMatchObject({ status, summary: 'Broken', devAgentId: 'a1', devSessionId: 'original-session', round: 2 });
  });

  const qaFails = async (tester: Record<string, unknown>) => {
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    rec.status = 'testing';
    rec.testedSha = 'sha-1';
    await s.onQaFinished(tester, repo, result(true, failReport));
  };

  describe('durable QA outcomes', () => {
    const code: QaCheck = { name: 'Feature', findingKey: 'missing-button', result: 'fail', failureKind: 'code', confirmed: true,
      introducedBySha: 'sha-1', details: 'Head fails the reproduction; base passes.' };
    let tester: Record<string, unknown>;
    const complete = async (checks: QaCheck[], verdict = 'fail') => {
      Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
      Object.assign(rec, { status: 'testing', testedSha: 'sha-1' });
      await s.onQaFinished(tester, repo, result(true, { verdict, summary: 'Observed QA evidence', checks }));
      return swarm.snapshot().qaOutcomes!.at(-1)!;
    };
    beforeEach(() => {
      s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
      tester = addAgent('q1', 'Grace', 'qa', 0);
      rec.attempt = { id: 'attempt-1', startedAt: Date.now() - 1000, headSha: 'sha-1', baseSha: 'base-1' };
      vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, body: '', isCrossRepository: false, baseSha: 'base-1' });
      s.state.prContributions.push({ repoId: repo.id, prNumber: 13, title: 'Feature', url: '', state: 'OPEN',
        original: { agentId: 'a1', name: 'Ada', submittedSha: 'sha-1', at: Date.now() - 2000 }, repairs: [] });
      vi.spyOn(s.backend, 'qaCi').mockImplementation(async (_repo, headSha) => ({ headSha, observedAt: Date.now(), availability: 'available',
        checks: [{ id: 'check-7', runId: 'run-42', name: 'CI', status: 'completed', conclusion: 'success', url: null }] }));
    });

    it('retains worker-only failures before merge normalization, including exact-revision CI', async () => {
      const events = vi.spyOn(s, 'broadcast');
      const evidence = await complete([{ name: 'Suite', result: 'fail', failureKind: 'environment', details: 'Exit 137: worker OOM; unchanged-base probe passed.' }]);
      expect(evidence).toMatchObject({ reviewId: 'review-13', attemptId: 'attempt-1', reviewer: { agentId: 'q1', name: 'Grace' },
        headSha: 'sha-1', baseSha: 'base-1', revision: 'exact', verdict: 'fail', classification: 'worker',
        checks: [{ result: 'fail' }], findings: [{ classification: 'worker' }], worker: { telemetry: null },
        ci: { headSha: 'sha-1', checks: [{ id: 'check-7', runId: 'run-42', conclusion: 'success' }] } });
      expect(rec).toMatchObject({ status: 'passed', ciRequired: true, checks: [{ result: 'skip' }] });
      expect(ada.score).toBe(0);
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'qaOutcome' }));
      expect(s.backend.qaCi).toHaveBeenCalledWith(repo.fullName, 'sha-1');
    });

    it('scores only the confirmed attributable defect in a mixed report and keeps its ID on an unchanged-head retry', async () => {
      const checks: QaCheck[] = [code, { name: 'Suite', result: 'fail', failureKind: 'environment', details: 'Worker OOM.' },
        { ...code, name: 'Suspected', findingKey: 'suspected', confirmed: false },
        { ...code, name: 'Unknown origin', findingKey: 'unknown-origin', introducedBySha: 'unknown' }];
      const first = await complete(checks);
      expect(first.classification).toBe('mixed');
      expect(first.legacyPenalty?.findingIds).toEqual([first.findings[0].id]);
      expect(ada.score).toBe(-1);
      rec.attempt = { ...rec.attempt!, id: 'attempt-2' };
      rec.round++;
      const retry = await complete(checks);
      expect(retry.findings[0].id).toBe(first.findings[0].id);
      expect(swarm.snapshot().qaOutcomes).toHaveLength(2);
      expect(ada.score).toBe(-1);
      await complete(checks); // duplicate completion of the same attempt
      expect(swarm.snapshot().qaOutcomes).toHaveLength(2);
      expect(ada.score).toBe(-1);
    });

    it.each(['head', 'base'] as const)('retains stale evidence when the %s moves while posting, even on a final round', async (part) => {
      rec.round = 3;
      vi.spyOn(s.backend, 'commentPull').mockImplementation(async () => {
        vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, headSha: part === 'head' ? 'sha-2' : 'sha-1', baseSha: part === 'base' ? 'base-2' : 'base-1', body: '', isCrossRepository: false });
        return 'comment';
      });
      const evidence = await complete([code]);
      expect(evidence).toMatchObject({ revision: 'stale', headSha: 'sha-1', baseSha: 'base-1', checks: [{ introducedBySha: 'sha-1' }] });
      expect(ada.score).toBe(0);
    });

    it('rejects CI evidence from another head and leaves an unexplained failure inconclusive', async () => {
      vi.mocked(s.backend.qaCi).mockResolvedValue({ headSha: 'new-head', observedAt: Date.now(), availability: 'available', checks: [] });
      const evidence = await complete([{ name: 'Suite', result: 'fail', details: 'Timed out; cause unknown.' }]);
      expect(evidence).toMatchObject({ ci: null, classification: 'inconclusive', findings: [{ classification: 'inconclusive' }] });
      expect(ada.score).toBe(0);
    });

    it('retains a session failure reason without treating it as a code defect', async () => {
      Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
      rec.status = 'testing';
      await s.onQaFinished(tester, repo, { ...result(false), errors: ['Session timed out after 600s'] });
      expect(swarm.snapshot().qaOutcomes!.at(-1)).toMatchObject({ verdict: 'incomplete', classification: 'inconclusive', terminalReason: 'Session timed out after 600s' });
      expect(ada.score).toBe(0);
    });

    it('preserves a manager handoff while no-report CI evidence is delayed', async () => {
      let finishCi!: (ci: Awaited<ReturnType<Backend['qaCi']>>) => void;
      vi.mocked(s.backend.qaCi).mockImplementation(() => new Promise((resolve) => { finishCi = resolve; }));
      Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
      rec.status = 'testing';
      const finishing = s.onQaFinished(tester, repo, result(false));
      await vi.advanceTimersByTimeAsync(0);
      s.clearTask(tester);
      Object.assign(rec, { status: 'failed', qaAgentId: null, summary: 'Accepted manager repair', sessionFailures: 0 });
      finishCi({ headSha: 'sha-1', observedAt: Date.now(), availability: 'available', checks: [] });
      await finishing;
      expect(rec).toMatchObject({ status: 'failed', summary: 'Accepted manager repair', sessionFailures: 0 });
      expect(swarm.snapshot().qaOutcomes).toHaveLength(1);
    });

    it('persists linked reviewer/manager corrections and history after cleanup and restart', async () => {
      const first = await complete([code]);
      expect(ada.score).toBe(-1);
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
      vi.spyOn(fs, 'rename').mockResolvedValue();
      const correction = await swarm.correctQaFinding(first.id, { findingId: first.findings[0].id, actor: 'manager', reason: 'Stable worker retry passed unchanged.', classification: 'worker' });
      expect(ada.score).toBe(0);
      const second = await swarm.correctQaFinding(first.id, { findingId: first.findings[0].id, actor: 'q1', reason: 'Root cause still unknown.', classification: 'inconclusive' });
      expect(second.previousCorrectionId).toBe(correction.id);
      expect(first.findings[0].classification).toBe('code');
      await expect(swarm.correctQaFinding(first.id, { findingId: first.findings[0].id, actor: 'other', reason: 'No', classification: 'worker' })).rejects.toMatchObject({ status: 400 });
      await expect(swarm.correctQaFinding(first.id, { findingId: first.findings[0].id, actor: 'manager', reason: '', classification: 'worker' })).rejects.toMatchObject({ status: 400 });
      s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
      expect(swarm.snapshot().qa).toHaveLength(0);
      await s.writeState();
      const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
      Object.assign(persisted, { repos: [], agents: [] });
      const fresh = new Swarm(createDemoBackend());
      const restored = fresh as unknown as Internals;
      restored.backend.demo = false;
      vi.spyOn(restored, 'save').mockImplementation(() => {});
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
      await fresh.init();
      expect(fresh.snapshot().qaOutcomes).toEqual(swarm.snapshot().qaOutcomes);
      await fresh.shutdown();
    });

    describe('Authorship and Repair scores', () => {
      const scores = (sw: Swarm, id: string) => sw.snapshot().agents.find((a) => a.id === id)?.scores;
      const ledger = () => swarm.snapshot().scoreEvents!.map((e) => e.id);

      it('worker-blocked unchanged-head merge: the author earns Authorship and the worker result stays neutral', async () => {
        await complete([{ name: 'Suite', result: 'fail', failureKind: 'environment', details: 'Exit 137: worker OOM; unchanged-base probe passed.' }]);
        expect(rec).toMatchObject({ status: 'passed', ciRequired: true });
        s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
        s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
        expect(scores(swarm, 'a1')).toEqual({ authorship: { points: 2, events: 1 }, repair: { points: 0, events: 0 }, neutral: 1 });
        expect(ledger()).toEqual(['neutral:qa:attempt-1', `authorship:merge:${repo.id}#13`]);
      });

      it('inherited-defect repair handoff: merge and defect stay with the author, verified Repair goes to the repairer, through restart', async () => {
        const events = vi.spyOn(s, 'broadcast');
        await complete([code]);
        expect(scores(swarm, 'a1')?.authorship).toEqual({ points: -1, events: 1 });
        const barbara = addAgent('a2', 'Barbara', 'dev', 1);
        Object.assign(barbara, { status: 'working', task: 'fix', prNumber: 13 });
        Object.assign(rec, { status: 'fixing', devAgentId: 'a2', fixReason: 'qa' });
        s.startRepairContribution(barbara, repo, rec, 'sha-1');
        vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, headSha: 'sha-2', body: '', isCrossRepository: false, baseSha: 'base-1' });
        await s.onFixFinished(barbara, repo, result(true));
        Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
        Object.assign(rec, { status: 'testing', testedSha: 'sha-2', attempt: { id: 'attempt-2', startedAt: Date.now(), headSha: 'sha-2', baseSha: 'base-1' } });
        await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Toolbar fixed', checks: [{ name: 'Feature', result: 'pass', details: 'Button reachable.' }] }));
        s.reconcilePulls(repo, [{ ...pull, headSha: 'sha-2', state: 'MERGED' }]);
        expect(scores(swarm, 'a1')).toEqual({ authorship: { points: 1, events: 2 }, repair: { points: 0, events: 0 }, neutral: 0 });
        expect(scores(swarm, 'a2')).toEqual({ authorship: { points: 0, events: 0 }, repair: { points: 1, events: 1 }, neutral: 0 });
        expect(ada.score).toBe(-1); // the legacy total is unchanged by the new ledger
        expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent', agent: expect.objectContaining({ id: 'a2', scores: expect.objectContaining({ repair: { points: 1, events: 1 } }) }) }));

        vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
        const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
        vi.spyOn(fs, 'rename').mockResolvedValue();
        await s.writeState();
        const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
        persisted.repos = [];
        const fresh = new Swarm(createDemoBackend());
        const restored = fresh as unknown as Internals;
        restored.backend.demo = false;
        vi.spyOn(restored, 'save').mockImplementation(() => {});
        vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
        await fresh.init();
        restored.syncScores(repo.id, 13); // a duplicate sync after restart appends nothing
        expect(fresh.snapshot().scoreEvents).toEqual(swarm.snapshot().scoreEvents);
        expect(scores(fresh, 'a1')).toEqual(scores(swarm, 'a1'));
        expect(scores(fresh, 'a2')).toEqual(scores(swarm, 'a2'));
        await fresh.shutdown();
      });

      it('starts an earlier office at zero without reconstructing its history', async () => {
        await complete([code]);
        s.reconcilePulls(repo, [{ ...pull, state: 'MERGED' }]);
        vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
        const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
        vi.spyOn(fs, 'rename').mockResolvedValue();
        await s.writeState();
        const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
        delete persisted.scoreLedger;
        persisted.repos = [];
        const fresh = new Swarm(createDemoBackend());
        const restored = fresh as unknown as Internals;
        restored.backend.demo = false;
        vi.spyOn(restored, 'save').mockImplementation(() => {});
        vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
        await fresh.init();
        restored.syncScores(repo.id, 13);
        expect(fresh.snapshot().scoreEvents).toEqual([]);
        expect(fresh.snapshot().agents.find((a) => a.id === 'a1')).toMatchObject({ score: 1, scores: { authorship: { points: 0, events: 0 }, repair: { points: 0, events: 0 } } });
        await fresh.shutdown();
      });
    });
  });

  it('does not send an environment-only validation failure to developers for a code fix', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: pull.headSha });
    const phone = vi.spyOn(s, 'postMessage');
    const comment = vi.spyOn(s.backend, 'commentPull');
    await s.onQaFinished(tester, repo, result(true, {
      verdict: 'fail',
      summary: 'Changed behavior passed; no code defect found. Full suite interrupted by shared-worker memory exhaustion.',
      checks: [{ name: 'Full regression suite', result: 'fail', failureKind: 'environment', details: 'Worker ran out of memory; focused retries and unchanged-base probes passed.' }],
    }));
    expect(['failed', 'fixing', 'needs-human']).not.toContain(rec.status);
    expect(rec.failedSha).toBeNull();
    expect(runFix).not.toHaveBeenCalled();
    expect(phone).not.toHaveBeenCalled();
    expect(comment.mock.calls.at(-1)?.[2]).toContain('Local validation was blocked only by the worker environment');
    expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha, ciRequired: true,
      checks: [{ result: 'skip', failureKind: 'environment' }] });
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    expect(await s.advanceMerge(repo, rec, pull)).toBe(true);
    expect(merge).toHaveBeenCalledWith(repo.fullName, pull.number, 'squash', pull.headSha);
  });

  it.each(['code', 'unclassified', 'invalid', 'security'] as const)('keeps %s failures in QA even when CI is green', async (kind) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: pull.headSha });
    if (kind === 'security') Object.assign(rec, { securityReview: { reason: 'Authorization', qaSha: pull.headSha, auditBaseSha: 'base-1' } });
    await s.onQaFinished(tester, repo, result(true, {
      verdict: 'fail', summary: 'Validation is blocked.',
      checks: [
        { name: 'Local suite', result: 'fail', failureKind: 'environment', details: 'Worker exhausted memory.' },
        ...(kind === 'security' ? [] : [{ name: 'Feature behavior', result: 'fail', details: 'Still broken.',
          ...(kind === 'unclassified' ? {} : { failureKind: kind === 'invalid' ? 'unknown' : 'code' }) }]),
      ],
    }));
    expect(rec.status).not.toBe('passed');
    expect(rec.passedSha).not.toBe(pull.headSha);
  });

  it('requires CI even when QA already marked an environment-blocked check skipped', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: pull.headSha });
    await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Source review passed.',
      checks: [{ name: 'Local suite', result: 'skip', failureKind: 'environment', details: 'Worker exhausted memory.' }] }));
    expect(rec).toMatchObject({ status: 'passed', ciRequired: true });
    const merge = vi.spyOn(s.backend, 'mergePull');
    expect(await s.advanceMerge(repo, rec, { ...pull, checks: 'none' })).toBe(false);
    expect(merge).not.toHaveBeenCalled();
  });

  it('treats a resource-only QA failure like an environment one, without charging a round', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: pull.headSha });
    const { round, retests } = rec;
    await s.onQaFinished(tester, repo, result(true, { verdict: 'fail', summary: 'Feature works; suite cancelled.',
      checks: [{ name: 'Local suite', result: 'fail', failureKind: 'resources', details: 'Cancelled under memory pressure.',
        resources: { freeMemory: '0.8 GB', swap: '0 B', cancelled: 204 } }] }));
    expect(rec).toMatchObject({ status: 'passed', ciRequired: true, passedSha: pull.headSha, round, retests,
      mergeNote: 'QA desk ran out of memory (free 0.8 GB, swap 0 B, 204 tests cancelled); not charged a round' });
    expect(rec.summary).not.toMatch(/timed out/);
  });

  it('accepts the demo environment-only report through the same QA path', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
    Object.assign(rec, { status: 'testing', testedSha: pull.headSha });
    const finished = vi.fn();
    const handle = s.backend.startSession({ cwd: '/fake-desk', role: 'qa', model: 'demo', effort: 'low',
      prompt: 'Please test pull request #13: [environment]', systemAppend: '', browserTesting: false, additionalDirectories: [] },
    { log: vi.fn(), tool: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), sessionId: vi.fn(), finished });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(finished).toHaveBeenCalledOnce();
    handle.stop();
    await s.onQaFinished(tester, repo, finished.mock.calls[0][0]);
    expect(rec).toMatchObject({ status: 'passed', ciRequired: true, passedSha: pull.headSha });
  });
  it('keeps unclassified send-backs neutral through retries and owner changes', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    const replacement = addAgent('a2', 'Barbara', 'dev', 1);
    Object.assign(ada, { score: 0 });
    Object.assign(replacement, { score: 4 });
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    await qaFails(tester);
    expect(ada.score).toBe(0);
    await qaFails(tester); // duplicated callback / same persisted round
    expect(ada.score).toBe(0);
    Object.assign(rec, { round: 3, retests: 1, devAgentId: 'a2' });
    await qaFails(tester);
    expect(ada.score).toBe(0);
    expect(replacement.score).toBe(4);
    expect(tester.score ?? 0).toBe(0);
  });

  it('fork: an office developer fixing a fork PR keeps their score through its QA failures and merge', async () => {
    vi.mocked(s.backend.prDetails).mockRestore();
    s.state.qa.length = 0;
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(ada, { score: 3, prNumber: null });
    const fork = demoForkPull(repo.fullName, 'swarm/issue-99-outsider');
    try {
      const listed = (await s.backend.listPulls(repo.fullName)).pulls.find((p) => p.number === fork.pull.number)!;
      s.repoRt.get(repo.id)!.pulls = [listed];
      s.reconcilePulls(repo, [listed]);
      const forkRec = s.state.qa.find((q) => q.prNumber === listed.number)!;
      expect(forkRec).toMatchObject({ devAgentId: null, crossRepository: true });
      const qaFailsFork = async () => {
        Object.assign(tester, { status: 'working', task: 'qa', prNumber: listed.number });
        Object.assign(forkRec, { status: 'testing', qaAgentId: tester.id, testedSha: fork.pull.headSha });
        await s.onQaFinished(tester, repo, result(true, failReport));
      };
      await qaFailsFork();
      expect(forkRec.status).toBe('failed');
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledWith(ada, repo, forkRec);
      Object.assign(forkRec, { status: 'fixing', devAgentId: ada.id }); // what prepareFix records
      fork.pull.headSha = 'outsider-push';
      Object.assign(forkRec, { round: forkRec.round + 1 });
      await qaFailsFork();
      expect(forkRec.status).toBe('failed');
      expect(ada.score).toBe(3);
      s.reconcilePulls(repo, [{ ...listed, state: 'MERGED', mergedAt: '2026-11-04' }]);
      expect(ada.score).toBe(3);
    } finally {
      fork.remove();
    }
  });

  it.each(['changed', 'closed', 'unavailable', 'incomplete', 'stale-session', 'human'] as const)('does not charge a %s QA result', async (reason) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    ada.score = 0;
    const details = vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    if (reason === 'changed') details.mockResolvedValue({ ...pull, headSha: 'new-sha', body: '', isCrossRepository: false });
    if (reason === 'closed') details.mockResolvedValue({ ...pull, state: 'CLOSED', body: '', isCrossRepository: false });
    if (reason === 'unavailable') details.mockRejectedValue(new Error('offline'));
    if (reason === 'human') rec.round = 3;
    if (reason === 'stale-session') {
      vi.spyOn(s.backend, 'commentPull').mockImplementation(async () => { s.clearTask(tester); return ''; });
    }
    if (reason === 'incomplete') {
      Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
      rec.status = 'testing';
      await s.onQaFinished(tester, repo, result(false));
    } else await qaFails(tester);
    if (reason === 'changed') expect(rec.status).toBe('queued');
    if (reason === 'unavailable') expect(rec.status).toBe('needs-human');
    expect(ada.score).toBe(0);
  });

  it('does not charge a failed security audit when its base moves during report posting', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(rec, { securityReview: { reason: 'Authentication', qaSha: 'sha-1', auditBaseSha: 'base-1' } });
    const pr = { ...pull, body: '', isCrossRepository: false, baseSha: 'base-1' };
    vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
    vi.spyOn(s.backend, 'commentPull').mockImplementation(async () => { pr.baseSha = 'base-2'; return 'comment'; });
    await qaFails(tester);
    expect(rec).toMatchObject({ status: 'failed', fixReason: 'base' });
    expect(ada.score).toBe(0);
  });

  it('retains neutral scoring after a security record closes and reopens', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(rec, { securityReview: { reason: 'Authentication', qaSha: null } });
    const reviewId = rec.reviewId;
    await qaFails(tester);
    expect(ada.score).toBe(0);
    s.reconcilePulls(repo, [{ ...pull, state: 'CLOSED' }]);
    s.reconcilePulls(repo, [{ ...pull, headSha: 'sha-2' }]);
    expect(rec.reviewId).not.toBe(reviewId);
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, headSha: 'sha-2', body: '', isCrossRepository: false });
    Object.assign(rec, { status: 'testing', testedSha: 'sha-2' });
    Object.assign(tester, { task: 'qa', status: 'working', prNumber: 13 });
    await s.onQaFinished(tester, repo, result(true, failReport));
    expect(ada.score).toBe(0);
  });

  it('does not charge skipped unchanged QA', async () => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    ada.score = 0;
    rec.failedSha = pull.headSha;
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    await s.runQa(tester, repo, rec);
    expect(rec.status).toBe('failed');
    expect(ada.score).toBe(0);
  });

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
    expect(comment.mock.calls[0][2]).toContain('Reconsider the approach');
  });

  it.each([{ mergeable: 'CONFLICTING', mergeState: 'UNKNOWN' }, { mergeable: 'UNKNOWN', mergeState: 'DIRTY' }])('hands the third QA failure to the manager despite a conflict: %j', async (conflict) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    Object.assign(rec, { round: 3, mergeFixes: MAX_MERGE_FIXES - 1 });
    Object.assign(repo, { defaultBranch: 'main' });
    const comment = vi.spyOn(s.backend, 'commentPull');
    const phone = vi.spyOn(s, 'postMessage');
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, ...conflict, body: '', isCrossRepository: false });
    await qaFails(tester);
    expect(rec).toMatchObject({ status: 'needs-human', fixReason: 'qa', mergeFixes: MAX_MERGE_FIXES - 1, passedSha: null,
      fixInstructions: expect.stringContaining('Chaser: never catches up') });
    expect(comment.mock.calls[0][2]).toContain('Reconsider the approach');
    expect(phone).toHaveBeenCalledWith('office', expect.stringContaining('Reconsider the approach'));
  });

  it.each(['changed head', 'lookup failed'] as const)('does not count a third QA failure when revision verification reports %s', async (why) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    rec.round = 3;
    const details = vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, mergeable: 'CONFLICTING', body: '', isCrossRepository: false,
      headSha: why === 'changed head' ? 'sha-2' : 'sha-1' });
    if (why === 'lookup failed') details.mockRejectedValue(new Error('GitHub unavailable'));
    await qaFails(tester);
    expect(rec).toMatchObject(why === 'changed head' ? { status: 'queued', retests: 1 } : { status: 'needs-human', fixReason: null });
  });

  it.each(['stable', 'base moved', 'comparison unavailable', 'coverage missing', 'retargeted'] as const)('checks prior findings on the third QA round when the review range is %s', async (revision) => {
    const tester = addAgent('q1', 'Grace', 'qa', 0);
    const pr = { ...pull, body: '', isCrossRepository: false, baseSha: 'base-1', baseRefName: 'main' };
    vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
    vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
    const session = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
    const comment = vi.spyOn(s.backend, 'commentPull');
    const fullReview = revision === 'comparison unavailable' || revision === 'retargeted';
    const compare = vi.spyOn(s.backend, 'deskQaDiffBase').mockResolvedValue(fullReview ? null : 'sha-1');
    Object.assign(rec, { status: 'queued', round: 2, retests: 0 });
    await s.runQa(tester, repo, rec);
    expect(session.mock.calls[0][4]).toContain('git diff base-1...sha-1');
    expect(compare).not.toHaveBeenCalled();
    await s.onQaFinished(tester, repo, result(true, { ...failReport, codeReviewComplete: true, fixInstructions: undefined,
      findings: [{ title: 'Timer stops when the tab blurs', details: 'Check every timer that relies on focus.' }] }));
    const id = comment.mock.calls[0][2].match(/QA-[0-9a-f]+/)![0];
    expect(rec.status).toBe('failed');

    Object.assign(rec, { status: 'queued', round: 3 });
    pr.headSha = 'sha-2';
    await s.runQa(tester, repo, rec);
    expect(session.mock.calls[1][3]).toContain(id);
    expect(session.mock.calls[1][4]).toContain(fullReview ? 'git diff base-1...sha-2' : 'git diff sha-1 sha-2');
    if (revision === 'base moved') comment.mockImplementationOnce(async () => { pr.baseSha = 'base-2'; return 'stale-comment'; });
    if (revision === 'retargeted') pr.baseRefName = 'release';
    await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Checks passed', checks: [], codeReviewComplete: revision !== 'coverage missing',
      findingUpdates: revision === 'stable' ? [] : [{ id, status: 'resolved', evidence: 'The timer runs after blur.' }] }));
    if (revision === 'coverage missing') {
      expect(comment).toHaveBeenCalledOnce();
      expect(rec).toMatchObject({ status: 'queued', round: 3, passedSha: null });
      await s.runQa(tester, repo, rec);
      expect(session.mock.calls[2][4]).toContain('git diff base-1...sha-2');
      return;
    }
    expect(comment.mock.calls[1][2]).not.toContain('Check every timer that relies on focus.');
    if (revision === 'stable') {
      expect(comment.mock.calls[1][2]).toContain(`${id}** still open`);
      expect(rec).toMatchObject({ status: 'needs-human', passedSha: null });
    } else if (revision === 'base moved' || revision === 'retargeted') {
      expect(rec).toMatchObject({ status: 'queued', passedSha: null, findings: [{ id, status: 'open' }] });
    } else {
      expect(rec).toMatchObject({ status: 'passed', passedSha: 'sha-2' });
    }
  });

  it.each([false, true])('reruns checks once per head and sends persistent failures back (API rejects: %s)', async (reject) => {
    Object.assign(rec, { status: 'passed', passedSha: pull.headSha, mergeFixes: 0 });
    const pr = { ...pull, checks: 'failing' as const, failedChecks: [{ name: 'CI', url: 'https://github.com/o/r/actions/runs/42/job/7' }] };
    const rerun = vi.spyOn(s.backend, 'rerunFailedJobs').mockResolvedValue();
    if (reject) rerun.mockRejectedValue(new Error('Access denied'));
    const events = vi.spyOn(s, 'broadcast');
    const merge = vi.spyOn(s.backend, 'mergePull');
    if (reject) await expect(s.advanceMerge(repo, rec, pr)).rejects.toThrow('Access denied');
    else await s.advanceMerge(repo, rec, pr);
    expect(rerun).toHaveBeenCalledExactlyOnceWith(repo.fullName, [42]);
    expect(rec).toMatchObject({ status: 'passed', checkRerunSha: pull.headSha, checkRerunAt: Date.now(), mergeFixes: 0 });
    expect(events).toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ checkRerunSha: pull.headSha, checkRerunAt: Date.now() }) });
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    expect(swarm.snapshot().qa[0]).toMatchObject({ checkRerunSha: pull.headSha, checkRerunAt: Date.now() });
    await s.advanceMerge(repo, rec, pr);
    expect(rec.status).toBe('passed');
    vi.setSystemTime(Date.now() + CHECK_RERUN_GRACE_MS);
    await s.advanceMerge(repo, rec, pr);
    expect(rec).toMatchObject({ status: 'failed', fixReason: 'checks', mergeFixes: 1 });
    expect(rerun).toHaveBeenCalledOnce();
    expect(merge).not.toHaveBeenCalled();
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

    it('keeps failed QA findings in the re-test after a conflict fix', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      Object.assign(rec, { status: 'queued', round: 4, fixReason: 'conflict', passedSha: null, fixInstructions: 'Fix Chaser timing' });
      await s.runQa(tester, repo, rec);
      expect(session).toHaveBeenCalledOnce();
      expect(session.mock.calls[0][3]).toContain('Last round\'s findings:\nBroken\nFix Chaser timing');
      expect(session.mock.calls[0][3]).not.toContain('QA passed it before');
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
    it('retries an available fixer when the only fresh developer is held after a startup crash', async () => {
      const barbara = addAgent('a2', 'Barbara', 'dev', 1);
      fixCrashes(barbara);
      Object.assign(barbara, { status: 'error', endedAt: Date.now() });
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13, sessionId: null });
      Object.assign(rec, { status: 'fixing', devAgentId: 'a1' });
      await crashCli(ada);
      expect(ada.startupFailed).toBe(true);
      expect(rec).toMatchObject({ status: 'failed', fixCrashes: ['a2'] });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledExactlyOnceWith(barbara, repo, rec);
    });

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

    it('starts a fresh count once a fix is pushed', async () => {
      addAgent('a2', 'Barbara', 'dev', 1);
      fixCrashes(ada);
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      rec.status = 'fixing';
      await s.onFixFinished(ada, repo, result(true));
      expect(rec).toMatchObject({ status: 'queued', round: 3, fixCrashes: [] });
    });
  });

  describe('a fix that ends well', () => {
    const head = (sha: string) => vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, headSha: sha, body: '', isCrossRepository: false });
    const fixEnds = async (dev: Record<string, unknown>) => {
      Object.assign(dev, { status: 'working', task: 'fix', prNumber: 13 });
      Object.assign(rec, { status: 'fixing', devAgentId: dev.id, fixReason: 'qa' });
      await s.onFixFinished(dev, repo, result(true));
    };

    it('goes back to QA for the next round when it pushed a commit', async () => {
      head('sha-2');
      await fixEnds(ada);
      expect(rec).toMatchObject({ status: 'queued', round: 3, fixCrashes: [] });
      expect(ada.status).toBe('done');
    });

    it("doesn't count as pushed, or start a QA round, when the head didn't move; then goes to a human", async () => {
      const barbara = addAgent('a2', 'Barbara', 'dev', 1);
      const phone = vi.spyOn(s, 'postMessage');
      head('sha-0');
      await fixEnds(ada);
      expect(rec).toMatchObject({ status: 'failed', round: 2, fixCrashes: ['a1'] });
      expect(ada).toMatchObject({ status: 'error', lastError: 'No new commits were pushed for PR #13' });
      expect(s.agentRt.get('a1')!.log).toContainEqual(expect.objectContaining({ kind: 'error', text: '✗ No new commits were pushed for PR #13' }));
      ada.status = 'idle';
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledExactlyOnceWith(barbara, repo, rec); // someone who hasn't failed on it
      await fixEnds(barbara);
      expect(rec).toMatchObject({ status: 'needs-human', round: 2, fixCrashes: ['a1', 'a2'], mergeNote: 'the fix was never pushed' });
      expect(phone).toHaveBeenCalledWith('office', expect.stringContaining('ended without pushing a commit'));
      await swarm.sendToQa(repo.id, 13); // the manager's retry clears the note
      expect(rec).toMatchObject({ status: 'queued', round: 3, mergeNote: null });
    });

    // Save the state file, then start a new office from it (no floors or people, so nothing else loads).
    const restartFromDisk = async () => {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
      vi.spyOn(fs, 'rename').mockResolvedValue();
      await (s as unknown as { writeState(): Promise<void> }).writeState();
      const persisted = JSON.parse(String(write.mock.calls.at(-1)![1]));
      Object.assign(persisted, { repos: [], agents: [] });
      const fresh = new Swarm(createDemoBackend());
      const restored = fresh as unknown as Internals;
      restored.backend.demo = false;
      vi.spyOn(restored, 'save').mockImplementation(() => {});
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(persisted));
      await fresh.init();
      return restored.state.qa;
    };

    it.each([
      ['qa', 'the fix was never pushed'],
      ['conflict', 'the conflict was never resolved'],
    ] as const)('keeps why an unpushed %s fix needs the manager through a restart', async (fixReason, note) => {
      addAgent('a2', 'Barbara', 'dev', 1);
      head('sha-0');
      Object.assign(rec, { passedSha: fixReason === 'conflict' ? 'sha-0' : null, fixCrashes: ['a2'] });
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      Object.assign(rec, { status: 'fixing', devAgentId: 'a1', fixReason });
      await s.onFixFinished(ada, repo, result(true));
      expect(rec).toMatchObject({ status: 'needs-human', mergeNote: note });
      const [loaded] = await restartFromDisk();
      expect(loaded).toMatchObject({ status: 'needs-human', round: 2, fixCrashes: ['a2', 'a1'], mergeNote: note });
    });

    it('still forgets merge progress on a restart', async () => {
      Object.assign(rec, { status: 'passed', passedSha: 'sha-1', mergeNote: 'waiting for checks: CI', ciRequired: true });
      const [loaded] = await restartFromDisk();
      expect(loaded).toMatchObject({ status: 'passed', mergeNote: null, ciRequired: true });
    });

    it('defaults missing retry fields from older state files', async () => {
      const [loaded] = await restartFromDisk();
      expect(loaded).toMatchObject({ checkRerunSha: null, checkRerunAt: null });
    });

    it('preserves a check retry across a restart', async () => {
      Object.assign(rec, { checkRerunSha: 'sha-1', checkRerunAt: Date.now() });
      const [loaded] = await restartFromDisk();
      expect(loaded).toMatchObject({ checkRerunSha: 'sha-1', checkRerunAt: Date.now() });
    });

    it("takes the session at its word when the PR's head can't be read", async () => {
      vi.spyOn(s.backend, 'prDetails').mockRejectedValue(new Error('gh: HTTP 502'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await fixEnds(ada);
      expect(rec).toMatchObject({ status: 'queued', round: 3 });
      expect(s.agentRt.get('a1')!.log).toContainEqual(expect.objectContaining({ text: expect.stringContaining('Could not check PR #13 for new commits') }));
    });

    it('lets a checks fix re-run CI without a commit', async () => {
      const details = head('sha-0');
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      Object.assign(rec, { status: 'fixing', fixReason: 'checks', passedSha: 'sha-0' });
      await s.onFixFinished(ada, repo, result(true));
      expect(details).not.toHaveBeenCalled();
      expect(rec).toMatchObject({ status: 'passed', round: 2, mergeNote: 'waiting for fresh checks' });
    });

    it('changes nothing when the task moved on while the head was read', async () => {
      let answer!: (sha: string) => void;
      vi.spyOn(s.backend, 'prDetails').mockImplementation(() => new Promise((r) => (answer = (sha) => r({ ...pull, headSha: sha, body: '', isCrossRepository: false }))));
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      Object.assign(rec, { status: 'fixing', devAgentId: 'a1', fixReason: 'qa' });
      const ending = s.onFixFinished(ada, repo, result(true));
      s.clearTask(ada);
      answer('sha-0');
      await ending;
      expect(rec).toMatchObject({ status: 'fixing', fixCrashes: [] });
    });
  });

  describe('detailed security review on a QA desk', () => {
    it.each(['automatic', 'manual'] as const)('sends back criss-cross history even when all merge bases still match the audit base (%s merge)', async (route) => {
      const pr = { ...pull, labels: [], baseSha: 'B1', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => {
        if (head === 'B1') return { aheadBy: 2, behindBy: 0, mergeBaseSha: 'B0', files: ['guard.txt'] };
        // The side commit predates B0; H and B1 share it, but all comparisons report B0.
        return { aheadBy: base === 'B0' ? 4 : 3, behindBy: base === 'B0' ? 0 : 1, mergeBaseSha: 'B0', files: ['pr.txt'] };
      });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment');
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      Object.assign(rec, { status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha, mergeFixes: 1,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'B0' } });
      if (route === 'automatic') expect(await s.advanceMerge(repo, rec, pr)).toBe(false);
      else await expect(swarm.mergePull(repo.id, pr.number)).rejects.toThrow('requires a passing security review');
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', mergeFixes: 1, round: 2, retests: 0 });
      expect(merge).not.toHaveBeenCalled();
    });

    it.each(['automatic', 'manual'] as const)('sends back a clean disjoint advance when a merged and reverted side branch changes the real merge base (%s merge)', async (route) => {
      const pr = { ...pull, labels: [], baseSha: 'B1', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      const compare = vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => {
        if (head === 'B1') return { aheadBy: 3, behindBy: 0, mergeBaseSha: 'B0', files: ['g', 'q'] };
        // H merged G1 (g=fixed), reverted g, and changed p. B1 then merged G1 without squashing.
        return base === 'B0'
          ? { aheadBy: 3, behindBy: 0, mergeBaseSha: 'B0', files: ['p'] }
          : { aheadBy: 2, behindBy: 2, mergeBaseSha: 'G1', files: ['g', 'p'] };
      });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment');
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      Object.assign(rec, { status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha, mergeFixes: 1,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'B0' } });
      if (route === 'automatic') expect(await s.advanceMerge(repo, rec, pr)).toBe(false);
      else await expect(swarm.mergePull(repo.id, pr.number)).rejects.toThrow('requires a passing security review');
      expect(compare).toHaveBeenCalledWith(repo.fullName, 'B1', pull.headSha);
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', mergeFixes: 1, round: 2, retests: 0 });
      expect(merge).not.toHaveBeenCalled();
    });

    it('merges a passed security review after a disjoint docs-only base advance', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-2', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      const compare = vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => ({
        aheadBy: 1, behindBy: base === 'base-2' ? 1 : 0, mergeBaseSha: 'base-1', files: head === 'base-2' ? ['docs/research/billing.md'] : ['server/billing.ts'],
      }));
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      const comment = vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment');
      Object.assign(rec, {
        status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha, mergeFixes: 2,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' },
      });
      // A fresh board sync must defer the base decision until the exact comparisons are available.
      Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now() });
      s.reconcilePulls(repo, [pr]);
      expect(rec.status).toBe('passed');
      expect(await s.advanceMerge(repo, rec, pr)).toBe(true);
      expect(compare).toHaveBeenCalledWith(repo.fullName, 'base-1', 'base-2');
      expect(compare).toHaveBeenCalledWith(repo.fullName, 'base-1', pull.headSha);
      expect(compare).toHaveBeenCalledWith(repo.fullName, 'base-2', pull.headSha);
      expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', pull.headSha);
      expect(rec).toMatchObject({ status: 'passed', round: 2, retests: 0, mergeFixes: 2, securityReview: { auditBaseSha: 'base-2' } });
      expect(comment).toHaveBeenCalledWith(repo.fullName, 13, expect.stringContaining('base advanced by 1 commits touching no PR files; security pass carried to base-2'));
      expect(runFix).not.toHaveBeenCalled();
    });

    it('does not charge a base-only send-back or its reconciliation to the fix and QA budgets', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-2', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      Object.assign(rec, {
        status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha, mergeFixes: MAX_MERGE_FIXES,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' },
      });
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', mergeFixes: MAX_MERGE_FIXES, round: 2, retests: 0 });
      Object.assign(ada, { status: 'working', task: 'fix', prNumber: 13 });
      Object.assign(rec, { status: 'fixing' });
      vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pr, headSha: 'reconciled-head' });
      await s.onFixFinished(ada, repo, result(true));
      expect(rec).toMatchObject({ status: 'queued', mergeFixes: MAX_MERGE_FIXES, round: 2, retests: 0 });
    });

    it.each(['overlap', 'conflict', 'conflict with unavailable comparison', 'unknown', 'moved again', 'head changed', 'unavailable', 'current comparison unavailable'] as const)('does not carry a security pass on a fresh %s result', async (outcome) => {
      const pr = { ...pull, labels: [], baseSha: 'base-2', body: '', isCrossRepository: false };
      const details = vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      const compare = vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base) => ({ aheadBy: 1, behindBy: base === 'base-2' ? 1 : 0, mergeBaseSha: 'base-1', files: ['server/billing.ts'] }));
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      const comment = vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment');
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      Object.assign(rec, {
        status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha, mergeFixes: 1,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' },
      });
      // The listed PR and first details read say CLEAN; the comparison must use a newer details read.
      if (outcome.startsWith('conflict')) details.mockResolvedValue({ ...pr, mergeable: 'CONFLICTING', mergeState: 'DIRTY' }).mockResolvedValueOnce(pr);
      if (outcome === 'unknown') details.mockResolvedValue({ ...pr, mergeable: 'UNKNOWN' }).mockResolvedValueOnce(pr);
      if (outcome === 'moved again') details.mockResolvedValue({ ...pr, baseSha: 'base-3' }).mockResolvedValueOnce(pr);
      if (outcome === 'head changed') details.mockResolvedValue({ ...pr, headSha: 'sha-2' }).mockResolvedValueOnce(pr);
      if (outcome.includes('unavailable')) compare.mockRejectedValue(new Error('HTTP 503'));
      if (outcome === 'current comparison unavailable') compare.mockImplementation(async (_repo, base) => {
        if (base === 'base-2') throw new Error('HTTP 503');
        return { aheadBy: 1, behindBy: 0, mergeBaseSha: 'base-1', files: ['server/billing.ts'] };
      });
      expect(await s.advanceMerge(repo, rec, pr)).toBe(false);
      expect(merge).not.toHaveBeenCalled();
      if (outcome.startsWith('conflict')) {
        expect(rec).toMatchObject({ status: 'failed', fixReason: 'conflict', mergeFixes: 2 });
        expect(comment).toHaveBeenCalledWith(repo.fullName, 13, expect.stringContaining('PR conflicts with'));
      } else if (outcome === 'overlap') {
        expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', mergeFixes: 1, round: 2, retests: 0 });
        expect(comment).toHaveBeenCalledWith(repo.fullName, 13, expect.stringContaining('base reconciliation and review required'));
      } else {
        expect(rec).toMatchObject({ status: 'passed', securityReview: { auditBaseSha: 'base-1' }, mergeFixes: 1 });
      }
    });

    it('leaves ordinary PRs on their existing merge path', async () => {
      vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, labels: [], baseSha: 'base-2', body: '', isCrossRepository: false });
      Object.assign(rec, { status: 'passed', passedSha: pull.headSha });
      const compare = vi.spyOn(s.backend, 'compareFiles');
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      expect(await s.advanceMerge(repo, rec, pull)).toBe(true);
      expect(merge).toHaveBeenCalledOnce();
      expect(compare).not.toHaveBeenCalled();
    });

    const auditChecks: QaCheck[] = ['Scoped audit coverage', 'validate-findings.cjs', 'validate-coverage-ledger.cjs']
      .map((name) => ({ name, result: 'pass', details: 'Complete for the assigned diff' }));

    const sandboxReport = {
      verdict: 'incomplete', summary: 'Source review found no blocking findings.',
      validationGap: 'no-os-sandbox', normalGatesPassed: true, blockingFindings: 'none',
      checks: [...auditChecks, { name: 'Dynamic validation', result: 'skip' as const, details: 'No OS sandbox on this desk.' }],
    };
    it.each([
      ['no-os-sandbox', 'none', 'pass'],
      ['other', 'none', 'incomplete'],
      ['no-os-sandbox', 'confirmed', 'fail'],
      ['no-os-sandbox', 'needs_validation', 'incomplete'],
    ] as const)('normalizes %s with %s findings without mutating the report', (validationGap, blockingFindings, verdict) => {
      const input = Object.freeze({ ...sandboxReport, verdict: 'incomplete' as const, validationGap, blockingFindings, commands: [], screenshots: [] });
      const normalized = securityReportOutcome(input);
      expect(normalized.verdict).toBe(verdict);
      expect(input.verdict).toBe('incomplete');
      expect(input.summary).toBe(sandboxReport.summary);
    });
    const securityDesk = async () => {
      const tester = addAgent('q2', 'Morse', 'qa', 1);
      Object.assign(tester, { cli: 'codex' });
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(pr);
      vi.spyOn(s.backend, 'deskHead').mockResolvedValue(pr.headSha);
      vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
      const session = vi.spyOn(s, 'startAgentSession').mockImplementation((agent) => {
        Object.assign(agent as object, { status: 'working', sessionId: 'qa-session' });
      });
      const comment = vi.spyOn(s.backend, 'commentPull');
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      Object.assign(rec, { status: 'passed', passedSha: pull.headSha, testedSha: pull.headSha });
      s.reconcilePulls(repo, [pr]);
      await s.runQa(tester, repo, rec);
      expect(rec).toHaveProperty('securityReview.auditBaseSha', 'base-1');
      return { tester, comment, session };
    };

    it.each(['a changed merge base', 'criss-cross history'] as const)('rejects %s when completing a passing audit', async (history) => {
      const { tester, comment } = await securityDesk();
      const crissCross = history === 'criss-cross history';
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-2', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockResolvedValue(pr);
      vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => {
        if (head === 'base-2') return { aheadBy: crissCross ? 2 : 3, behindBy: 0, mergeBaseSha: 'base-1', files: ['g', 'q'] };
        return base === 'base-1'
          ? { aheadBy: crissCross ? 4 : 3, behindBy: 0, mergeBaseSha: 'base-1', files: ['p'] }
          : { aheadBy: crissCross ? 3 : 2, behindBy: crissCross ? 1 : 2, mergeBaseSha: crissCross ? 'base-1' : 'G1', files: crissCross ? ['p'] : ['g', 'p'] };
      });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Audit passed', checks: auditChecks }));
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', round: 2, retests: 0 });
      expect(comment).toHaveBeenCalledWith(repo.fullName, 13, expect.stringContaining('base reconciliation and review required'));
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(merge).not.toHaveBeenCalled();
    });

    it.each(['during audit', 'during report publication'] as const)('keeps a passing audit when a disjoint base advance happens %s', async (timing) => {
      const { tester, comment } = await securityDesk();
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: timing === 'during audit' ? 'base-2' : 'base-1', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockImplementation(async () => ({ ...pr }));
      vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => ({
        aheadBy: 2, behindBy: base === 'base-2' ? 2 : 0, mergeBaseSha: 'base-1', files: head === 'base-2' ? ['docs/research/team.md'] : ['server/billing.ts'],
      }));
      comment.mockImplementation(async () => { pr.baseSha = 'base-2'; return 'comment-url'; });
      await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Audit passed', checks: auditChecks }));
      expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha, round: 2, retests: 0,
        securityReview: { approvedSha: pull.headSha, auditBaseSha: 'base-2' } });
      expect(comment).toHaveBeenCalledWith(repo.fullName, 13, expect.stringContaining('base advanced by 2 commits touching no PR files; security pass carried to base-2'));
    });

    it.each(['unknown mergeability', 'comparison outage'] as const)('keeps a completed audit for merge-gate retry after %s', async (outcome) => {
      const { tester, comment } = await securityDesk();
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-2', body: '', isCrossRepository: false,
        mergeable: outcome === 'unknown mergeability' ? 'UNKNOWN' : 'MERGEABLE' };
      vi.mocked(s.backend.prDetails).mockImplementation(async () => ({ ...pr }));
      const compare = vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => ({
        aheadBy: 1, behindBy: base === 'base-2' ? 1 : 0, mergeBaseSha: 'base-1', files: head === 'base-2' ? ['docs/research/team.md'] : ['server/billing.ts'],
      }));
      const disjoint = compare.getMockImplementation()!;
      if (outcome === 'comparison outage') compare.mockRejectedValue(new Error('HTTP 503'));
      comment.mockResolvedValue('comment-url');
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'Audit passed', checks: auditChecks }));
      expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha, round: 2, retests: 0,
        securityReview: { approvedSha: pull.headSha, auditBaseSha: 'base-1' }, mergeNote: 'waiting to verify the security review base advance' });
      pr.mergeable = 'MERGEABLE';
      pr.labels = [];
      compare.mockImplementation(disjoint);
      expect(await s.advanceMerge(repo, rec, pr)).toBe(true);
      expect(rec).toHaveProperty('securityReview.auditBaseSha', 'base-2');
      expect(merge).toHaveBeenCalledOnce();
      expect(runFix).not.toHaveBeenCalled();
    });

    it('records the verified carry before commenting and holds if the base moves again during publication', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-2', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockImplementation(async () => ({ ...pr }));
      vi.spyOn(s.backend, 'compareFiles').mockImplementation(async (_repo, base, head) => ({
        aheadBy: 1, behindBy: base === 'base-2' ? 1 : 0, mergeBaseSha: 'base-1', files: head === 'base-2' ? ['docs/research/team.md'] : ['server/billing.ts'],
      }));
      Object.assign(rec, { status: 'passed', passedSha: pull.headSha,
        securityReview: { reason: 'Auth', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' } });
      vi.spyOn(s.backend, 'commentPull').mockImplementation(async () => {
        expect(rec).toHaveProperty('securityReview.auditBaseSha', 'base-2');
        pr.baseSha = 'base-3';
        return 'comment-url';
      });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      expect(await s.advanceMerge(repo, rec, { ...pr })).toBe(false);
      expect(merge).not.toHaveBeenCalled();
      expect(rec).toMatchObject({ status: 'passed', securityReview: { auditBaseSha: 'base-2' } });
    });

    it.each(['pass', 'incomplete'])('passes a Codex sandbox-only %s review without charging a QA round', async (verdict) => {
      const { tester, comment, session } = await securityDesk();
      expect(session.mock.calls[0][4]).toContain('No OS sandbox alone is a known desk limit');
      await s.onQaFinished(tester, repo, result(true, { ...sandboxReport, verdict }));
      expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha, round: 2, retests: 0 });
      expect(comment.mock.calls.at(-1)?.[2]).toContain('Security review report: ✅ Passed');
      expect(comment.mock.calls.at(-1)?.[2]).toContain('dynamic validation not run: no OS sandbox on this desk');
      expect(rec.summary).toContain('dynamic validation not run: no OS sandbox on this desk');
    });

    it('completes the demo backend security path with the disclosed sandbox limit', async () => {
      const { tester, session, comment } = await securityDesk();
      const finished = vi.fn();
      const handle = s.backend.startSession({
        cwd: '/fake-desk', prompt: String(session.mock.calls[0][3]), systemAppend: String(session.mock.calls[0][4]),
        role: 'qa', model: 'demo', effort: 'low', browserTesting: false, additionalDirectories: [],
      }, { log: vi.fn(), tool: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), sessionId: vi.fn(), finished });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(finished).toHaveBeenCalledOnce();
      handle.stop();
      await s.onQaFinished(tester, repo, finished.mock.calls[0][0]);
      expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha });
      expect(comment.mock.calls.at(-1)?.[2]).toContain('dynamic validation not run: no OS sandbox on this desk');
    });

    it('keeps the CI requirement from ordinary QA after a passing security audit', async () => {
      const { tester } = await securityDesk();
      Object.assign(rec, { ciRequired: true });
      await s.onQaFinished(tester, repo, result(true, sandboxReport));
      expect(rec).toMatchObject({ status: 'passed', ciRequired: true });
    });

    it.each(['available', 'stopped', 'startup failed', 'removed'])('retries a sandbox-only incomplete report once when the alternate is %s', async (availability) => {
      const { tester, comment } = await securityDesk();
      const alternate = addAgent('q3', 'Marple', 'qa', 2);
      const events = vi.spyOn(s, 'broadcast');
      await s.onQaFinished(tester, repo, result(true, sandboxReport));
      expect(rec).toMatchObject({ status: 'queued', round: 2, retests: 0, passedSha: null,
        securitySandboxRetry: { headSha: pull.headSha, baseSha: 'base-1', agentId: 'q3' } });
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'qa', qa: expect.objectContaining({ securitySandboxRetry: expect.objectContaining({ agentId: 'q3' }) }) }));
      expect(comment.mock.calls.at(-1)?.[2]).toContain('no human action needed');
      expect(comment.mock.calls.at(-1)?.[2]).toContain('dynamic validation not run: no OS sandbox on this desk');
      if (availability === 'stopped') alternate.status = 'stopped';
      if (availability === 'startup failed') alternate.startupFailed = true;
      if (availability === 'removed') s.state.agents = s.state.agents.filter((a) => a !== alternate);
      const nextTester = availability === 'available' ? alternate : tester;
      const run = vi.spyOn(s, 'runQa');
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(run).toHaveBeenLastCalledWith(nextTester, repo, rec);
      await run.mock.results.at(-1)?.value;
      // The original tester is free, but this revision has already had its one environment retry.
      await s.onQaFinished(nextTester, repo, result(true, sandboxReport));
      expect(rec).toMatchObject({ status: 'passed', round: 2, retests: 0, passedSha: pull.headSha });
      expect(comment.mock.calls.at(-1)?.[2]).toContain('Security review report: ✅ Passed');
    });

    describe('when the desk runs out of memory', () => {
      const oom: QaCheck = { name: 'Dynamic validation', result: 'skip', failureKind: 'resources', details: 'Suite cancelled under memory pressure.',
        resources: { freeMemory: '0.8 GB', swap: '0 B', load: '61', cancelled: 204 } };
      const oomReport = { ...sandboxReport, verdict: 'incomplete', validationGap: 'other',
        checks: [...auditChecks.filter((c) => c.name !== 'validate-findings.cjs'), { ...oom, name: 'validate-findings.cjs' }, oom] };
      const note = 'QA desk ran out of memory (free 0.8 GB, swap 0 B, load 61, 204 tests cancelled); not charged a round';

      it('recognizes resource-only audits and words them as such', () => {
        const report = { ...oomReport, verdict: 'incomplete' as const, validationGap: 'other' as const, blockingFindings: 'none' as const, commands: [], screenshots: [] };
        expect(resourceOnlyAudit(report)).toBe(true);
        expect(resourceOnlyAudit({ ...report, blockingFindings: 'needs_validation' })).toBe(false);
        expect(resourceOnlyAudit({ ...report, checks: [...report.checks, { name: 'Auth', result: 'fail', failureKind: 'code', details: 'Bypass' }] })).toBe(false);
        expect(resourceOnlyAudit({ ...report, checks: report.checks.filter((c) => c.name !== 'Scoped audit coverage') })).toBe(false);
        expect(resourceNote(report.checks)).toBe(note);
        expect(resourceNote([{ ...oom, resources: undefined }])).toBe('QA desk ran out of memory; not charged a round');
      });

      it('retries once without charging a round, then needs green checks instead of a human', async () => {
        const { tester, comment } = await securityDesk();
        const alternate = addAgent('q3', 'Marple', 'qa', 2);
        await s.onQaFinished(tester, repo, result(true, oomReport));
        expect(rec).toMatchObject({ status: 'queued', round: 2, retests: 0, passedSha: null, failedSha: null,
          resourceRetry: { headSha: pull.headSha, agentId: 'q2' }, mergeNote: `${note}; retrying once` });
        expect(comment.mock.calls.at(-1)?.[2]).toContain('no QA round charged');
        expect(comment.mock.calls.at(-1)?.[2]).not.toMatch(/timed out/);
        const run = vi.spyOn(s, 'runQa');
        expect(s.startPipelineWork(repo)).toBe(true);
        expect(run).toHaveBeenLastCalledWith(alternate, repo, rec);
        await run.mock.results.at(-1)?.value;
        await s.onQaFinished(alternate, repo, result(true, oomReport));
        expect(rec).toMatchObject({ status: 'passed', round: 2, retests: 0, passedSha: pull.headSha, ciRequired: true, mergeNote: note });
        expect(rec).toHaveProperty('securityReview.approvedSha', pull.headSha);
        const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
        expect(await s.advanceMerge(repo, rec, { ...pull, state: 'OPEN', checks: 'none', hasSuccessfulChecks: false })).toBe(false);
        expect(rec.mergeNote).toBe('waiting for passing GitHub checks to cover environment-blocked local validation');
        expect(merge).not.toHaveBeenCalled();
        // The office removed the security label when the review passed.
        vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, baseSha: 'base-1', body: '', isCrossRepository: false });
        expect(await s.advanceMerge(repo, rec, { ...pull, state: 'OPEN', checks: 'passing', hasSuccessfulChecks: true })).toBe(true);
        expect(merge).toHaveBeenCalled();
      });

      it("waits for the floor's other QA session rather than retry on the same desk beside it", async () => {
        const { tester } = await securityDesk();
        await s.onQaFinished(tester, repo, result(true, oomReport));
        const busy = addAgent('q3', 'Marple', 'qa', 2);
        Object.assign(busy, { status: 'working', task: 'qa', prNumber: 99 });
        const run = vi.spyOn(s, 'runQa');
        expect(s.startPipelineWork(repo)).toBe(false);
        Object.assign(busy, { status: 'done' });
        expect(s.startPipelineWork(repo)).toBe(true);
        expect(run).toHaveBeenLastCalledWith(busy, repo, rec);
      });

      it('still fails a code defect found in the same run', async () => {
        const { tester } = await securityDesk();
        await s.onQaFinished(tester, repo, result(true, { ...oomReport, verdict: 'fail', blockingFindings: 'confirmed',
          checks: [...oomReport.checks, { name: 'Tenant boundary', result: 'fail', failureKind: 'code', details: 'Reads another tenant.' }],
          fixInstructions: 'Check the tenant.' }));
        expect(rec).toMatchObject({ status: 'failed', passedSha: null });
        expect(rec).not.toHaveProperty('resourceRetry');
      });
    });

    it.each([
      ['confirmed', 'high', 'failed'], ['confirmed', 'critical', 'failed'],
      ['needs_validation', 'high', 'needs-human'], ['needs_validation', 'critical', 'needs-human'],
    ])('holds a %s %s finding despite a sandbox limit', async (blockingFindings, severity, status) => {
      const { tester, comment } = await securityDesk();
      await s.onQaFinished(tester, repo, result(true, {
        ...sandboxReport, verdict: 'pass', blockingFindings, summary: `${severity} boundary violation`,
        fixInstructions: 'Enforce the tenant boundary before reading the record.',
      }));
      expect(rec).toMatchObject({ status, passedSha: null });
      expect(comment.mock.calls.at(-1)?.[2]).not.toContain('Security review report: ✅ Passed');
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
    });

    it.each(['other gap', 'QA gates failed', 'QA gates unknown', 'findings unknown', 'missing validator', 'skipped validator', 'extra gap', 'explicit failure'])('does not waive %s as a sandbox limit', async (gap) => {
      const { tester } = await securityDesk();
      const report = { ...sandboxReport, verdict: 'pass', normalGatesPassed: true as boolean | undefined,
        blockingFindings: 'none' as string | undefined, checks: [...sandboxReport.checks] };
      if (gap === 'other gap') report.validationGap = 'other';
      if (gap === 'QA gates failed') report.normalGatesPassed = false;
      if (gap === 'QA gates unknown') report.normalGatesPassed = undefined;
      if (gap === 'findings unknown') report.blockingFindings = undefined;
      if (gap === 'missing validator') report.checks = report.checks.filter((c) => c.name !== 'validate-findings.cjs');
      if (gap === 'skipped validator') report.checks = report.checks.map((c) => c.name === 'validate-findings.cjs' ? { ...c, result: 'skip' } : c);
      if (gap === 'extra gap') report.checks.push({ name: 'Unreviewed authentication path', result: 'skip', details: 'Not covered' });
      if (gap === 'explicit failure') report.verdict = 'fail';
      await s.onQaFinished(tester, repo, result(true, report));
      expect(rec).toMatchObject({ status: gap === 'explicit failure' ? 'failed' : 'needs-human', passedSha: null, round: 2 });
    });

    it.each(['posted', 'crashed', 'new head', 'new base'] as const)('lets only a manager merge over an incomplete audit posted at its head and base: %s', async (variant) => {
      const { tester } = await securityDesk();
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      Object.assign(s.agentRt.get('q2')!, { qaResume: null });
      rec.sessionFailures = 1;
      await s.onQaFinished(tester, repo, variant === 'crashed' ? result(false) : result(true, { ...sandboxReport, validationGap: 'other' }));
      expect(rec).toMatchObject({ status: 'needs-human', testedSha: 'sha-1', passedSha: null });
      expect(rec.failedSha).not.toBe('sha-1');
      Object.assign(repo, { autoMerge: true });
      s.repoRt.get(repo.id)!.pulls = [{ ...pull, labels: ['ready-for-review'] }];
      await (s as unknown as { advanceMerges(repo: Repo): Promise<void> }).advanceMerges(repo);
      expect(merge).not.toHaveBeenCalled();
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      if (variant === 'new head' || variant === 'new base') {
        const moved = variant === 'new head' ? { headSha: 'sha-2' } : { baseSha: 'base-2' };
        vi.mocked(s.backend.prDetails).mockResolvedValue({ ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false, ...moved });
        s.repoRt.get(repo.id)!.pulls = [{ ...pull, labels: ['ready-for-review'], ...moved }];
      }
      const approved = swarm.mergePr({ floor: repo.floor, number: 13, reason: 'Manager requested merge; validation gaps accepted' });
      if (variant !== 'posted') {
        await expect(approved).rejects.toMatchObject({ status: 409 });
        expect(merge).not.toHaveBeenCalled();
        return;
      }
      expect(await approved).toContain('Merged PR #13');
      expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', 'sha-1');
    });

    it.each(['desk never started', 'stopped'] as const)("doesn't count regular QA's report as the audit's when the audit ends unrecorded: %s", async (variant) => {
      const tester = addAgent('q2', 'Morse', 'qa', 1);
      const pr = { ...pull, labels: [] as string[], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockImplementation(async () => pr);
      vi.spyOn(s.backend, 'deskHead').mockResolvedValue(pr.headSha);
      vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
      vi.spyOn(s, 'startAgentSession').mockImplementation((agent) => {
        Object.assign(agent as object, { status: 'working', sessionId: 'qa-session' });
      });
      vi.spyOn(s.backend, 'commentPull').mockResolvedValue('comment-url');
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockImplementation(async () => { pr.labels = ['ready-for-review']; });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      Object.assign(rec, { status: 'queued', failedSha: null, qaAgentId: null });
      await s.runQa(tester, repo, rec);
      await s.onQaFinished(tester, repo, result(true, { verdict: 'pass', summary: 'QA passed', checks: [], securityReviewReason: 'Changes authentication' }));
      expect(rec).toMatchObject({ securityReview: { qaSha: 'sha-1' }, passedSha: null });
      expect(s.state.qaOutcomes.at(-1)).toMatchObject({ verdict: 'pass', headSha: 'sha-1', baseSha: 'base-1', commentUrl: 'comment-url' });
      s.reconcilePulls(repo, [pr]);
      tester.status = 'idle';
      await s.runQa(tester, repo, rec);
      expect(rec).toHaveProperty('securityReview.auditBaseSha', 'base-1');
      if (variant === 'stopped') swarm.stopAgent('q2');
      else {
        rec.preparation = { qa: { headSha: 'sha-1', failures: 1, holds: 1, holdUntil: 0 } };
        s.jobDeskFailed(tester, repo, { rec, task: 'qa' }, 'Session never started on office: spawn');
      }
      expect(rec).toMatchObject({ status: 'needs-human', testedSha: 'sha-1', failedSha: null });
      s.repoRt.get(repo.id)!.pulls = [{ ...pull, labels: ['ready-for-review'] }];
      await expect(swarm.mergePr({ floor: repo.floor, number: 13, reason: 'Manager requested merge' })).rejects.toMatchObject({ status: 409 });
      expect(merge).not.toHaveBeenCalled();
    });

    it.each(['explicit fail', 'confirmed finding'] as const)('keeps a posted %s audit blocked when a later revision read fails', async (variant) => {
      const { tester, comment } = await securityDesk();
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      let posted = false;
      let failedRead = false;
      comment.mockImplementation(async () => { posted = true; return 'comment-url'; });
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.mocked(s.backend.prDetails).mockImplementation(async () => {
        if (posted && !failedRead) {
          failedRead = true;
          throw new Error('HTTP 502');
        }
        return pr;
      });
      await s.onQaFinished(tester, repo, result(true, {
        ...sandboxReport, checks: auditChecks, validationGap: 'none', summary: 'Tenant boundary bypass',
        ...(variant === 'explicit fail' ? { verdict: 'fail' } : { verdict: 'pass', blockingFindings: 'confirmed' }),
      }));
      expect(failedRead).toBe(true);
      expect(rec).toMatchObject({ status: 'needs-human', testedSha: 'sha-1', failedSha: 'sha-1', commentUrl: 'comment-url' });
      s.repoRt.get(repo.id)!.pulls = [{ ...pull, labels: ['ready-for-review'] }];
      await expect(swarm.mergePr({ floor: repo.floor, number: 13, reason: 'Manager requested merge' })).rejects.toMatchObject({ status: 409 });
      expect(merge).not.toHaveBeenCalled();
    });

    it.each(['explicit fail', 'confirmed finding'] as const)('keeps a posted %s audit blocked when the manager stops it during the last revision read', async (variant) => {
      const { tester, comment } = await securityDesk();
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
      let readsAfterPost = -1;
      comment.mockImplementation(async () => { readsAfterPost = 0; return 'comment-url'; });
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      // The send-back check reads the PR first; the evidence's revision read comes last.
      vi.mocked(s.backend.prDetails).mockImplementation(async () => {
        if (readsAfterPost >= 0 && ++readsAfterPost === 2) swarm.stopAgent('q2');
        return pr;
      });
      await s.onQaFinished(tester, repo, result(true, {
        ...sandboxReport, checks: auditChecks, validationGap: 'none', summary: 'Tenant boundary bypass',
        ...(variant === 'explicit fail' ? { verdict: 'fail' } : { verdict: 'pass', blockingFindings: 'confirmed' }),
      }));
      expect(readsAfterPost).toBe(2);
      expect(tester).toMatchObject({ status: 'stopped' });
      expect(rec).toMatchObject({ status: 'needs-human', testedSha: 'sha-1' });
      expect(s.state.qaOutcomes.at(-1)).toMatchObject({ commentUrl: null });
      s.repoRt.get(repo.id)!.pulls = [{ ...pull, labels: ['ready-for-review'] }];
      await expect(swarm.mergePr({ floor: repo.floor, number: 13, reason: 'Manager requested merge' })).rejects.toMatchObject({ status: 409 });
      expect(merge).not.toHaveBeenCalled();
    });

    it('queues a labeled PR that already passed regular QA, even when automatic merge is off', () => {
      Object.assign(rec, { status: 'passed', passedSha: pull.headSha, testedSha: pull.headSha });
      s.reconcilePulls(repo, [{ ...pull, labels: ['ready-for-review'] }]);
      expect(rec).toMatchObject({ status: 'queued', mergeNote: 'waiting for detailed security review' });
    });

    it.each(['pass', 'fail', 'incomplete', 'missing checks', 'skipped check', 'failed check', 'missing evidence', 'extra skipped check', 'changed head', 'changed base', 'publication failed'] as const)('keeps merge eligibility tied to the specialist outcome: %s', async (outcome) => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      const pr = { ...pull, labels: [] as string[], baseSha: 'base-1', body: '', isCrossRepository: false };
      const details = vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
      vi.spyOn(s.backend, 'deskHead').mockImplementation(async () => pr.headSha);
      vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
      const session = vi.spyOn(s, 'startAgentSession').mockImplementation((agent) => {
        Object.assign(agent as object, { status: 'working', sessionId: 'qa-session' });
      });
      const label = vi.spyOn(s.backend, 'setSecurityReviewLabel').mockImplementation(async (_repo, _number, present) => {
        pr.labels = present ? ['ready-for-review'] : [];
      });
      const comment = vi.spyOn(s.backend, 'commentPull');
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      rec.status = 'queued';
      await s.runQa(tester, repo, rec);
      await s.onQaFinished(tester, repo, result(true, {
        verdict: 'pass', summary: 'QA passed', checks: [], securityReviewReason: 'Changed session authentication.',
      }));
      expect(rec).toMatchObject({ status: 'queued', passedSha: null });
      expect(label).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, true);
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      await s.runQa(tester, repo, rec);
      expect(session.mock.calls[1][4]).toMatch(/Security review specialism/);
      expect(session.mock.calls[1][4]).toContain('base-1');
      expect(session.mock.calls[1][5]).toBeUndefined();
      if (outcome === 'changed head') pr.headSha = 'sha-2';
      if (outcome === 'changed base') pr.baseSha = 'base-2';
      if (outcome === 'publication failed') comment.mockRejectedValueOnce(new Error('Unavailable'));
      let checks = auditChecks;
      if (outcome === 'missing checks') checks = auditChecks.slice(0, 1);
      if (outcome === 'skipped check' || outcome === 'failed check') {
        checks = auditChecks.map((c) => c.name === 'validate-findings.cjs'
          ? { ...c, result: outcome === 'skipped check' ? 'skip' : 'fail', details: 'PASS' } : c);
      }
      if (outcome === 'missing evidence') checks = auditChecks.map((c) => c.name === 'validate-findings.cjs' ? { ...c, details: '  ' } : c);
      if (outcome === 'extra skipped check') checks = [...auditChecks, { name: 'Additional audit check', result: 'skip', details: 'Not run' }];
      await s.onQaFinished(tester, repo, result(true, {
        verdict: outcome === 'incomplete' || outcome === 'fail' ? outcome : 'pass', summary: 'Audit report',
        checks,
      }));
      if (outcome !== 'pass') {
        expect(label).toHaveBeenCalledTimes(1);
        expect(rec.status).toBe(outcome === 'changed head' ? 'queued' : outcome === 'fail' || outcome === 'changed base' ? 'failed' : 'needs-human');
        if (outcome === 'skipped check') expect(rec).toMatchObject({
          summary: 'Required audit checks missing or not passing: validate-findings.cjs (skip). Audit report',
          mergeNote: 'Required audit checks missing or not passing: validate-findings.cjs (skip). Audit report',
        });
        if (outcome === 'missing checks') expect(rec.summary).toBe('Required audit checks missing or not passing: validate-findings.cjs (missing), validate-coverage-ledger.cjs (missing). Audit report');
        if (outcome === 'failed check') expect(rec.summary).toContain('validate-findings.cjs (fail)');
        if (outcome === 'missing evidence') expect(rec.summary).toContain('validate-findings.cjs (missing details)');
        if (outcome === 'extra skipped check') expect(rec.summary).toContain('Additional audit check (skip)');
        if (outcome === 'changed base') expect(rec).toMatchObject({ fixReason: 'base', fixInstructions: expect.stringContaining('base-2') });
        await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
        expect(merge).not.toHaveBeenCalled();
        return;
      }
      expect(label).toHaveBeenLastCalledWith(repo.fullName, 13, false);
      expect(rec).toMatchObject({ status: 'passed', passedSha: 'sha-1' });
      // A pull list fetched during the audit can still show the label after the office clears it.
      await s.advanceMerge(repo, rec, { ...pull, labels: ['ready-for-review'] });
      expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', 'sha-1');
      merge.mockClear();
      details.mockResolvedValue({ ...pr, baseSha: 'base-2' });
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', fixInstructions: expect.stringContaining('base-2') });
      expect(merge).not.toHaveBeenCalled();
      expect(s.startPipelineWork(repo)).toBe(true);
      expect(runFix).toHaveBeenCalledExactlyOnceWith(ada, repo, rec);
    });

    it('keeps the security requirement when a closed PR is reopened with a different head', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-1', body: '', isCrossRepository: false };
      const details = vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pr, state: 'CLOSED' });
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      Object.assign(rec, {
        status: 'passed', testedSha: pr.headSha, passedSha: pr.headSha,
        securityReview: { reason: 'Changes authentication', qaSha: pr.headSha, approvedSha: pr.headSha, auditBaseSha: pr.baseSha },
      });
      const events = vi.spyOn(s, 'broadcast');
      await (s as unknown as { pruneUnlistedQa(repo: Repo, pulls: PullInfo[]): Promise<void> }).pruneUnlistedQa(repo, []);
      expect(events).toHaveBeenCalledWith({ type: 'qaRemoved', repoId: repo.id, prNumber: 13 });
      details.mockResolvedValue({ ...pr, headSha: 'sha-2' });
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      s.reconcilePulls(repo, [{ ...pr, headSha: 'sha-2' }]);
      expect(events).toHaveBeenCalledWith({ type: 'qa', qa: expect.objectContaining({ status: 'queued', prNumber: 13 }) });
      expect(merge).not.toHaveBeenCalled();
    });

    it('keeps a label request observed by manual merge before the PR had a QA record', async () => {
      s.state.qa = [];
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(s.state.qa[0]).toMatchObject({ status: 'queued', securityReview: { qaSha: null } });
      pr.labels = [];
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(merge).not.toHaveBeenCalled();
    });

    it('keeps a label request observed during ordinary QA after GitHub removes the label', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(pr);
      const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
      rec.status = 'testing';
      s.reconcilePulls(repo, [{ ...pr, labels: ['ready-for-review'] }]);
      await expect(swarm.mergePull(repo.id, 13)).rejects.toThrow('requires a passing security review');
      expect(rec.status).toBe('testing');
      expect(merge).not.toHaveBeenCalled();
    });

    it('honors a new security label between fallback attempts on an ordinary PR', async () => {
      const pr = { ...pull, labels: [] as string[], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
      const merge = vi.spyOn(s.backend, 'mergePull').mockImplementation(async () => {
        pr.labels = ['ready-for-review'];
        throw new Error('Squash merge is not allowed');
      });
      Object.assign(rec, { status: 'passed', testedSha: pr.headSha, passedSha: pr.headSha });
      expect(await s.advanceMerge(repo, rec, pull)).toBe(false);
      expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, pr.number, 'squash', pr.headSha);
      expect(rec).toMatchObject({ status: 'queued', mergeNote: 'waiting for detailed security review' });
    });

    it('rechecks the base before a fallback merge method and sends the PR back when it moved', async () => {
      const pr = { ...pull, labels: [], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pr }));
      vi.spyOn(s.backend, 'setSecurityReviewLabel').mockResolvedValue();
      const merge = vi.spyOn(s.backend, 'mergePull').mockImplementation(async () => {
        pr.baseSha = 'base-2';
        throw new Error('Squash merge is not allowed');
      });
      Object.assign(rec, {
        status: 'passed', testedSha: pr.headSha, passedSha: pr.headSha,
        securityReview: { reason: 'Changes authentication', qaSha: pr.headSha, approvedSha: pr.headSha, auditBaseSha: pr.baseSha },
      });
      expect(await s.advanceMerge(repo, rec, pull)).toBe(false);
      expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, pr.number, 'squash', pr.headSha);
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', fixInstructions: expect.stringContaining('base-2') });
    });

    it('requeues ordinary QA when checkout fetched a head that was not checked for ancestry', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(pr);
      const compare = vi.spyOn(s.backend, 'containsCommit').mockResolvedValue(true);
      vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
      vi.spyOn(s.backend, 'deskHead').mockResolvedValue('sha-2');
      const session = vi.spyOn(s, 'startAgentSession');
      rec.status = 'queued';
      await s.runQa(tester, repo, rec);
      expect(compare).toHaveBeenCalledExactlyOnceWith(repo.fullName, pr.headSha, pr.baseSha);
      expect(rec).toMatchObject({ status: 'queued', mergeNote: expect.stringContaining('head changed') });
      expect(session).not.toHaveBeenCalled();
    });

    it('ignores a canceled checkout error after another QA desk takes ownership', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      const replacement = addAgent('q3', 'Poirot', 'qa', 2);
      const pr = { ...pull, labels: ['ready-for-review'], baseSha: 'base-1', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(pr);
      vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
      let rejectHead!: (error: Error) => void;
      const headCheck = vi.spyOn(s.backend, 'deskHead')
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectHead = reject; }))
        .mockResolvedValue(pr.headSha);
      vi.spyOn(s, 'startAgentSession').mockImplementation((agent) => {
        Object.assign(agent as object, { status: 'working' });
      });
      rec.status = 'queued';
      const first = s.runQa(tester, repo, rec);
      await vi.advanceTimersByTimeAsync(0);
      expect(headCheck).toHaveBeenCalledOnce();
      s.clearTask(tester);
      rec.status = 'queued';
      await s.runQa(replacement, repo, rec);
      rejectHead(new Error('Canceled desk lookup'));
      await first;
      expect(rec).toMatchObject({ status: 'testing', qaAgentId: 'q3' });
      expect(replacement.status).toBe('working');
    });

    it('sends the PR back when its head and base move together but the head lacks the current base', async () => {
      const tester = addAgent('q2', 'Marple', 'qa', 1);
      const pr = { ...pull, headSha: 'sha-2', baseSha: 'base-2', baseRefName: 'main', body: '', isCrossRepository: false };
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue(pr);
      const compare = vi.spyOn(s.backend, 'containsCommit').mockResolvedValue(false);
      const session = vi.spyOn(s, 'startAgentSession');
      Object.assign(rec, {
        status: 'passed', testedSha: pull.headSha, passedSha: pull.headSha,
        securityReview: { reason: 'Changes authentication', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' },
      });
      s.reconcilePulls(repo, [pr]);
      expect(rec.status).toBe('queued');
      await s.runQa(tester, repo, rec);
      expect(compare).toHaveBeenCalledExactlyOnceWith(repo.fullName, pr.headSha, pr.baseSha);
      expect(rec).toMatchObject({ status: 'failed', fixReason: 'base', fixInstructions: expect.stringContaining('origin/main') });
      expect(session).not.toHaveBeenCalled();
    });

    describe('waived by removing the label', () => {
      const waived = { type: 'toast', level: 'info', text: 'Security review waived for PR #13 (label removed).' };
      const sync = (labels: string[], headSha = pull.headSha) => {
        Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now() });
        s.reconcilePulls(repo, [{ ...pull, headSha, labels }]);
      };
      let events: Mock;
      beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        events = vi.spyOn(s, 'broadcast') as Mock;
        Object.assign(rec, {
          status: 'queued', testedSha: pull.headSha, passedSha: null, failedSha: null, mergeNote: 'waiting for detailed security review',
          securityReview: { reason: 'Changed session authentication.', qaSha: pull.headSha },
        });
      });

      it('stops holding an escalated, unapproved PR once its label is removed', async () => {
        sync(['ready-for-review']);
        expect(rec).toMatchObject({ status: 'queued', securityReview: { qaSha: pull.headSha } });
        sync([]);
        expect(rec).toMatchObject({ status: 'passed', passedSha: pull.headSha, mergeNote: null, securityWaived: true });
        expect(rec).not.toHaveProperty('securityReview', expect.anything());
        expect(events).toHaveBeenCalledWith(waived);
        vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, labels: [], baseSha: 'base-1', body: '', isCrossRepository: false });
        const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
        vi.spyOn(swarm, 'syncRepo').mockResolvedValue();
        await swarm.mergePull(repo.id, 13);
        expect(merge).toHaveBeenCalledOnce();
      });

      it("keeps a later QA pass's security reason from escalating it again", async () => {
        sync(['ready-for-review']);
        sync([]);
        const tester = addAgent('q2', 'Marple', 'qa', 1);
        Object.assign(tester, { status: 'working', task: 'qa', prNumber: 13 });
        Object.assign(rec, { status: 'testing', qaAgentId: 'q2', testedSha: 'sha-2', passedSha: null });
        s.backend.prDetails = async () => ({ ...pull, headSha: 'sha-2', body: '', isCrossRepository: false });
        const label = vi.spyOn(s.backend, 'setSecurityReviewLabel');
        await s.onQaFinished(tester, repo, result(true, {
          verdict: 'pass', summary: 'QA passed', checks: [], securityReviewReason: 'Changed session authentication.',
        }));
        expect(rec).toMatchObject({ status: 'passed', passedSha: 'sha-2', mergeNote: null });
        expect(rec).not.toHaveProperty('securityReview', expect.anything());
        expect(label).not.toHaveBeenCalled();
      });

      it('holds the PR again when the label is added back', () => {
        sync(['ready-for-review']);
        sync([]);
        sync(['ready-for-review']);
        expect(rec).toMatchObject({ status: 'queued', mergeNote: 'waiting for detailed security review', securityReview: { reason: 'Requested by the PR label.' } });
        expect(rec).not.toHaveProperty('securityWaived');
      });

      it('leaves a review approved for the current head alone', () => {
        const review = { reason: 'Changed session authentication.', qaSha: pull.headSha, approvedSha: pull.headSha, auditBaseSha: 'base-1' };
        Object.assign(rec, { status: 'passed', passedSha: pull.headSha, mergeNote: null, securityReview: review, securityLabel: true });
        sync([]);
        expect(rec).toMatchObject({ status: 'passed', securityReview: review });
        expect(events).not.toHaveBeenCalledWith(waived);
        sync([], 'sha-2');
        expect(rec).toMatchObject({ status: 'queued', securityReview: { reason: review.reason } });
      });

      it('does not mistake the label being absent all along for a waiver', () => {
        sync([]);
        expect(rec).toMatchObject({ status: 'queued', securityReview: { qaSha: pull.headSha } });
        expect(events).not.toHaveBeenCalledWith(waived);
      });
    });
  });

  describe('a QA session that ends without a report', () => {
    let session: Mock;
    let tester: Record<string, unknown>;
    const starts = () => session.mock.calls.length;
    beforeEach(async () => {
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
      vi.spyOn(s, 'prepare').mockResolvedValue('demo-worktree');
      session = vi.spyOn(s, 'startAgentSession').mockImplementation((agent) => {
        Object.assign(agent as object, { status: 'working', sessionId: 'qa-session' });
      }) as Mock;
      tester = addAgent('q2', 'Marple', 'qa', 1);
      rec.status = 'queued';
      await s.runQa(tester, repo, rec);
      s.agentRt.get('q2')!.shots!.push({ data: Buffer.from('png'), mime: 'image/png', url: null, at: 1 });
    });

    it('is resumed once in the same session, worktree and schema, keeping its screenshots and round', async () => {
      const [, , cwd, , systemAppend, , schema] = session.mock.calls[0];
      expect(systemAppend).toContain(ONE_TURN);
      await s.onQaFinished(tester, repo, result(true));
      expect(starts()).toBe(2);
      expect(session.mock.calls[1]).toEqual([tester, repo, cwd, QA_RESUME_PROMPT, systemAppend, 'qa-session', schema]);
      expect(rec).toMatchObject({ status: 'testing', qaAgentId: 'q2', round: 2, retests: 0, sessionFailures: 0 });
      expect(tester).toMatchObject({ status: 'working', task: 'qa', endedAt: null });
      expect(s.agentRt.get('q2')!.shots).toHaveLength(1);
      const comment = vi.spyOn(s.backend, 'commentPull');
      await s.onQaFinished(tester, repo, result(true, failReport));
      expect(rec).toMatchObject({ status: 'failed', round: 2, sessionFailures: 0 });
      expect(comment).toHaveBeenCalledOnce();
    });

    it('takes the usual failure path on a second miss, without another resume or round', async () => {
      await s.onQaFinished(tester, repo, result(true));
      await s.onQaFinished(tester, repo, result(true));
      expect(starts()).toBe(2);
      expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, sessionFailures: 1 });
      expect(tester).toMatchObject({ status: 'error', lastError: 'QA finished without a usable report' });
    });

    it('hands the PR to a human when the resumed session is stopped', async () => {
      await s.onQaFinished(tester, repo, result(true));
      swarm.stopAgent('q2');
      await s.onQaFinished(tester, repo, result(true));
      expect(starts()).toBe(2);
      expect(rec).toMatchObject({ status: 'needs-human', qaAgentId: null, summary: 'QA was stopped by the manager.' });
      expect(tester).toMatchObject({ status: 'stopped' });
    });

    it.each([
      ['stopped', () => { tester.status = 'stopped'; }, false, { status: 'needs-human', sessionFailures: 1 }],
      ['failed', () => {}, true, { status: 'queued', sessionFailures: 1 }],
      ['usage-limited', () => { s.pausedUntil = Date.now() + 60_000; }, false, { status: 'queued', sessionFailures: 0 }],
      ['reassigned', () => { rec.qaAgentId = 'q1'; }, false, { status: 'queued', sessionFailures: 1 }],
      ['picked up after a restart', () => { delete s.agentRt.get('q2')!.qaResume; }, false, { status: 'queued', sessionFailures: 1 }],
    ] as const)('is never resumed when %s', async (_why, arrange, crashed, after) => {
      rec.sessionFailures = 0;
      arrange();
      await s.onQaFinished(tester, repo, result(!crashed));
      expect(starts()).toBe(1);
      expect(rec).toMatchObject({ ...after, qaAgentId: null, round: 2 });
    });

    it.each([
      ['Stop', () => swarm.stopAgent('q2'), { status: 'needs-human', sessionFailures: 0 }],
      ['Clear desk', () => s.clearTask(tester), { status: 'queued', sessionFailures: 0 }],
    ] as const)('is not resumed after %s during the desk clean-up', async (_what, act, after) => {
      let cleaned!: () => void;
      const finishing = s.onQaFinished(tester, repo, result(true), new Promise<void>((resolve) => { cleaned = resolve; }));
      await vi.advanceTimersByTimeAsync(0);
      act();
      cleaned();
      await finishing;
      expect(starts()).toBe(1);
      expect(rec).toMatchObject({ ...after, qaAgentId: null, round: 2 });
    });

    it("isn't charged a failure when the usage limit hits during the desk clean-up", async () => {
      let cleaned!: () => void;
      const finishing = s.onQaFinished(tester, repo, result(true), new Promise<void>((resolve) => { cleaned = resolve; }));
      await vi.advanceTimersByTimeAsync(0);
      s.pausedUntil = Date.now() + 60_000;
      cleaned();
      await finishing;
      expect(starts()).toBe(1);
      expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, round: 2, sessionFailures: 0 });
    });
  });
});

describe('fixes across office restarts', () => {
  const fixRec = (status: string) => ({
    repoId: repo.id, prNumber: 45, status, round: 2, sessionFailures: 0, retests: 0, testedSha: 'sha-0', fixCrashes: [], fixReason: 'qa',
    devAgentId: 'a1', devSessionId: 'dev-session', qaAgentId: 'q1', summary: 'Broken', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0,
  }) as unknown as QaRec;

  beforeEach(() => {
    s.backend.demo = false; // the fake backend, with real session-resume recovery
    Object.assign(repo, { links: [] });
    s.repoRt.get(repo.id)!.pulls = [{ number: 45, headRefName: 'swarm/issue-12-ada', title: 'Toolbar', url: '' } as PullInfo];
  });

  it.each([false, true])('handles a PR session after another task left OpenCode on the desk (legacy record: %s)', async (legacy) => {
    const dev = s.state.agents[0];
    const savedId = '015fe943-1bad-470d-9469-d24bd8b2195a';
    Object.assign(dev, { prNumber: 45, sessionId: savedId, sessionCli: 'codex' });
    const rec = s.queueQa(repo, 45, dev, null);
    expect(rec).toMatchObject({ devSessionId: savedId, devSessionCli: 'codex' });
    rec.status = 'failed';
    if (legacy) delete rec.devSessionCli;
    Object.assign(dev, { prNumber: 99, cli: 'opencode', model: '', sessionId: 'ses_qa', sessionCli: 'opencode' });
    (s.state as unknown as { settings: { runtime: string } }).settings.runtime = 'terminal';
    let prepared!: (cwd: string) => void;
    vi.spyOn(s, 'prepare').mockImplementation(() => new Promise((r) => (prepared = r)));
    const start = vi.spyOn(s.backend, 'startSession');
    const fixing = s.runFix(dev, repo, rec);
    await Promise.resolve();
    expect(dev).toMatchObject({ status: 'preparing', task: 'fix', sessionId: null });
    await vi.waitFor(() => expect(prepared).toBeTypeOf('function')); // after the open-PR check
    prepared('/fake-desk');
    await fixing;
    expect(start).toHaveBeenCalledOnce();
    const { cli, resumeSessionId } = start.mock.calls[0][0];
    expect({ cli, resumeSessionId }).toEqual({
      cli: legacy ? 'opencode' : 'codex',
      resumeSessionId: legacy ? undefined : savedId,
    });
  });

  it('puts a fix still being prepared back in line instead of resuming a stale session', () => {
    const dev = s.state.agents[0];
    Object.assign(dev, { status: 'stopped', task: 'fix', prNumber: 45, branch: 'swarm/issue-12-ada', sessionId: 'qa-session' });
    s.state.qa.push(fixRec('fixing'));
    const message = vi.spyOn(swarm, 'message');
    s.recover([dev], new Set([dev]));
    expect(message).not.toHaveBeenCalled();
    expect(s.state.qa[0].status).toBe('failed');
    expect(dev).toMatchObject({ status: 'error', task: null });
  });

  it('requeues a running fix with its original session and branch context', () => {
    const dev = s.state.agents[0];
    Object.assign(dev, { status: 'stopped', task: 'fix', prNumber: 45, branch: 'swarm/issue-12-ada', sessionId: 'fix-session' });
    s.state.qa.push(fixRec('fixing'));
    const message = vi.spyOn(swarm, 'message').mockResolvedValue(undefined as never);
    s.recover([dev]);
    expect(message).not.toHaveBeenCalled();
    expect(s.state.qa[0]).toMatchObject({ status: 'failed', devSessionId: 'dev-session' });
    expect(dev).toMatchObject({ status: 'error', task: null });
  });
});

describe('developer specialism', () => {
  it('reads the current playbook for issue and repair prompts, separately from the job brief', () => {
    const read = vi.spyOn(syncFs, 'readFileSync').mockReturnValueOnce('First playbook').mockReturnValueOnce('Edited playbook');
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    const a = Object.assign(s.state.agents[0], { brief: 'Project-specific ownership' });
    const p = s as unknown as Record<string, (...args: unknown[]) => string>;

    const issuePrompt = p.buildSystemAppend(a, repo, '/desk', 'swarm/issue-1-ada');
    const fixPrompt = p.buildSystemAppend(a, repo, '/desk', 'swarm/13', { pr: 13, headRef: 'swarm/13' });
    const playbook = new URL('../docs/specialisms/developer.md', import.meta.url);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(playbook, 'utf8');
    expect(issuePrompt).toContain('First playbook');
    expect(issuePrompt).toContain('Project-specific ownership');
    expect(fixPrompt).toContain('Edited playbook');
    expect(fixPrompt).not.toContain('First playbook');
  });
});

describe('prototype review', () => {
  const prototypeIssue = issue(66, ['swarm:prototype']);
  const draft = {
    number: 12, title: 'Prototype: filters', url: 'https://github.com/demo-co/pixel-todo/pull/12',
    isCrossRepository: false, headRefName: 'prototype/issue-66-ada', headSha: 'prototype-sha', state: 'OPEN', isDraft: true,
    closesIssues: [], checks: 'none', mergeable: 'MERGEABLE', reviewDecision: null, createdAt: '', mergedAt: null,
    additions: 1, deletions: 0, mergeState: 'DRAFT', failedChecks: [], pendingChecks: [],
  } satisfies PullInfo;
  const evidence = '## Question and scope\nCan people find a report?\n## How to run and review\nOpen the preview.\n## Screenshots\n![The filter panel](https://example.invalid/filter.png)\n## Findings and limitations\nUses sample data.';
  beforeEach(() => {
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    setIssues({ ...prototypeIssue, labels: [...prototypeIssue.labels] });
  });

  it('finishes a prototype with a review link and never queues production QA', async () => {
    const dev = s.state.agents[0];
    await swarm.assign('a1', 66);
    expect(dev.branch).toBe(draft.headRefName);
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [draft] });
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue(undefined as never);
    const generation = (s.agentRt.get('a1') as { generation?: undefined }).generation;
    await s.recordFinished(dev, repo, { ok: true, text: draft.url, errors: [], costUsd: 0, turns: 1 }, generation, undefined);
    s.reconcilePulls(repo, [draft]);
    expect(dev).toMatchObject({ status: 'done', prNumber: draft.number, prUrl: draft.url });
    expect(s.state.qa).toEqual([]);
  });

  it('revises the same draft with the manager’s feedback', async () => {
    s.repoRt.get(repo.id)!.pulls = [draft];
    await expect(swarm.assign('a1', 66)).rejects.toThrow('Blocked board');
    await swarm.revisePrototype(repo.id, draft.number, draft.headSha, 'Make the floor filter visible');
    expect(runTask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ branch: draft.headRefName, prNumber: draft.number }),
      repo, prototypeIssue, 'Make the floor filter visible',
    );
    await expect(swarm.approvePrototype(repo.id, draft.number, draft.headSha, 'Build filters', 'Show all floors.')).rejects.toThrow('update to finish');
  });

  it('keeps a successful approval visible when the subsequent board refresh fails', async () => {
    s.repoRt.get(repo.id)!.pulls = [draft];
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...prototypeIssue, repo: repo.fullName, state: 'OPEN' });
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({
      ...draft, body: evidence, isCrossRepository: false,
    } as unknown as Awaited<ReturnType<Backend['prDetails']>>);
    vi.spyOn(s.backend, 'editIssue').mockResolvedValue();
    vi.spyOn(swarm, 'syncRepo').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(swarm.approvePrototype(repo.id, draft.number, draft.headSha, 'Build filters', 'Show all floors.')).resolves.toBeUndefined();
    expect(s.repoRt.get(repo.id)!.issues[0]).toMatchObject({ title: 'Build filters', labels: [] });
    expect(ready()).toEqual([66]);
  });

  it('holds approval for missing screenshots and releases the source issue for regular implementation once approved', async () => {
    s.repoRt.get(repo.id)!.pulls = [draft];
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ ...prototypeIssue, repo: repo.fullName, state: 'OPEN' });
    const details = { ...draft, body: evidence, isCrossRepository: false } as unknown as Awaited<ReturnType<Backend['prDetails']>>;
    const prDetails = vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...details, body: evidence.replace('![The filter panel](https://example.invalid/filter.png)', 'Screenshot not taken') });
    const edit = vi.spyOn(s.backend, 'editIssue').mockImplementation(async (_repo, _n, patch) => {
      setIssues({ ...prototypeIssue, title: patch.title!, body: patch.body!, labels: [] });
    });
    vi.spyOn(swarm, 'syncRepo').mockResolvedValue(undefined as never);
    const approve = () => swarm.approvePrototype(repo.id, draft.number, draft.headSha, 'Build filters', 'Show all floors.');
    await expect(approve()).rejects.toThrow('attach screenshots');
    expect(edit).not.toHaveBeenCalled();
    prDetails.mockResolvedValue(details);
    await approve();
    expect(edit).toHaveBeenCalledExactlyOnceWith(repo.fullName, 66, expect.objectContaining({
      title: 'Build filters', body: expect.stringContaining(draft.headSha), removeLabels: ['swarm:prototype'],
    }));
    expect(ready()).toEqual([66]);
    await swarm.assign('a1', 66);
    expect(s.state.agents[0].branch).toBe('swarm/issue-66-ada');
  });
});

describe('QA specialism', () => {
  it('scopes ordinary and security review before checking CI for the assigned head', () => {
    const tester = { ...s.state.agents[0], role: 'qa' };
    const pr = { number: 13, title: 'Chaser', headRefName: 'swarm/13', headSha: 'reviewed-sha', baseSha: 'base-sha', url: '' };
    const p = s as unknown as Record<string, (...args: unknown[]) => string>;
    const qa = p.buildQaSystemAppend(tester, repo, '/desk', 'qa/pr-13-tester', pr);
    const audit = p.buildSecuritySystemAppend(repo, '/desk', pr, 'Changed trust boundary', 'Security playbook');

    for (const prompt of [qa, audit]) {
      const scope = prompt.indexOf('blast radius');
      const ci = prompt.indexOf('check CI for assigned head reviewed-sha');
      expect(scope).toBeGreaterThan(-1);
      expect(ci).toBeGreaterThan(scope);
      expect(prompt).toContain(`repos/${repo.fullName}/commits/reviewed-sha/check-runs`);
      expect(prompt).toContain('Run only additional checks needed to fill evidence gaps');
      expect(prompt).toContain('git show base-sha:CUBEBASE_QA.md');
      expect(prompt).toContain('wait for evidence on the assigned head before passing');
    }
    expect(qa.indexOf('"Blast radius:"')).toBeGreaterThan(-1);
    expect(qa.indexOf('"Blast radius:"')).toBeLessThan(qa.indexOf('check CI for assigned head'));
    expect(qa).toContain('Before each extra check, use a separate shell call to print a line starting with "Coverage gap:"');
    expect(qa).toContain('If you cannot name a gap, skip the check.');
    expect(qa).toContain('Unless repository QA guidance specifies another automated reviewer');
    expect(audit).toContain('Complete the scoped audit, independent verification, and artifact validation');
    expect(audit).toContain('Security playbook');
  });

  it('rereads the QA playbook for both the tester and a developer covering QA', () => {
    const read = vi.spyOn(syncFs, 'readFileSync').mockReturnValueOnce('QA playbook').mockReturnValueOnce('Edited QA playbook');
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    const developer = s.state.agents[0];
    const tester = { ...developer, role: 'qa', brief: 'Project-specific QA brief' };
    const pr = { number: 13, title: 'Chaser', headRefName: 'swarm/13', url: '' };
    const p = s as unknown as Record<string, (...args: unknown[]) => string>;

    const testerPrompt = p.buildQaSystemAppend(tester, repo, '/desk', 'qa/pr-13-tester', pr);
    const coverPrompt = p.buildQaSystemAppend(developer, repo, '/desk', 'qa/pr-13-ada', pr);

    const playbook = new URL('../docs/specialisms/qa.md', import.meta.url);
    expect(read.mock.calls).toEqual([[playbook, 'utf8'], [playbook, 'utf8']]);
    expect(testerPrompt).toContain('QA playbook');
    expect(testerPrompt).toContain('is not a QA fail');
    expect(testerPrompt).toContain('Project-specific QA brief');
    expect(coverPrompt).toContain('Edited QA playbook');
    expect(coverPrompt).toContain('covering for the QA lab');
    expect(coverPrompt).toContain('Resolve the fetched PR target branch to a commit');
    expect(coverPrompt).toContain('If the path is absent, continue with the default QA playbook');
    expect(coverPrompt).toContain('Finish with the structured QA report');
  });
});

describe.each(['claude', 'codex', 'opencode'] as const)('shared Docker safety on %s', (cli) => {
  it.each(['issue', 'fix', 'qa', 'covering QA', 'prototype', 'security'] as const)('reaches the %s prompt on every floor', (kind) => {
    const p = s as unknown as Record<string, (...args: unknown[]) => string>;
    const pr = { number: 13, title: 'Chaser', headRefName: 'swarm/13', url: '' };
    for (const floor of [1, 2]) {
      const project = { ...repo, floor, fullName: `demo-co/floor-${floor}`, links: [], defaultBranch: 'main', qaBrief: floor === 1 ? 'Floor QA checks' : '' };
      const dev = { ...s.state.agents[0], cli, brief: floor === 1 ? 'Project ownership' : '' };
      const tester = { ...dev, role: 'qa' };
      const prompts = {
        issue: () => p.buildSystemAppend(dev, project, '/desk', 'swarm/issue-1-ada'),
        fix: () => p.buildSystemAppend(dev, project, '/desk', 'fix/13', { pr: 13, headRef: 'swarm/13' }),
        qa: () => p.buildQaSystemAppend(tester, project, '/desk', 'qa/pr-13-tester', pr),
        'covering QA': () => p.buildQaSystemAppend(dev, project, '/desk', 'qa/pr-13-ada', pr),
        prototype: () => p.buildSystemAppend(dev, project, '/desk', 'prototype/issue-1-ada'),
        security: () => p.buildSecuritySystemAppend(project, '/desk', pr, 'Requested review', 'Security playbook'),
      };
      const systemAppend = prompts[kind]();
      expect(systemAppend).toContain("This machine's Docker engine is shared with other desks and the manager.");
      expect(systemAppend).toContain('Record the ID of every container, network and volume you create; remove only those, by ID.');
      expect(systemAppend).toContain('Never `docker rm/stop/kill` by name pattern, label or filter; never `docker system/container/volume/network prune`; never `docker compose down` on a project you did not create.');
      expect(systemAppend).toContain("If you can't tell who owns something, leave it and say so in your report.");
      expect(systemAppend.match(/This machine's Docker engine/g)).toHaveLength(1);

      const { args, env } = launchArgs(cli, {
        prompt: 'Do the assigned task', systemAppend, model: '', effort: 'medium', sessionId: 'session-1',
        cwd: '/desk', name: 'Ada', role: kind === 'qa' || kind === 'security' ? 'qa' : 'dev', additionalDirectories: [],
        files: { settings: 'settings.json', system: 'instructions.md', mcp: null },
        notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' }, codexHook: 'codex-hook.cjs',
        plugin: 'file:///plugin.mjs', browser: null,
      });
      if (cli === 'claude') expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('instructions.md');
      if (cli === 'opencode') expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).instructions).toEqual(['instructions.md']);
      if (cli === 'codex') {
        expect(args.join(' ').length).toBeLessThan(8000);
        const instructions = args.find((arg) => arg.startsWith('developer_instructions='))!;
        // Short prompts may stay inline; longer ones must still use the existing file path.
        expect(instructions.includes('instructions.md') || instructions.includes("This machine's Docker engine")).toBe(true);
      }
    }
  });
});

describe('the line about turns ending', () => {
  it('is in the developer, fix, QA and CEO prompts exactly once', () => {
    Object.assign(repo, { links: [], defaultBranch: 'main' });
    const a = s.state.agents[0];
    const pr = { number: 13, title: 'Chaser', headRefName: 'swarm/13', url: '' };
    const p = s as unknown as Record<string, (...args: unknown[]) => string>;
    const prompts = [
      p.buildSystemAppend(a, repo, '/desk', 'swarm/issue-1-ada'),
      p.buildSystemAppend(a, repo, '/desk', 'fix/13', { pr: 13, headRef: 'swarm/13' }),
      p.buildQaSystemAppend(a, repo, '/desk', 'qa/pr-13-ada', pr),
      ceoSystemPrompt({ name: 'Joi', company: 'Acme', manager: 'Sam', notesFile: '/notes.md', researchFolder: '/research', sessionLimit: 4, teamCap: 5, hiring: 'approve' }),
      researcherSystemPrompt({ name: 'Hypatia', title: '', brief: '', company: 'Acme', today: '2026-10-15', companyFolder: '/research', place: { kind: 'company', repo: 'demo-manager/cubebase', defaultBranch: 'main', cwd: '/research', branch: 'swarm/research-doc-test', autoMerge: false } }),
    ];
    for (const prompt of prompts) expect(prompt.split(ONE_TURN)).toHaveLength(2);
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

  it('automatically upgrades a closed office from the scheduler without admitting any work', async () => {
    await swarm.closeOffice();
    f.officeHead = 'old';
    f.officeUpdate.behind = 3;
    s.backend.office.launcher = true;
    const update = vi.spyOn(s.backend.office, 'update').mockResolvedValue(null);
    const heartbeat = vi.spyOn(s, 'maybeHeartbeat');
    const ceo = vi.spyOn(s, 'startCeoWork');
    const researcher = vi.spyOn(s as unknown as { startResearchWork(): void }, 'startResearchWork');
    f.state.deferredResumes.push('a1');
    f.state.ceo.queue.push({ id: 'queued' });
    (s.schedule as Mock).mockRestore();
    s.schedule();
    await drain();
    expect(update).toHaveBeenCalledExactlyOnceWith('old');
    expect(f.state.officeHeld).toBe(true);
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(sessions).toHaveLength(0);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(ceo).not.toHaveBeenCalled();
    expect(researcher).not.toHaveBeenCalled();
    expect(f.state.deferredResumes).toContain('a1');
  });

  it.each([true, false])('keeps the office closed after an update completes with ok=%s', async (ok) => {
    await swarm.closeOffice();
    f.officeHead = 'old';
    s.backend.office.launcher = true;
    vi.spyOn(s.backend, 'syncMain').mockResolvedValue({ status: ok ? 'in sync' : 'update ready (3 commits)', behind: ok ? 0 : 3, updatable: !ok });
    const update = vi.spyOn(s.backend.office, 'update').mockImplementation(async () => {
      if (ok) f.officeUpdate.behind = 0;
      return { from: 'old', to: ok ? 'new' : 'old', ok, error: ok ? undefined : 'build failed', installed: false, built: ok, at: Date.now() };
    });
    (s.schedule as Mock).mockRestore();
    f.setOfficeBehind(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalledOnce();
    expect(f.state.officeHeld).toBe(true);
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(f.officeUpdateView().state).toBe(ok ? 'none' : 'failed');
    expect(sessions).toHaveLength(0);
  });

  it.each([
    { name: 'disabled automatic updates', autoUpdate: false, update: {}, state: 'available' },
    { name: 'a postponement', autoUpdate: true, update: { postponedBehind: 3 }, state: 'waiting' },
    { name: 'a failed update', autoUpdate: true, update: { failed: 'build failed', failedBehind: 3 }, state: 'failed' },
  ])('respects $name while closed', async ({ autoUpdate, update: patch, state }) => {
    await swarm.closeOffice();
    f.officeHead = 'old';
    f.state.settings.autoUpdate = autoUpdate;
    Object.assign(f.officeUpdate, patch, state === 'waiting' ? { postponedUntil: Date.now() + 60_000 } : {});
    s.backend.office.launcher = true;
    const update = vi.spyOn(s.backend.office, 'update').mockResolvedValue(null);
    f.setOfficeBehind(3);
    await drain();
    expect(update).not.toHaveBeenCalled();
    expect(f.officeUpdateView().state).toBe(state);
    expect(f.state.officeHeld).toBe(true);
    expect(sessions).toHaveLength(0);
  });

  it('waits for closing state to be saved before upgrading, then retries from the scheduler', async () => {
    await swarm.closeOffice();
    Object.assign(f, { officeSaved: false });
    writes.mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.officeHead = 'old';
    f.officeUpdate.behind = 3;
    s.backend.office.launcher = true;
    const update = vi.spyOn(s.backend.office, 'update').mockResolvedValue(null);
    (s.schedule as Mock).mockRestore();
    s.schedule();
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    expect(f.officeLifecycleView()).toEqual({ state: 'closing', running: 0 });
    expect(update).not.toHaveBeenCalled();
    writes.mockResolvedValue(undefined);
    s.schedule();
    await drain();
    expect(update).toHaveBeenCalledOnce();
    expect(f.officeLifecycleView()).toEqual({ state: 'closed', running: 0 });
    expect(f.state.officeHeld).toBe(true);
    expect(sessions).toHaveLength(0);
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
    s.state.agents[0].sessionId = 'running-thread';
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
    vi.spyOn(s.backend, 'prForBranch').mockResolvedValue({ number: 13, url: 'https://github.com/demo-co/pixel-todo/pull/13' });
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ number: 13, url: 'https://github.com/demo-co/pixel-todo/pull/13', state: 'OPEN', headRefName: 'swarm/issue-66-ada', isCrossRepository: false } as never);
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

  it('passes a finished terminal’s scratch to its machine and holds follow-ups during cleanup', async () => {
    let finished!: SessionCallbacks['finished'];
    let released!: () => void;
    vi.mocked(s.backend.startSession).mockImplementationOnce((_opts, cb) => {
      finished = cb.finished;
      return { send: vi.fn(), stop: vi.fn(), finishedScratchSession: 'worker-session' };
    });
    await swarm.assign('a1', 66);
    await drain();
    ada().sessionId = 'retained-session';
    const release = vi.spyOn(s.backend, 'releaseDesk').mockReturnValueOnce(new Promise<void>((resolve) => { released = resolve; }));
    const completion = finished(result);
    await drain();
    expect(release).toHaveBeenCalledWith(repo.fullName, 'ada-a1', expect.any(Number), 'worker-session');
    await expect(swarm.message('a1', 'Follow up')).rejects.toThrow('cleaning up the previous job');
    const terminal = f.newTerminal('a1');
    try {
      expect(terminal.allowInput()).toBe(false);
      released();
      await completion;
      expect(terminal.allowInput()).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it('holds completion retries and resumes them once, retaining pushed work', async () => {
    vi.spyOn(s.backend, 'deskHead').mockResolvedValueOnce('base').mockResolvedValue('new-commit');
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
    await drain();
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
    number: 13, title: 'Feature', url: '', isCrossRepository: false, headRefName: 'swarm/13', state: 'OPEN', isDraft: false,
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
    expect(ada().heldRetry).toMatchObject({ resume: true, issueNumber: 66 });
    expect(sessions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await swarm.reopenOffice();
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    s.schedule();
    await drain();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.resumeSessionId).toBe('old-thread');
    expect(f.state.deferredResumes).toEqual([]);
  });

  it('retains restart recovery when reopening during unrelated PR parking, then resumes once', async () => {
    s.backend.demo = false; // Fake sessions, with real recovery and admission checks.
    repo.autoAssign = false;
    Object.assign(ada(), { status: 'stopped', task: 'issue', issueNumber: 66, branch: 'swarm/issue-66-ada', sessionId: 'old-thread' });
    const pull = { ...qaPull(), headRefName: 'swarm/issue-67-other', closesIssues: [67] };
    s.repoRt.get(repo.id)!.pulls = [pull];
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pull, body: '', isCrossRepository: false });
    let releaseParking!: () => void;
    vi.spyOn(s.backend, 'commentPull').mockImplementation(() => new Promise<string>((resolve) => { releaseParking = () => resolve('fake-comment'); }));
    vi.spyOn(s.backend, 'closePull').mockResolvedValue();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await swarm.closeOffice();
    s.recover([ada()]);
    const parking = swarm.parkPr({ floor: 1, number: pull.number, reason: 'Park an unrelated placeholder' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    await swarm.reopenOffice();
    vi.mocked(s.schedule).mockRestore();
    vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
    vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
    s.schedule();
    await drain();
    expect(ada().heldRetry).toMatchObject({ resume: true, issueNumber: 66 });
    expect(sessions).toHaveLength(0);
    expect(ada()).toMatchObject({ status: 'idle', issueNumber: 66 });

    releaseParking();
    await parking;
    expect(ada().heldRetry).toMatchObject({ resume: true, issueNumber: 66 });
    const savedResumes: string[][] = [];
    vi.mocked(s.save).mockImplementation(() => savedResumes.push([...f.state.deferredResumes]));
    s.schedule();
    s.schedule(); // A second tick before the successful promise settles must not start twice.
    await drain();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.resumeSessionId).toBe('old-thread');
    expect(f.state.deferredResumes).toEqual([]);
    expect(savedResumes).toContainEqual([]);
    s.schedule();
    await drain();
    expect(sessions).toHaveLength(1);
  });

  it('keeps passed PRs queued for automatic merge until reopened', async () => {
    Object.assign(repo, { autoMerge: true });
    Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now(), syncing: false, merging: false });
    s.repoRt.get(repo.id)!.pulls = [qaPull()];
    const rec = qaRecord();
    Object.assign(rec, { status: 'passed', passedSha: 'sha-1' });
    s.state.qa.push(rec);
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...qaPull(), body: '', isCrossRepository: false });
    await swarm.closeOffice();
    await f.advanceMerges(repo);
    expect(merge).not.toHaveBeenCalled();
    expect(rec.status).toBe('passed');
    await swarm.reopenOffice();
    await f.advanceMerges(repo);
    expect(merge).toHaveBeenCalledOnce();
  });

  it('rebases queued PRs one at a time and merges after fresh CI without another QA round', async () => {
    Object.assign(repo, { autoMerge: true });
    let baseSha = 'base-1';
    const first = { ...qaPull(), baseRefName: 'main', hasSuccessfulChecks: true, successfulChecks: ['CI', 'e2e'] };
    const second = { ...first, number: 14, headRefName: 'swarm/14', headSha: 'sha-2' };
    const third = { ...first, number: 15, headRefName: 'swarm/15', headSha: 'sha-3' };
    const pulls = [first, second, third];
    const heads = new Map(pulls.map((pr) => [pr.headSha, baseSha]));
    const records = pulls.map((pr) => ({ ...qaRecord(), status: 'passed' as const, prNumber: pr.number, passedSha: pr.headSha, testedSha: pr.headSha }));
    s.state.qa.push(...records);
    vi.spyOn(s.backend, 'prDetails').mockImplementation(async (_repo, number) => ({
      ...pulls.find((pr) => pr.number === number)!, body: '', baseSha, isCrossRepository: false,
    }));
    vi.spyOn(s.backend, 'containsCommit').mockImplementation(async (_repo, head, base) => heads.get(head) === base);
    const merge = vi.spyOn(s.backend, 'mergePull').mockImplementation(async (_repo, number, _method, sha) => {
      const pr = pulls.find((pull) => pull.number === number)!;
      expect(sha).toBe(pr.headSha);
      pr.state = 'MERGED';
      baseSha = `merged-${number}`;
    });
    const rebase = vi.spyOn(s.backend, 'rebasePull').mockImplementation(async (_repo, number, head, base) => {
      const pr = pulls.find((pull) => pull.number === number)!;
      expect(head).toBe(pr.headSha);
      expect(base).toBe(baseSha);
      pr.headSha = `${head}-rebased`;
      pr.checks = 'none';
      pr.hasSuccessfulChecks = false;
      pr.successfulChecks = [];
      heads.set(pr.headSha, base);
      return pr.headSha;
    });
    const poll = async (hasBase = true) => {
      Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now(), pulls: pulls.map((pr) => ({ ...pr, baseSha: hasBase ? baseSha : undefined })) });
      await f.advanceMerges(repo);
    };

    await poll(false);
    expect(merge).not.toHaveBeenCalled();
    expect(rebase).not.toHaveBeenCalled();
    await poll();
    expect(merge).toHaveBeenCalledExactlyOnceWith(repo.fullName, 13, 'squash', 'sha-1');
    expect(rebase).not.toHaveBeenCalled();
    await poll();
    expect(rebase).toHaveBeenCalledExactlyOnceWith(repo.fullName, 14, 'sha-2', 'merged-13');
    await poll();
    Object.assign(second, { checks: 'passing', hasSuccessfulChecks: true, successfulChecks: ['CI'] });
    await poll();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(rebase).toHaveBeenCalledTimes(1);

    second.checks = 'failing';
    baseSha = 'external-merge';
    await poll();
    expect(rebase).toHaveBeenLastCalledWith(repo.fullName, 14, 'sha-2-rebased', 'external-merge');
    expect(merge).toHaveBeenCalledTimes(1);
    Object.assign(second, { checks: 'passing', hasSuccessfulChecks: true, successfulChecks: ['CI', 'e2e'] });
    await poll();
    expect(merge).toHaveBeenLastCalledWith(repo.fullName, 14, 'rebase', 'sha-2-rebased-rebased');
    expect(records[1]).toMatchObject({ status: 'passed', passedSha: 'sha-2', testedSha: 'sha-2', round: 1, retests: 0 });
    expect(sessions).toHaveLength(0);

    await poll();
    expect(rebase).toHaveBeenLastCalledWith(repo.fullName, 15, 'sha-3', 'merged-14');
    third.headSha = 'developer-push';
    await poll();
    expect(records[2]).toMatchObject({ status: 'queued', round: 2, retests: 1 });
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it.each(['needs-review', 'needs-human'])('holds automatic merges until %s is removed', async (label) => {
    Object.assign(repo, { autoMerge: true });
    const pull = { ...qaPull(), labels: [label] };
    Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now(), pulls: [pull] });
    const rec = { ...qaRecord(), status: 'passed' as const, passedSha: pull.headSha };
    s.state.qa.push(rec);
    const details = vi.spyOn(s.backend, 'prDetails').mockImplementation(async () => ({ ...pull, body: '', isCrossRepository: false }));
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    await f.advanceMerges(repo);
    expect(details).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();

    // A label added after the list refresh still holds the actual merge.
    details.mockResolvedValueOnce({ ...pull, body: '', isCrossRepository: false });
    pull.labels = [];
    await f.advanceMerges(repo);
    expect(merge).not.toHaveBeenCalled();
    await f.advanceMerges(repo);
    expect(merge).toHaveBeenCalledOnce();
  });

  it('marks a QA-passed draft ready instead of leaving it waiting', async () => {
    Object.assign(repo, { autoMerge: true });
    Object.assign(s.repoRt.get(repo.id)!, { fetchedAt: Date.now(), syncing: false, merging: false });
    s.repoRt.get(repo.id)!.pulls = [{ ...qaPull(), isDraft: true }];
    const rec = qaRecord();
    Object.assign(rec, { status: 'passed', passedSha: 'sha-1' });
    s.state.qa.push(rec);
    const ready = vi.spyOn(s.backend, 'markPullReady').mockResolvedValue();
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    await f.advanceMerges(repo);
    expect(ready).toHaveBeenCalledWith(repo.fullName, qaPull().number);
    expect(merge).not.toHaveBeenCalled();
    expect(rec.status).toBe('passed');
  });

  it('round-trips the hold through an automatic upgrade hand-off and startup before scheduling', async () => {
    writes.mockRestore();
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = vi.spyOn(fs, 'rename').mockResolvedValue();
    await swarm.closeOffice();
    expect(mkdir).toHaveBeenCalled();
    expect(rename).toHaveBeenCalled();
    f.officeHead = 'old';
    s.backend.office.launcher = true;
    const update = vi.spyOn(s.backend.office, 'update').mockResolvedValue(null);
    f.setOfficeBehind(1);
    await drain();
    expect(update).toHaveBeenCalledExactlyOnceWith('old');
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
    const start = vi.spyOn(restored.backend, 'startSession');
    await fresh.init();
    await restored.refreshOfficeLifecycle();
    expect(fresh.snapshot().officeLifecycle).toEqual({ state: 'closed', running: 0 });
    expect(restored.state.officeHeld).toBe(true);
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

describe('researchers', () => {
  type Research = {
    state: { research: { queue: unknown[]; job: unknown; done: { topic: string; where: string }[] } };
    ensureResearcher(interrupted: unknown[]): void;
    reconcilePulls(repo: Repo, pulls: PullInfo[]): void;
    startResearchWork(): void;
  };
  const r = () => s as unknown as Research & Internals;
  const pull = (headRefName: string): PullInfo => ({
    number: 21, title: 'Research: due dates', url: '', headRefName, state: 'OPEN',
    isCrossRepository: false,
    isDraft: false, closesIssues: [5], checks: 'pending', mergeable: 'MERGEABLE', headSha: 'abc',
    reviewDecision: null, createdAt: '', mergedAt: null, additions: 80, deletions: 0,
    mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  });
  beforeEach(() => {
    s.state.agents.push({ id: 'd1', name: 'Darwin', repoId: repo.id, role: 'researcher', specialty: 'research', status: 'idle', task: null, issueNumber: null, desk: 1, endedAt: null });
    s.agentRt.set('d1', { log: [], pending: [], terminal: null });
  });

  it('hands research issues to researchers and everything else to developers', () => {
    setIssues(issue(5, ['swarm:research']), issue(6));
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask.mock.calls.map(([a, , i]) => [(a as { id: string }).id, i.number])).toEqual([['d1', 5]]);
    s.state.agents.find((a) => a.id === 'd1')!.status = 'working';
    s.startIssueWork(repo);
    expect(runTask.mock.calls.map(([a, , i]) => [(a as { id: string }).id, i.number])).toEqual([['d1', 5], ['a1', 6]]);
  });

  it('leaves research issues waiting on a floor without a free researcher', () => {
    s.state.agents.find((a) => a.id === 'd1')!.status = 'working';
    setIssues(issue(5, ['swarm:research']));
    s.startIssueWork(repo);
    expect(runTask).not.toHaveBeenCalled();
  });

  it("won't give a researcher a code issue", async () => {
    setIssues(issue(6));
    await expect(swarm.assign('d1', 6)).rejects.toThrow('Darwin is a researcher: they take swarm:research issues.');
  });

  it('passes research pull requests without QA', () => {
    r().reconcilePulls(repo, [pull('swarm/research-5-darwin')]);
    expect(s.state.qa).toEqual([expect.objectContaining({ prNumber: 21, status: 'passed', qaAgentId: null, passedSha: 'abc' })]);
    s.state.qa = [];
    r().reconcilePulls(repo, [pull('swarm/issue-5-ada')]);
    expect(s.state.qa).toEqual([expect.objectContaining({ prNumber: 21, status: 'queued' })]);
  });

  it('keeps a research PR passed when more research is pushed', async () => {
    r().reconcilePulls(repo, [pull('swarm/research-5-darwin')]);
    const rec = s.state.qa[0];
    await s.advanceMerge(repo, rec, { ...pull('swarm/research-5-darwin'), headSha: 'def', checks: 'passing' });
    expect(rec).toEqual(expect.objectContaining({ status: 'passed', passedSha: 'def' }));
  });

  it.each([{ labels: [] }, { labels: [READY_FOR_SECURITY_REVIEW] }])('queues a fork research branch for QA and never auto-merges it before a pass (labels: $labels)', async ({ labels }) => {
    const pr = { ...pull('swarm/research-5-darwin'), isCrossRepository: true, checks: 'passing' as const, labels };
    Object.assign(repo, { autoMerge: true, defaultBranch: 'main' });
    Object.assign(s.repoRt.get(repo.id)!, { pulls: [pr], fetchedAt: Date.now() });
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ ...pr, body: '' });
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    r().reconcilePulls(repo, [pr]);
    await (s as unknown as { advanceMerges(repo: Repo): Promise<void> }).advanceMerges(repo);
    expect(merge).not.toHaveBeenCalled();
    expect(s.state.qa).toEqual([expect.objectContaining({ prNumber: 21, status: 'queued', passedSha: null })]);
    if (labels.length) expect(s.state.qa[0]).toMatchObject({ securityReview: { qaSha: null } });
  });

  it('requeues new commits on a fork research branch after QA passes', async () => {
    const pr = { ...pull('swarm/research-5-darwin'), isCrossRepository: true, checks: 'passing' as const };
    r().reconcilePulls(repo, [pr]);
    const rec = s.state.qa[0];
    Object.assign(rec, { status: 'passed', passedSha: 'abc', testedSha: 'abc' });
    const merge = vi.spyOn(s.backend, 'mergePull').mockResolvedValue();
    expect(await s.advanceMerge(repo, rec, { ...pr, headSha: 'def' })).toBe(false);
    expect(rec).toMatchObject({ status: 'queued', passedSha: 'abc', testedSha: 'abc', round: 2, retests: 1 });
    expect(merge).not.toHaveBeenCalled();
  });

  it('always has a lobby researcher, who takes briefs and files company research', async () => {
    r().ensureResearcher([]);
    const lobby = s.state.agents.find((a) => a.id === 'researcher')!;
    expect(lobby).toEqual(expect.objectContaining({ role: 'researcher', repoId: '', name: 'Hypatia' }));
    expect(() => swarm.fireAgent('researcher')).toThrow("Hypatia researches for the whole company and can't be let go.");
    await expect(swarm.assign('researcher', 6)).rejects.toThrow('send them a brief instead of an issue');

    const out = await s.officeTools().call('request_research', { topic: 'Todo app pricing', brief: 'What do the big apps charge?' });
    expect(out).toContain('Queued for Hypatia (1 waiting)');
    expect(await s.officeTools().call('request_research', { topic: 'todo app pricing', brief: 'again' })).toContain('already on Hypatia');
    expect(JSON.parse(s.companyStatus()).research.queue).toEqual(['Researching "Todo app pricing"']);

    const start = vi.spyOn(s.backend, 'startSession');
    r().startResearchWork();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      role: 'researcher',
      cwd: expect.stringContaining('/demo-manager/cubebase/desks/'),
      prompt: expect.stringContaining('docs/research/company/ by pull request'),
    }), expect.anything());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r().state.research.done).toEqual([expect.objectContaining({ topic: 'Todo app pricing', where: expect.stringMatching(/^https:\/\/github\.com\/demo-manager\/cubebase\/pull\/\d+$/) })]);
    expect(lobby.status).toBe('done');
  });
});

describe('boxes', () => {
  type Agent = Record<string, unknown>;
  const internals = () => swarm as unknown as { prepare(a: Agent, r: Repo, base: object, branch: string): Promise<string | null>; available(r: Repo, role: string): Agent[]; boxConns: Map<string, { state(): { status: string; running: number; clis: { id: string }[] } }> };

  beforeEach(() => {
    Object.assign(s.repoRt.get(repo.id)!, { cloneStatus: 'ready' });
    Object.assign(repo, { links: [], box: '' });
    Object.assign(s.state.agents[0], { box: null, deskBox: '' });
  });

  it('keeps per-machine resize capability and resource evidence independent of machine names', async () => {
    const box = swarm.addBox('Unfamiliar VPS', 'cpu-busy.example');
    swarm.setMachineCapacity(box.id, 'resizable');
    swarm.setMachineCapacity('', 'fixed');
    await vi.advanceTimersByTimeAsync(1600);
    const fleet = swarm as unknown as { state: { officeCapacity: string; boxes: unknown[] }; boxView(b: unknown): unknown };
    expect(fleet.state.officeCapacity).toBe('fixed');
    expect(fleet.boxView(fleet.state.boxes[0])).toMatchObject({ id: box.id, capacity: 'resizable', telemetry: { status: 'constrained', constraints: ['cpu'] } });
    expect(() => swarm.setMachineCapacity(box.id, 'maybe')).toThrow(HttpError);
    expect(() => swarm.setMachineCapacity('missing', 'fixed')).toThrow(HttpError);
    expect(() => swarm.setMachineCapacity(undefined, 'fixed')).toThrow(HttpError);
    swarm.removeBox(box.id);
    expect(fleet.state.boxes).toEqual([]);
  });

  it("moves a whole floor to a box with one change, and the floor's next tasks start there", async () => {
    const box = swarm.addBox('Build box', 'ada@buildbox');
    await vi.advanceTimersByTimeAsync(1600);
    expect((swarm as unknown as { boxView(b: unknown): unknown }).boxView(box)).toMatchObject({ name: 'Build box', status: 'online', running: 0 });

    const ada = s.state.agents[0];
    ada.box = ''; // her own choice, cleared when the whole floor moves
    swarm.updateRepo(repo.id, { box: box.id, everyone: true });
    expect(ada.box).toBeNull();
    expect(ada.deskBox).toBe(''); // nothing moves until a task starts

    ada.status = 'preparing';
    const cwd = s.prepare(ada, repo, {}, 'swarm/issue-1-ada');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cwd).toMatch(/^\/boxes\/Build-box\//);
    expect(ada.deskBox).toBe(box.id);
  });

  it('keeps an agent who has a box of their own there when only the floor moves', () => {
    const box = swarm.addBox('', 'ada@buildbox');
    const ada = s.state.agents[0];
    ada.box = '';
    swarm.updateRepo(repo.id, { box: box.id });
    expect(ada.box).toBe('');
    expect(s.repoView(repo)).toMatchObject({ box: box.id });
  });

  it("prepares a floor researcher's desk on the floor's box using Claude Code availability", async () => {
    const box = swarm.addBox('Build box', 'ada@buildbox');
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id)!;
    const state = conn.state();
    vi.spyOn(conn, 'state').mockReturnValue({ ...state, clis: state.clis.filter((cli) => cli.id === 'claude') });
    swarm.updateSettings({ defaultCli: 'opencode' });
    swarm.updateRepo(repo.id, { box: box.id });
    const { id } = swarm.hireAgent(repo.id, { role: 'researcher', name: 'Feynman' });
    const researcher = s.state.agents.find((agent) => agent.id === id)!;

    expect(internals().available(repo, 'researcher')).toContain(researcher);
    researcher.status = 'preparing';
    const cwd = s.prepare(researcher, repo, {}, 'swarm/research-57-feynman');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cwd).toMatch(/^\/boxes\/Build-box\//);
    expect(researcher.deskBox).toBe(box.id);
  });

  it('waits while the box is offline: the agent takes no new work, and an assignment waits', async () => {
    const box = swarm.addBox('Attic', 'offline-attic');
    await vi.advanceTimersByTimeAsync(1600);
    const ada = s.state.agents[0];
    swarm.updateAgent('a1', { box: box.id });
    expect(internals().available(repo, 'dev')).toEqual([]);
    s.repoRt.get(repo.id)!.issues = [issue(7)];
    const out = (await swarm.assign('a1', 7)) as { warning?: string };
    expect(out.warning).toMatch(/Attic.*offline/);
    expect(runTask).not.toHaveBeenCalled();
    expect(repo.requestedStarts).toEqual([expect.objectContaining({ issueNumber: 7, restartPending: true })]);
    swarm.updateAgent('a1', { box: null });
    expect(internals().available(repo, 'dev').map((a) => a.id)).toEqual(['a1']);
    expect(ada.box).toBeNull();
  });

  it("falls back to the office's machine once the box is removed, and doesn't resume a conversation left there", async () => {
    const box = swarm.addBox('Old box', 'ada@old');
    await vi.advanceTimersByTimeAsync(1600);
    const ada = s.state.agents[0];
    Object.assign(ada, { box: box.id, deskBox: box.id, sessionId: 'on-the-box', branch: 'swarm/issue-3-ada', task: 'issue', status: 'stopped' });
    swarm.removeBox(box.id);
    expect(ada.box).toBeNull();
    expect(internals().boxConns.has(box.id)).toBe(false); // nothing ran there: closed at once
    await expect(swarm.message('a1', 'carry on')).rejects.toThrow(/Old box, which was removed/);

    ada.status = 'preparing';
    const cwd = s.prepare(ada, repo, {}, 'swarm/issue-4-ada');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cwd).toMatch(/^\/demo\//);
    expect(ada.deskBox).toBe('');
  });

  it("waits while the box hasn't got the agent's coding agent", async () => {
    const box = swarm.addBox('Mac mini', 'ada@mini');
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id)!;
    const real = conn.state.bind(conn);
    vi.spyOn(conn, 'state').mockImplementation(() => ({ ...real(), clis: real().clis.filter((c) => c.id === 'claude') }));
    const ada = s.state.agents[0];
    Object.assign(ada, { cli: 'codex', box: box.id });
    expect(internals().available(repo, 'dev')).toEqual([]);
    s.repoRt.get(repo.id)!.issues = [issue(8)];
    expect(((await swarm.assign('a1', 8)) as { warning?: string }).warning).toBe("waiting: Mac mini hasn't got Codex (not on the login-shell PATH or in ~/.local/bin, ~/.bun/bin, ~/.npm-global/bin)");
    ada.cli = 'claude';
    expect(internals().available(repo, 'dev').map((a) => a.id)).toEqual(['a1']);
  });

  it('asks a box again, or connects to an offline one now', async () => {
    const online = swarm.addBox('Mac mini', 'ada@mini');
    const attic = swarm.addBox('Attic', 'offline-attic');
    await vi.advanceTimersByTimeAsync(1600);
    expect(await swarm.checkBox(online.id)).toMatchObject({ status: 'online' });
    const again = swarm.checkBox(attic.id);
    expect((swarm as unknown as { boxView(b: unknown): { status: string } }).boxView(attic).status).toBe('connecting');
    const failed = expect(again).rejects.toThrow(/Attic didn't answer: ssh: connect to host/);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    await expect(swarm.checkBox('box-gone')).rejects.toThrow(HttpError);
  });

  it.each(['automatic', 'manager'])('detects a newly installed CLI without relinking (%s), then gives its waiting agent work', async (how) => {
    const box = swarm.addBox('Mac mini', 'ada@mini');
    const conn = internals().boxConns.get(box.id) as unknown as BoxConnection;
    const installed = await conn.machine.detectClis();
    const missing = installed.map((c) => c.id === 'opencode' ? { ...c, installed: false, version: null } : c);
    const detect = vi.spyOn(conn.machine, 'detectClis').mockResolvedValueOnce(missing).mockResolvedValue(installed);
    const relink = vi.spyOn(conn, 'relink');
    const restart = vi.spyOn(conn, 'restart');
    await vi.advanceTimersByTimeAsync(1600);
    Object.assign(s.state.agents[0], { cli: 'opencode', box: box.id });
    setIssues(issue(8));
    const waiting = await swarm.assign('a1', 8) as { warning?: string };
    expect(waiting.warning).toContain("hasn't got OpenCode (not on the login-shell PATH or in ~/.opencode/bin, ~/.local/bin, ~/.bun/bin, ~/.npm-global/bin)");
    expect(internals().available(repo, 'dev')).toEqual([]);
    expect(runTask).not.toHaveBeenCalled();

    if (how === 'manager') await swarm.checkBox(box.id);
    else {
      // Restore the real scheduler; work stays blocked until the asynchronous report comes back.
      (s.schedule as Mock).mockRestore();
      Object.assign(s, { scheduling: true, officeHead: `0ff1ce5${'0'.repeat(33)}` });
      vi.spyOn(s, 'startCeoWork').mockImplementation(() => {});
      vi.spyOn(s, 'maybeHeartbeat').mockImplementation(() => {});
      Object.assign(s.repoRt.get(repo.id)!, { lastSync: Date.now() });
      s.schedule();
      expect(runTask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(internals().available(repo, 'dev').map((a) => a.id)).toEqual(how === 'manager' ? ['a1'] : []);
    if (how === 'manager') s.startIssueWork(repo);
    expect(runTask).toHaveBeenCalledWith(s.state.agents[0], repo, expect.objectContaining({ number: 8 }), undefined);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(relink).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('coalesces missing CLI checks per box and retries after five minutes, even after a failure', async () => {
    const box = swarm.addBox('Mac mini', 'claude-only-mini');
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id) as unknown as BoxConnection;
    const check = vi.spyOn(conn, 'check');
    Object.assign(s.state.agents[0], { cli: 'opencode', box: box.id });
    s.state.agents.push({ ...s.state.agents[0], id: 'a2', cli: 'codex' });
    const office = swarm as unknown as { refreshWaitingBoxClis(): void };
    office.refreshWaitingBoxClis();
    office.refreshWaitingBoxClis();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(BOX_CLI_CHECK_MS - 1);
    office.refreshWaitingBoxClis();
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    check.mockRejectedValueOnce(new Error('temporary report failure'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    office.refreshWaitingBoxClis();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    office.refreshWaitingBoxClis();
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BOX_CLI_CHECK_MS);
    office.refreshWaitingBoxClis();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(3);
    s.state.agents[0].status = 'working';
    s.state.agents[2].status = 'working';
    await vi.advanceTimersByTimeAsync(BOX_CLI_CHECK_MS);
    office.refreshWaitingBoxClis();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('shares a slow report with the manager and does not overlap it after the cooldown', async () => {
    const box = swarm.addBox('Mac mini', 'claude-only-mini');
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id) as unknown as BoxConnection;
    let finish!: () => void;
    const check = vi.spyOn(conn, 'check').mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    Object.assign(s.state.agents[0], { cli: 'opencode', box: box.id });
    const office = swarm as unknown as { refreshWaitingBoxClis(): void };
    office.refreshWaitingBoxClis();
    const manager = swarm.checkBox(box.id);
    await vi.advanceTimersByTimeAsync(BOX_CLI_CHECK_MS);
    office.refreshWaitingBoxClis();
    expect(check).toHaveBeenCalledOnce();
    finish();
    await manager;
    // The manager can ask again immediately; automatic checks respect that new timestamp.
    await swarm.checkBox(box.id);
    office.refreshWaitingBoxClis();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("moves a box to the office's commit at once, its agents carrying on, and nothing new starts there meanwhile", async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): { status: string; sync: { text: string; failed: boolean } | null } };
    Object.assign(office, { scheduling: true, officeHead: `0ff1ce5${'0'.repeat(33)}` }); // the demo office's commit
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const box = swarm.addBox('Tower', 'stale-tower');
    const ada = s.state.agents[0];
    Object.assign(ada, { box: box.id, deskBox: box.id, status: 'working' });
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id) as unknown as import('./machine.ts').BoxConnection;
    const restart = vi.spyOn(conn, 'restart');
    expect(office.boxView(box).sync).toEqual({ text: "Updating to the office's 0ff1ce5: its agents carry on…", failed: false });
    ada.status = 'done';
    expect(internals().available(repo, 'dev')).toEqual([]);
    s.repoRt.get(repo.id)!.issues = [issue(9)];
    expect(((await swarm.assign('a1', 9)) as { warning?: string }).warning).toBe("waiting: Tower is moving to the office's version");
    ada.status = 'working';

    await vi.advanceTimersByTimeAsync(3000);
    expect(office.boxView(box)).toMatchObject({ status: 'connecting', sync: { text: "Reconnecting on the office's 0ff1ce5…" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(office.boxView(box)).toMatchObject({ status: 'online', sync: null });
    expect(conn.state().info?.commit).toBe(`0ff1ce5${'0'.repeat(33)}`);
    expect(restart).not.toHaveBeenCalled();
    ada.status = 'done';
    expect(internals().available(repo, 'dev').map((a) => a.id)).toEqual(['a1']);
  });

  it("restarts a box's keeper once its agents finish when the update changed it", async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): import('../shared/types.ts').BoxView };
    Object.assign(office, { scheduling: true, officeHead: `0ff1ce5${'0'.repeat(33)}` });
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const box = swarm.addBox('Tower', 'stale-keeper-tower');
    const ada = s.state.agents[0];
    Object.assign(ada, { box: box.id, deskBox: box.id, status: 'working' });
    await vi.advanceTimersByTimeAsync(1600 + 3000 + 1500); // updated and redialled while ada works
    const conn = internals().boxConns.get(box.id) as unknown as import('./machine.ts').BoxConnection;
    expect(conn.state().info).toMatchObject({ commit: `0ff1ce5${'0'.repeat(33)}`, keeperStale: true });
    expect(office.boxView(box).sync).toEqual({ text: "Restarting its terminals on the office's 0ff1ce5 once its 1 agent finishes: nothing new starts there.", failed: false });
    expect(office.boxView(box).restartRequired).toBe(true);
    ada.status = 'done';
    expect(internals().available(repo, 'dev')).toEqual([]);

    office.syncBoxes();
    expect(office.boxView(box)).toMatchObject({ status: 'connecting', sync: { text: 'Restarting its terminals on 0ff1ce5…' } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(office.boxView(box)).toMatchObject({ status: 'online', sync: null });
    expect(conn.state().info?.keeperStale).toBe(false);
    expect(office.boxView(box).restartRequired).toBe(false);
    expect(internals().available(repo, 'dev').map((a) => a.id)).toEqual(['a1']);
  });

  it("still redials a box whose checkout was updated by an office that restarted before redialling it", async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): { status: string; sync: { text: string; failed: boolean } | null } };
    const head = `0ff1ce5${'0'.repeat(33)}`;
    Object.assign(office, { officeHead: head });
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const box = swarm.addBox('Tower', 'stale-tower');
    await vi.advanceTimersByTimeAsync(1600);
    const conn = internals().boxConns.get(box.id) as unknown as import('./machine.ts').BoxConnection;
    const update = vi.spyOn(conn, 'update');
    const updating = conn.update(head); // the office before this one, which went before restarting the box's host
    await vi.advanceTimersByTimeAsync(3000);
    await updating;
    expect(conn.state().info?.commit).toMatch(/^5ta1e00/); // the old host still runs

    office.scheduling = true;
    office.syncBoxes();
    expect(office.boxView(box).sync?.text).toBe("Updating to the office's 0ff1ce5: its agents carry on…");
    await vi.advanceTimersByTimeAsync(3000);
    expect(office.boxView(box)).toMatchObject({ status: 'connecting', sync: { text: "Reconnecting on the office's 0ff1ce5…" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(office.boxView(box)).toMatchObject({ status: 'online', sync: null });
    expect(conn.state().info?.commit).toBe(head);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("updates a box refused for another protocol at once, though an agent is still at work there", async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): { status: string; sync: { text: string; failed: boolean } | null } };
    const head = `0ff1ce5${'0'.repeat(33)}`;
    Object.assign(office, { officeHead: head });
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const box = swarm.addBox('Tower', 'ada@tower');
    const conn = internals().boxConns.get(box.id) as unknown as import('./machine.ts').BoxConnection;
    const real = conn.state.bind(conn);
    let refused = true; // its old checkout speaks another protocol, until it's updated
    vi.spyOn(conn, 'state').mockImplementation(() => (refused ? { ...real(), status: 'offline', info: null, clis: [], reported: false, refused: true } : real()));
    const update = vi.spyOn(conn, 'update').mockImplementation(async (target) => {
      refused = false;
      return { ok: true, checkout: true, from: `5ta1e00${'0'.repeat(33)}`, to: target };
    });
    await vi.advanceTimersByTimeAsync(1600);
    Object.assign(s.state.agents[0], { box: box.id, deskBox: box.id, status: 'working' });

    office.scheduling = true;
    office.syncBoxes();
    expect(update).toHaveBeenCalledWith(head);
    await vi.advanceTimersByTimeAsync(0);
    expect(office.boxView(box).sync?.text).toBe("Reconnecting on the office's 0ff1ce5…");
    await vi.advanceTimersByTimeAsync(1500);
    expect(office.boxView(box)).toMatchObject({ status: 'online', sync: null });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("asks a box from before #94 on the npm office's own version to update, and says when it can't", async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): { status: string; sync: { text: string; failed: boolean } | null } };
    Object.assign(office, { scheduling: true, officeHead: null }); // run from npm
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const events = vi.spyOn(s, 'broadcast');
    const box = swarm.addBox('Tower', 'ada@tower');
    const conn = internals().boxConns.get(box.id) as unknown as import('./machine.ts').BoxConnection;
    const real = conn.state.bind(conn);
    vi.spyOn(conn, 'state').mockImplementation(() => {
      const st = real();
      return { ...st, info: st.info && { ...st.info, version: VERSION, commit: undefined } }; // the office's version, no commit
    });
    // Its cubefarm doesn't know --update.
    const update = vi.spyOn(conn, 'update').mockRejectedValue(new Error('cubefarm box: an office starts this over ssh: cubefarm box --stdio --office <office id>'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(update).toHaveBeenCalledWith(VERSION);
    expect(office.boxView(box).sync).toEqual({ text: `Couldn't move to the office's v${VERSION}: cubefarm box: an office starts this over ssh: cubefarm box --stdio --office <office id>. Look again tries now; it also tries again in 30 min.`, failed: true });
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'toast', level: 'error', text: expect.stringMatching(/^Tower couldn't move to the office's version/) }));
    office.syncBoxes();
    expect(update).toHaveBeenCalledTimes(1); // not retried for the same version yet
    expect(internals().available(repo, 'dev').length).toBeGreaterThan(0); // agents can still work there

    // Half an hour on it tries again by itself, without another toast for the same error.
    events.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    office.syncBoxes();
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(office.boxView(box).sync?.failed).toBe(true);
    expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'toast' }));
  });

  it('tries a failed move again on Look again, once the manager updated the box by hand', async () => {
    const office = swarm as unknown as { scheduling: boolean; officeHead: string | null; schedule(): void; syncBoxes(): void; boxView(b: unknown): { status: string; sync: { text: string; failed: boolean } | null } };
    Object.assign(office, { scheduling: true, officeHead: `0ff1ce5${'0'.repeat(33)}` }); // the demo office's commit
    vi.spyOn(office, 'schedule').mockImplementation(() => undefined);
    const box = swarm.addBox('Tower', 'old-tower'); // its cubefarm predates --update
    await vi.advanceTimersByTimeAsync(1600 + 3000);
    expect(office.boxView(box).sync).toEqual({
      text: "Couldn't move to the office's 0ff1ce5: Tower's cubefarm predates self-update: run git pull, npm install and node scripts/build-server.mjs in its cubefarm folder once, then Look again",
      failed: true,
    });
    office.syncBoxes();
    expect(office.boxView(box).sync?.failed).toBe(true); // it waits for the manager

    await swarm.checkBox(box.id);
    expect(office.boxView(box).sync?.text).toBe("Updating to the office's 0ff1ce5: its agents carry on…");
    await vi.advanceTimersByTimeAsync(3000 + 1500);
    expect(office.boxView(box)).toMatchObject({ status: 'online', sync: null });
  });

  it('refuses bad boxes', () => {
    expect(() => swarm.addBox('x', '-oProxyCommand=evil')).toThrow(HttpError);
    expect(() => swarm.updateAgent('a1', { box: 'nope' })).toThrow(/No box/);
    expect(() => swarm.updateAgent(CEO_ID, { box: '' })).toThrow(/office's machine/);
  });
});

describe('approved Idea blockers', () => {
  const PREREQ = { repo: 'demo-co/weather-api', number: 7 };
  const url = (n: number) => `https://github.com/${repo.fullName}/issues/${n}`;
  const idea = (body = ''): IssueInfo => ({ ...issue(50, [], body), url: url(50), nativeBlockers: [] });
  const read = (state: 'OPEN' | 'CLOSED', stateReason: string | null = null): TrackedIssue =>
    ({ repo: PREREQ.repo, number: PREREQ.number, url: '', title: 'Add /forecast endpoint', body: '', labels: [], state, stateReason });
  let answer: TrackedIssue | null | Error;
  let list: Mock;

  /** A publication the office recorded: entry `e` released as #50 on this floor. */
  const seed = (plan: Partial<ApprovedSnapshot['issues'][number]> = {}, extra: ApprovedSnapshot['issues'] = [], numbers: Record<string, number | null> = {}) => {
    const snapshot = demoApprovedProposal(repo.fullName, 1);
    snapshot.issues = [{ ...snapshot.issues[0], entryId: 'e', ...plan }, ...extra];
    const rec = newPublication(snapshot, 1);
    for (const i of rec.issues) Object.assign(i, { step: 'released', number: i.entryId === 'e' ? 50 : numbers[i.entryId] ?? null });
    (s.state as unknown as { publications: Record<string, PublicationView> }).publications = { [rec.proposalId]: rec };
  };
  const sync = () => swarm.syncRepo(repo.id);
  const waitReason = () => JSON.parse(s.companyStatus()).floors[0].backlog.find((i: { number: number }) => i.number === 50).waitReason;

  beforeEach(() => {
    Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
    Object.assign(s.repoRt.get(repo.id)!, { lastMergedAt: null });
    list = vi.spyOn(s.backend, 'listIssues').mockResolvedValue([idea(), issue(51)]);
    vi.spyOn(s.backend, 'listPulls').mockResolvedValue({ pulls: [] });
    answer = read('OPEN');
    vi.spyOn(s.backend, 'readIssue').mockImplementation(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    seed({ blockedBy: [PREREQ] });
  });

  it('holds an Idea issue behind an open cross-repository prerequisite on both start paths, and says why', async () => {
    await sync();
    expect(s.backend.readIssue).toHaveBeenCalledWith(PREREQ.repo, PREREQ.number);
    expect(ready()).toEqual([51]); // ordinary work is unaffected
    expect(waitReason()).toBe('waits for approved prerequisite demo-co/weather-api#7 (open)');
    expect(issueWorkNote((s.repoView(repo) as { issues: IssueInfo[] }).issues[0])).toContain('demo-co/weather-api#7 (open)');
    await expect(swarm.assign('a1', 50)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('held by its approved plan: waits for approved prerequisite demo-co/weather-api#7 (open)') });
    expect(await s.officeTools().call('start_issue', { floor: 1, number: 50 })).toMatch(/^Refused: .*demo-co\/weather-api#7 \(open\)/);
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask.mock.calls[0][2].number).toBe(51);
  });

  it.each([
    ['unreadable', () => new Error('HTTP 502'), 'unreadable'],
    ['missing', () => null, 'missing'],
    ['closed as not planned', () => read('CLOSED', 'not_planned'), 'closed as not planned, delivery not confirmed'],
    ['closed as a duplicate', () => read('CLOSED', 'duplicate'), 'closed as duplicate, delivery not confirmed'],
  ] as [string, () => TrackedIssue | null | Error, string][])('keeps it held when the prerequisite is %s, whatever the body and native links say', async (_case, make, note) => {
    // The body and a native read both claim the prerequisite closed: neither replaces the approved identity's read.
    list.mockResolvedValue([{ ...idea(`Depends on https://github.com/${PREREQ.repo}/issues/7`), bodyBlockers: [{ ...PREREQ, state: 'CLOSED' }], nativeBlockers: [{ ...PREREQ, state: 'CLOSED' }] }]);
    answer = make();
    await sync();
    expect(ready()).toEqual([]);
    expect(waitReason()).toContain(`demo-co/weather-api#7 (${note})`);
    await expect(swarm.assign('a1', 50)).rejects.toMatchObject({ status: 409 });
    expect(s.startIssueWork(repo)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('holds until the first read, and never trusts a stale delivered read once a newer one fails', async () => {
    expect(ready()).toEqual([]);
    s.repoRt.get(repo.id)!.issues = [idea()];
    expect(waitReason()).toContain('(not read yet)');
    answer = read('CLOSED', 'completed');
    await sync();
    expect(ready()).toEqual([50, 51]);
    answer = new Error('HTTP 502');
    await sync();
    expect(ready()).toEqual([51]);
    expect(waitReason()).toContain('(unreadable)');
  });

  it('starts automatically once delivery is confirmed', async () => {
    list.mockResolvedValue([idea()]);
    await sync();
    expect(s.startIssueWork(repo)).toBe(false);
    answer = read('CLOSED', 'completed');
    await sync();
    expect(waitReason()).toBeUndefined();
    expect(s.startIssueWork(repo)).toBe(true);
    expect(runTask.mock.calls[0][2].number).toBe(50);
  });

  it('lets the manager start it once delivery is confirmed, with the ordinary readiness rules back in charge', async () => {
    answer = read('CLOSED', 'completed');
    list.mockResolvedValue([{ ...idea(), labels: ['needs-info'] }]);
    await sync();
    await expect(swarm.assign('a1', 50)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('waiting for info') });
    list.mockResolvedValue([idea()]);
    await sync();
    await swarm.assign('a1', 50);
    expect(runTask.mock.calls[0][2].number).toBe(50);
  });

  it('resolves a plan-entry blocker to the issue publication recorded, and holds it until that one is published', async () => {
    const other = { ...demoApprovedProposal(repo.fullName, 1).issues[0], entryId: 'api', repo: PREREQ.repo };
    seed({ blockedBy: [{ entryId: 'api' }] }, [other], { api: null });
    await sync();
    expect(s.backend.readIssue).not.toHaveBeenCalled();
    expect(waitReason()).toBe('waits for approved prerequisite plan entry api (not published yet)');
    seed({ blockedBy: [{ entryId: 'api' }] }, [other], { api: 7 });
    answer = read('CLOSED', 'completed');
    await sync();
    expect(s.backend.readIssue).toHaveBeenCalledWith(PREREQ.repo, 7);
    expect(ready()).toEqual([50, 51]);
  });

  it('keeps a Tracking Parent out of both start paths', async () => {
    seed({ tracking: true });
    await sync();
    expect(ready()).toEqual([51]);
    expect(waitReason()).toMatch(/Tracking Parent/);
    await expect(swarm.assign('a1', 50)).rejects.toMatchObject({ status: 409 });
  });

  it('leaves ordinary issues to their existing rules: an explicit start still overrides a body dependency', async () => {
    list.mockResolvedValue([issue(60), issue(61, [], 'Depends on #60')]);
    await sync();
    expect(s.backend.readIssue).not.toHaveBeenCalled();
    expect(ready()).toEqual([60]);
    await swarm.assign('a1', 61);
    expect(runTask.mock.calls[0][2].number).toBe(61);
  });
});

describe('closed work', () => {
  type Closing = Omit<Internals, 'agentRt'> & {
    stopClosedWork(repo: Repo, issues: IssueInfo[] | null, pulls: PullInfo[]): Promise<void>;
    agentRt: Map<string, { log: { text: string }[]; session?: { stop(): void } | null }>;
  };
  let c: Closing;
  let stop: Mock;
  const closedPull = (number: number, state: PullInfo['state'] = 'CLOSED') => ({ number, state } as PullInfo);
  const tracked = (number: number, state: 'OPEN' | 'CLOSED', labels: string[] = []): TrackedIssue => ({ repo: 'demo-co/pixel-todo', number, url: '', title: '', body: '', labels, state });
  const rec = (patch: Partial<QaRec> = {}) => ({
    repoId: repo.id, prNumber: 12, status: 'testing', round: 1, sessionFailures: 0, devAgentId: null, qaAgentId: 'a1',
    summary: null, checks: [], commentUrl: null, mergeNote: null, updatedAt: 0, ...patch,
  }) as QaRec;

  beforeEach(() => {
    c = s as unknown as Closing;
    stop = vi.fn();
    c.agentRt.get('a1')!.session = { stop };
    Object.assign(s.state.agents[0], { status: 'working', task: 'issue', issueNumber: 7, branch: 'swarm/issue-7-ada', prNumber: null });
  });
  const log = () => c.agentRt.get('a1')!.log.map((e) => e.text).join('\n');

  it('stops a busy developer whose issue closed and clears the desk', async () => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue(tracked(7, 'CLOSED'));
    const messages = vi.spyOn(s, 'postMessage');
    await c.stopClosedWork(repo, [issue(8)], []);
    expect(stop).toHaveBeenCalledOnce();
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null, issueNumber: null, branch: null });
    expect(log()).toContain('Stopped: issue #7 was closed');
    expect(messages).toHaveBeenCalledWith('office', expect.stringContaining('Stopped Ada'));
  });

  it.each([['still open past the listing cap', tracked(7, 'OPEN')], ['held for publication', tracked(7, 'CLOSED', ['held-for-publication'])]])('leaves an issue %s', async (_, read) => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue(read);
    await c.stopClosedWork(repo, [], []);
    expect(stop).not.toHaveBeenCalled();
    expect(s.state.agents[0]).toMatchObject({ status: 'working', issueNumber: 7 });
  });

  it('stops QA on a PR closed unmerged, keeping a record that holds a security review', async () => {
    Object.assign(s.state.agents[0], { task: 'qa', prNumber: 12 });
    const reviewed = rec({ securityReview: { reason: 'Auth', qaSha: 'sha' } } as Partial<QaRec>);
    s.state.qa.push(reviewed, rec({ prNumber: 14, qaAgentId: 'q2' }));
    await c.stopClosedWork(repo, null, [closedPull(12)]);
    expect(stop).toHaveBeenCalledOnce();
    expect(s.state.qa[0]).toMatchObject({ prNumber: 12, closed: true, status: 'queued', qaAgentId: null, securityReview: { qaSha: null } });
    expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null });
  });

  it('drops a fixing record without a security review', async () => {
    Object.assign(s.state.agents[0], { task: 'fix', prNumber: 12 });
    s.state.qa.push(rec({ status: 'fixing', devAgentId: 'a1', qaAgentId: null }));
    await c.stopClosedWork(repo, null, [closedPull(12)]);
    expect(s.state.qa).toEqual([]);
  });

  it('leaves CEO-parked and merged PRs alone', async () => {
    Object.assign(s.state.agents[0], { task: 'fix', prNumber: 12 });
    repo.parkedBranches = [{ issueNumber: 7, prNumber: 12, branch: 'swarm/issue-7-ada' }];
    await c.stopClosedWork(repo, null, [closedPull(12)]);
    repo.parkedBranches = [];
    await c.stopClosedWork(repo, [], [closedPull(12, 'MERGED')]);
    expect(stop).not.toHaveBeenCalled();
  });

  describe('on a sync, for a PR the open and merged lists leave out', () => {
    let prState: PullInfo['state'] | Error;
    // The production listPulls over gh's answers: open PRs and the newest merged ones, never a closed one.
    const raw = (number: number, state: 'OPEN' | 'MERGED') => ({
      number, title: '', url: '', isCrossRepository: false, headRefName: `feature/${number}`, headRefOid: 'sha', state, isDraft: false, mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: null, labels: [], closingIssuesReferences: [], createdAt: '',
      mergedAt: state === 'MERGED' ? '2026-11-01' : null, additions: 0, deletions: 0, statusCheckRollup: [],
    });
    beforeEach(() => {
      Object.assign(repo, { defaultBranch: 'main', links: [], parkedBranches: [] });
      Object.assign(s.repoRt.get(repo.id)!, { lastMergedAt: '2026-11-01' });
      vi.spyOn(s.backend, 'listIssues').mockResolvedValue([]);
      vi.spyOn(s.backend, 'listPulls').mockImplementation((name) => listPulls(name, async (args) => [raw(args.includes('open') ? 13 : 9, args.includes('open') ? 'OPEN' : 'MERGED')]));
      prState = 'CLOSED';
      vi.spyOn(s.backend, 'prDetails').mockImplementation(async (_name, number) => {
        if (prState instanceof Error) throw prState;
        return { number, state: prState } as Awaited<ReturnType<Backend['prDetails']>>;
      });
    });

    it('confirms a QA session\'s PR closed, stops it and keeps the record that holds a security review', async () => {
      Object.assign(s.state.agents[0], { task: 'qa', prNumber: 12 });
      s.state.qa.push(rec({ securityReview: { reason: 'Auth', qaSha: 'sha' } } as Partial<QaRec>));
      await swarm.syncRepo(repo.id);
      expect(s.backend.prDetails).toHaveBeenCalledWith(repo.fullName, 12);
      expect(stop).toHaveBeenCalledOnce();
      expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null, prNumber: null });
      expect(s.state.qa.find((q) => q.prNumber === 12)).toMatchObject({ closed: true, status: 'queued', qaAgentId: null, securityReview: { qaSha: null } });
      expect(log()).toContain('Stopped: PR #12 was closed without merging');
    });

    it('confirms a fix session\'s PR closed, stops it and drops its record', async () => {
      Object.assign(s.state.agents[0], { task: 'fix', prNumber: 12 });
      s.state.qa.push(rec({ status: 'fixing', devAgentId: 'a1', qaAgentId: null }));
      await swarm.syncRepo(repo.id);
      expect(stop).toHaveBeenCalledOnce();
      expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null });
      expect(s.state.qa.some((q) => q.prNumber === 12)).toBe(false);
    });

    it.each([['open', 'OPEN'], ['merged', 'MERGED'], ['unreadable', new Error('HTTP 502')]] as const)('leaves the session on a PR that is %s', async (_, state) => {
      prState = state;
      Object.assign(s.state.agents[0], { task: 'fix', prNumber: 12 });
      s.state.qa.push(rec({ status: 'fixing', devAgentId: 'a1', qaAgentId: null }));
      await swarm.syncRepo(repo.id);
      expect(stop).not.toHaveBeenCalled();
      expect(s.state.agents[0]).toMatchObject({ status: 'working', task: 'fix', prNumber: 12 });
      expect(s.state.qa[0]).toMatchObject({ prNumber: 12, status: 'fixing' });
    });

    it('clears a resumed issue before starting when its PR closed unmerged, though the issue is still open', async () => {
      const session = { send: vi.fn(), stop: vi.fn() };
      const starts = vi.spyOn(s.backend, 'startSession').mockReturnValue(session);
      vi.spyOn(s.backend, 'deskHead').mockResolvedValue('base');
      vi.mocked(s.backend.listIssues).mockResolvedValue([issue(7)]);
      c.agentRt.get('a1')!.session = null;
      Object.assign(s.state.agents[0], { status: 'done', task: 'issue', prNumber: 12, sessionId: 'dev-session', model: '', effort: '', cli: '' });
      await swarm.message('a1', 'Carry on');
      expect(starts).not.toHaveBeenCalled();
      expect(s.backend.prDetails).toHaveBeenCalledWith(repo.fullName, 12);
      expect(session.stop).not.toHaveBeenCalled();
      expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null, issueNumber: null, prNumber: null });
      expect(log()).toContain('Not resuming: PR #12 was closed without merging');
    });

    it('still stops an issue task on a closed issue when its unlisted PR reads back open', async () => {
      prState = 'OPEN';
      vi.spyOn(s.backend, 'readIssue').mockResolvedValue(tracked(7, 'CLOSED'));
      Object.assign(s.state.agents[0], { prNumber: 12 });
      await swarm.syncRepo(repo.id);
      expect(stop).toHaveBeenCalledOnce();
      expect(log()).toContain('Stopped: issue #7 was closed');
    });

    it.each([['merged', 'MERGED'], ['unreadable', new Error('HTTP 502')]] as const)('leaves an issue task on a %s unlisted PR, even with its issue closed', async (_, state) => {
      prState = state;
      const read = vi.spyOn(s.backend, 'readIssue').mockResolvedValue(tracked(7, 'CLOSED'));
      Object.assign(s.state.agents[0], { prNumber: 12 });
      await swarm.syncRepo(repo.id);
      expect(read).not.toHaveBeenCalledWith(repo.fullName, 7);
      expect(stop).not.toHaveBeenCalled();
      expect(s.state.agents[0]).toMatchObject({ status: 'working', task: 'issue', issueNumber: 7 });
    });

    it('leaves a CEO-parked PR alone without reading it', async () => {
      Object.assign(s.state.agents[0], { task: 'fix', prNumber: 12 });
      repo.parkedBranches = [{ issueNumber: 7, prNumber: 12, branch: 'swarm/issue-7-ada' }];
      await swarm.syncRepo(repo.id);
      expect(s.backend.prDetails).not.toHaveBeenCalledWith(repo.fullName, 12);
      expect(stop).not.toHaveBeenCalled();
    });
  });

  describe('before a desk is prepared', () => {
    const actual = () => new Swarm(s.backend) as unknown as Internals;
    beforeEach(() => {
      Object.assign(repo, { defaultBranch: 'main', links: [] });
      c.agentRt.get('a1')!.session = null;
    });

    it('refuses a closed issue and logs why', async () => {
      vi.spyOn(s.backend, 'readIssue').mockResolvedValue(tracked(7, 'CLOSED'));
      const prepare = vi.spyOn(s, 'prepare');
      s.repoRt.get(repo.id)!.issues = [issue(7)];
      Object.assign(s.state.agents[0], { status: 'preparing' });
      await actual().runTask.call(s, s.state.agents[0], repo, issue(7));
      expect(prepare).not.toHaveBeenCalled();
      expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null });
      expect(s.repoRt.get(repo.id)!.issues).toEqual([]);
      expect(log()).toContain('Not starting: issue #7 is closed');
    });

    it('goes ahead when the issue cannot be read', async () => {
      vi.spyOn(s.backend, 'readIssue').mockRejectedValue(new Error('offline'));
      const prepare = vi.spyOn(s, 'prepare').mockResolvedValue('');
      Object.assign(s.state.agents[0], { status: 'preparing' });
      await actual().runTask.call(s, s.state.agents[0], repo, issue(7));
      expect(prepare).toHaveBeenCalledOnce();
    });

    it.each(['OPEN', 'CLOSED'] as const)('drops a start whose task was replaced while issue #7 read back %s', async (state) => {
      let answer!: (issue: TrackedIssue) => void;
      vi.spyOn(s.backend, 'readIssue').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const prepare = vi.spyOn(s, 'prepare').mockResolvedValue('/desk');
      const start = vi.spyOn(s, 'startAgentSession').mockImplementation(() => {});
      const a = s.state.agents[0];
      Object.assign(a, { status: 'preparing' });
      const run = actual().runTask.call(s, a, repo, issue(7));
      s.clearTask(a);
      s.beginTask(a, { task: 'issue', issueNumber: 8, issueTitle: 'Issue 8', branch: 'swarm/issue-8-ada', prNumber: null }, 'Issue #8', 'Preparing');
      answer(tracked(7, state));
      await run;
      expect(prepare).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(a).toMatchObject({ status: 'preparing', task: 'issue', issueNumber: 8, branch: 'swarm/issue-8-ada' });
      expect(log()).not.toContain('Not starting');
    });

    it('drops a start for an agent removed while its PR was read', async () => {
      let answer!: (details: Awaited<ReturnType<Backend['prDetails']>>) => void;
      vi.spyOn(s.backend, 'prDetails').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const prepare = vi.spyOn(s, 'prepare').mockResolvedValue('/desk');
      const record = rec({ status: 'failed', devAgentId: 'a1', qaAgentId: null });
      s.state.qa.push(record);
      const a = s.state.agents[0];
      const run = s.runFix(a, repo, record);
      await vi.waitFor(() => expect(s.backend.prDetails).toHaveBeenCalled());
      s.state.agents = s.state.agents.filter((x) => x !== a);
      answer({ state: 'OPEN' } as Awaited<ReturnType<Backend['prDetails']>>);
      await run;
      expect(prepare).not.toHaveBeenCalled();
    });

    it('refuses a fix for a closed PR and drops its record', async () => {
      vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ state: 'CLOSED' } as Awaited<ReturnType<Backend['prDetails']>>);
      const prepare = vi.spyOn(s, 'prepare');
      const record = rec({ status: 'failed', devAgentId: 'a1', qaAgentId: null });
      s.state.qa.push(record);
      await s.runFix(s.state.agents[0], repo, record);
      expect(prepare).not.toHaveBeenCalled();
      expect(s.state.qa).toEqual([]);
      expect(s.state.agents[0]).toMatchObject({ status: 'idle', task: null });
      expect(log()).toContain('Not starting: PR #12 is closed');
    });
  });
});

describe('silent QA and fix loop guard', () => {
  it.each(['qa', 'fix'] as const)('counts each silent %s stop once and parks the third, freeing the desk', async (task) => {
    const recovery = s as Internals & { watchSilentSessions(): void };
    const a = s.state.agents[0];
    Object.assign(a, { role: task === 'qa' ? 'qa' : 'dev', deskBox: '', cli: '' });
    const rec = { repoId: repo.id, prNumber: 13, issueNumber: 66, status: task === 'qa' ? 'queued' : 'failed', round: 2, sessionFailures: 0, qaAgentId: null, devAgentId: task === 'fix' ? 'a1' : 'author', summary: 'Keep findings', checks: [], commentUrl: null, mergeNote: null, updatedAt: 0, fixCrashes: [] } as unknown as QaRec;
    s.state.qa.push(rec);
    const stop = vi.fn();
    const start = async (agent: unknown, _repo: Repo, r: unknown) => {
      s.beginTask(agent, { task, issueNumber: 66, prNumber: 13 }, 'Working', 'Preparing');
      Object.assign(agent as object, { status: 'working', task, prNumber: 13, startedAt: Date.now(), sessionId: 'thread' });
      Object.assign(r as object, task === 'qa' ? { status: 'testing', qaAgentId: 'a1' } : { status: 'fixing', devAgentId: 'a1' });
      Object.assign(s.agentRt.get('a1')!, { session: { send: vi.fn(), stop } });
    };
    vi.spyOn(s, task === 'qa' ? 'runQa' : 'runFix').mockImplementation(start);
    for (let n = 1; n <= 3; n++) {
      expect(s.startPipelineWork(repo)).toBe(true);
      vi.setSystemTime(Date.now() + 60 * 60_000);
      recovery.watchSilentSessions();
      vi.setSystemTime(Date.now() + 10 * 60_000);
      recovery.watchSilentSessions();
      expect(stop).toHaveBeenCalledTimes(n);
      expect(swarm.runHistory().attempts[0].outcome).toMatchObject({ result: 'interrupted', cause: 'office' });
      expect(a.taskFailures).toEqual({ key: `r1:${task}:13`, count: n });
      vi.setSystemTime(Date.now() + 2 * 60_000);
      s.recoverDesks();
      expect(a.taskFailures).toEqual({ key: `r1:${task}:13`, count: n });
      if (n < 3) expect(rec).toMatchObject({ status: task === 'qa' ? 'queued' : 'failed', sessionFailures: 0 });
    }
    expect(rec).toMatchObject({ status: 'needs-human', round: 2, sessionFailures: 0, summary: expect.stringContaining('failed this task 3 times') });
    expect(a).toMatchObject({ status: 'idle', task: null, prNumber: null });
    expect(s.startPipelineWork(repo)).toBe(false);
  });
});

describe('silent session recovery', () => {
  type Recovery = Internals & { watchSilentSessions(): void; reattachSession(a: unknown): Promise<void> };
  let recovery: Recovery;
  let cb: SessionCallbacks;
  let send: Mock;
  let stop: Mock;
  const dev = () => s.state.agents[0];
  const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);

  beforeEach(async () => {
    recovery = s as Recovery;
    s.agentRt.set(CEO_ID, { log: [], pending: [], terminal: null });
    Object.assign(repo, { defaultBranch: 'main', links: [] });
    Object.assign(dev(), { model: '', effort: '', cli: '', costUsd: 0, turns: 0 });
    s.runTask = (Swarm.prototype as unknown as Pick<Internals, 'runTask'>).runTask;
    vi.spyOn(s, 'prepare').mockResolvedValue('/fake-desk');
    vi.spyOn(s.backend, 'deskHead').mockResolvedValue('base');
    send = vi.fn();
    stop = vi.fn();
    vi.spyOn(s.backend, 'startSession').mockImplementation((_opts, callbacks) => {
      cb = callbacks;
      return { send, stop };
    });
    setIssues(issue(66));
    await swarm.assign('a1', 66);
    await vi.advanceTimersByTimeAsync(0);
    cb.sessionId('running-thread');
  });

  it('nudges once, then holds a retry with its conversation and ignores late completions', () => {
    minutes(20);
    recovery.watchSilentSessions();
    recovery.watchSilentSessions();
    expect(send).toHaveBeenCalledOnce();
    minutes(10);
    recovery.watchSilentSessions();
    recovery.watchSilentSessions();
    expect(stop).toHaveBeenCalledOnce();
    expect(dev()).toMatchObject({ status: 'error', sessionId: 'running-thread', branch: 'swarm/issue-66-ada', heldRetry: { issueNumber: 66, resume: true } });
    expect(swarm.snapshot().repos[0].sessionRemedies?.['issue:66'].requeueAt).toBe(Date.now());
    cb.finished({ ok: true, text: '', costUsd: 0, turns: 0, errors: [] });
    expect(dev().status).toBe('error');
  });

  it('counts each silent issue stop once through cooldown and resume, then parks the third', async () => {
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ repo: repo.fullName, ...issue(66), state: 'OPEN' });
    const held = s as unknown as { runHeldRetries(): void };
    const silence = () => {
      minutes(60);
      recovery.watchSilentSessions();
      minutes(10);
      recovery.watchSilentSessions();
    };
    for (const count of [1, 2]) {
      silence();
      expect(dev()).toMatchObject({ status: 'error', heldRetry: { issueNumber: 66, resume: true }, taskFailures: { count } });
      minutes(2);
      s.recoverDesks();
      expect(dev()).toMatchObject({ status: 'idle', taskFailures: { count } });
      held.runHeldRetries();
      await vi.advanceTimersByTimeAsync(0);
      expect(dev()).toMatchObject({ status: 'working', task: 'issue', issueNumber: 66, taskFailures: { count } });
    }
    silence();
    expect(stop).toHaveBeenCalledTimes(3);
    expect(dev()).toMatchObject({ status: 'idle', task: null, heldRetry: null, taskFailures: { count: 3 } });
    expect(repo.noWorkEndings).toEqual([expect.objectContaining({ issueNumber: 66, reason: expect.stringContaining('failed this task 3 times') })]);
  });

  it.each(['hook', 'log', 'terminal'] as const)('recent %s activity postpones the nudge', (source) => {
    minutes(19);
    if (source === 'hook') cb.activity!();
    if (source === 'log') cb.log([{ kind: 'tool', text: 'Working' }]);
    if (source === 'terminal') Object.assign(s.agentRt.get('a1')!, { terminal: { lastOutputAt: Date.now() } });
    minutes(1);
    recovery.watchSilentSessions();
    expect(send).not.toHaveBeenCalled();
    minutes(19);
    recovery.watchSilentSessions();
    expect(send).toHaveBeenCalledOnce();
  });

  it('requeues an issue without a conversation through requested starts even with auto assignment disabled', () => {
    dev().sessionId = null;
    repo.autoAssign = false;
    minutes(20);
    recovery.watchSilentSessions();
    minutes(10);
    recovery.watchSilentSessions();
    expect(stop).toHaveBeenCalledOnce();
    expect(dev()).toMatchObject({ status: 'idle', task: null, taskFailures: { count: 1 } });
    expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', restartPending: true }]);
    expect(s.startIssueWork(repo)).toBe(true);
    expect(dev()).toMatchObject({ task: 'issue', issueNumber: 66, taskFailures: { count: 1 } });
  });

  it.each(['CLOSED', 'MERGED'] as const)('clears a kept CLI on a %s PR before attaching to it', async (state) => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    Object.assign(dev(), { status: 'stopped', prNumber: 12 });
    vi.spyOn(s.backend, 'prDetails').mockResolvedValue({ state } as Awaited<ReturnType<Backend['prDetails']>>);
    vi.mocked(s.backend.startSession).mockClear();
    await recovery.reattachSession(dev());
    expect(s.backend.startSession).not.toHaveBeenCalled();
    expect(dev()).toMatchObject({ status: 'idle', task: null, sessionId: null });
  });

  it('clears an issue closed during downtime before resuming it', async () => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    dev().status = 'stopped';
    vi.spyOn(s.backend, 'readIssue').mockResolvedValue({ repo: repo.fullName, ...issue(66), state: 'CLOSED' });
    vi.mocked(s.backend.startSession).mockClear();
    await swarm.message('a1', 'Resume after restart');
    expect(s.backend.startSession).not.toHaveBeenCalled();
    expect(dev()).toMatchObject({ status: 'idle', task: null });
  });

  it('checks a box desk on its machine and reattaches there without local restoration', async () => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    Object.assign(dev(), { status: 'stopped', deskBox: 'box-1' });
    const deskExists = vi.fn(async () => true);
    const startSession = vi.fn((_opts: SessionOptions, callbacks: SessionCallbacks) => {
      cb = callbacks;
      return { send, stop };
    });
    const machine = { ...s.backend, deskExists, startSession };
    const boxes = s as unknown as { boxConns: Map<string, unknown>; state: { boxes: { id: string }[] } };
    boxes.state.boxes.push({ id: 'box-1' });
    boxes.boxConns.set('box-1', { machine, state: () => ({ status: 'online', clis: [{ id: 'claude', installed: true }] }) });
    vi.mocked(s.backend.startSession).mockClear();
    vi.mocked(s.backend.deskExists).mockClear();
    const prepare = vi.spyOn(s.backend, 'prepareDesk');
    await recovery.reattachSession(dev());
    expect(deskExists).toHaveBeenCalledOnce();
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ reattach: true }), expect.anything());
    expect(s.backend.deskExists).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(s.backend.startSession).not.toHaveBeenCalled();
    minutes(20);
    cb.activity!();
    recovery.watchSilentSessions();
    expect(send).not.toHaveBeenCalled();
  });

  it('requeues a missing desk instead of resuming a conversation there', async () => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    dev().status = 'stopped';
    vi.mocked(s.backend.deskExists).mockResolvedValue(false);
    vi.mocked(s.backend.startSession).mockClear();
    await swarm.message('a1', 'Resume after restart');
    expect(s.backend.startSession).not.toHaveBeenCalled();
    expect(dev()).toMatchObject({ status: 'idle', task: null });
    expect(repo.requestedStarts).toEqual([{ issueNumber: 66, preferredAgentId: 'a1', restartPending: true }]);
  });

  it('admits a typed fix follow-up synchronously so its CLI does not reject the prompt', () => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    Object.assign(dev(), { status: 'done', task: 'fix', prNumber: 12 });
    const terminal = (s as unknown as { terminalFor(a: unknown): AgentTerminal }).terminalFor(dev());
    const read = vi.spyOn(s.backend, 'prDetails');
    expect(terminal.onIdlePrompt!('Please finish this fix')).toBe(true);
    expect(s.backend.startSession).toHaveBeenLastCalledWith(expect.objectContaining({ typed: true }), expect.anything());
    expect(read).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it.each(['cached-head', null])('records a typed fix follow-up synchronously with starting SHA %s', async (headSha) => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    Object.assign(dev(), { status: 'done', task: 'fix', prNumber: 12 });
    s.queueQa(repo, 12, dev(), 66);
    if (headSha) s.repoRt.get(repo.id)!.pulls = [{ number: 12, headSha } as PullInfo];
    const terminal = (s as unknown as { terminalFor(a: unknown): AgentTerminal }).terminalFor(dev());
    const read = vi.spyOn(s.backend, 'prDetails');
    vi.mocked(s.backend.startSession).mockClear();

    expect(terminal.onIdlePrompt!('Please finish this fix')).toBe(true);
    expect(s.backend.startSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ typed: true }), expect.anything());
    expect(read).not.toHaveBeenCalled();
    expect(s.state.prContributions).toHaveLength(1);
    expect(s.state.prContributions[0].repairs).toHaveLength(1);
    expect(s.state.prContributions[0].repairs[0]).toMatchObject({ agentId: 'a1', startingSha: headSha, findings: 'Please finish this fix' });
    await Promise.resolve();
    expect(s.state.prContributions[0].repairs).toHaveLength(1);
    terminal.dispose();
  });

  it('keeps recovery details after a desk check fails instead of leaving a phantom worker', async () => {
    Object.assign(s.agentRt.get('a1')!, { session: null });
    dev().status = 'stopped';
    vi.mocked(s.backend.deskExists).mockRejectedValue(new Error('box disconnected'));
    vi.mocked(s.backend.startSession).mockClear();
    await expect(swarm.message('a1', 'Resume after restart')).rejects.toThrow('box disconnected');
    expect(dev()).toMatchObject({ status: 'stopped', task: 'issue', sessionId: 'running-thread', issueNumber: 66 });
    expect(s.backend.startSession).not.toHaveBeenCalled();
  });
});

describe('Upstash placement', () => {
  const cloud = () => swarm as unknown as {
    state: { upstashTasks: import('../shared/types.ts').UpstashTask[]; repos: { box?: string }[]; settings: { runtime: string } };
    clis: { id: string; installed: boolean }[];
    upstash: { full(): boolean };
    place(a: unknown, kind: 'new' | 'within'): { box?: string; wait?: string; lacks?: string };
  };
  const task = (): import('../shared/types.ts').UpstashTask => ({ id: 'upstash-task', name: 'task', boxId: 'box-1', agentId: 'a1', repo: repo.fullName, branch: 'task', cli: 'codex', slug: 'ada-a1', port: 5324, phase: 'active', error: null });

  it('offers opt-in placement when hiring, for individual workers and for a whole floor', () => {
    const hired = swarm.hireAgent(repo.id, { name: 'Cloud Ada', box: 'upstash', cli: 'codex' });
    expect(hired.box).toBe('upstash');
    swarm.updateAgent(hired.id, { box: '' });
    expect(s.state.agents.find((a) => a.id === hired.id)?.box).toBe('');
    swarm.updateRepo(repo.id, { box: 'upstash', everyone: true });
    expect((s.state.repos[0] as Repo & { box: string }).box).toBe('upstash');
    expect(s.state.agents.find((a) => a.id === hired.id)?.box).toBeNull();
  });

  it('falls back to the floor machine, or queues if an Upstash floor’s main-office fallback lacks the CLI', () => {
    const c = cloud(); c.state.settings.runtime = 'terminal'; c.upstash = { full: () => true };
    Object.assign(s.state.agents[0], { box: 'upstash', cli: 'codex', deskBox: '' });
    c.clis = [{ id: 'claude', installed: true }];
    c.state.repos[0].box = 'upstash';
    expect(c.place(s.state.agents[0], 'new')).toEqual({ wait: '', lacks: 'codex' });
    c.clis.push({ id: 'codex', installed: true });
    expect(c.place(s.state.agents[0], 'new')).toEqual({ box: '' });
    const floor = swarm.addBox('Floor machine', 'floor-machine');
    c.state.repos[0].box = floor.id;
    expect(c.place(s.state.agents[0], 'new')).toEqual({ wait: floor.id });
  });

  it('reuses an active reservation even at capacity and holds new work behind cleanup after a placement change', () => {
    const c = cloud(); c.state.settings.runtime = 'terminal'; c.upstash = { full: () => true };
    Object.assign(s.state.agents[0], { box: 'upstash', cli: 'codex', deskBox: 'upstash-task' });
    c.state.upstashTasks.push(task());
    expect(c.place(s.state.agents[0], 'new')).toEqual({ box: 'upstash' });
    // An active task cannot silently move to local disk when its connection is missing.
    expect(c.place(s.state.agents[0], 'within')).toEqual({ wait: 'upstash-task' });
    s.state.agents[0].box = '';
    expect(c.place(s.state.agents[0], 'new')).toEqual({ wait: 'upstash-task' });
    s.state.agents[0].box = 'upstash'; c.state.upstashTasks[0].phase = 'cleanup-blocked';
    expect(c.place(s.state.agents[0], 'new')).toEqual({ wait: 'upstash-task' });
  });
});


it('opens an Upstash link outside the task start that requested it', async () => {
  const task: import('../shared/types.ts').UpstashTask = { id: 'upstash-task', name: 'task', boxId: 'box-1', agentId: 'a1', repo: repo.fullName, branch: 'task', cli: 'opencode', slug: 'ada-a1', port: 5324, phase: 'active', error: null };
  const internals = swarm as unknown as { openUpstash(task: unknown): Promise<unknown> };
  const { operationSignal, withOperation } = await import('./operation.ts');
  let seen: AbortSignal | undefined | null = null;
  vi.spyOn(s.backend.upstash, 'connect').mockImplementation(async () => {
    await Promise.resolve();
    seen = operationSignal();
    throw new Error('no link');
  });
  await expect(withOperation(new AbortController().signal, () => internals.openUpstash(task))).rejects.toThrow('no link');
  // Session-end callbacks run in the link's context: an inherited start signal, aborted once the session starts, fails their gh and Box calls.
  expect(seen).toBeUndefined();
});

it('reconnects a stopped Upstash task without resetting its unsaved worktree', async () => {
  const a = s.state.agents[0];
  Object.assign(a, { status: 'preparing', deskBox: 'upstash-task', box: 'upstash', branch: 'task', cli: 'codex' });
  const task: import('../shared/types.ts').UpstashTask = { id: 'upstash-task', name: 'task', boxId: 'box-1', agentId: 'a1', repo: repo.fullName, branch: 'task', cli: 'codex', slug: 'ada-a1', port: 5324, phase: 'active', error: null, deskStarted: true };
  const internals = swarm as unknown as { state: { upstashTasks: typeof task[] }; upstash: import('./upstash.ts').UpstashTasks; boxConns: Map<string, BoxConnection>; openUpstash(): Promise<unknown>; writeState(): Promise<void> };
  internals.state.upstashTasks.push(task);
  const { UpstashTasks } = await import('./upstash.ts');
  internals.upstash = new UpstashTasks(internals.state.upstashTasks, s.backend.upstash, async () => {});
  const machine = { ...s.backend, prepareDesk: vi.fn(), deskExists: vi.fn(async () => true), deskDir: () => 'existing-cloud-desk' };
  a.name = 'Renamed worker';
  internals.boxConns.set(task.id, { machine, hooksReady: () => undefined, state: () => ({ status: 'online' }) } as unknown as BoxConnection);
  vi.spyOn(internals, 'openUpstash').mockResolvedValue([]);
  vi.spyOn(internals, 'writeState').mockResolvedValue();
  s.repoRt.get(repo.id)!.cloneStatus = 'ready';
  expect(await s.prepare(a, repo, {}, 'task')).toBe('existing-cloud-desk');
  expect(machine.prepareDesk).not.toHaveBeenCalled();
  expect(machine.deskExists).toHaveBeenCalledWith(repo.fullName, task.slug);
});
