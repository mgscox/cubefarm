import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createUpstashProvider } from './upstashProvider.ts';
import { UpstashKeySettings } from './upstashKeySettings.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('uses the saved Box key immediately, persists it privately, and restores startup configuration on clear', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm-upstash-key-'));
  try {
    const startup = 'box-startup-fixture';
    const saved = 'box-settings-fixture';
    const settings = new UpstashKeySettings(home, startup);
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers).get('X-Box-Api-Key')!);
      return Response.json([]);
    });
    const provider = createUpstashProvider(() => ({ UPSTASH_BOX_API_KEY: settings.activeKey() }));

    expect(settings.view(true)).toEqual({ keySource: 'startup', canManage: true });
    await provider.list();
    settings.update(saved);
    expect(settings.view(true)).toEqual({ keySource: 'settings', canManage: true });
    await provider.list();

    const file = path.join(home, 'credentials', 'upstash-box.json');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(new UpstashKeySettings(home, startup).activeKey()).toBe(saved);
    settings.update(null);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await provider.list();
    expect(requests).toEqual([startup, saved, startup]);
    expect(new UpstashKeySettings(home, startup).view(true)).toEqual({ keySource: 'startup', canManage: true });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

it('blocks provider calls if a saved key is unreadable, even with a process fallback', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm-upstash-key-'));
  try {
    const fallback = 'box-fallback-fixture';
    vi.stubEnv('UPSTASH_BOX_API_KEY', fallback);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const folder = path.join(home, 'credentials');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'upstash-box.json'), '{broken', { mode: 0o600 });

    const settings = new UpstashKeySettings(home, fallback);
    expect(settings.view(true)).toEqual({ keySource: 'unreadable', canManage: true });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const provider = createUpstashProvider(() => ({ UPSTASH_BOX_API_KEY: settings.activeKey() }));
    await expect(provider.list()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    settings.update(null);
    expect(settings.activeKey()).toBe(fallback);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

it('keeps startup configuration when no saved credential exists in the configured home', () => {
  const unused = path.join(import.meta.dirname, 'unused-upstash-test-home');
  const settings = new UpstashKeySettings(unused, 'box-fallback-fixture');
  expect(settings.view(true)).toEqual({ keySource: 'startup', canManage: true });
  expect(() => settings.update('box-settings-fixture')).toThrow('outside the repository');
});
