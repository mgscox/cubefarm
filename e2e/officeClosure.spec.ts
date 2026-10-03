import { test, expect } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import type { WorldSnapshot } from '../shared/types';

// Exercise manager controls against real demo sessions and websocket lifecycle events.
test('Settings closes, drains, reconnects and reopens the office with keyboard controls', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  const tutorialStep = (await state()).settings.tutorialStep;
  await request.post('/api/office/reopen');
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  await expect.poll(async () => (await state()).officeLifecycle.running).toBeGreaterThan(0);
  await page.addInitScript((spot) => localStorage.setItem('cubefarm:view', JSON.stringify(spot)), {
    floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6,
  });
  const settings = async () => {
    await page.goto('/');
    const enter = page.getByRole('button', { name: 'Enter the office' });
    await expect(enter).toBeEnabled();
    await enter.click();
    await expect(page.getByText("Open the manager's console")).toBeVisible();
    await page.keyboard.press('e');
    await page.waitForTimeout(450); // The console suppresses activation clicks for 400 ms after E.
    const tab = page.getByRole('button', { name: '⚙️ Settings' });
    await tab.focus();
    await page.keyboard.press('Enter'); // Opening the console briefly suppresses mouse clicks.
    await expect(tab).toHaveClass(/tab-on/);
  };
  try {
    await settings();
    const close = page.getByRole('button', { name: 'Close Office', exact: true });
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Closing — waiting for jobs to finish')).toBeVisible();
    const held = await state();
    const starts = held.agents.map((a) => [a.id, a.startedAt]);
    await page.getByText('Closing — waiting for jobs to finish').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('office-closing.png') });
    await testInfo.attach('Closing office', { path: testInfo.outputPath('office-closing.png'), contentType: 'image/png' });
    const dev = held.agents.find((a) => a.role === 'dev')!;
    const rejected = await request.post(`/api/agents/${dev.id}/assign`, { data: { issueNumber: 999 } });
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error).toContain('Reopen Office');
    await expect(page.getByText('Closed — safe to shut down')).toBeVisible({ timeout: 150_000 });
    const closed = await state();
    expect(closed.officeLifecycle).toEqual({ state: 'closed', running: 0 });
    expect(closed.agents.map((a) => [a.id, a.startedAt])).toEqual(starts);
    expect(closed.qa.some((q) => q.status === 'queued' || q.status === 'failed' || q.status === 'passed')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('office-closed.png') });
    await testInfo.attach('Closed and safe', { path: testInfo.outputPath('office-closed.png'), contentType: 'image/png' });
    await settings(); // New websocket snapshot must preserve closure.
    await expect(page.getByText('Closed — safe to shut down')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const card = page.locator('.office-lifecycle');
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('office-closed-mobile.png') });
    await testInfo.attach('Closed office on phone', { path: testInfo.outputPath('office-closed-mobile.png'), contentType: 'image/png' });
    const reopen = page.getByRole('button', { name: 'Reopen Office', exact: true });
    await reopen.focus();
    await expect(reopen).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Open — accepting work')).toBeVisible();
    await expect.poll(async () => (await state()).officeLifecycle.running).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  } finally {
    await request.post('/api/office/reopen');
    await request.patch('/api/settings', { data: { tutorialStep } });
  }
});
