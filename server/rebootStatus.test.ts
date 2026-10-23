import { describe, expect, it } from 'vitest';
import { macRestartStatus, rebootStatus } from './rebootStatus.ts';

const absent = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

describe('OS reboot notices', () => {
  it('reports the Ubuntu reboot marker even when it has no content', async () => {
    expect(await rebootStatus({ platform: 'linux', readText: async () => '' })).toEqual({ required: true, reason: 'The operating system has requested a reboot.' });
  });
  it('only reports no Linux reboot when both markers are absent', async () => {
    expect(await rebootStatus({ platform: 'linux', readText: absent })).toEqual({ required: false, reason: null });
    expect((await rebootStatus({ platform: 'linux', readText: async () => { throw new Error('permission denied'); } })).required).toBeNull();
  });
  it('reports macOS updates requiring a restart without calling them already installed', () => {
    const text = '* Label: macOS Tahoe 27.1-26B22\n Title: macOS Tahoe 27.1, Version: 27.1, Size: 123KiB, Recommended: YES, Action: restart,\n* Label: Safari-27.1\n Title: Safari, Version: 27.1, Recommended: YES,';
    expect(macRestartStatus(text)).toEqual({ required: true, reason: 'macOS update requires a restart to install: macOS Tahoe 27.1-26B22.' });
    expect(macRestartStatus(text.replace('Action: restart', 'Action: shut down')).required).toBe(true);
  });
  it('does not claim a definitive macOS pending reboot verdict from an empty update list', () => {
    expect(macRestartStatus('No new software available.').required).toBeNull();
  });
  it('only reads cached macOS update state and bounds the command', async () => {
    const calls: unknown[] = [];
    await rebootStatus({ platform: 'darwin', command: async (...args) => { calls.push(args); return 'No new software available.'; } });
    expect(calls).toEqual([['/usr/sbin/softwareupdate', ['--list', '--no-scan'], { timeoutMs: 8000 }]]);
  });
  it('keeps unsupported systems and failed probes unknown', async () => {
    expect((await rebootStatus({ platform: 'win32' })).required).toBeNull();
    expect((await rebootStatus({ platform: 'darwin', command: async () => { throw new Error('timeout'); } })).required).toBeNull();
  });
});
