// Read local OS restart signals; never install updates or restart the machine.
import fs from 'node:fs/promises';
import type { RebootStatus } from '../shared/types.ts';
import { run } from './exec.ts';

const unknown = (reason: string): RebootStatus => ({ required: null, reason });

/** Cached macOS updates describe a restart needed to install, not proof of an already-installed pending reboot. */
export function macRestartStatus(output: string): RebootStatus {
  const updates: string[] = [];
  let label = '';
  for (const line of output.split(/\r?\n/)) {
    const found = line.match(/^\s*\*\s*Label:\s*(.+)/);
    if (found) label = found[1].trim();
    if (/\bAction:\s*(?:restart|shut\s*down)\b/i.test(line)) updates.push(label || 'macOS update');
  }
  return updates.length
    ? { required: true, reason: `macOS update requires a restart to install: ${[...new Set(updates)].join(', ')}.` }
    : unknown('macOS does not expose a reliable pending-reboot status; no cached update currently requests a restart.');
}

/** Unsupported, unreadable or indeterminate states remain unknown rather than reporting that a reboot is unnecessary. */
export async function rebootStatus(opts: {
  platform?: string;
  readText?: (file: string) => Promise<string>;
  command?: typeof run;
} = {}): Promise<RebootStatus> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') {
    const read = opts.readText ?? ((file: string) => fs.readFile(file, 'utf8'));
    let failed = false;
    for (const file of ['/run/reboot-required', '/var/run/reboot-required']) {
      try {
        await read(file);
        return { required: true, reason: 'The operating system has requested a reboot.' };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
      }
    }
    return failed ? unknown('The operating system reboot marker could not be read.') : { required: false, reason: null };
  }
  if (platform === 'darwin') {
    try {
      return macRestartStatus(await (opts.command ?? run)('/usr/sbin/softwareupdate', ['--list', '--no-scan'], { timeoutMs: 8000 }));
    } catch {
      return unknown('Cached macOS update status could not be read.');
    }
  }
  return unknown('OS restart detection is unavailable on this platform.');
}
