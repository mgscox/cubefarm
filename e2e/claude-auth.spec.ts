import { expect, test } from '@playwright/test';

// Entirely demo: no auth subprocess, no provider traffic, no real credential directory.
test('mobile phone Settings safely replaces a demo subscription token and cancels a pending replacement', async ({ page, request, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outbound: string[] = [];
  page.on('request', (req) => { if (req.url().includes('/api/settings/claude')) outbound.push(req.postData() ?? ''); });
  const secret = 'sk-ant-oat01-' + 'e'.repeat(80);
  await page.goto('/');
  await page.getByRole('button', { name: /^Phone/ }).click();
  await page.locator('.phone-tabs').getByRole('button', { name: /Settings/ }).click({ timeout: 5000 });
  const card = page.getByRole('region', { name: 'Claude authentication', exact: true });
  await expect(card.getByRole('status')).toContainText('Demo');
  await card.getByRole('button', { name: 'Use manual token fallback', exact: true }).click({ timeout: 5000 });
  await expect(card.getByText(/no Claude login process runs here/)).toBeVisible();
  await page.locator('.phone').screenshot({ path: testInfo.outputPath('claude-auth-mobile-pending.png') });
  const token = card.getByLabel('New subscription token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill(secret);
  // Clear on cancel; the secret must not be sent by the cancellation request.
  await card.getByRole('button', { name: 'Cancel replacement', exact: true }).click();
  expect(outbound.some((body) => body.includes(secret))).toBe(false);
  await card.getByRole('button', { name: 'Use manual token fallback', exact: true }).click({ timeout: 5000 });
  await expect(token).toHaveValue('');
  await token.fill(secret);
  await card.getByRole('button', { name: 'Save subscription token', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('Demo replacement complete');
  await expect(token).toHaveCount(0);
  expect((await page.locator('body').innerText()).includes(secret)).toBe(false);
  expect((await (await request.get('/api/state')).text()).includes(secret)).toBe(false);
  expect(await page.evaluate((value) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value), secret)).toBe(false);
  const bounds = await card.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await card.screenshot({ path: testInfo.outputPath('claude-auth-mobile.png') });
  await page.reload();
  await page.getByRole('button', { name: /^Phone/ }).click();
  await page.locator('.phone-tabs').getByRole('button', { name: /Settings/ }).click();
  await expect(card.getByRole('status')).toContainText('Demo replacement complete');
  expect(errors).toEqual([]);
});


test('mobile phone opens official demo sign-in, returns one code, clears it, and cancels a second flow', async ({ page, context, request, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await context.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Fake Claude approval: return demo-code-123 in Settings.</p>' }));
  const outbound: string[] = [];
  const responses: string[] = [];
  page.on('request', (req) => { if (req.url().includes('/api/settings/claude')) outbound.push(req.postData() ?? ''); });
  page.on('response', async (res) => { if (res.url().includes('/api/settings/claude')) responses.push(await res.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Phone/ }).click();
  await page.locator('.phone-tabs').getByRole('button', { name: /Settings/ }).click();
  const card = page.getByRole('region', { name: 'Claude authentication', exact: true });
  await card.getByRole('button', { name: 'Sign in with Claude', exact: true }).click({ timeout: 5000 });
  const link = card.getByRole('link', { name: 'Open Claude sign-in', exact: true });
  await expect(link).toHaveAttribute('href', /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  const popupEvent = page.waitForEvent('popup');
  await link.click();
  const popup = await popupEvent;
  await expect(popup.getByText('Fake Claude approval:', { exact: false })).toBeVisible();
  await popup.close();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByRole('button', { name: 'Copy sign-in URL', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
  const code = card.getByLabel('Code from Claude sign-in', { exact: true });
  await expect(code).toHaveAttribute('type', 'password');
  await expect(code).toHaveAttribute('autocomplete', 'off');
  await card.screenshot({ path: testInfo.outputPath('claude-browser-mobile-pending.png') });
  await code.fill('dummy-code-not-submitted');
  await card.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  expect(outbound.some((body) => body.includes('dummy-code-not-submitted'))).toBe(false);
  await expect(card.getByText('Sign-in cancelled.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Sign in with Claude', exact: true }).click({ timeout: 5000 });
  await expect(code).toHaveValue('');
  await code.fill('demo-code-123');
  await card.getByRole('button', { name: 'Complete sign-in', exact: true }).click();
  await expect(code).toHaveCount(0);
  await expect(card.getByRole('status')).toContainText('Demo sign-in complete');
  expect(responses.join('')).not.toContain('demo-code-123');
  expect((await page.locator('body').innerText()).includes('demo-code-123')).toBe(false);
  expect((await (await request.get('/api/state')).text()).includes('demo-code-123')).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('demo-code-123'))).toBe(false);
  await card.screenshot({ path: testInfo.outputPath('claude-browser-mobile-complete.png') });
  // Unmount cancels the server-owned process/flow rather than leaving a code exchange running.
  await card.getByRole('button', { name: 'Sign in with Claude', exact: true }).click({ timeout: 5000 });
  await expect(code).toBeVisible();
  await page.locator('.phone-tabs').getByRole('button', { name: /Hires/ }).click();
  await expect.poll(async () => {
    const response = await request.post('/api/settings/claude/status', { headers: { Origin: baseURL!, 'X-CubeFarm-Claude-Auth': '1' }, data: {} });
    return (await response.json()).phase;
  }).toBe('cancelled');
});

// A second Settings client observes the singleton; it does not acquire cleanup ownership.
for (const delayed of ['none', 'initial-status', 'poll-status'] as const) {
  test(`mobile observer never cancels another client's flow on unmount (${delayed})`, async ({ page, context, request, baseURL }) => {
    await context.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
    await context.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
    const openSettings = async (client: typeof page) => {
      await client.setViewportSize({ width: 390, height: 844 });
      await client.goto('/');
      await client.getByRole('button', { name: /^Phone/ }).click();
      await client.locator('.phone-tabs').getByRole('button', { name: /Settings/ }).click();
      return client.getByRole('region', { name: 'Claude authentication', exact: true });
    };
    const status = async () => (await request.post('/api/settings/claude/status', {
      headers: { Origin: baseURL!, 'X-CubeFarm-Claude-Auth': '1' }, data: {},
    })).json();
    const owner = await openSettings(page);
    await owner.getByRole('button', { name: 'Sign in with Claude', exact: true }).click();
    await expect(owner.getByLabel('Code from Claude sign-in', { exact: true })).toBeVisible();
    const owned = await status();
    const observer = await context.newPage();
    const cancelled: string[] = [];
    observer.on('request', (req) => { if (req.url().endsWith('/api/settings/claude/cancel')) cancelled.push(req.postData() ?? ''); });
    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => { received = resolve; });
    let delivered!: () => void;
    const responseDelivered = new Promise<void>((resolve) => { delivered = resolve; });
    let calls = 0;
    if (delayed !== 'none') await observer.route('**/api/settings/claude/status', async (route) => {
      const response = await route.fetch();
      calls += 1;
      if (calls === (delayed === 'initial-status' ? 1 : 2)) {
        const gate = new Promise<void>((resolve) => { release = resolve; });
        received();
        await gate;
        await route.fulfill({ response });
        delivered();
      } else await route.fulfill({ response });
    });
    try {
      const observed = await openSettings(observer);
      if (delayed === 'none') await expect(observed.getByLabel('Code from Claude sign-in', { exact: true })).toBeVisible();
      else await held;
      await observer.locator('.phone-tabs').getByRole('button', { name: /Hires/ }).click();
      if (delayed !== 'none') { release(); await responseDelivered; }
      // Allow the delivered fetch continuation and effect cleanup requests to settle.
      await observer.waitForTimeout(300);
      expect(cancelled).toEqual([]);
      expect(await status()).toMatchObject({ flowId: owned.flowId, phase: 'awaiting-code' });
    } finally {
      release?.();
      await observer.close();
      await page.locator('.phone-tabs').getByRole('button', { name: /Hires/ }).click();
      await expect.poll(async () => (await status()).flowId).toBeNull();
    }
  });
}

test('mobile owner cancels its own start response arriving after unmount', async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { received = resolve; });
  let startedId: string;
  await page.route('**/api/settings/claude/start', async (route) => {
    const response = await route.fetch();
    startedId = (await response.json()).flowId;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    received();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Phone/ }).click();
  await page.locator('.phone-tabs').getByRole('button', { name: /Settings/ }).click();
  const card = page.getByRole('region', { name: 'Claude authentication', exact: true });
  await card.getByRole('button', { name: 'Sign in with Claude', exact: true }).click();
  await held;
  await page.locator('.phone-tabs').getByRole('button', { name: /Hires/ }).click();
  const cancelled = page.waitForRequest((req) => req.url().endsWith('/api/settings/claude/cancel'));
  release();
  expect((await cancelled).postDataJSON()).toEqual({ flowId: startedId! });
  await expect.poll(async () => {
    const response = await request.post('/api/settings/claude/status', {
      headers: { Origin: baseURL!, 'X-CubeFarm-Claude-Auth': '1' }, data: {},
    });
    return (await response.json()).phase;
  }).toBe('cancelled');
});
