#!/usr/bin/env node
// Cron entrypoint: refresh the office's own folder and fleet reports; its existing scheduler handles safe upgrades.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Refreshes state without overriding Automatic updates, Later, or failed-update holds; the office stays closed during upgrades. */
export async function maintainOffice({ url = 'http://127.0.0.1:4317', repo = 'mgscox/cubefarm', request = fetch } = {}) {
  const expires = Date.now() + 12 * 60_000;
  const call = async (route, method = 'GET') => {
    if (Date.now() >= expires) throw new Error('Maintenance exceeded its 12-minute budget');
    const deadline = Math.min(expires, Date.now() + 30000);
    for (;;) {
      try {
        const response = await request(new URL(route, url), { method, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
        return await response.json();
      } catch (err) {
        // These requests are idempotent checks. Retry a lost connection while the supervisor restarts the office.
        if (!(err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError') || Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const state = await call('/api/state');
  const errors = [];
  let folder = null;
  let syncError = null;
  if (state.settings?.autoUpdate === true) {
    const own = state.repos?.find((r) => r.id === repo);
    if (!own?.localPath) errors.push(`Office repository ${repo} has no configured local folder`);
    else {
      try {
        folder = await call(`/api/repos/${encodeURIComponent(own.id)}/sync-folder`, 'POST');
        const status = folder?.folderSync;
        if (typeof status === 'string' && /failed|diverged|local changes/i.test(status)) errors.push(status);
      } catch (err) { syncError = err.message; }
    }
  }
  for (const box of state.boxes ?? []) {
    try { await call(`/api/boxes/${encodeURIComponent(box.id)}/check`, 'POST'); }
    catch (err) { errors.push(`${box.name}: ${err.message}`); }
  }
  const after = await call('/api/state');
  if (syncError && (!state.officeCommit || after.officeCommit === state.officeCommit)) errors.push(syncError);
  if (after.officeUpdate?.state === 'failed') errors.push(after.officeUpdate.detail || 'The office upgrade failed');
  for (const box of after.boxes ?? []) {
    if (box.status !== 'online' || box.sync?.failed) errors.push(`${box.name}: ${box.error || box.sync?.text || box.status}`);
  }
  return { automaticUpdates: state.settings?.autoUpdate === true, folder, office: after.officeUpdate ?? null,
    boxes: (after.boxes ?? []).map((b) => ({ name: b.name, status: b.status, sync: b.sync ?? null })), errors };
}

async function main() {
  const result = await maintainOffice({ url: process.env.CUBEFARM_OFFICE_URL, repo: process.env.CUBEFARM_OFFICE_REPO });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`CubeFarm maintenance: ${err.message}`); process.exitCode = 1; });
}
