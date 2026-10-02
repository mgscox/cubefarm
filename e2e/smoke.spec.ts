import { test as base, expect, type Page } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import { colourStats, decodePng } from './png';
import type { RepoView, ServerEvent } from '../shared/types';

// Smoke tests against the demo office: it loads without errors, you can walk in, the 3D view renders and moves,
// and the main panels open and close. Pointer lock may not work headless, so nothing here depends on it.

const VIEW_KEY = 'cubefarm:view'; // where the client remembers the player's spot (store.ts saveView)

interface SavedView {
  floor: number;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

// Every test fails on a console error, an uncaught exception, or a request to the office that failed.
const test = base.extend<{ page: Page }>({
  page: async ({ page, baseURL }, use) => {
    const problems: string[] = [];
    // Only the office itself is under test: stub anything external (the Google Fonts stylesheet) so the result
    // doesn't depend on the network.
    await page.route(
      (url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'),
      (route) => route.fulfill({ status: 200, body: '' }),
    );
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
    });
    await use(page);
    expect(problems, 'console errors or failed requests').toEqual([]);
  },
});

/** Loads the office and walks in through the first-run flow (the setup wizard if it's up, else the start screen). */
async function enterOffice(page: Page) {
  await page.goto('/');
  const enter = page.getByRole('button', { name: 'Enter the office' });
  const skipSetup = page.getByRole('button', { name: /skip setup/i });
  await expect(enter.or(skipSetup)).toBeVisible();
  if (await skipSetup.isVisible()) await skipSetup.click();
  else {
    await expect(page.getByText(/DEMO MODE/)).toBeVisible();
    await expect(enter).toBeEnabled(); // it reads "Loading…" until the first snapshot arrives
    await enter.click();
  }
  await expect(enter).toBeHidden();
  await expect(phoneButton(page)).toBeVisible(); // the HUD only shows it once you're inside
}

const phoneButton = (page: Page) => page.getByTitle('Your phone (P)');

async function savedView(page: Page): Promise<SavedView | null> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), VIEW_KEY);
}

/**
 * The 3D view on its own: everything else on the page is hidden while it's captured. A page screenshot clipped to
 * the canvas, because an element screenshot first waits for frames in which it hasn't moved, and software WebGL
 * can take seconds per frame.
 */
async function canvasColours(page: Page) {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('the canvas has no size');
  const png = await page.screenshot({ clip: box, caret: 'initial', style: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
  return colourStats(decodePng(png));
}

test('/api/state returns JSON with floors', async ({ request }) => {
  const res = await request.get('/api/state');
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toContain('application/json');
  const state = await res.json();
  expect(state.demo).toBe(true);
  expect(state.repos.length).toBeGreaterThan(0);
  for (const repo of state.repos) expect(repo.floor).toBeGreaterThan(0);
  expect(state.agents.length).toBeGreaterThan(0);
});

test('the office loads, you can walk in and the 3D view renders', async ({ page }) => {
  await enterOffice(page);
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  // A blank or failed WebGL canvas is one flat colour; the lobby has walls, furniture, people and signs.
  // Polled because the first frames can still be empty while the scene loads.
  await expect
    .poll(
      async () => {
        const { colours, topShare } = await canvasColours(page);
        return topShare < 0.9 ? colours : 0; // one colour covering nearly everything counts as blank
      },
      { message: 'distinct colours in the canvas', timeout: 90_000 },
    )
    .toBeGreaterThan(200);
});

test('H opens help and Esc closes it', async ({ page }) => {
  await enterOffice(page);
  const help = page.getByText('How the office works', { exact: true });
  await page.keyboard.press('h');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(phoneButton(page)).toBeVisible();
});

test('the phone opens and closes with P, its button and Esc', async ({ page }) => {
  await enterOffice(page);
  const hires = page.getByRole('button', { name: /Hires/ }); // one of the phone's tabs
  const company = page.getByRole('button', { name: /Company/ });
  await page.keyboard.press('p');
  await expect(hires).toBeVisible();
  await expect(phoneButton(page)).toBeHidden();
  // The chat focuses its message box, where P types a "p"; from another tab P puts the phone away.
  await company.click();
  await expect(company).toHaveClass(/phone-tab-on/);
  await page.keyboard.press('p');
  await expect(hires).toBeHidden();

  // Closing a panel grabs the mouse again (#42); a locked pointer can't click the HUD, so let go of it first. The lock
  // request is async: wait for it to land (or be refused) before letting go, or it lands after and eats the click.
  await page
    .waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 3000 })
    .catch(() => undefined);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => document.pointerLockElement === null);
  // Clicks are also ignored for a moment after a panel closes (so a double click can't act through it): retry.
  await expect(async () => {
    await phoneButton(page).click();
    await expect(hires).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.keyboard.press('Escape');
  await expect(hires).toBeHidden();
  await expect(phoneButton(page)).toBeVisible();
});

test("the manager's console opens with E at its desk and closes with Esc", async ({ page }) => {
  // Start in the manager's office, just in front of the desk, looking down at the computer (-Z is north).
  const spot: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };
  await page.addInitScript(([key, view]) => localStorage.setItem(key, view), [VIEW_KEY, JSON.stringify(spot)] as const);
  await enterOffice(page);
  await expect(page.getByText("Open the manager's console")).toBeVisible(); // the crosshair hint
  await page.keyboard.press('e');
  const panel = page.getByText(/Manager's console/); // the panel's title; the hint and help text say "manager's"
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(phoneButton(page)).toBeVisible();
});

test('repository refresh distinguishes unavailable checks, REST fallback, stale data, failure and recovery', async ({ page }, testInfo) => {
  let phase: 'checks' | 'fallback' | 'stale' | 'failed' | 'success' = 'checks';
  const diagnostic = 'GraphQL: Resource not accessible by personal access token (repository.pullRequests.nodes.0.statusCheckRollup.contexts.nodes.0)';
  const fallbackNote = 'Check rollup access denied; REST fallback in use (GitHub Actions and commit statuses).';
  const decorate = (repo: RepoView) => {
    repo.folderSync = 'in sync';
    repo.syncing = false;
    repo.syncError = undefined;
    repo.pulls = [{
      number: 12, title: 'Fallback checks', url: `https://github.com/${repo.fullName}/pull/12`, headRefName: 'swarm/12',
      state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, closesIssues: [],
      createdAt: '2026-10-01', mergedAt: null, additions: 1, deletions: 0, headSha: 'abc', mergeState: 'CLEAN',
      checks: phase === 'checks' ? 'unavailable' : 'passing', failedChecks: [], pendingChecks: [],
    }];
    repo.refresh = {
      status: phase === 'failed' ? 'failed' : phase === 'success' ? 'success' : 'partial',
      issues: { at: 1_800_000_000_000, error: phase === 'failed' ? 'HTTP 401: Bad credentials' : undefined },
      pulls: { at: 1_800_000_000_000, error: phase === 'stale' ? 'network timeout' : phase === 'failed' ? 'HTTP 401: Bad credentials' : undefined },
      checksError: phase === 'checks' ? diagnostic : phase === 'fallback' ? fallbackNote : undefined,
    };
  };
  // Exercise both the initial snapshot and subsequent repo events without credentials or real GitHub traffic.
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(message.toString()) as ServerEvent;
      if (event.type === 'snapshot') {
        event.data.settings.tutorialStep = -1;
        event.data.repos.forEach(decorate);
      }
      if (event.type === 'repo') decorate(event.repo);
      ws.send(JSON.stringify(event));
    });
  });
  const spot: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };
  await page.addInitScript(([key, view]) => localStorage.setItem(key, view), [VIEW_KEY, JSON.stringify(spot)] as const);
  await enterOffice(page);
  await expect(page.getByText("Open the manager's console")).toBeVisible();
  await page.keyboard.press('e');
  await page.getByRole('button', { name: /Floors & repos/ }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  const card = page.locator('.floor-card').first();
  await expect(card.getByText('GitHub: partially refreshed')).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(1);
  await expect(card.getByRole('alert')).toContainText('automatic merging is blocked for those PRs');
  await expect(card.getByText(/Local Git: in sync/)).toBeVisible();
  await expect(card.locator('pre')).toBeHidden();
  await card.getByText('GitHub refresh diagnostics').click();
  await expect(card.locator('pre')).toHaveText(diagnostic);
  await card.getByText('GitHub refresh diagnostics').click();
  await card.screenshot({ path: testInfo.outputPath('checks-unavailable.png') });

  phase = 'fallback';
  await card.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(card.getByRole('alert')).toHaveText('PR checks are read through GitHub Actions and commit statuses.');
  await card.getByText('GitHub refresh diagnostics').click();
  await expect(card.locator('pre')).toHaveText(fallbackNote);
  await card.getByText('GitHub refresh diagnostics').click();
  await card.screenshot({ path: testInfo.outputPath('checks-rest-fallback.png') });

  phase = 'stale';
  await card.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(card.getByText(/PRs:.*stale · last refreshed/)).toBeVisible();
  await expect(card.getByText(/Issues:.*open · refreshed/)).toBeVisible();
  await expect(card.getByText(/Some PR checks could not be read/)).toBeHidden();
  phase = 'failed';
  await card.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(card.getByText('GitHub: refresh failed')).toBeVisible();
  phase = 'success';
  await card.getByRole('button', { name: 'Refresh GitHub' }).click();
  await expect(card.getByText('GitHub: refreshed')).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByText('GitHub refresh diagnostics')).toHaveCount(0);
});

test('holding W walks forward', async ({ page }) => {
  await enterOffice(page);
  // The client saves the player's spot about once a second while you're inside.
  await expect.poll(() => savedView(page)).not.toBeNull();
  const from = (await savedView(page))!;
  await page.keyboard.down('w');
  try {
    // Hold W until the saved spot has moved: about a second at 3.6 m/s, much longer when software WebGL on a busy
    // runner manages only a few frames a second (each frame moves you at most 0.18 m).
    await expect
      .poll(async () => {
        const at = await savedView(page);
        return at ? Math.hypot(at.x - from.x, at.z - from.z) : 0;
      }, { message: 'metres walked', timeout: 60_000 })
      .toBeGreaterThan(0.1);
  } finally {
    await page.keyboard.up('w');
  }
  const to = (await savedView(page))!;
  expect(to.floor).toBe(from.floor);
  expect(to.yaw).toBeCloseTo(from.yaw); // W walks, it doesn't turn
});
