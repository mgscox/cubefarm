import { test, expect } from '@playwright/test';

// Adaptive resolution must survive Canvas resize configuration without a scene re-render.
test.use({ deviceScaleFactor: 2, viewport: { width: 640, height: 360 } });

test('adaptive DPR stays controlled after resizing during sustained slow frames', async ({ page, request, baseURL }, testInfo) => {
  expect((await request.patch('/api/settings', { data: { setupDone: true, tutorialStep: -1 } })).ok()).toBe(true);
  await page.route(
    (url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'),
    (route) => route.fulfill({ status: 200, body: '' }),
  );
  // Cap animation callbacks at 20 fps so this exercises real slow samples even on a fast GPU.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 50);
    window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  });
  await page.goto('/?stats');
  await page.getByRole('button', { name: 'Enter the office' }).click();
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
  const stats = page.locator('.stats span');
  await expect(stats).toContainText('dpr 1.75');
  await expect(stats).toContainText('dpr 1.00', { timeout: 60_000 });
  await expect(page.locator('canvas')).toHaveAttribute('width', '640');
  await expect(page.locator('canvas')).toHaveAttribute('height', '360');
  await page.screenshot({ path: testInfo.outputPath('dpr-before-resize.png') });

  // Observe every readout after the resize, including further slow samples at the controller's minimum.
  const samples = await stats.evaluateHandle((el) => {
    const values: { text: string; width: number; height: number }[] = [];
    new MutationObserver(() => {
      const canvas = document.querySelector('canvas')!;
      if (canvas.style.width !== '900px' || canvas.style.height !== '500px') return;
      values.push({ text: el.textContent!, width: canvas.width, height: canvas.height });
    }).observe(el, { childList: true });
    return values;
  });
  await page.setViewportSize({ width: 900, height: 500 });
  await expect.poll(() => samples.evaluate((values) => values.length), { timeout: 60_000 }).toBeGreaterThanOrEqual(24);
  const readings = await samples.jsonValue();
  await testInfo.attach('post-resize-samples', { body: JSON.stringify(readings, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('dpr-after-resize.png') });
  for (const reading of readings) {
    expect(reading.text).toContain('dpr 1.00');
    expect(reading.width).toBe(900);
    expect(reading.height).toBe(500);
    expect(Number(reading.text.match(/^(\d+) fps/)![1])).toBeLessThan(36);
  }
});
