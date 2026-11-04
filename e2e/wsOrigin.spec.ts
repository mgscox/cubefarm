import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

// The office's websockets accept its own page and non-browser clients, and refuse a page from another origin.
function open(url: string, origin?: string) {
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(url, origin ? { origin } : {});
    socket.once('open', () => { socket.close(); resolve(101); });
    socket.once('unexpected-response', (_req, res) => { socket.terminate(); resolve(res.statusCode ?? 0); });
    socket.once('error', () => resolve(0));
  });
}

test('websockets refuse a cross-origin page', async ({ baseURL }) => {
  const { host } = new URL(baseURL!);
  const agent = (await fetch(`${baseURL}/api/state`).then((r) => r.json())).agents[0].id as string;
  for (const path of ['/ws', `/ws/term?agent=${agent}`]) {
    const url = `ws://${host}${path}`;
    expect(await open(url, baseURL), path).toBe(101);
    expect(await open(url), path).toBe(101);
    expect(await open(url, 'https://evil.example'), path).toBe(403);
    expect(await open(url, `http://localhost:${new URL(baseURL!).port}`), path).toBe(403); // not the Host it opened
    expect(await open(url, 'null'), path).toBe(403);
  }
});
