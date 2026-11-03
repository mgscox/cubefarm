import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ManagerMcpSettings, managerTokenDigest } from './managerMcpSettings.ts';

it('keeps the saved credential and switch across startup, with no plaintext token on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cubefarm-mcp-settings-'));
  const file = path.join(dir, 'manager-mcp.json');
  const startup = 'a'.repeat(32);
  const saved = 'b'.repeat(32);
  try {
    const first = new ManagerMcpSettings(file, undefined);
    await first.update({ token: saved });
    expect(first.activeDigest()).toBeUndefined();
    await Promise.all([first.update({ enabled: true }), first.update({ token: saved })]);
    const restored = new ManagerMcpSettings(file, startup);
    expect(restored.activeDigest()).toBe(managerTokenDigest(saved));
    expect(await readFile(file, 'utf8')).not.toContain(saved);

    await restored.update({ enabled: false });
    const disabled = new ManagerMcpSettings(file, startup);
    expect(disabled.activeDigest()).toBeUndefined();
    expect(disabled.view(true)).toMatchObject({ enabled: false, tokenSource: 'settings' });
    await disabled.update({ token: null });
    expect(disabled.activeDigest()).toBeUndefined();
    await disabled.update({ enabled: true });
    expect(disabled.activeDigest()).toBe(managerTokenDigest(startup));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
