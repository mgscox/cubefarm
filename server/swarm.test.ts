import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError, Swarm } from './swarm.ts';
import { CEO_ID, type IssueInfo } from '../shared/types.ts';

// The scheduler's view of ready-for-human issues, on a Swarm that is never init()ed: no state file, timers or sessions.

type RunTask = (agent: unknown, repo: Repo, issue: IssueInfo) => Promise<void>;
type Repo = { id: string; fullName: string; floor: number; autoAssign: boolean; preview: { command: null; env: object } };
interface Internals {
  state: { repos: Repo[]; agents: Record<string, unknown>[] };
  repoRt: Map<string, { issues: IssueInfo[]; pulls: unknown[] }>;
  agentRt: Map<string, { log: unknown[]; terminal: null }>;
  readyIssues(repo: Repo): { issue: IssueInfo }[];
  startIssueWork(repo: Repo): boolean;
  companyStatus(): string;
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
  swarm = new Swarm(createDemoBackend());
  s = swarm as unknown as Internals;
  repo = { id: 'r1', fullName: 'demo-co/pixel-todo', floor: 1, autoAssign: true, preview: { command: null, env: {} } };
  s.state.repos.push(repo);
  s.state.agents.push({ id: 'a1', name: 'Ada', repoId: repo.id, role: 'dev', specialty: '', status: 'idle', task: null, issueNumber: null, desk: 0, endedAt: null });
  s.agentRt.set('a1', { log: [], terminal: null });
  s.state.agents.push({ id: CEO_ID, name: 'Joi', repoId: '', role: 'ceo', status: 'idle' });
  s.repoRt.set(repo.id, { issues: [], pulls: [] });
  runTask = vi.fn<RunTask>(async () => {});
  s.runTask = runTask;
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
