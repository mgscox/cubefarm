import { test, expect, chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { playwrightMcpCommand } from '../server/browser.ts';

// Exercise the agents' real pinned browser tools against fake office data, without a paid agent session.
test('QA browser tools navigate and capture the demo office', async ({ baseURL, request }, testInfo) => {
  expect((await (await request.get('/api/state')).json()).demo).toBe(true);
  const client = new Client({ name: 'demo-qa-browser', version: '1.0.0' });
  try {
    const browser = playwrightMcpCommand(testInfo.outputPath('browser'));
    // Match Playwright Test's Chromium install and sandbox default; production agents keep Chrome's defaults.
    browser.args.push('--executable-path', chromium.executablePath(), '--no-sandbox');
    await client.connect(new StdioClientTransport(browser));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['browser_navigate', 'browser_snapshot', 'browser_take_screenshot']));
    const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url: baseURL } });
    expect(navigate.isError, JSON.stringify(navigate)).not.toBe(true);
    const evaluate = await client.callTool({
      name: 'browser_evaluate',
      arguments: { function: 'async () => { await document.body.requestPointerLock(); const locked = document.pointerLockElement === document.body; document.exitPointerLock(); localStorage.setItem("cubefarm:mode", "dashboard"); return locked; }' },
    });
    expect(evaluate.isError, JSON.stringify(evaluate)).not.toBe(true);
    expect(evaluate.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('true') })]));
    await client.callTool({ name: 'browser_navigate', arguments: { url: baseURL } });
    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    expect(snapshot.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Manager console') })]));
    const screenshot = await client.callTool({ name: 'browser_take_screenshot', arguments: {} });
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  } finally {
    await client.close();
  }
});
