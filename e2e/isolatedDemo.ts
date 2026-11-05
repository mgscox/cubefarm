import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test as sharedTest, expect } from '@playwright/test';

// Autonomous research must not inherit queued briefs or elapsed boot time from other tests.
// Boot closed on an OS-assigned port; the workflow explicitly reopens its own demo office.
export const test = sharedTest.extend({
  baseURL: async ({}, use, testInfo) => {
    const home = testInfo.outputPath('isolated-office');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'demo-state.json'), JSON.stringify({ officeHeld: true }));
    const proc = spawn(process.execPath, ['bin/cubefarm.js', '--demo', '--no-open', '--port', '0'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, SWARM_HOME: home, SWARM_HOST: '127.0.0.1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    let output = '';
    let error: Error | undefined;
    proc.stdout.on('data', (data) => { output += String(data); });
    proc.stderr.on('data', (data) => { output += String(data); });
    proc.on('error', (err) => { error = err; });
    try {
      await expect.poll(() => {
        if (error) throw error;
        if (proc.exitCode !== null) throw new Error(`Isolated demo exited: ${output}`);
        return output;
      }).toMatch(new RegExp('cubefarm on http://localhost:[0-9]+'));
      const port = output.match(new RegExp('cubefarm on http://localhost:([0-9]+)'))![1];
      const url = `http://127.0.0.1:${port}`;
      expect((await fetch(`${url}/api/state`).then((r) => r.json())).demo).toBe(true);
      await use(url);
    } finally {
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-proc.pid, 'SIGTERM');
        await exited;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  },
});
