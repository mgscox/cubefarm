// Bind configuration is separate from the local URLs used by browsers, probes and agent callbacks.
import net from 'node:net';

const WILDCARDS = ['0.0.0.0', '::'];

/**
 * SWARM_HOST as an address to listen on: trimmed, IPv6 brackets dropped, 127.0.0.1 when unset. Only an IP address or
 * localhost is accepted (no zone ids: they don't fit in a callback URL); anything else throws a message to show.
 */
export function officeHost(env = process.env) {
  const raw = env.SWARM_HOST ?? '';
  const host = raw.trim().replace(/^\[(.*)\]$/, '$1');
  if (!host) return '127.0.0.1';
  if (host.toLowerCase() === 'localhost') return 'localhost';
  if (net.isIP(host) && !host.includes('%')) return host;
  throw new Error(`SWARM_HOST="${raw}" isn't an address to listen on. Use 0.0.0.0 (every IPv4 network), :: or one of this machine's IP addresses, or unset it for 127.0.0.1.`);
}

/** The address this machine reaches an office listening on `host` at: loopback for a wildcard, else that address. */
export function localAddress(host) {
  return WILDCARDS.includes(host) ? '127.0.0.1' : host;
}

/** The office's URL from this machine (agent callbacks, probes, proxies), with IPv6 in brackets. */
export function localUrl(host, port, scheme = 'http') {
  const address = localAddress(host);
  return `${scheme}://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/** The URL to show or open in this machine's browser: localhost when the office is on 127.0.0.1. */
export function browserUrl(host, port) {
  return localAddress(host) === '127.0.0.1' ? `http://localhost:${port}` : localUrl(host, port);
}

const isLoopback = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');

export function bindMessage(host, port) {
  const bind = `Listening on ${host}:${port}`;
  if (isLoopback(host)) return `${bind} (loopback only)`;
  const remote = WILDCARDS.includes(host) ? `http://<office-machine-LAN-IP>:${port}` : localUrl(host, port);
  return `${bind} · remote: ${remote} · trusted LAN only: manager API and terminals have no manager login`;
}
