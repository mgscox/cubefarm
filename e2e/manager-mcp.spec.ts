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
    expect(tools).toEqual(expect.arrayContaining(['decide_proposal', 'get_office_status', 'list_proposals', 'read_phone', 'send_message']));
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

test('a manager can operate fleet, desks, floors and office lifecycle using only MCP', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const client = new Client({ name: 'demo-console-manager', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${startupToken}` } },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent;
    };
    const state = async () => await call('get_office_snapshot') as unknown as WorldSnapshot;
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_boxes', 'add_box', 'remove_box', 'check_box', 'set_fleet_capacity',
      'stop_agent', 'reset_agent', 'assign_agent', 'message_agent', 'dismiss_agent', 'get_agent_screen',
      'add_floor', 'connect_floor', 'update_floor', 'remove_floor', 'sync_floor', 'plan_floor', 'onboard_floor',
      'merge_pull', 'close_pull', 'run_qa', 'approve_prototype', 'revise_prototype',
      'close_office', 'reopen_office', 'update_office', 'update_settings',
      'retry_telegram', 'skip_telegram', 'mark_phone_read', 'send_ceo_message', 'request_ceo_review',
      'create_idea', 'reply_idea', 'retry_idea', 'reject_request', 'retry_publication',
    ]));
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(20);
    for (const name of ['remove_box', 'remove_floor', 'dismiss_agent', 'close_office', 'merge_pull']) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(true);
    }
    expect((await client.callTool({ name: 'merge_pull', arguments: { repoId: 'demo/x', number: -1 } })).isError).toBe(true);
    expect((await client.callTool({ name: 'update_settings', arguments: { patch: { hiring: 'invalid' } } })).isError).toBe(true);
    const missing = await client.callTool({ name: 'remove_box', arguments: { boxId: 'missing' } });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: 'text', text: 'No such box' }]);
    expect((await client.callTool({ name: 'get_agent_screen', arguments: { agentId: 'missing' } })).isError).toBe(true);
    const failed = await client.callTool({ name: 'connect_floor', arguments: { fullName: 'missing/repo' } });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: 'CubeFarm could not confirm the command. Check the office before sending new work.' }]);

    await call('update_settings', { patch: { ceoHeartbeatMin: 0, hiring: 'approve' } });
    for (const floor of (await state()).repos) await call('update_floor', { repoId: floor.id, patch: { autoMerge: false } });
    const box = await call('add_box', { name: 'MCP worker', destination: 'mcp-demo-worker' }) as { id: string };
    await expect.poll(async () => (await state()).boxes.find((b) => b.id === box.id)?.status).toBe('online');
    expect(await call('check_box', { boxId: box.id })).toMatchObject({ id: box.id });
    await call('set_fleet_capacity', { machineId: box.id, capacity: 'fixed' });
    expect(await call('list_boxes')).toMatchObject({ boxes: expect.arrayContaining([expect.objectContaining({ id: box.id, capacity: 'fixed' })]) });
    await call('remove_box', { boxId: box.id });
    expect((await state()).boxes.some((b) => b.id === box.id)).toBe(false);

    const floor = await call('add_floor', { name: 'mcp-new-floor', mission: 'MCP parity test' }) as { id: string };
    expect((await state()).repos.some((r) => r.id === floor.id)).toBe(true);
    expect(await call('update_floor', { repoId: floor.id, patch: { autoAssign: false, autoMerge: false } })).toMatchObject({ autoAssign: false, autoMerge: false });
    await expect.poll(async () => (await state()).repos.find((r) => r.id === floor.id)?.cloneStatus).toBe('ready');
    await expect.poll(async () => (await state()).agents.some((a) => a.role === 'dev' && a.status === 'working')).toBe(true);
    const agent = (await state()).agents.find((a) => a.role === 'dev' && a.status === 'working')!;
    await call('stop_agent', { agentId: agent.id });
    expect((await state()).agents.find((a) => a.id === agent.id)?.status).not.toBe('working');
    await call('reset_agent', { agentId: agent.id });
    await call('dismiss_agent', { agentId: agent.id });
    expect((await state()).agents.some((a) => a.id === agent.id)).toBe(false);
    await call('remove_floor', { repoId: floor.id });
    expect((await state()).repos.some((r) => r.id === floor.id)).toBe(false);
    expect(await call('connect_floor', { fullName: floor.id })).toMatchObject({ id: floor.id });
    await call('remove_floor', { repoId: floor.id });

    await expect.poll(async () => {
      const agent = (await state()).agents.find((a) => a.screenshotAt !== null);
      if (!agent) return [];
      const screen = await client.callTool({ name: 'get_agent_screen', arguments: { agentId: agent.id } });
      return screen.isError ? [] : screen.content;
    }, { timeout: 90_000, intervals: [100, 250, 500] }).toEqual([
      expect.objectContaining({ type: 'image', data: expect.any(String), mimeType: 'image/svg+xml' }),
    ]);
    await expect.poll(async () => (await state()).qa.some((q) => q.status === 'passed' && q.checks.length > 0), { timeout: 180_000 }).toBe(true);
    const reviewed = (await state()).qa.find((q) => q.status === 'passed' && q.checks.length > 0)!;
    await call('merge_pull', { repoId: reviewed.repoId, number: reviewed.prNumber });
    expect((await state()).repos.find((r) => r.id === reviewed.repoId)?.pulls.find((p) => p.number === reviewed.prNumber)?.state).toBe('MERGED');

    const idea = await call('create_idea', { description: 'MCP idea intake' }) as { id: string };
    expect((await state()).ideas).toContainEqual(expect.objectContaining({ id: idea.id, description: 'MCP idea intake' }));
    await call('mark_phone_read');
    expect((await state()).phoneReadAt).toBeGreaterThan(0);
    const message = { text: 'MCP CEO message alias', requestId: randomUUID() };
    const receipt = await call('send_ceo_message', message);
    expect(await call('send_message', message)).toEqual(receipt);
    expect(await call('close_office')).toMatchObject({ state: expect.stringMatching(/closing|closed/) });
    for (const agent of (await state()).agents) await call('stop_agent', { agentId: agent.id });
    await expect.poll(async () => (await state()).officeLifecycle.state).toBe('closed');
    expect(await call('reopen_office')).toMatchObject({ state: 'open' });
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
    }, subOffice);
  });
}
