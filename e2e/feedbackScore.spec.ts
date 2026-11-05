import { expect, test } from '@playwright/test';
import type { AgentView, ServerEvent } from '../shared/types';

test('developer feedback scores appear on Team and terminal headers and update live on phones', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  let developer: AgentView;
  let sendScore: (score: number) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sendScore = (score) => {
      developer = { ...developer, score };
      ws.send(JSON.stringify({ type: 'agent', agent: developer }));
    };
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      // Keep the fixture stable while exercising the real client event handler.
      if (event.type === 'agent' || event.type === 'agentRemoved') return;
      if (event.type === 'snapshot') {
        for (const agent of event.data.agents) agent.score = agent.role === 'dev' ? 4 : 0;
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

  const badge = '[title="+2 per merged PR, -1 per QA send-back"]';
  const rows = page.locator('.team tr');
  for (const row of await rows.all()) {
    const dev = await row.getByText('💻 Dev', { exact: true }).count();
    if (dev) await expect(row.locator(badge)).toHaveText('Score +4');
    else await expect(row.locator(badge)).toHaveCount(0);
  }
  const devRow = rows.filter({ has: page.locator(`input[value=${JSON.stringify(developer!.name)}]`) });
  await expect(devRow.locator(badge)).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('feedback-team-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(devRow.locator(badge)).toBeInViewport();
  sendScore(0);
  await expect(devRow.locator(badge)).toHaveText('Score 0');
  expect(await devRow.locator(badge).evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('feedback-team-phone.png') });

  await devRow.getByRole('button', { name: 'Terminal', exact: true }).click();
  const header = page.locator('.term-title');
  await expect(header).toContainText(developer!.name);
  await expect(header.locator(badge)).toHaveText('Score 0');
  sendScore(-1);
  await expect(header.locator(badge)).toHaveText('Score -1');
  await expect(header.locator(badge)).toBeInViewport();
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('feedback-terminal-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('feedback-terminal-desktop.png') });
});
