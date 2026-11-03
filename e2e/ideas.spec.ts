import { expect, test } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import type { IdeaRecordView, ServerEvent, WorldSnapshot } from '../shared/types';

// The demo uses the same intake/persistence path as the real office, without real GitHub traffic.
test('submit, inspect and reload Ideas, with optional hints and independent records', async ({ page, request, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  await page.addInitScript((spot) => localStorage.setItem('cubefarm:view', JSON.stringify(spot)), {
    floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6,
  });
  await page.addInitScript(() => {
    const capture = Element.prototype.requestPointerLock;
    const view = window as unknown as { ideaPointerCaptures: number };
    view.ideaPointerCaptures = 0;
    Element.prototype.requestPointerLock = function (options) {
      view.ideaPointerCaptures++;
      return capture.call(this, options);
    };
  });
  const enter = async (url: string) => {
    await page.goto(url);
    await page.reload(); // A hash-only navigation keeps React alive; exercise an actual reload.
    const button = page.getByRole('button', { name: 'Enter the office' });
    await expect(button).toBeEnabled();
    await button.click();
    if (url.includes('#idea/')) {
      expect(await page.evaluate(() => (window as unknown as { ideaPointerCaptures: number }).ideaPointerCaptures)).toBe(0);
    }
  };
  try {
    await enter('/');
    await expect(page.getByText("Open the manager's console")).toBeVisible();
    await page.keyboard.press('e');
    await page.waitForTimeout(450); // E suppresses activation clicks for 400 ms while the console opens.
    const tab = page.getByRole('button', { name: '💡 Ideas' });
    await tab.focus();
    await page.keyboard.press('Enter');
    const queue = page.getByRole('button', { name: 'Queue Idea', exact: true });
    await expect(queue).toBeDisabled();
    await page.getByLabel('Short description').fill('   ');
    await expect(queue).toBeDisabled();
    await page.getByLabel('Short description').fill('Help new teammates find their way around');
    await queue.click();
    const detail = page.getByRole('article', { name: 'Idea detail' });
    await expect(detail).toContainText('Help new teammates find their way around');
    await expect(detail.getByRole('status')).toHaveText('Queued');
    await expect(detail).toContainText('No floor hints');
    const link = await detail.getByRole('link', { name: 'Link to this Idea' }).getAttribute('href');
    expect(link).toMatch(/^#idea\/[a-z0-9-]+$/);
    await enter(`/${link}`);
    await expect(detail).toContainText('Help new teammates find their way around');
    await expect(detail.getByRole('status')).toHaveText('Queued');
    await page.getByRole('button', { name: 'New Idea', exact: true }).click();
    await page.getByLabel('Short description').fill('Share updates between our apps');
    await page.getByLabel('Links (optional, one per line)').fill('https://example.com/context');
    await page.getByLabel('Constraints (optional)').fill('Keep offline access');
    await page.getByLabel(initial.repos[0].fullName, { exact: true }).check();
    await queue.click();
    await expect(detail).toContainText('Share updates between our apps');
    await expect(detail).toContainText(initial.repos[0].id);
    await expect(detail).toContainText('Keep offline access');
    await expect(detail.getByRole('link', { name: 'https://example.com/context' })).toBeVisible();
    const ideaId = (await detail.getByRole('link', { name: 'Link to this Idea' }).getAttribute('href'))!.slice('#idea/'.length);
    // Future slices supply these read-only projections; their workflow is deliberately outside intake.
    const records: IdeaRecordView[] = (['research', 'review', 'proposal'] as const).map((kind) => ({
      id: `${kind}-1`, ideaId, kind, title: `${kind} record`, body: `Independent ${kind} content`, createdAt: 1,
    }));
    await page.routeWebSocket('**/ws', (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        const event = JSON.parse(message.toString()) as ServerEvent;
        if (event.type === 'snapshot') event.data.ideaRecords = [...records, { ...records[0], ideaId: 'another-idea', title: 'Other Idea only' }];
        ws.send(JSON.stringify(event));
      });
    });
    await enter(`/#idea/${ideaId}`);
    for (const kind of ['research', 'review', 'proposal']) await expect(detail).toContainText(`Independent ${kind} content`);
    await expect(detail).not.toContainText('Other Idea only');
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: testInfo.outputPath('idea-detail.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toBeVisible();
    expect(await page.locator('.tab-body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('idea-mobile.png') });
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep } });
  }
});
