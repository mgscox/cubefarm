// Use the published SDK client against an isolated demo office and its real shared phone commands.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HireRequestView, WorldSnapshot } from '../shared/types';

const startupToken = 'cubefarm-e2e-demo-manager-token-only';
const root = path.resolve(import.meta.dirname, '..');

// The Actions checkout can be detached. Give the demo its own real checkout identity.
async function withOffice(branch: string, use: (url: string) => Promise<void>, subOffice = false) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-mcp-e2e-'));
  try {
    await Promise.all([
      cp(path.join(root, 'dist-server'), path.join(folder, 'dist-server'), { recursive: true }),
      cp(path.join(root, 'docs', 'specialisms'), path.join(folder, 'docs', 'specialisms'), { recursive: true }),
      cp(path.join(root, 'package.json'), path.join(folder, 'package.json')),
      symlink(path.join(root, 'dist'), path.join(folder, 'dist'), 'junction'),
      symlink(path.join(root, 'node_modules'), path.join(folder, 'node_modules'), 'junction'),
    ]);
    execFileSync('git', ['init', '--quiet', '--initial-branch', branch], { cwd: folder });
    const proc = spawn(process.execPath, ['dist-server/index.js', '--demo'], {
      cwd: folder,
      env: {
        ...process.env, SWARM_HOME: path.join(folder, 'state'), SWARM_HOST: '127.0.0.1', SWARM_PORT: '0',
        SWARM_SUB_OFFICE: subOffice ? '1' : '0', CUBEFARM_MCP_TOKEN: startupToken,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const closed = once(proc, 'close');
    let timer: NodeJS.Timeout | undefined;
    try {
      const port = await Promise.race([
        new Promise<string>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('MCP demo did not start')), 15_000);
          let output = '';
          proc.stdout.on('data', (chunk) => {
            output += chunk;
            const match = /localhost:(\d+).*DEMO MODE/.exec(output);
            if (match) resolve(match[1]!);
          });
        }),
        closed.then(([code]) => { throw new Error(`MCP demo stopped during startup (${code})`); }),
      ]);
      await use(`http://127.0.0.1:${port}`);
    } finally {
      clearTimeout(timer);
      proc.kill();
      await closed;
    }
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

const test = base.extend<{}, { mcpOfficeUrl: string }>({
  mcpOfficeUrl: [async ({}, use) => withOffice('main', use), { scope: 'worker' }],
  baseURL: async ({ mcpOfficeUrl }, use) => use(mcpOfficeUrl),
});

test('authorized MCP clients can coordinate through the shared phone and proposal workflow', async ({ baseURL, request }) => {
  const headers = { Authorization: `Bearer ${startupToken}` };
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  expect((await request.post('/mcp')).status()).toBe(401);
  expect((await request.post('/mcp', { headers: { Authorization: `Bearer ${'x'.repeat(32)}` } })).status()).toBe(401);
  expect((await request.post('/mcp', { headers: { ...headers, Origin: baseURL! } })).status()).toBe(403);
  expect((await request.get('/mcp', { headers })).status()).toBe(405);

  const client = new Client({ name: 'demo-manager', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseURL), { requestInit: { headers } }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools.sort()).toEqual(['decide_proposal', 'get_office_status', 'list_proposals', 'read_phone', 'send_message']);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    expect((await call('get_office_status')).structuredContent).toMatchObject({ demo: true, floors: expect.any(Array) });

    expect((await request.post('/api/office/reopen')).ok()).toBe(true);
    const initial = (await state()).phoneReadAt;
    const cursor = (await call('read_phone')).structuredContent as { nextCursor: number };
    const message = { text: 'MCP demo office check', requestId: randomUUID() };
    const first = await call('send_message', message);
    expect(first.structuredContent).toMatchObject({ accepted: true, messageId: expect.any(Number) });
    expect((await call('send_message', message)).structuredContent).toEqual(first.structuredContent);
    expect((await call('send_message', { ...message, text: 'Different command' })).isError).toBe(true);
    expect((await call('send_message', { ...message, requestId: 'invalid' })).isError).toBe(true);
    await expect.poll(async () => (await state()).messages.some((m) => m.from === 'ceo' && m.text.includes(message.text))).toBe(true);
    expect((await state()).messages.filter((m) => m.text === message.text)).toHaveLength(1);
    expect((await call('read_phone', { afterId: cursor.nextCursor })).structuredContent).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ origin: 'mcp', text: message.text })]),
    });
    expect((await state()).phoneReadAt).toBe(initial);

    expect((await request.post('/api/telegram', { data: { action: 'demo', text: '/proposal' } })).ok()).toBe(true);
    const result = (await call('list_proposals', { status: 'pending' })).structuredContent as { proposals: HireRequestView[] };
    const proposalId = result.proposals.find((p) => p.title === 'Demo developer')!.id;
    expect((await call('decide_proposal', { proposalId, decision: 'reject' })).structuredContent).toEqual({ proposalId, status: 'rejected' });
    expect((await call('decide_proposal', { proposalId, decision: 'approve' })).isError).toBe(true);
    expect((await state()).requests.find((p) => p.id === proposalId)?.status).toBe('rejected');
  } finally {
    await client.close();
  }
});

test('Settings rotates and disables the gateway immediately', async ({ page, request, baseURL }, testInfo) => {
  const settingsPath = '/api/settings/mcp';
  const savedToken = randomUUID();
  const gateway = (token: string) => request.get('/mcp', { headers: { Authorization: `Bearer ${token}` } });
  expect((await request.patch(settingsPath, { headers: { Origin: 'https://outside.example' }, data: { token: savedToken } })).status()).toBe(403);
  expect((await request.patch(settingsPath, { headers: { 'X-Forwarded-For': '192.0.2.1' }, data: { token: savedToken } })).status()).toBe(403);
  expect((await request.patch(settingsPath, { data: { token: 'too-short' } })).status()).toBe(400);
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Manager console', exact: true }).click();
    await page.locator('.panel').getByRole('button', { name: /Settings/ }).click();
  };
  try {
    await page.goto('/');
    await openSettings();
    const card = page.getByRole('region', { name: 'Manager MCP' });
    const toggle = card.getByRole('switch');
    const input = card.getByLabel('MCP token', { exact: true });
    await expect(toggle).toBeChecked();
    await input.fill(savedToken);
    await card.getByRole('button', { name: 'Save token', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('Using the token saved in Settings.');
    await expect(input).toHaveValue('');
    expect((await gateway(startupToken)).status()).toBe(401);
    expect((await gateway(savedToken)).status()).toBe(405);
    expect(await (await request.get(settingsPath)).json()).toEqual({ available: true, enabled: true, tokenSource: 'settings', canManage: true });
    await card.screenshot({ path: testInfo.outputPath('manager-mcp-settings.png') });

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect((await gateway(savedToken)).status()).toBe(404);
    await page.reload();
    await openSettings();
    await expect(toggle).not.toBeChecked();
    await expect(card.getByRole('status')).toHaveText('Using the token saved in Settings.');
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect((await gateway(savedToken)).status()).toBe(405);
    await card.getByRole('button', { name: 'Clear saved token' }).click();
    await expect(card.getByRole('status')).toHaveText('Using the token from startup configuration.');
    expect((await gateway(startupToken)).status()).toBe(405);
    expect((await gateway(savedToken)).status()).toBe(401);
  } finally {
    await request.patch(settingsPath, { data: { enabled: true, token: null } });
  }
});

test('Settings saves and clears a write-only demo Box key and updates other clients', async ({ page, request, baseURL }, testInfo) => {
  const endpoint = '/api/settings/upstash';
  const key = 'demo-box-key-' + randomUUID();
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Manager console', exact: true }).click();
    await page.locator('.panel').getByRole('button', { name: /Settings/ }).click();
  };
  try {
    await page.goto('/');
    await openSettings();
    const card = page.getByRole('region', { name: 'Upstash Box', exact: true });
    const input = card.getByLabel('Upstash Box API key', { exact: true });
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(key);
    await card.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('Using the key saved in Settings.');
    await expect(input).toHaveValue('');
    expect(await (await request.get(endpoint)).json()).toEqual({ available: true, keySource: 'settings', canManage: true });
    const snapshot = await (await request.get('/api/state')).text();
    expect(snapshot).not.toContain(key);
    expect(JSON.parse(snapshot).upstashKey).toEqual({ available: true, keySource: 'settings' });
    await page.reload();
    await openSettings();
    await expect(input).toHaveValue('');
    await expect(card.getByRole('status')).toHaveText('Using the key saved in Settings.');
    await card.screenshot({ path: testInfo.outputPath('upstash-box-key-settings.png') });
    // A command from another client reaches this already-open Settings card through its websocket.
    expect((await request.patch(endpoint, { data: { key: null } })).ok()).toBe(true);
    await expect(card.getByRole('status')).toHaveText('No Box API key configured.');
    await input.fill(key);
    await card.getByRole('button', { name: 'Save key', exact: true }).click();
    await card.getByRole('button', { name: 'Clear saved key', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('No Box API key configured.');
  } finally { await request.patch(endpoint, { data: { key: null } }); }
});

for (const [branch, subOffice] of [['swarm-preview', false], ['main', true]] as const) {
  base(`manager MCP is unavailable on ${subOffice ? 'a marked sub-office on main' : branch}`, async ({ request }) => {
    await withOffice(branch, async (url) => {
      const settingsUrl = url + '/api/settings/mcp';
      const headers = { Authorization: `Bearer ${startupToken}` };
      expect((await request.post(url + '/mcp', { headers })).status()).toBe(404);
      expect(await (await request.get(settingsUrl)).json()).toEqual({
        available: false, enabled: false, tokenSource: null, canManage: false,
      });
      expect((await request.patch(settingsUrl, { data: { token: randomUUID(), enabled: true } })).status()).toBe(404);
      expect(await (await request.get(url + '/api/settings/upstash')).json()).toEqual({ available: false, keySource: null, canManage: false });
      expect((await request.patch(url + '/api/settings/upstash', { data: { key: 'demo-key' } })).status()).toBe(404);
    }, subOffice);
  });
}
