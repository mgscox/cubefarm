import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { allowUpgrade, officeHostnames } from './wsOrigin.ts';

const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) }) as NetworkInterfaceInfo;
const interfaces = {
  lo: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
  eth0: [iface('192.168.1.20', 'IPv4'), iface('fe80::1%eth0', 'IPv6'), iface('fd00::20', 'IPv6')],
};

describe('officeHostnames', () => {
  it('adds nothing beyond loopback on a loopback bind', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) expect(officeHostnames(host, interfaces, 'box').size).toBe(0);
  });

  it('adds LAN addresses and the hostname on a wildcard bind', () => {
    expect([...officeHostnames('0.0.0.0', interfaces, 'Office-PC')].sort()).toEqual(['127.0.0.1', '192.168.1.20', '[::1]', '[fd00::20]', 'office-pc']);
  });

  it('adds a single bound address', () => {
    expect(officeHostnames('10.0.0.5', {}, '')).toEqual(new Set(['10.0.0.5']));
  });
});

describe('allowUpgrade', () => {
  const local = officeHostnames('127.0.0.1', interfaces, 'office-pc');
  const lan = officeHostnames('0.0.0.0', interfaces, 'office-pc');

  it('accepts the office page on the port it was opened on', () => {
    expect(allowUpgrade('http://localhost:4317', 'localhost:4317', local)).toBe(true);
    expect(allowUpgrade('http://127.0.0.1:4317', '127.0.0.1:4317', local)).toBe(true);
    expect(allowUpgrade('http://[::1]:4317', '[::1]:4317', local)).toBe(true);
    expect(allowUpgrade('http://localhost:5317', 'localhost:5317', local)).toBe(true); // through Vite in dev
  });

  it('refuses localhost and 127.0.0.1 mixed, as the browser never sends that', () => {
    expect(allowUpgrade('http://localhost:4317', '127.0.0.1:4317', local)).toBe(false);
  });

  it('refuses another local port, such as a floor preview', () => {
    expect(allowUpgrade('http://localhost:6301', 'localhost:4317', local)).toBe(false);
  });

  it('accepts LAN addresses only with SWARM_HOST set', () => {
    expect(allowUpgrade('http://192.168.1.20:4317', '192.168.1.20:4317', lan)).toBe(true);
    expect(allowUpgrade('http://[fd00::20]:5317', '[fd00::20]:5317', lan)).toBe(true);
    expect(allowUpgrade('http://Office-PC:4317', 'office-pc:4317', lan)).toBe(true);
    expect(allowUpgrade('http://192.168.1.20:4317', '192.168.1.20:4317', local)).toBe(false);
  });

  it('refuses foreign sites and DNS rebinding', () => {
    expect(allowUpgrade('https://evil.example', 'localhost:4317', local)).toBe(false);
    expect(allowUpgrade('http://evil.example:4317', 'evil.example:4317', lan)).toBe(false);
    expect(allowUpgrade('http://192.168.1.99:4317', '192.168.1.20:4317', lan)).toBe(false);
  });

  it('refuses null and malformed origins', () => {
    expect(allowUpgrade('null', 'localhost:4317', local)).toBe(false);
    expect(allowUpgrade('file:///tmp/a.html', 'localhost:4317', local)).toBe(false);
    expect(allowUpgrade('http://localhost:4317', undefined, local)).toBe(false);
  });

  it('accepts a missing Origin (a non-browser client)', () => {
    expect(allowUpgrade(undefined, 'localhost:4317', local)).toBe(true);
    expect(allowUpgrade(undefined, undefined, local)).toBe(true);
  });
});
