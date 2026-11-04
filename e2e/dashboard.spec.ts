import { expect, test } from '@playwright/test';

test('Dashboard opens every Manager console panel and can visit a floor', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();

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

test('Dashboard Lobby shows who is working and the office notices, and leaves Tab to focus', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  // The demo office never fails GitHub or updates itself: add both to its snapshot.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === 'snapshot') {
        event.data.ghReady = false;
        event.data.ghError = 'GitHub CLI is not logged in';
        event.data.officeUpdate = { state: 'waiting', behind: 2, launcher: true, drainingSince: null, running: 1, detail: null };
      }
      ws.send(JSON.stringify(event));
    });
  });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');

  await expect(page.getByRole('alert').filter({ hasText: 'GitHub CLI is not logged in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Updating the office after 1 session finishes/ })).toBeVisible();

  const working = page.locator('.dashboard-main > .workers');
  await expect(working.getByRole('button', { name: /^Working/ })).toHaveAttribute('aria-expanded', 'true');
  // The CEO's details are the Manager console; a floor agent's are their terminal.
  const row = working.locator('.wk-group').filter({ hasNot: page.getByText('HQ', { exact: true }) }).locator('.wk-row').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('dashboard-lobby-working.png') });

  await page.getByRole('button', { name: 'Manager console', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Phone/ })).toBeFocused();
  await expect(working).toBeVisible();

  await row.click();
  await expect(page.getByPlaceholder(/while they work/)).toBeVisible();
});
