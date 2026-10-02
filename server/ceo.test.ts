import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createOfficeTools, IssueCap, jobLabel, mergeableState, pickDeveloper, planRoute, planStartIssue, prStatusView, specialtyLabel, specialtySlug, type CeoJob, type PrQaState, type RouteRequest, type OfficeHandlers } from './ceo.ts';
import { stuckAnswer, stuckTarget } from './demo.ts';
import type { PullInfo } from '../shared/types.ts';

describe('specialtySlug', () => {
  it('turns a specialty into a lowercase slug', () => {
    expect(specialtySlug('Three.js graphics')).toBe('three-js-graphics');
    expect(specialtySlug('Testing')).toBe('testing');
    expect(specialtySlug('front_end / UI')).toBe('front-end-ui');
  });

  it('trims separators from both ends', () => {
    expect(specialtySlug('  --Backend!!  ')).toBe('backend');
  });

  it('keeps at most 24 characters', () => {
    expect(specialtySlug('a'.repeat(40))).toBe('a'.repeat(24));
    expect(specialtySlug('infrastructure and devops tooling')).toHaveLength(24);
  });

  // Known bug: the cut happens after the trim, so 'abcdefghijklmnopqrstuvw xyz' becomes 'abcdefghijklmnopqrstuvw-'.
  it.todo('does not end in "-" when the 24-character cut lands on a separator');

  it('is empty for no specialty', () => {
    expect(specialtySlug(undefined)).toBe('');
    expect(specialtySlug('')).toBe('');
    expect(specialtySlug('!!!')).toBe('');
  });

  it('never returns "skip", which means "leave this issue alone"', () => {
    expect(specialtySlug('skip')).toBe('');
    expect(specialtySlug('SKIP')).toBe('');
    expect(specialtySlug(' -skip- ')).toBe('');
    expect(specialtySlug('skipping')).toBe('skipping');
  });

  it('round-trips through specialtyLabel', () => {
    expect(specialtyLabel(specialtySlug('Three.js graphics'))).toBe('swarm:three-js-graphics');
  });
});

describe('jobLabel', () => {
  const job = (kind: CeoJob['kind']): CeoJob => ({ kind, repoId: 'r1', at: 0 });
  const floor = { floor: 3, fullName: 'leonvanzyl/office-swarm' };

  it('names the floor and repo for floor jobs', () => {
    expect(jobLabel(job('onboard'), floor)).toBe('Onboarding floor 3 · office-swarm');
    expect(jobLabel(job('plan'), floor)).toBe('Planning floor 3 · office-swarm');
  });

  it('falls back to the full name when it has no owner', () => {
    expect(jobLabel(job('plan'), { floor: 1, fullName: 'solo' })).toBe('Planning floor 1 · solo');
  });

  it('says so when the floor is gone', () => {
    expect(jobLabel(job('onboard'), null)).toBe('Onboarding a removed floor');
    expect(jobLabel(job('plan'), null)).toBe('Planning a removed floor');
  });

  it('labels company-wide jobs without a floor', () => {
    expect(jobLabel(job('review'), floor)).toBe('Reviewing the company');
    expect(jobLabel(job('review'), null)).toBe('Reviewing the company');
    expect(jobLabel({ kind: 'chat', text: 'hi', at: 0 }, null)).toBe('Replying to you');
  });
});

// The CEO only sees the office tools if the whole list converts to JSON Schema: one schema the SDK can't handle
// (z.record did this) empties tools/list, and the CEO silently loses every tool.
describe('office tools', () => {
  const connect = async (startIssue: OfficeHandlers['startIssue'] = async () => 'started', rerunQa: OfficeHandlers['rerunQa'] = async () => 'queued') => {
    const floors: unknown[] = [];
    const office = createOfficeTools({
      companyStatus: () => '{}',
      agentDetail: () => '{}',
      setFloorProfile: (a) => (floors.push(a), 'saved'),
      updateJob: () => '',
      proposeHire: () => '',
      proposeLetGo: () => '',
      fileIssue: async () => '',
      routeIssue: async () => '',
      startIssue,
      rerunQa,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await office.server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    return { client, floors };
  };

  it('lists every tool the CEO relies on', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['agent_detail', 'company_status', 'file_issue', 'propose_hire', 'propose_let_go', 'rerun_qa', 'route_issue', 'set_floor_profile', 'start_issue', 'update_job']);
  });

  it('validates rerun arguments and returns handler errors as tool errors', async () => {
    const requests: unknown[] = [];
    const { client } = await connect(undefined, async (a) => {
      requests.push(a);
      if (a.number === 14) throw new Error('PR #14 is already testing');
      return 'PR #13 on floor 8 is queued for QA (round 2).';
    });
    const args = { floor: 8, number: 13, note: 'Check the recovery path' };
    expect(await client.callTool({ name: 'rerun_qa', arguments: args })).toMatchObject({
      content: [{ type: 'text', text: 'PR #13 on floor 8 is queued for QA (round 2).' }],
    });
    for (const invalid of [{ floor: 8 }, { ...args, number: 13.5 }, { ...args, floor: 8.5 }, { ...args, number: 0 }, { ...args, note: 'x'.repeat(1001) }]) {
      expect(await client.callTool({ name: 'rerun_qa', arguments: invalid })).toMatchObject({ isError: true });
    }
    expect(requests).toEqual([args]);
    expect(await client.callTool({ name: 'rerun_qa', arguments: { floor: 8, number: 14 } })).toMatchObject({
      isError: true, content: [{ type: 'text', text: 'Refused: PR #14 is already testing' }],
    });
  });

  it('passes validated start arguments and returns refusal text instead of crashing', async () => {
    const requests: unknown[] = [];
    const { client } = await connect(async (a) => {
      requests.push(a);
      throw new Error('All 2 session slots are busy.');
    });
    const args = { floor: 1, number: 4, agent: 'Ada', note: 'Keep it small' };
    const result = await client.callTool({ name: 'start_issue', arguments: args });
    expect(requests).toEqual([args]);
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Refused: All 2 session slots are busy.' }] });
    for (const invalid of [{ ...args, number: 0 }, { ...args, floor: 1.5 }, { ...args, note: 'x'.repeat(1001) }]) {
      expect(await client.callTool({ name: 'start_issue', arguments: invalid })).toMatchObject({ isError: true });
    }
    expect(requests).toHaveLength(1);
  });

  it('still takes preview_env as a map of strings', async () => {
    const { client, floors } = await connect();
    await client.callTool({ name: 'set_floor_profile', arguments: { floor: 1, preview_env: { VITE_API: 'http://localhost:{port}' } } });
    expect(floors).toEqual([{ floor: 1, preview_env: { VITE_API: 'http://localhost:{port}' } }]);
  });
});

describe('planRoute (route_issue)', () => {
  // #1 ← #2 ← #3 is a two-step chain; #5 waits for #4; #9 is closed.
  const base: RouteRequest = {
    floor: 1,
    number: 4,
    issues: [
      { number: 1, body: 'Set up the skeleton', labels: ['swarm:frontend'] },
      { number: 2, body: 'Depends on #1', labels: [] },
      { number: 3, body: 'Depends on #2\n\nThe rest', labels: [] },
      { number: 4, body: 'Some text', labels: ['swarm:backend', 'bug'] },
      { number: 5, body: 'Intro\n\nDepends on #4\n\nMore', labels: [] },
      { number: 6, body: 'Free', labels: [] },
    ],
    closed: (n) => n === 9,
    inProgress: false,
    specialties: ['frontend', 'backend'],
  };
  const route = (over: Partial<RouteRequest>) => planRoute({ ...base, ...over });

  it('re-routes to a specialty on the floor, dropping the old swarm label only', () => {
    expect(route({ specialty: 'Frontend' })).toEqual({ addLabels: ['swarm:frontend'], removeLabels: ['swarm:backend'], body: null, summary: '#4 on floor 1: routed to frontend.' });
    expect(route({ specialty: '' })).toMatchObject({ addLabels: [], removeLabels: ['swarm:backend'], summary: '#4 on floor 1: no specialty.' });
  });

  it('refuses a specialty nobody on the floor or in a pending proposal has', () => {
    expect(() => route({ specialty: 'wizardry' })).toThrow('Nobody on floor 1 has the specialty "wizardry", and no pending proposal does. Specialties there: frontend, backend.');
    expect(() => route({ specialty: '!!!' })).toThrow(/is not a specialty/);
  });

  it('rewrites the Depends on line and leaves the rest of the body alone', () => {
    expect(route({ number: 5, dependsOn: [6] }).body).toBe('Depends on #6\n\nIntro\n\nMore');
    expect(route({ number: 5, dependsOn: [] }).body).toBe('Intro\n\nMore');
    expect(route({ number: 6, dependsOn: [1, 4] })).toMatchObject({ body: 'Depends on #1, #4\n\nFree', summary: '#6 on floor 1: depends on #1, #4.' });
  });

  it('refuses a closed or unknown issue', () => {
    expect(() => route({ number: 9, specialty: 'frontend' })).toThrow('#9 is closed.');
    expect(() => route({ number: 42, specialty: 'frontend' })).toThrow('There is no open issue #42 on floor 1.');
  });

  it('refuses dependencies on itself, on closed and on unknown issues', () => {
    expect(() => route({ dependsOn: [4] })).toThrow("#4 can't depend on itself.");
    expect(() => route({ dependsOn: [9] })).toThrow("#9 is closed, so there's nothing to wait for.");
    expect(() => route({ dependsOn: [42] })).toThrow('There is no open issue #42 on floor 1.');
  });

  it('refuses a cycle', () => {
    expect(() => route({ number: 1, dependsOn: [3] })).toThrow('#3 already waits for #1, directly or through other issues, so that would be a cycle.');
    expect(() => route({ number: 4, dependsOn: [5] })).toThrow(/#5 already waits for #4/);
  });

  it('refuses a chain deeper than two steps', () => {
    expect(() => route({ number: 1, dependsOn: [6] })).toThrow('That makes a dependency chain 3 steps deep through #1.');
    expect(() => route({ number: 6, dependsOn: [3] })).toThrow(/3 steps deep/);
    expect(route({ number: 6, dependsOn: [2] }).body).toBe('Depends on #2\n\nFree');
  });

  it('keeps the specialty but not the dependencies of an issue in progress', () => {
    expect(() => route({ inProgress: true, dependsOn: [] })).toThrow("#4 is already in progress, so its dependencies can't change. Changing its specialty is fine.");
    expect(route({ inProgress: true, specialty: 'frontend' }).addLabels).toEqual(['swarm:frontend']);
  });

  it('needs something to change', () => {
    expect(() => route({})).toThrow(/Nothing to change/);
  });
});

describe('IssueCap', () => {
  it('refuses the 13th issue and says the next manager message allows more', () => {
    const cap = new IssueCap(12);
    for (let i = 0; i < 12; i++) {
      cap.check();
      cap.record('a/b');
    }
    expect(() => cap.check()).toThrow("You already filed 12 issues in this job. That's plenty for one milestone. The manager's next message allows more.");
  });

  it('resets when a manager message arrives, and still counts the whole job', () => {
    const cap = new IssueCap(2);
    cap.record('a/b');
    cap.record('c/d');
    expect(() => cap.check()).toThrow();
    cap.managerMessage();
    expect(() => cap.check()).not.toThrow();
    cap.record('a/b');
    expect(cap.total).toBe(3);
    expect([...cap.repos]).toEqual(['a/b', 'c/d']);
  });
});


describe('planStartIssue', () => {
  const dev = { id: 'ada', name: 'Ada', repoId: 'r1', role: 'dev' as const, status: 'idle' as const, specialty: 'server', desk: 1 };
  const other = { ...dev, id: 'bob', name: 'Bob', specialty: 'frontend', desk: 0 };
  const context = {
    repoId: 'r1',
    issues: [{ number: 4, title: 'Start issues', body: '', labels: ['swarm:server'] }],
    agents: [other, dev], available: [other, dev], ready: ['server'], inProgress: false, usagePaused: false,
  };
  const request = { floor: 1, number: 4 };

  it('prefers a matching free specialist and falls back to any free developer', () => {
    expect(planStartIssue(request, context).agent.id).toBe('ada');
    expect(planStartIssue(request, { ...context, available: [other] }).agent.id).toBe('bob');
  });

  it('uses the scheduler order: match, ready load, open load, then desk', () => {
    expect(pickDeveloper([other, dev], () => false, ['frontend'], [])?.id).toBe('ada');
    expect(pickDeveloper([other, dev], () => false, [], ['frontend'])?.id).toBe('ada');
    expect(pickDeveloper([dev, other], () => false, [], [])?.id).toBe('bob');
  });

  it('accepts an explicit id or case-insensitive name over specialty preference', () => {
    for (const agent of ['bob', ' BOB ']) expect(planStartIssue({ ...request, agent }, context).agent.id).toBe('bob');
  });

  it.each([
    [{ role: 'qa' as const }, 'Ada is a QA tester; give issues to developers.'],
    [{ role: 'ceo' as const }, 'Ada is the CEO; give issues to developers.'],
    [{ status: 'working' as const }, 'Ada is busy; wait for them to finish.'],
    [{ status: 'preparing' as const }, 'Ada is busy; wait for them to finish.'],
    [{ repoId: 'r2' }, 'Ada is not on floor 1.'],
  ])('refuses an unsuitable explicit agent: %j', (patch, message) => {
    expect(() => planStartIssue({ ...request, agent: 'ada' }, { ...context, agents: [{ ...dev, ...patch }] })).toThrow(message);
  });

  it('refuses an unknown agent and an empty free developer pool', () => {
    expect(() => planStartIssue({ ...request, agent: 'nobody' }, context)).toThrow('No agent "nobody".');
    expect(() => planStartIssue(request, { ...context, available: [] })).toThrow('No free developer on floor 1.');
  });

  it('refuses dependencies that are still open, but permits closed dependencies', () => {
    const issues = [{ ...context.issues[0], body: 'Depends on #3' }];
    expect(() => planStartIssue(request, { ...context, issues: [...issues, { ...issues[0], number: 3, body: '' }] })).toThrow('#4 waits on open #3.');
    expect(planStartIssue(request, { ...context, issues }).issue.number).toBe(4);
  });

  it('refuses issues that are not open, already taken, or usage paused', () => {
    expect(() => planStartIssue({ ...request, number: 99 }, context)).toThrow('Issue #99 is not open on floor 1.');
    expect(() => planStartIssue(request, { ...context, inProgress: true })).toThrow('#4 is already in progress or has an open PR.');
    expect(() => planStartIssue(request, { ...context, usagePaused: true })).toThrow('Usage is paused; wait for the usage limit to reset.');
  });
});

describe('company_status pull requests', () => {
  const pull = { number: 14, title: 'Chase late invoices', checks: 'passing' as PullInfo['checks'], headSha: 'abcdef1234567', mergeable: 'MERGEABLE', mergeState: 'CLEAN' };
  const qa = (o: Partial<PrQaState> = {}): PrQaState => ({
    status: 'passed', round: 1, retests: 0, summary: 'All good', checks: [{ name: 'Build', result: 'pass', details: '' }], commentUrl: 'https://gh/c/1',
    mergeNote: null, testedSha: 'abcdef1234567', sessionFailures: 0, fixReason: null, devAgentId: 'a1', ...o,
  });
  const view = (p: Partial<typeof pull>, q?: PrQaState) => prStatusView({ ...pull, ...p }, q, { maxQaRounds: 3, agentName: (id) => (id === 'a1' ? 'Ada' : null) });
  const FAILURE = ['qaSummary', 'failedChecks', 'qaCommentUrl', 'fixReason', 'sessionFailures', 'qaRoundsLeft'];

  it('says why a needs-human PR is stuck', () => {
    const v = view(
      { mergeable: 'CONFLICTING', mergeState: 'DIRTY', headSha: '9999999aaaa' },
      qa({
        status: 'needs-human', round: 4, retests: 1, summary: 'x'.repeat(600), fixReason: 'qa', sessionFailures: 1,
        checks: [{ name: 'Build', result: 'pass', details: '' }, { name: 'Mobile layout', result: 'fail', details: '' }, { name: 'Console', result: 'fail', details: '' }],
      }),
    );
    expect(v).toMatchObject({
      qa: 'needs-human (round 4)', mergeable: 'conflicting', developer: 'Ada', failedChecks: ['Mobile layout', 'Console'],
      qaCommentUrl: 'https://gh/c/1', fixReason: 'qa', sessionFailures: 1, qaRoundsLeft: 0,
      testedSha: 'abcdef1', headSha: '9999999', newCommitsSinceQa: true,
    });
    expect(v.qaSummary).toHaveLength(400);
  });

  it('counts rounds left without the retests', () => {
    expect(view({}, qa({ status: 'failed', round: 2, retests: 1 })).qaRoundsLeft).toBe(2);
  });

  it('shows none of the failure fields for a passed PR', () => {
    const v = view({}, qa({ mergeNote: 'waiting for checks: CI' }));
    expect(v).toEqual({
      number: 14, title: 'Chase late invoices', qa: 'passed', checks: 'passing', mergeable: 'clean', merge: 'waiting for checks: CI',
      developer: 'Ada', testedSha: 'abcdef1', headSha: 'abcdef1', newCommitsSinceQa: false,
    });
    for (const k of FAILURE) expect(v).not.toHaveProperty(k);
  });

  it('keeps an untested PR to the basics', () => {
    expect(view({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' })).toEqual({ number: 14, title: 'Chase late invoices', qa: 'not tested', checks: 'passing', mergeable: 'unknown' });
  });

  it("reads GitHub's mergeable state", () => {
    expect(mergeableState({ mergeable: 'MERGEABLE', mergeState: 'BEHIND' })).toBe('clean');
    expect(mergeableState({ mergeable: 'UNKNOWN', mergeState: 'DIRTY' })).toBe('conflicting');
    expect(mergeableState({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' })).toBe('unknown');
  });

  it('lets the demo CEO explain a stuck PR', () => {
    const v = view({ mergeable: 'CONFLICTING' }, qa({ status: 'failed', round: 2, summary: 'Toolbar overflows.', checks: [{ name: 'Mobile', result: 'fail', details: '' }] }));
    expect(stuckAnswer(3, v)).toBe('PR #14 on floor 3 is failed (round 2). QA said: Toolbar overflows. Failed QA checks: Mobile. It conflicts with the default branch. Ada should resolve the conflicts.');
    expect(stuckAnswer(3, view({}, qa()))).toBe('PR #14 on floor 3 is passed. Nothing is holding it up.');
  });

  it('lets the demo CEO explain waiting checks, testing and exhausted rounds', () => {
    expect(stuckAnswer(3, view({ checks: 'pending' }, qa({ mergeNote: 'waiting for checks: CI' })))).toBe(
      "PR #14 on floor 3 is passed. GitHub's checks are still running. Auto-merge: waiting for checks: CI.",
    );
    expect(stuckAnswer(3, view({}, qa({ status: 'testing', round: 2 })))).toBe('PR #14 on floor 3 is testing (round 2). QA is testing it now.');
    expect(stuckAnswer(3, view({}))).toBe('PR #14 on floor 3 is not tested. QA has not tested it yet.');
    const out = view({}, qa({ status: 'needs-human', round: 3, summary: 'Still broken', checks: [] }));
    expect(stuckAnswer(3, out)).toBe('PR #14 on floor 3 is needs-human (round 3). QA said: Still broken. It needs your call: fix it by hand, close it, or rerun QA.');
  });

  it('routes the demo CEO to the floor or repository asked about', () => {
    const floors = [{ floor: 1, repo: 'demo-co/pixel-todo' }, { floor: 2, repo: 'demo-co/weather-api' }];
    expect(stuckTarget('Why is #14 stuck on floor 2?', floors)).toEqual({ number: 14, floors: [2] });
    expect(stuckTarget('why is #14 stuck on weather-api?', floors)).toEqual({ number: 14, floors: [2] });
    expect(stuckTarget('Why is #14 stuck?', floors)).toEqual({ number: 14, floors: [1, 2] });
    expect(stuckTarget('Why is #14 stuck on floor 99?', floors)).toEqual({ refused: 'There is no floor 99.' });
    expect(stuckTarget('Why is #8 stuck on missing-repo?', floors)).toEqual({ refused: 'No floor for "missing-repo".' });
    expect(stuckTarget('Start #14 on floor 2', floors)).toBeNull();
  });
});
