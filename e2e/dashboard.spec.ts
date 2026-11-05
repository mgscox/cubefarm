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

  const working = page.locator('.dashboard-terminals > .workers');
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

test('Dashboard work list is a bounded grid card that never pushes the terminals down', async ({ page, baseURL }) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  // Everyone starts idle and the demo's own agent events are dropped, so the test alone decides who is working.
  type Agent = { id: string; name: string; role: string; repoId: string; status: string; issueNumber: number | null };
  let send: (agent: Agent) => void = () => {};
  let template: Agent | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    send = (agent) => ws.send(JSON.stringify({ type: 'agent', agent: { ...agent, log: undefined } }));
    server.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === 'agent' || event.type === 'agentRemoved') return;
      if (event.type === 'snapshot') {
        for (const agent of event.data.agents as Agent[]) agent.status = 'idle';
        template = (event.data.agents as Agent[]).find((agent) => agent.role === 'dev' && agent.repoId);
      }
      ws.send(JSON.stringify(event));
    });
  });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  const grid = page.locator('.dashboard-terminals');
  const working = grid.locator('> .workers');
  const tile = grid.locator('.dashboard-agent').first();
  const list = working.locator('.wk-list');
  await expect(working.getByText('Nobody is working right now.')).toBeVisible();
  await expect(tile).toBeVisible();
  const top = async () => (await tile.boundingBox())!.y;
  const startTop = await top();
  const panelHeight = (await working.boundingBox())!.height;
  expect(template).toBeTruthy();

  const busy = (from: number, to: number) => {
    for (let i = from; i < to; i++) send({ ...template!, id: `wk-test-${i}`, name: `Worker ${i}`, status: 'working', issueNumber: 900 + i });
  };
  busy(0, 3);
  await expect(working.locator('.wk-row')).toHaveCount(3);
  expect(await top()).toBe(startTop);

  busy(3, 30);
  await expect(working.locator('.wk-row')).toHaveCount(30);
  expect(await top()).toBe(startTop);
  expect((await working.boundingBox())!.height).toBe(panelHeight);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const last = working.getByRole('button', { name: /Worker 29/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // Grouping and collapsing still work, and the terminals stay put.
  const group = working.locator('.wk-group-head').first();
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(working.locator('.wk-row')).toHaveCount(0);
  await group.click();
  await expect(working.locator('.wk-row')).toHaveCount(30);
  expect(await top()).toBe(startTop);

  // Narrow and phone widths: one card per row, nothing overlapping and no page-wide horizontal scroll.
  for (const width of [700, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const panel = (await working.boundingBox())!;
    const first = (await tile.boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(first.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
