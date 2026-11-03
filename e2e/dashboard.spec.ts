import { expect, test } from '@playwright/test';

test('Dashboard opens every Manager console panel and can visit a floor', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click({ timeout: 5000 });

  const consoleTitle = page.getByText("Manager's console");
  const panel = page.locator('.panel').filter({ has: consoleTitle });
  await expect(consoleTitle).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Add a project/ })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('dashboard-manager-console.png') });

  const tabs = [
    [/CEO & hiring/, 'heading', /Project briefs/],
    [/Team/, 'button', '+ Developer'],
    [/Fleet/, 'heading', /Machines/],
    [/Ideas/, 'heading', 'Ideas'],
    [/Issues/, 'heading', /File a new issue/],
    [/Settings/, 'heading', 'Office'],
  ] as const;
  for (const [tab, role, name] of tabs) {
    await panel.getByRole('button', { name: tab }).click();
    await expect(panel.getByRole(role, { name, exact: true }).first()).toBeVisible();
  }

  await page.keyboard.press('Escape');
  await expect(consoleTitle).toBeHidden();
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  await panel.getByRole('button', { name: 'Visit', exact: true }).first().click();
  await expect(consoleTitle).toBeHidden();
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toBeVisible();
});
