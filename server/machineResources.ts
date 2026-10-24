// Read the machine running this process (a VM reports its guest allocation). Never query a physical host remotely.
import os from 'node:os';
import fs from 'node:fs/promises';
import type { MachineSample } from '../shared/types.ts';
import { run } from './exec.ts';

type Cpu = Pick<os.CpuInfo, 'times'>;

export function cpuUsage(before: Cpu[], after: Cpu[]): number | null {
  if (!before.length || before.length !== after.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < after.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) {
      const delta = after[i].times[key] - before[i].times[key];
      if (delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : null;
}

export function availableMemory(text: string): number | null {
  const match = text.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m);
  return match ? Number(match[1]) * 1024 : null;
}

export function pressureAverage(text: string): number | null {
  const match = text.match(/^some\s+.*?\bavg60=(\d+(?:\.\d+)?)\b/m);
  const n = match ? Number(match[1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function runnableThreads(text: string): number | null {
  const lines = text.trimEnd().split(/\r?\n/);
  // macOS -M forces its own fixed-width format, including indented continuation rows for other threads.
  if (!lines[0].includes('STAT') || lines.length < 2) return null;
  const rows = lines.slice(1).filter((s) => s.trim());
  // Values over 99.9% widen the CPU column. Match neighbouring fields instead of relying on a character offset.
  const states = rows.map((s) => s.match(/(?:^|\s)\d+(?:\.\d+)?\s+([RUSTIZ][\w+<>-]*)\s+-?\d+[A-Z]?\s+\d+:\d/)?.[1]).filter((s): s is string => !!s);
  if (!states.length || states.length < rows.length * 0.95) return null;
  // ps observes its own runnable thread too. Do not count that observation as demand from other work.
  return Math.max(0, states.filter((s) => s.startsWith('R')).length - 1);
}

export function createResourceReader(opts: {
  platform?: string;
  cpus?: () => Cpu[];
  totalmem?: () => number;
  freemem?: () => number;
  loadavg?: () => number[];
  readText?: (file: string) => Promise<string>;
  command?: typeof run;
} = {}): () => Promise<MachineSample> {
  const platform = opts.platform ?? process.platform;
  const cpus = opts.cpus ?? os.cpus;
  let previous = cpus();
  const read = opts.readText ?? ((file) => fs.readFile(file, 'utf8'));
  return async () => {
    const now = cpus();
    const cpuPercent = cpuUsage(previous, now);
    previous = now;
    const total = (opts.totalmem ?? os.totalmem)();
    let available: number | null = null;
    let memoryPressure: MachineSample['memoryPressure'] = null;
    let cpuStall: number | null = null;
    let memoryStall: number | null = null;
    let ioStall: number | null = null;
    let runnable: number | null = null;
    if (platform === 'linux') {
      const results = await Promise.all(['/proc/meminfo', '/proc/pressure/cpu', '/proc/pressure/memory', '/proc/pressure/io'].map((file) => read(file).catch(() => '')));
      available = availableMemory(results[0]);
      cpuStall = pressureAverage(results[1]);
      memoryStall = pressureAverage(results[2]);
      ioStall = pressureAverage(results[3]);
    } else if (platform === 'darwin') {
      // Free pages exclude reclaimable caches on macOS: use its pressure signal rather than flagging cached RAM as full.
      const command = opts.command ?? run;
      const [level, threads] = await Promise.all([
        command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 2000 }).catch(() => ''),
        command('/bin/ps', ['-A', '-M'], { timeoutMs: 2000 }).catch(() => ''),
      ]);
      memoryPressure = ({ '1': 'normal', '2': 'warning', '4': 'critical' } as const)[level.trim() as '1' | '2' | '4'] ?? null;
      runnable = runnableThreads(threads);
    } else if (platform === 'win32') {
      available = (opts.freemem ?? os.freemem)();
    }
    return { at: Date.now(), cpus: now.length, cpuPercent, runnableThreads: runnable, load1: platform === 'win32' ? null : (opts.loadavg ?? os.loadavg)()[0], memoryTotal: total, memoryAvailable: available === null ? null : Math.max(0, Math.min(total, available)), memoryPressure, cpuStall, memoryStall, ioStall };
  };
}
