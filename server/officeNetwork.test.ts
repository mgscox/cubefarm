import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMessage, officeHost } from '../bin/officeNetwork.js';

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

  it.each(['127.0.0.1', '0.0.0.0'])('uses %s for both server and Vite, keeping proxies local', async (host) => {
    vi.stubEnv('SWARM_HOST', host);
    vi.stubEnv('SWARM_PORT', '5324');
    vi.resetModules();
    const { HOST } = await import('./config.ts');
    const { default: vite } = await import('../vite.config.ts');
    expect(HOST).toBe(host);
    expect(vite.server?.host).toBe(host);
    expect(vite.server?.proxy).toEqual({
      '/api': 'http://127.0.0.1:5324',
      '/ws': { target: 'ws://127.0.0.1:5324', ws: true },
    });
  });

  it('advertises a LAN IP URL and access model, never a wildcard URL', () => {
    const message = bindMessage('0.0.0.0', 5324);
    expect(message).toContain('Listening on 0.0.0.0:5324');
    expect(message).toContain('http://<office-machine-LAN-IP>:5324');
    expect(message).toContain('manager API and terminals have no manager login');
    expect(message).not.toContain('http://0.0.0.0');
  });
});
