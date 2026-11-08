import { mkdtemp, readFile, rm, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { expect, it } from 'vitest';
import { UpstashKeySettings, upstashKeySettingsRouter } from './upstashKeySettings.ts';

it.each(['process-env-key', 'dotenv-key', undefined])('saves privately, restores %s on clear, and exposes source only', async (startup) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-box-key-'));
  const file = path.join(home, 'credentials', 'upstash-box.json');
  try {
    const settings = new UpstashKeySettings(home, startup);
    await settings.save('saved-key');
    expect(settings.activeKey()).toBe('saved-key');
    expect(settings.view(true)).toEqual({ available: true, keySource: 'settings', canManage: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ key: 'saved-key' });
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    const restarted = new UpstashKeySettings(home, startup);
    expect(restarted.activeKey()).toBe('saved-key');
    await restarted.save(null);
    expect(restarted.activeKey()).toBe(startup);
    expect(restarted.view(true).keySource).toBe(startup ? 'startup' : null);
    expect(new UpstashKeySettings(home, startup).activeKey()).toBe(startup);
    expect(await readdir(path.dirname(file))).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

it('preserves the active key on disk errors and keeps credentials out of errors', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-box-key-'));
  try {
    const settings = new UpstashKeySettings(home, 'startup');
    await settings.save('previous');
    const file = path.join(home, 'credentials', 'upstash-box.json');
    await rm(file);
    await mkdir(file);
    await expect(settings.save('replacement-secret')).rejects.toThrow();
    expect(settings.activeKey()).toBe('previous');
    expect(await readdir(path.dirname(file))).toEqual(['upstash-box.json']);
    await expect(settings.save(null)).rejects.toThrow();
    expect(settings.activeKey()).toBe('previous');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

it('demo never reads or writes credentials, including an invalid existing file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-box-demo-'));
  try {
    const dir = path.join(home, 'credentials');
    await mkdir(dir);
    const file = path.join(dir, 'upstash-box.json');
    await writeFile(file, 'must not read');
    const settings = new UpstashKeySettings(home, undefined, true);
    await settings.save('fake');
    expect(settings.view(true).keySource).toBe('settings');
    await settings.save(null);
    expect(settings.view(true).keySource).toBeNull();
    expect(await readFile(file, 'utf8')).toBe('must not read');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

it('restricts mutations like Manager MCP and never returns keys or provider errors', async () => {
  const settings = new UpstashKeySettings('unused', 'startup-secret', true);
  const app = express();
  app.use('/settings', upstashKeySettingsRouter(settings, async (key) => {
    if (key === 'fail-secret') throw new Error('provider included fail-secret');
    await settings.save(key);
  }));
  app.use('/unavailable', upstashKeySettingsRouter(null, async () => { throw new Error('unreachable'); }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const raw = (route: string, method: string, body: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const request = http.request(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString(), { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const patch = (body: unknown, headers: Record<string, string> = {}) => raw('/settings', 'PATCH', body, headers);
  try {
    expect((await patch({ key: 'secret' }, { Origin: 'https://outside.example' })).status).toBe(403);
    expect((await patch({ key: 'secret' }, { Host: 'lan.example' })).status).toBe(403);
    expect((await patch({ key: 'secret' }, { 'X-Forwarded-For': '192.0.2.1' })).status).toBe(403);
    const remote = await raw('/settings', 'GET', undefined, { Host: 'lan.example' });
    expect(await remote.json()).toEqual({ available: true, keySource: 'startup', canManage: false });
    for (const body of [{}, { key: '' }, { key: 'bad\nkey' }, { key: 123 }, { key: 'x', extra: 'field' }, { key: 'x'.repeat(1025) }]) expect((await patch(body)).status).toBe(400);
    expect((await patch({ key: 'x' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    const saved = await patch({ key: 'saved-secret' }, { Origin: url });
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(await saved.json()).toEqual({ available: true, keySource: 'settings', canManage: true });
    const failure = await patch({ key: 'fail-secret' });
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain('fail-secret');
    expect(settings.activeKey()).toBe('saved-secret');
    expect((await patch({ key: null })).status).toBe(200);
    expect(settings.activeKey()).toBe('startup-secret');
    expect(await (await fetch(url + '/unavailable')).json()).toEqual({ available: false, keySource: null, canManage: false });
    expect((await fetch(url + '/unavailable', { method: 'PATCH' })).status).toBe(404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
