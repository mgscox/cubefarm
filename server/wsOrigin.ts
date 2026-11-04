// Which browser pages may open the office's websockets (/ws, /ws/term). /ws/term types into agents' unsandboxed
// CLIs, so a page from another site must not connect: cross-site WebSocket hijacking. A transport check, not a hook.
import type { NetworkInterfaceInfo } from 'node:os';

const loopbackHost = (name: string) => name === 'localhost' || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name);
const urlHost = (address: string) => (address.includes(':') ? `[${address}]` : address).toLowerCase();

/**
 * The hostnames beyond loopback a browser may use to reach the office: none on a loopback `SWARM_HOST` (the
 * default); otherwise the bound address, the machine's own interface addresses (LAN IPs) and its hostname.
 */
export function officeHostnames(bindHost: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, hostname: string) {
  const names = new Set<string>();
  if (loopbackHost(urlHost(bindHost))) return names;
  if (bindHost !== '0.0.0.0' && bindHost !== '::') names.add(urlHost(bindHost));
  for (const a of Object.values(interfaces).flat()) if (a && !a.address.includes('%')) names.add(urlHost(a.address));
  if (hostname) names.add(hostname.toLowerCase());
  return names;
}

/**
 * Whether to accept a websocket upgrade. The page's `Origin` must be the address the request came in on (`Host`:
 * the server's port, or Vite's when it proxies in dev), under a loopback name or one of `hostnames`. That rejects other
 * sites, DNS rebinding (a foreign hostname) and other local pages such as floor previews (another port).
 * A missing `Origin` is accepted: browsers always send one on a websocket upgrade, so it's a non-browser client,
 * which could send any `Origin` it liked anyway.
 */
export function allowUpgrade(origin: string | undefined, host: string | undefined, hostnames: Set<string>) {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, file pages) and anything else unparseable
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.host !== host?.toLowerCase()) return false;
  return loopbackHost(url.hostname) || hostnames.has(url.hostname);
}
