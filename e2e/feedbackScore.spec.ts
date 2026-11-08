import { expect, test } from '@playwright/test';
import type { AgentView, DeveloperScoresView, RepoView, ScoreEventView, ServerEvent } from '../shared/types';

const scores = (authorship: number, authored: number, repair: number, repaired: number): DeveloperScoresView =>
  ({ authorship: { points: authorship, events: authored }, repair: { points: repair, events: repaired }, neutral: 1 });

test('Authorship, Repair and legacy scores appear on Team and terminal headers and update live on phones', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  let developer: AgentView;
  let sendScores: (next: DeveloperScoresView) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sendScores = (next) => {
      developer = { ...developer, scores: next };
      ws.send(JSON.stringify({ type: 'agent', agent: developer }));
    };
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      // Keep the fixture stable while exercising the real client event handler.
      if (event.type === 'agent' || event.type === 'agentRemoved') return;
      if (event.type === 'snapshot') {
        for (const agent of event.data.agents) {
          agent.score = agent.role === 'dev' ? 4 : 0;
          if (agent.role === 'dev') agent.scores = scores(1, 2, 1, 1);
        }
        developer = event.data.agents.find((agent) => agent.role === 'dev')!;
      }
      ws.send(JSON.stringify(event));
    });
  });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  await page.getByRole('button', { name: /Team/ }).click();

  const authorship = (scope: ReturnType<typeof page.locator>) => scope.locator('.chip', { hasText: /^Authorship / });
  const repair = (scope: ReturnType<typeof page.locator>) => scope.locator('.chip', { hasText: /^Repair / });
  const legacy = (scope: ReturnType<typeof page.locator>) => scope.locator('.chip', { hasText: /^Legacy / });
  const rows = page.locator('.team-agent');
  for (const row of await rows.all()) {
    const dev = await row.getByText(/^💻 Dev/).count();
    if (dev) {
      await expect(authorship(row)).toHaveText('Authorship +1 · 2 events');
      await expect(repair(row)).toHaveText('Repair +1 · 1 event');
      await expect(legacy(row)).toHaveText('Legacy +4');
    } else await expect(authorship(row)).toHaveCount(0);
  }
  const devRow = rows.filter({ has: page.getByText(developer!.name, { exact: true }) });
  await expect(authorship(devRow)).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scores-team-desktop.png') });

  const details = devRow.getByRole('button', { name: 'Details', exact: true });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(devRow.getByLabel('Model', { exact: true })).toBeHidden();
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(devRow.getByLabel('Model', { exact: true })).toBeVisible();
  await expect(devRow.getByLabel('Job description')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scores-team-details.png') });

  const teamTab = page.locator('.tab-body');
  for (const width of [1280, 768, 414, 375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const { scrollWidth, clientWidth } = await teamTab.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(scrollWidth, `Team tab width at ${width}px`).toBeLessThanOrEqual(clientWidth);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(authorship(devRow)).toBeInViewport();
  sendScores(scores(-1, 1, 0, 0));
  await expect(authorship(devRow)).toHaveText('Authorship -1 · 1 event');
  await expect(repair(devRow)).toHaveText('Repair 0 · 0 events');
  for (const chip of [authorship(devRow), repair(devRow), legacy(devRow)]) {
    expect(await chip.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(30);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scores-team-phone.png') });

  await devRow.getByRole('button', { name: 'Terminal', exact: true }).click();
  const header = page.locator('.term-title');
  await expect(header).toContainText(developer!.name);
  await expect(authorship(header)).toHaveText('Authorship -1 · 1 event');
  sendScores(scores(2, 1, 1, 1));
  await expect(authorship(header)).toHaveText('Authorship +2 · 1 event');
  await expect(repair(header)).toHaveText('Repair +1 · 1 event');
  await expect(legacy(header)).toHaveText('Legacy +4');
  await expect(legacy(header)).toBeInViewport();
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scores-terminal-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scores-terminal-desktop.png') });
});

test('the floor Kanban explains each score event and its correction after reconnecting', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let repo: RepoView;
  const ledger = (repoId: string): ScoreEventView[] => {
    const base = { repoId, prNumber: 999999, at: 5000 };
    return [
      { ...base, id: 'neutral:qa:attempt-0', agentId: 'ada', name: 'Ada', score: null, points: 0, rule: 'neutral', reason: 'QA fail at abc1234 scored nothing: 1 worker', evidence: { outcomeId: 'attempt-0', sha: 'abc1234' } },
      { ...base, id: 'authorship:defect:x', agentId: 'ada', name: 'Ada', score: 'authorship', points: -1, rule: 'original-defect', reason: 'Confirmed defect "toolbar" from the original implementation', evidence: { outcomeId: 'attempt-1', findingId: 'f-1', sha: 'abc1234' } },
      { ...base, id: 'repair:fix:x', agentId: 'bob', name: 'Bob', score: 'repair', points: 1, rule: 'repair-fix', reason: 'Independently verified fix for inherited "toolbar" at def5678', evidence: { attemptId: 'fix-1', outcomeId: 'attempt-2', sha: 'def5678' } },
      { ...base, id: 'authorship:merge:x', agentId: 'ada', name: 'Ada', score: 'authorship', points: 2, rule: 'merge', reason: 'Merged; originally submitted at abc1234', evidence: { sha: 'abc1234' } },
      { ...base, id: 'correction:authorship:defect:x:1', agentId: 'ada', name: 'Ada', score: 'authorship', points: 1, rule: 'correction', reason: 'Voided: Finding corrected to worker by manager: Stable retry passed', evidence: { outcomeId: 'attempt-1', findingId: 'f-1', correctionId: 'c-1', sha: 'abc1234' }, corrects: { eventId: 'authorship:defect:x', active: false } },
    ];
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        repo = { ...event.data.repos[0], issues: [], pulls: [] };
        event.data.repos[0] = repo;
        event.data.scoreEvents = ledger(repo.id).slice(0, 4);
        setTimeout(() => ws.send(JSON.stringify({ type: 'scoreEvents', events: ledger(repo.id).slice(3) })), 300);
      }
      if (event.type === 'repo' && repo && event.repo.id === repo.id) event.repo = repo;
      if (event.type !== 'scoreEvents') ws.send(JSON.stringify(event));
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openHistory = async () => {
    await page.goto('/');
    await expect.poll(() => repo?.id).toBeTruthy();
    await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(repo!.fullName) }).click();
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await page.getByText('Score events (5)', { exact: true }).click();
  };
  await openHistory();
  await expect(page.getByText('PR #999999 · Ada · Authorship -1 · Confirmed defect "toolbar" from the original implementation (voided)', { exact: true })).toBeVisible();
  await expect(page.getByText('PR #999999 · Bob · Repair +1 · Independently verified fix for inherited "toolbar" at def5678', { exact: true })).toBeVisible();
  await expect(page.getByText('PR #999999 · Ada · No score change · QA fail at abc1234 scored nothing: 1 worker', { exact: true })).toBeVisible();
  await page.getByText(/Voided: Finding corrected to worker by manager/).click();
  await expect(page.getByText('Finding correction c-1', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('score-events.png') });
  await openHistory();
  await expect(page.getByText(/Merged; originally submitted at abc1234/)).toBeVisible();
});
