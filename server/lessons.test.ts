import { describe, expect, it } from 'vitest';
import type { QaOutcomeView, RunAttemptView } from '../shared/types.ts';
import { approvedVersion, lessonExport, lessonStatus, recurringFindings, sourceHeld, versionStatus } from '../shared/lessons.ts';
import { draftLesson, reviewLesson, reviseLesson, type LessonEvidence } from './lessons.ts';
import { HttpError } from './httpError.ts';

const REPO = 'demo-co/todo-app';

function outcome(id: string, pr: number, at: number, opts: Partial<QaOutcomeView> = {}): QaOutcomeView {
  return {
    id, repoId: REPO, prNumber: pr, reviewId: `cycle-${pr}`, round: 1, attemptId: id, reviewer: { agentId: 'qa', name: 'Quinn' },
    startedAt: at - 10, finishedAt: at, baseSha: `base${pr}`, headSha: `head${pr}${id}`, revision: 'exact', classification: 'code', observed: null,
    verdict: 'fail', summary: 'Toolbar overflows.', checks: [], commands: [], findings: [], worker: { boxId: null, from: null, to: null, telemetry: null },
    terminalReason: null, ci: null, commentUrl: `https://github.com/${REPO}/pull/${pr}#qa-${id}`, corrections: [], ...opts,
  };
}

const finding = (id: string, classification: 'code' | 'worker' | 'inconclusive', confirmed = true, evidence = 'Toolbar overflows at 375px; the base wraps.') =>
  ({ id, key: classification === 'worker' ? 'suite-oom' : 'toolbar-overflow', check: classification === 'worker' ? 'Local suite' : 'Mobile layout (375px)',
    classification, evidence, confirmed, attributableTo: null });

function attempt(id: string, pr: number, opts: Partial<RunAttemptView> = {}): RunAttemptView {
  return {
    id, parentId: null, repoId: REPO, repo: REPO, task: 'issue', specialty: 'frontend', issueNumber: pr - 10, prNumber: pr,
    agent: { id: 'ada', name: 'Ada', role: 'dev', specialty: 'frontend' }, assignment: { reason: 'auto', factors: {} },
    runtime: { cli: 'claude', model: null, effort: 'high', playbook: null, office: 'test' },
    worker: { box: '', name: 'office', healthAtStart: null, healthAtEnd: null }, sessionIds: ['raw-session'], revisions: { start: 'aaa', submitted: `sub${pr}` },
    review: null, times: { assignedAt: 1, startedAt: 2, endedAt: 3 }, usage: { sessions: 1, costUsd: null, turns: null }, events: [],
    outcome: { result: 'delivered', cause: 'agent' }, ...opts,
  };
}

/** Two PRs with the same confirmed regression, each fixed and passed on its re-review, and a worker OOM on a third. */
function office(): LessonEvidence {
  return {
    repoId: REPO,
    outcomes: [
      outcome('o1', 11, 100, { findings: [finding('f1', 'code')] }),
      outcome('o2', 11, 200, { verdict: 'pass', classification: 'pass', round: 2 }),
      outcome('o3', 12, 300, { findings: [finding('f3', 'code', true, 'Overflow again. token=ghp_abcdefghijklmnopqrstuvwxyz0123 ' + 'x'.repeat(400))] }),
      outcome('o4', 12, 400, { verdict: 'pass', classification: 'pass', round: 2 }),
      outcome('o5', 13, 500, { classification: 'worker', findings: [finding('w1', 'worker', false, 'Exit 137 while the suite ran.')] }),
      outcome('o6', 14, 600, { classification: 'worker', findings: [finding('w2', 'worker', false, 'Exit 137 again.')] }),
      outcome('o7', 13, 700, { verdict: 'pass', classification: 'pass', round: 2 }),
    ],
    attempts: [
      attempt('a11', 11), attempt('a12', 12),
      attempt('q13', 13, { task: 'qa', outcome: { result: 'prepare-failed', cause: 'worker', excerpt: 'ENOSPC: no space left on device' } }),
      attempt('q13b', 13, { task: 'qa', parentId: 'q13', outcome: { result: 'qa-passed', cause: 'agent' } }),
    ],
  };
}

const agentDraft = {
  kind: 'agent', specialty: 'frontend', title: 'Check the toolbar at 375px', guidance: 'Before handing off, load the page at 375px and check every toolbar button is reachable.',
  sources: [{ qaOutcomeId: 'o1', findingId: 'f1' }, { qaOutcomeId: 'o3', findingId: 'f3' }, { attemptId: 'a11' }, { attemptId: 'a12' }],
  verification: { kind: 'fix', qaOutcomeId: 'o4' },
};

const fails = (fn: () => unknown, status: number, message: RegExp) => {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected an error');
};

describe('recurring findings', () => {
  it('suggests the same confirmed regression on two PRs and the re-review that verified its fix, until a lesson cites it', () => {
    const ev = office();
    const [regression, worker] = recurringFindings(ev.outcomes, []);
    expect(regression).toMatchObject({ key: 'toolbar-overflow', kind: 'agent', fix: { qaOutcomeId: 'o4', prNumber: 12 } });
    expect(regression.findings.map((f) => f.findingId)).toEqual(['f1', 'f3']);
    expect(worker).toMatchObject({ key: 'suite-oom', kind: 'operational', fix: { qaOutcomeId: 'o7', prNumber: 13 } });
    const lesson = draftLesson(agentDraft, ev, 'manager', 1000);
    expect(recurringFindings(ev.outcomes, [lesson]).map((s) => s.key)).toEqual(['suite-oom']);
  });

  it('ignores unconfirmed code findings and a finding repeated on one PR only', () => {
    const ev = office();
    ev.outcomes[2].findings[0].confirmed = false;
    expect(recurringFindings(ev.outcomes, []).map((s) => s.key)).toEqual(['suite-oom']);
    ev.outcomes[2] = outcome('o3', 11, 300, { findings: [finding('f3', 'code')] });
    expect(recurringFindings(ev.outcomes, []).map((s) => s.key)).toEqual(['suite-oom']);
  });
});

describe('drafting a lesson', () => {
  it('links findings, attempts and the verified fix by id with redacted, bounded summaries only', () => {
    const lesson = draftLesson(agentDraft, office(), 'manager', 1000);
    const v = lesson.versions[0];
    expect(lessonStatus(lesson)).toBe('draft');
    expect(v.sources.map((s) => [s.kind, s.ref, s.prNumber])).toEqual([['finding', 'f1', 11], ['finding', 'f3', 12], ['attempt', 'a11', 11], ['attempt', 'a12', 12]]);
    expect(v.sources[0]).toMatchObject({ qaOutcomeId: 'o1', sha: 'head11o1', classification: 'code', url: `https://github.com/${REPO}/pull/11#qa-o1` });
    expect(v.sources[1].summary).not.toContain('ghp_');
    expect(v.sources[1].summary.length).toBeLessThanOrEqual(240);
    expect(v.verification).toMatchObject({ kind: 'fix', test: null, evidence: { qaOutcomeId: 'o4', sha: 'head12o4' } });
    expect(v.revisions).toEqual(['head11o1', 'head12o3', 'sub11', 'sub12', 'head12o4']);
    expect(JSON.stringify(lesson)).not.toContain('raw-session');
  });

  it('keeps worker evidence for operational lessons and code defects for agent guidance', () => {
    const ev = office();
    fails(() => draftLesson({ ...agentDraft, sources: [{ qaOutcomeId: 'o5', findingId: 'w1' }] }, ev, 'manager', 1), 400, /worker failure: it can only support an operational lesson/);
    fails(() => draftLesson({ ...agentDraft, sources: [{ attemptId: 'q13' }] }, ev, 'manager', 1), 400, /operational lesson/);
    fails(() => draftLesson({ ...agentDraft, kind: 'operational' }, ev, 'manager', 1), 400, /code defect: it can only support an agent lesson/);
    const ops = draftLesson({
      kind: 'operational', specialty: null, title: 'Give QA desks memory headroom', guidance: 'Run the suite with --maxWorkers=2 on boxes under 8 GB.',
      sources: [{ qaOutcomeId: 'o5', findingId: 'w1' }, { qaOutcomeId: 'o6', findingId: 'w2' }, { attemptId: 'q13' }],
      verification: { kind: 'fix', attemptId: 'q13b' },
    }, ev, 'manager', 1);
    expect(ops.versions[0]).toMatchObject({ kind: 'operational', sources: [{ classification: 'worker' }, { classification: 'worker' }, { kind: 'attempt' }] });
    expect(ops.versions[0].sources[2].summary).toContain('ENOSPC');
  });

  it('follows corrections and refuses unverified or unconfirmed evidence', () => {
    const ev = office();
    ev.outcomes[0].corrections.push({ id: 'c1', findingId: 'f1', previousCorrectionId: null, actor: 'manager', reason: 'OOM', classification: 'inconclusive', at: 5 });
    fails(() => draftLesson(agentDraft, ev, 'manager', 1), 400, /not a confirmed code defect or a worker failure/);
    fails(() => draftLesson({ ...agentDraft, sources: [agentDraft.sources[1]], verification: { kind: 'fix', qaOutcomeId: 'o3' } }, ev, 'manager', 1), 400, /did not pass/);
    fails(() => draftLesson({ ...agentDraft, sources: [agentDraft.sources[1]], verification: { kind: 'regression-test', qaOutcomeId: 'o4' } }, ev, 'manager', 1), 400, /regression test is required/);
    fails(() => draftLesson({ ...agentDraft, sources: [] }, ev, 'manager', 1), 400, /1 to 20 sources/);
    fails(() => draftLesson({ ...agentDraft, sources: [{ qaOutcomeId: 'o1', findingId: 'f1' }] }, { ...ev, repoId: 'other/repo' }, 'manager', 1), 400, /Unknown finding/);
    fails(() => draftLesson({ ...agentDraft, sources: [{ url: 'file:///etc/passwd', summary: 'x' }] }, ev, 'manager', 1), 400, /http\(s\) URL/);
    fails(() => draftLesson({ ...agentDraft, sources: [{ url: 'https://me:pw@ci.example/run/1', summary: 'x' }] }, ev, 'manager', 1), 400, /credentials/);
  });
});

describe('reviewing a lesson', () => {
  it('records approval, revision, rejection and supersession; only the approved, applicable version is exported', () => {
    const ev = office();
    const lessons = [draftLesson(agentDraft, ev, 'manager', 1000)];
    const [lesson] = lessons;
    expect(lessonExport(lessons, { repoId: REPO }, 0).lessons).toEqual([]);
    fails(() => reviewLesson(lesson, { action: 'request-revision' }, lessons, 'manager', 1), 400, /reason is required/);
    reviewLesson(lesson, { action: 'request-revision', reason: 'Name the breakpoint.' }, lessons, 'manager', 1100);
    expect(lessonStatus(lesson)).toBe('needs-revision');
    fails(() => reviewLesson(lesson, { action: 'approve' }, lessons, 'manager', 1), 409, /Only a draft can be approved/);
    reviseLesson(lesson, { ...agentDraft, guidance: 'Check the toolbar at the 375px breakpoint.', reason: 'Named it.' }, ev, 'manager', 1200);
    reviewLesson(lesson, { action: 'approve' }, lessons, 'manager', 1300);
    expect(approvedVersion(lesson)).toMatchObject({ version: 2, approvedAt: 1300, approvedBy: 'manager' });

    // A third version waits for review while version 2 keeps applying; approving it supersedes version 2.
    reviseLesson(lesson, { ...agentDraft, verification: { kind: 'regression-test', test: 'e2e/toolbar.spec.ts', qaOutcomeId: 'o4' } }, ev, 'manager', 1400);
    expect(lessonExport(lessons, { repoId: REPO }, 0).lessons.map((l) => l.version)).toEqual([2]);
    reviewLesson(lesson, { action: 'approve' }, lessons, 'manager', 1500);
    expect(versionStatus(lesson, 2)).toBe('superseded');
    expect(lessonExport(lessons, { repoId: REPO }, 0).lessons).toMatchObject([{ version: 3, verification: { test: 'e2e/toolbar.spec.ts' } }]);

    const other = draftLesson({ ...agentDraft, title: 'A rejected idea' }, ev, 'manager', 1600);
    lessons.push(other);
    reviewLesson(other, { action: 'reject', reason: 'Too narrow.' }, lessons, 'manager', 1700);
    fails(() => reviewLesson(other, { action: 'approve' }, lessons, 'manager', 1), 409, /rejected/);

    const replacement = draftLesson({ ...agentDraft, title: 'Check every breakpoint' }, ev, 'manager', 1800);
    lessons.push(replacement);
    reviewLesson(replacement, { action: 'approve' }, lessons, 'manager', 1900);
    reviewLesson(lesson, { action: 'supersede', reason: 'Covered by the wider check.', supersededBy: replacement.id }, lessons, 'manager', 2000);
    expect(lessonStatus(lesson)).toBe('superseded');
    fails(() => reviseLesson(lesson, agentDraft, ev, 'manager', 1), 409, /superseded/);
    expect(lessonExport(lessons, { repoId: REPO }, 0).lessons.map((l) => l.title)).toEqual(['Check every breakpoint']);
    expect(lesson.reviews.map((r) => [r.version, r.action])).toEqual([
      [1, 'drafted'], [1, 'revision-requested'], [2, 'revised'], [2, 'approved'], [3, 'revised'], [3, 'approved'], [2, 'superseded'], [3, 'superseded'],
    ]);
    expect(lesson.reviews.at(-1)).toMatchObject({ supersededBy: replacement.id, reason: 'Covered by the wider check.' });
  });

  it('filters the export by floor and specialty, with every-specialty lessons in each', () => {
    const ev = office();
    const frontend = draftLesson(agentDraft, ev, 'manager', 1);
    const everyone = draftLesson({ ...agentDraft, specialty: null, title: 'All' }, ev, 'manager', 2);
    const lessons = [frontend, everyone];
    for (const l of lessons) reviewLesson(l, { action: 'approve' }, lessons, 'manager', 3);
    expect(lessonExport(lessons, { repoId: REPO, specialty: 'frontend' }, 0).lessons).toHaveLength(2);
    expect(lessonExport(lessons, { repoId: REPO, specialty: 'server' }, 0).lessons.map((l) => l.title)).toEqual(['All']);
    expect(lessonExport(lessons, { repoId: 'other/repo' }, 0).lessons).toEqual([]);
  });

  it('keeps a pruned record as its link and summary when the lesson is revised', () => {
    const ev = office();
    const lesson = draftLesson(agentDraft, ev, 'manager', 1);
    const pruned = { ...ev, outcomes: ev.outcomes.filter((o) => o.id !== 'o1' && o.id !== 'o4'), attempts: ev.attempts.filter((x) => x.id !== 'a11') };
    expect(sourceHeld(lesson.versions[0].sources[0], pruned.outcomes, pruned.attempts)).toBe(false);
    expect(sourceHeld(lesson.versions[0].sources[1], pruned.outcomes, pruned.attempts)).toBe(true);
    reviseLesson(lesson, { ...agentDraft, title: 'Revised after pruning' }, pruned, 'manager', 2);
    expect(lesson.versions[1].sources).toEqual(lesson.versions[0].sources);
    expect(lesson.versions[1].verification.evidence).toEqual(lesson.versions[0].verification.evidence);
  });
});
