import { expect, test } from '@playwright/test';
import type { QaOutcomeView, RepoView, ServerEvent } from '../shared/types';

test('QA history shows pinned mixed evidence and corrections after cleanup and reconnect', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let repo: RepoView;
  let outcome: QaOutcomeView;
  let send = (_event: ServerEvent) => {};
  let corrected = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    send = (event) => ws.send(JSON.stringify(event));
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        repo = { ...event.data.repos[0], issues: [], pulls: [] };
        outcome = {
          id: 'attempt-1', repoId: repo.id, prNumber: 999999, attemptId: 'attempt-1', reviewId: 'cycle-1', round: 1,
          reviewer: { agentId: 'qa-1', name: 'Grace' }, startedAt: 1000, finishedAt: 5000, headSha: 'tested-head', baseSha: 'tested-base',
          observed: { headSha: 'new-head', baseSha: 'tested-base', at: 5000 }, revision: 'stale', verdict: 'fail', classification: 'mixed',
          summary: 'Toolbar defect and worker OOM are separate findings.', commands: [{ command: 'npm test', result: 'Exit 137' }],
          checks: [{ name: 'Toolbar', result: 'fail', failureKind: 'code', details: 'Button unreachable.' }],
          findings: [
            { id: 'defect-1', key: 'toolbar', check: 'Toolbar', classification: 'code', confirmed: true, evidence: 'Base passes; head fails.', attributableTo: { agentId: 'ada', submittedSha: 'tested-head' } },
            { id: 'worker-1', key: 'suite', check: 'Suite', classification: 'worker', confirmed: false, evidence: 'Worker OOM exit 137.', attributableTo: null },
          ], worker: { boxId: 'box-1', from: null, to: null, telemetry: null }, terminalReason: 'Exit 137',
          ci: { headSha: 'tested-head', observedAt: 5000, availability: 'available', checks: [{ id: 'check-7', runId: 'run-42', name: 'CI', conclusion: 'success', status: 'completed', url: null }] },
          commentUrl: null, corrections: corrected ? [{ id: 'correction-1', findingId: 'defect-1', actor: 'manager', previousCorrectionId: null, reason: 'Stable retry passed unchanged.', classification: 'worker', at: 6000 }] : [],
        };
        event.data.repos[0] = repo;
        event.data.qa = [];
        event.data.qaOutcomes = [outcome];
      }
      if (event.type === 'repo' && repo && event.repo.id === repo.id) event.repo = repo;
      if (event.type !== 'qaOutcome') send(event);
    });
  });
  await page.route('**/api/qa-outcomes/attempt-1/corrections', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ findingId: 'defect-1', classification: 'worker', reason: 'Stable retry passed unchanged.', actor: 'manager' });
    corrected = true;
    outcome = { ...outcome, corrections: [{ id: 'correction-1', findingId: 'defect-1', actor: 'manager', previousCorrectionId: null, reason: 'Stable retry passed unchanged.', classification: 'worker', at: 6000 }] };
    send({ type: 'qaOutcome', outcome });
    send({ type: 'qaRemoved', repoId: repo.id, prNumber: outcome.prNumber });
    await route.fulfill({ json: outcome.corrections[0] });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openHistory = async () => {
    await page.goto('/');
    await expect.poll(() => repo?.id).toBeTruthy();
    await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(repo!.fullName) }).click();
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await page.getByText('QA history (1)', { exact: true }).click();
    await page.getByText('PR #999999 · fail · mixed · stale revision · Grace', { exact: true }).click();
  };
  await openHistory();
  await expect(page.getByText('Tested base:', { exact: false })).toContainText('tested-head');
  await expect(page.getByText('Finding defect-1', { exact: false })).toContainText('Score candidate: no');
  await expect(page.getByText('Finding worker-1', { exact: false })).toContainText('worker');
  await expect(page.getByText('CI: success', { exact: false })).toContainText('check check-7 · run run-42');
  await page.getByLabel('Corrected classification').first().selectOption('worker');
  await page.getByLabel('Correction reason').first().fill('Stable retry passed unchanged.');
  await page.getByRole('button', { name: 'Record correction' }).first().click();
  await expect(page.getByText('Correction correction-1 by manager', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('qa-outcome-history.png') });
  await openHistory();
  await expect(page.getByText('Correction correction-1 by manager', { exact: false })).toBeVisible();
});
