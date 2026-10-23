import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { maintainOffice } from './cron-office-update.mjs';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });

async function office(autoUpdate = true, folderSync = 'in sync', failBox = false) {
  const calls: string[] = [];
  const state = {
    settings: { autoUpdate }, repos: [{ id: 'mgscox/cubefarm', localPath: '/test/office' }],
    officeUpdate: { state: 'none', behind: 0, detail: null },
    boxes: [{ id: 'm2', name: 'mac-mini-m2', status: 'offline' }, { id: 'vm', name: 'cubefarm', status: 'online' }],
  };
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/state') return void res.end(JSON.stringify(state));
    if (req.url === '/api/repos/mgscox%2Fcubefarm/sync-folder') {
      if (folderSync === '1 behind') { state.officeUpdate.state = 'draining'; state.officeUpdate.behind = 1; }
      return void res.end(JSON.stringify({ folderSync }));
    }
    const box = state.boxes.find((b) => req.url === `/api/boxes/${b.id}/check`);
    if (box) {
      if (failBox && box.id === 'm2') { res.statusCode = 503; return void res.end('{}'); }
      box.status = 'online'; return void res.end(JSON.stringify(box));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe('cron office maintenance', () => {
  it('uses the configured own folder and existing coordinator, then verifies refreshed workers', async () => {
    const fake = await office(true, '1 behind');
    const result = await maintainOffice({ url: fake.url });
    expect(fake.calls).toEqual(['GET /api/state', 'POST /api/repos/mgscox%2Fcubefarm/sync-folder', 'POST /api/boxes/m2/check', 'POST /api/boxes/vm/check', 'GET /api/state']);
    expect(result.errors).toEqual([]);
    expect(result.office).toMatchObject({ state: 'draining', behind: 1 });
    expect(result.boxes.every((b) => b.status === 'online')).toBe(true);
  });
  it('respects disabled automatic upgrades while refreshing worker reports', async () => {
    const fake = await office(false);
    expect((await maintainOffice({ url: fake.url })).automaticUpdates).toBe(false);
    expect(fake.calls.some((c) => c.includes('sync-folder'))).toBe(false);
    expect(fake.calls.some((c) => c.includes('/boxes/'))).toBe(true);
  });
  it('reports refusal and worker errors while checking the remaining worker', async () => {
    const fake = await office(true, '1 behind: local changes', true);
    const result = await maintainOffice({ url: fake.url });
    expect(result.errors).toContain('1 behind: local changes');
    expect(result.errors.some((e) => e.includes('HTTP 503'))).toBe(true);
    expect(fake.calls).toContain('POST /api/boxes/vm/check');
  });
  it('reports a missing office floor instead of updating an arbitrary repo', async () => {
    const fake = await office();
    const result = await maintainOffice({ url: fake.url, repo: 'other/repo' });
    expect(result.errors).toContain('Office repository other/repo has no configured local folder');
    expect(fake.calls.some((c) => c.includes('sync-folder'))).toBe(false);
  });
  it('survives a transient connection loss during a supervised office restart', async () => {
    const fake = await office(true, '1 behind');
    let disconnected = false;
    const request: typeof fetch = async (input, init) => {
      if (!disconnected && String(input).includes('sync-folder')) {
        disconnected = true;
        throw new TypeError('fetch failed');
      }
      return fetch(input, init);
    };
    expect((await maintainOffice({ url: fake.url, request })).errors).toEqual([]);
    expect(disconnected).toBe(true);
    expect(fake.calls.filter((c) => c.includes('sync-folder'))).toHaveLength(1);
  });
});
