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
      '/api': { target: 'http://127.0.0.1:5324', xfwd: true },
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
      '/api': { target: 'http://192.168.1.20:5324', xfwd: true },
      '/ws': { target: 'ws://192.168.1.20:5324', ws: true },
    });
    expect(bindMessage(HOST, 5324)).toContain('remote: http://192.168.1.20:5324');
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
