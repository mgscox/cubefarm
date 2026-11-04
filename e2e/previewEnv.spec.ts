import { expect, test } from '@playwright/test';

test('preview settings enforce the character budget and save a large environment', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  const floor = page.locator('.floor-card').first();
  await floor.locator('summary').click();
  const env = floor.getByRole('textbox', { name: /Environment/ });
  await expect(env).toHaveAccessibleName(/16000 characters across names and values/);
  const save = floor.getByRole('button', { name: 'Save', exact: true });
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/repos/')) patches.push(r.url()); });

  await env.fill(`KEY=${'x'.repeat(15998)}`);
  await save.click();
  await expect(floor.getByText(/Preview environment exceeds 16000 characters across names and values/)).toBeVisible();
  expect(patches).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('preview-env-limit.png'), animations: 'disabled' });

  // More than 50 variables, a value over 4,000 characters, and exactly 16,000 characters in total.
  const entries: [string, string][] = Array.from({ length: 60 }, (_, i) => [`K${i}`, 'v']);
  entries.push(['LONG', 'x'.repeat(15766)]);
  await env.fill(entries.map(([key, value]) => `${key}=${value}`).join('\n'));
  const response = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/repos/'));
  await save.click();
  expect((await response).ok()).toBe(true);
  await expect(save).toBeDisabled();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.repos[0].previewConfig.env).toEqual(Object.fromEntries(entries));
  // Leave the shared demo office clean for subsequent tests.
  await env.fill('');
  await save.click();
  await expect(save).toBeDisabled();
});
