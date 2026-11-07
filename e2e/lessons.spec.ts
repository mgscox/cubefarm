import { expect, test } from '@playwright/test';
import type { LessonView, QaOutcomeView, RepoView, ServerEvent } from '../shared/types';
import { draftLesson, reviewLesson, reviseLesson } from '../server/lessons.ts';

test('a regression confirmed on two PRs becomes a reviewed lesson, apart from operational ones', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let repo: RepoView;
  let outcomes: QaOutcomeView[] = [];
  const lessons: LessonView[] = [];
  let send = (_event: ServerEvent) => {};
  const outcome = (id: string, pr: number, at: number, finding: 'code' | 'worker' | null): QaOutcomeView => ({
    id, repoId: repo.id, prNumber: pr, reviewId: `cycle-${pr}`, round: finding ? 1 : 2, attemptId: id, reviewer: { agentId: 'qa', name: 'Quinn' },
    startedAt: at - 10, finishedAt: at, baseSha: 'base', headSha: `${id}000000`, revision: 'exact', classification: finding ?? 'pass', observed: null,
    verdict: finding ? 'fail' : 'pass', summary: finding ? 'Failed.' : 'Passed.', checks: [], commands: [],
    findings: finding === 'code'
      ? [{ id: `f-${id}`, key: 'toolbar-overflow', check: 'Mobile layout (375px)', classification: 'code', confirmed: true, evidence: 'Toolbar overflows at 375px; the base wraps.', attributableTo: null }]
      : finding === 'worker' ? [{ id: `f-${id}`, key: 'suite-oom', check: 'Local suite', classification: 'worker', confirmed: false, evidence: 'Exit 137.', attributableTo: null }] : [],
    worker: { boxId: null, from: null, to: null, telemetry: null }, terminalReason: null, ci: null, commentUrl: null, corrections: [],
  });
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    send = (event) => ws.send(JSON.stringify(event));
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        repo = event.data.repos[0];
        if (!outcomes.length) outcomes = [
          outcome('a1', 901, 1000, 'code'), outcome('a2', 901, 2000, null),
          outcome('b1', 902, 3000, 'code'), outcome('b2', 902, 4000, null),
          outcome('c1', 903, 5000, 'worker'), outcome('d1', 904, 6000, 'worker'),
        ];
        event.data.qaOutcomes = outcomes;
        event.data.lessons = lessons;
      }
      if (event.type !== 'qaOutcome' && event.type !== 'lesson') send(event);
    });
  });
  const evidence = () => ({ repoId: repo.id, outcomes, attempts: [] });
  await page.route('**/api/repos/*/lessons', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ kind: 'agent', sources: [{ qaOutcomeId: 'a1', findingId: 'f-a1' }, { qaOutcomeId: 'b1', findingId: 'f-b1' }], verification: { kind: 'fix', qaOutcomeId: 'b2' } });
    const lesson = draftLesson(body, evidence(), 'manager', 7000);
    lessons.push(lesson);
    send({ type: 'lesson', lesson });
    await route.fulfill({ json: lesson });
  });
  await page.route('**/api/lessons/*/versions', async (route) => {
    const lesson = lessons.find((l) => route.request().url().includes(l.id))!;
    reviseLesson(lesson, route.request().postDataJSON(), evidence(), 'manager', 7500);
    send({ type: 'lesson', lesson: structuredClone(lesson) });
    await route.fulfill({ json: lesson });
  });
  await page.route('**/api/lessons/*/reviews', async (route) => {
    const lesson = lessons.find((l) => route.request().url().includes(l.id))!;
    reviewLesson(lesson, route.request().postDataJSON(), lessons, 'manager', 8000);
    send({ type: 'lesson', lesson: structuredClone(lesson) });
    await route.fulfill({ json: lesson });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  const openLessons = async () => {
    await page.goto('/');
    await expect.poll(() => repo?.id).toBeTruthy();
    await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(repo!.fullName) }).click();
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await page.locator('.lessons > summary').click();
  };
  await openLessons();
  const panel = page.locator('.lessons');
  await expect(panel).toContainText('No approved lessons yet.');
  const regression = panel.locator('.kcard').filter({ hasText: 'Mobile layout (375px) · Agent guidance' });
  await expect(regression).toContainText('Seen on PR #901, PR #902 · fix passed QA on PR #902');
  await expect(panel.locator('.kcard').filter({ hasText: 'Local suite · Operational' })).toContainText('no fix has passed QA yet');

  await regression.getByRole('button', { name: 'Draft lesson…' }).click();
  await regression.getByLabel('Lesson title').fill('Check the toolbar at 375px');
  await regression.getByLabel('Checklist or playbook guidance').fill('Before handing off, load the page at 375px and check every toolbar button is reachable.');
  await expect(regression.getByLabel('Verifying evidence')).toHaveValue('qa:b2');
  await regression.getByRole('button', { name: 'Save draft' }).click();

  const card = panel.locator('.kcard.lesson').filter({ hasText: 'Check the toolbar at 375px' });
  await expect(card).toContainText('Waiting for review');
  await expect(panel.locator('summary').first()).toHaveText('Lessons (0, 1 to review)');
  await expect(regression).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toContainText('Agent guidance · every specialty · version 1 · Approved');
  await expect(card).toContainText('code finding · PR #901 · a100000: Mobile layout (375px): Toolbar overflows at 375px; the base wraps.');
  await expect(card).toContainText('Verified by a fix that passed QA · QA review · PR #902 · b200000');
  await expect(panel.getByRole('link', { name: '⬇ Export JSON' })).toHaveAttribute('href', `/api/lessons?repoId=${encodeURIComponent(repo!.id)}&download=1`);
  await card.getByText('Review history (2)').click();
  await expect(card).toContainText('v1 approved by manager');
  await page.screenshot({ path: testInfo.outputPath('lessons-approved.png') });

  // The approved lesson comes back with the snapshot after a reconnect.
  await openLessons();
  await expect(panel.locator('summary').first()).toHaveText('Lessons (1)');
  await expect(panel.locator('.kcard.lesson')).toContainText('Approved');

  // A rejected revision leaves version 1 approved, and the manager can still write a better one.
  const approved = panel.locator('.kcard.lesson').first();
  await approved.getByRole('button', { name: 'Revise…' }).click();
  await approved.getByLabel('Lesson title').fill('Toolbar sweep');
  await approved.getByRole('button', { name: 'Save new version' }).click();
  const draft = panel.locator('.kcard.lesson').filter({ hasText: 'Toolbar sweep' });
  await draft.getByLabel('Review reason').fill('Too broad.');
  await draft.getByRole('button', { name: 'Reject' }).click();
  await expect(approved).toContainText('version 1 · Approved · version 2 rejected');
  await expect(approved.getByRole('button', { name: 'Revise…' })).toBeVisible();
  await expect(approved.getByRole('button', { name: 'Supersede' })).toBeVisible();
});
