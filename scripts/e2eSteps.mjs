// The e2e run's setup decisions for playwright.config.ts, kept pure so Vitest can cover them: which browser runs the
// smoke tests, and whether the demo office is built first.
import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * CI always uses Playwright's Chromium, as before. Elsewhere an installed Google Chrome saves the Chromium download,
 * unless E2E_BROWSER=chromium asks for CI's browser.
 */
export function e2eBrowser(env, chromeInstalled) {
  return !env.CI && env.E2E_BROWSER !== 'chromium' && chromeInstalled ? 'chrome' : 'chromium';
}

/** E2E_SKIP_BUILD=1 boots the demo office from the dist/ already built instead of building again. */
export function webServerCommand(env, hasBuild) {
  const boot = 'node --import tsx server/index.ts --demo';
  if (env.E2E_SKIP_BUILD !== '1') return `npm run build && ${boot}`;
  if (!hasBuild) throw new Error('E2E_SKIP_BUILD=1 but dist/index.html is missing: run npm run build first.');
  return boot;
}

/** Whether Google Chrome is installed where Playwright's `channel: 'chrome'` looks for it. */
export function chromeInstalled() {
  try {
    const { registry } = createRequire(import.meta.url)('playwright-core/lib/server/registry/index');
    const file = registry.findExecutable('chrome')?.executablePath('javascript');
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}
