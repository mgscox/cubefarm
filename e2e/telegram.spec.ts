import { test, expect } from '@playwright/test';
import type { WorldSnapshot } from '../shared/types';

// The fake transport exercises real phone commands/events without a bot token or external requests.
test('Telegram pairing, shared conversation, proposals and reconnect recovery', async ({ page, request, baseURL }, testInfo) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  const command = async (action: string, extra = {}) => {
    const response = await request.post('/api/telegram', { data: { action, ...extra } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const originalStep = (await state()).settings.tutorialStep;
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  await request.post('/api/office/reopen');
  await command('revoke');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const openPhone = async () => {
    await page.goto('/');
    const enter = page.getByRole('button', { name: 'Enter the office' });
    await expect(enter).toBeEnabled(); await enter.click();
    await page.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 3000 }).catch(() => undefined);
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => document.pointerLockElement === null);
    await page.keyboard.press('p');
    await expect(page.locator('.phone')).toBeVisible();
    await page.waitForTimeout(450); // Opening a panel suppresses activation clicks for 400 ms.
    await page.locator('.phone-tabs button').first().click();
    await page.locator('.telegram-settings summary').click();
    await expect(page.getByRole('textbox', { name: 'Simulate Telegram message' })).toBeVisible();
  };
  const simulate = async (text: string) => {
    await page.getByRole('textbox', { name: 'Simulate Telegram message' }).fill(text);
    await page.locator('.telegram-settings form button').click();
    await expect(page.locator('.telegram-settings form button')).toBeDisabled();
  };
  try {
    await openPhone();
    await page.getByRole('button', { name: 'Create pairing code' }).click();
    await expect.poll(async () => (await state()).telegram?.pairing?.code).toBeTruthy();
    const code = (await state()).telegram!.pairing!.code;
    await simulate(`/start ${code}`);
    await expect(page.getByText('Confirm this Telegram identity: user 12345, chat 12345')).toBeVisible();
    expect((await state()).telegram!.paired).toBeNull();
    await page.locator('.phone').screenshot({ path: testInfo.outputPath('telegram-pairing.png') });
    await page.getByRole('button', { name: 'Confirm pairing' }).click();
    await expect.poll(async () => (await state()).telegram?.state).toBe('connected');
    await simulate('Telegram shared request e2e');
    await expect(page.locator('.chat-log').getByText('Telegram shared request e2e', { exact: true })).toBeVisible();
    const ceo = (await state()).agents.find((a) => a.role === 'ceo')!;
    await page.getByRole('textbox', { name: `Message ${ceo.name}`, exact: true }).fill('WebUI shared request e2e');
    await page.locator('.chat-input button').click();
    await expect.poll(async () => (await state()).telegram!.demo!.sent.some((m) => m.text === 'Manager (WebUI): WebUI shared request e2e')).toBe(true);
    await simulate('/reply Shared Joi reply e2e');
    await expect(page.locator('.chat-log').getByText('Shared Joi reply e2e', { exact: true })).toBeVisible();
    await simulate('/proposal');
    await expect.poll(async () => (await state()).telegram!.demo!.sent.some((m) => m.buttons?.length === 2)).toBe(true);
    const proposal = (await state()).requests.find((r) => r.title === 'Demo developer' && r.status === 'pending')!;
    await command('demo', { text: `reject:${proposal.id}` });
    await expect.poll(async () => (await state()).requests.find((r) => r.id === proposal.id)?.status).toBe('rejected');
    await expect.poll(async () => (await state()).telegram!.demo!.sent.some((m) => m.text.includes('Demo developer') && m.text.includes('rejected') && !m.buttons?.length)).toBe(true);
    await page.locator('.phone').screenshot({ path: testInfo.outputPath('telegram-shared.png') });
    await simulate('/offline');
    await command('demo', { text: '/notice Pending during disconnect e2e' });
    await expect(page.locator('.telegram-settings summary')).toHaveText('Telegram · reconnecting');
    await page.locator('.phone').screenshot({ path: testInfo.outputPath('telegram-reconnecting.png') });
    await openPhone(); // websocket reconnect loads the same authoritative pairing/pending status
    await expect(page.getByRole('button', { name: 'Revoke pairing' })).toBeVisible();
    await simulate('/online');
    await expect.poll(async () => (await state()).telegram!.demo!.sent.some((m) => m.text === 'Office: Pending during disconnect e2e')).toBe(true);
    await expect.poll(async () => (await state()).telegram!.pending).toBe(0);
    await page.locator('.phone').screenshot({ path: testInfo.outputPath('telegram-recovered.png') });
    expect((await state()).messages.filter((m) => m.text === 'Telegram shared request e2e')).toHaveLength(1);
    expect(problems).toEqual([]);
  } finally {
    await command('revoke');
    await request.patch('/api/settings', { data: { tutorialStep: originalStep } });
  }
});
