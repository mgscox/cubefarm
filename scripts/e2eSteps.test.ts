import { describe, expect, it } from 'vitest';
import { e2eBrowser, webServerCommand } from './e2eSteps.mjs';

describe('e2eBrowser', () => {
  it('uses an installed Google Chrome outside CI', () => {
    expect(e2eBrowser({}, true)).toBe('chrome');
  });

  it("falls back to Playwright's Chromium without Chrome", () => {
    expect(e2eBrowser({}, false)).toBe('chromium');
  });

  it("always uses Playwright's Chromium in CI or when asked", () => {
    expect(e2eBrowser({ CI: 'true' }, true)).toBe('chromium');
    expect(e2eBrowser({ E2E_BROWSER: 'chromium' }, true)).toBe('chromium');
  });
});

describe('webServerCommand', () => {
  it('builds first unless E2E_SKIP_BUILD=1', () => {
    expect(webServerCommand({}, true)).toBe('npm run build && node --import tsx server/index.ts --demo');
    expect(webServerCommand({ CI: 'true' }, false)).toBe('npm run build && node --import tsx server/index.ts --demo');
    expect(webServerCommand({ E2E_SKIP_BUILD: '1' }, true)).toBe('node --import tsx server/index.ts --demo');
  });

  it('refuses to skip the build when there is no dist/', () => {
    expect(() => webServerCommand({ E2E_SKIP_BUILD: '1' }, false)).toThrow(/npm run build first/);
  });
});
