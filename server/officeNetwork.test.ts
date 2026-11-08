import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMessage, browserUrl, localAddress, localUrl, officeHost } from '../bin/officeNetwork.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('office bind configuration', () => {
  it('defaults to IPv4 loopback, including an empty override', () => {
    expect(officeHost({})).toBe('127.0.0.1');
    expect(officeHost({ SWARM_HOST: '' })).toBe('127.0.0.1');
    expect(bindMessage(officeHost({}), 4317)).toContain('127.0.0.1:4317 (loopback only)');
  });

  it('trims SWARM_HOST and accepts loopback, wildcards and a single IP', () => {
    for (const [value, host] of [
      ['127.0.0.1', '127.0.0.1'], [' localhost ', 'localhost'], ['::1', '::1'], ['0.0.0.0', '0.0.0.0'], [' :: ', '::'],
      ['[::]', '::'], ['192.168.1.20', '192.168.1.20'], ['\t10.0.0.5\n', '10.0.0.5'], ['[fd00::5]', 'fd00::5'], ['   ', '127.0.0.1'],
    ]) expect(officeHost({ SWARM_HOST: value })).toBe(host);
  });

  it.each(['mini.local', '0.0.0.0:4317', 'http://0.0.0.0', '192.168.1', '0.0.0.0 192.168.1.20', 'fe80::1%eth0'])('refuses %j with a clear message', (value) => {
    expect(() => officeHost({ SWARM_HOST: value })).toThrow(/isn't an address to listen on.*0\.0\.0\.0/);
  });

  it('calls back on loopback for a wildcard and on the address itself for a single IP', () => {
    expect(localAddress('0.0.0.0')).toBe('127.0.0.1');
    expect(localAddress('::')).toBe('127.0.0.1');
    expect(localUrl('127.0.0.1', 4317)).toBe('http://127.0.0.1:4317');
    expect(localUrl('::', 4317)).toBe('http://127.0.0.1:4317');
    expect(localUrl('192.168.1.20', 4317)).toBe('http://192.168.1.20:4317');
    expect(localUrl('::1', 4317, 'ws')).toBe('ws://[::1]:4317');
    expect(browserUrl('0.0.0.0', 4317)).toBe('http://localhost:4317');
    expect(browserUrl('192.168.1.20', 4317)).toBe('http://192.168.1.20:4317');
  });

  it.each(['127.0.0.1', '0.0.0.0', '::'])('uses %s for both server and Vite, keeping proxies local', async (host) => {
    vi.stubEnv('SWARM_HOST', host);
    vi.stubEnv('SWARM_PORT', '5324');
    vi.resetModules();
    const { HOST } = await import('./config.ts');
    const { default: vite } = await import('../vite.config.ts');
    expect(HOST).toBe(host);
    expect(vite.server?.host).toBe(host);
    expect(vite.server?.proxy).toEqual({
      '/api/settings/mcp': { target: 'http://127.0.0.1:5324', xfwd: true },
      '/api/settings/upstash': { target: 'http://127.0.0.1:5324', xfwd: true },
      '/api': 'http://127.0.0.1:5324',
      '/ws': { target: 'ws://127.0.0.1:5324', ws: true },
    });
  });

  it('binds Vite to a single IP and proxies to the server on that IP', async () => {
    vi.stubEnv('SWARM_HOST', ' 192.168.1.20 ');
    vi.stubEnv('SWARM_PORT', '5324');
    vi.resetModules();
    const { HOST } = await import('./config.ts');
    const { default: vite } = await import('../vite.config.ts');
    expect(HOST).toBe('192.168.1.20');
    expect(vite.server?.host).toBe('192.168.1.20');
    expect(vite.server?.proxy).toEqual({
      '/api/settings/mcp': { target: 'http://192.168.1.20:5324', xfwd: true },
      '/api/settings/upstash': { target: 'http://192.168.1.20:5324', xfwd: true },
      '/api': 'http://192.168.1.20:5324',
      '/ws': { target: 'ws://192.168.1.20:5324', ws: true },
    });
    expect(bindMessage(HOST, 5324)).toContain('remote: http://192.168.1.20:5324');
  });

  it('proxies every localhost-only settings route with X-Forwarded-For and its own Host', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const routers = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => readFileSync(path.join(dir, file), 'utf8'))
      .filter((source) => /canManageLocalSettings\(req\)/.test(source))
      .flatMap((source) => [...source.matchAll(/export function (\w+Router)\(/g)].map((match) => match[1]));
    const index = readFileSync(path.join(dir, 'index.ts'), 'utf8');
    const gated = routers.flatMap((name) => [...index.matchAll(new RegExp(`app\\.use\\('(/api/[^']+)', ${name}\\(`, 'g'))].map((match) => match[1]));
    expect(gated).toEqual(expect.arrayContaining(['/api/settings/mcp', '/api/settings/upstash']));
    vi.stubEnv('SWARM_HOST', '0.0.0.0');
    vi.resetModules();
    const { default: vite } = await import('../vite.config.ts');
    for (const route of gated) expect(vite.server?.proxy?.[route], route).toEqual({ target: expect.any(String), xfwd: true });
  });

  it('says loopback only for every loopback address', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) expect(bindMessage(host, 4317)).toContain('(loopback only)');
  });

  it('advertises a LAN IP URL and access model, never a wildcard URL', () => {
    const message = bindMessage('0.0.0.0', 5324);
    expect(message).toContain('Listening on 0.0.0.0:5324');
    expect(message).toContain('http://<office-machine-LAN-IP>:5324');
    expect(message).toContain('manager API and terminals have no manager login');
    expect(message).not.toContain('http://0.0.0.0');
  });
});
