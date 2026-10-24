// Interpret sustained resource contention separately from utilisation. No scheduling or host changes happen here.
import type { MachineSample, MachineTelemetry } from '../shared/types.ts';

export const RESOURCE_INTERVAL_MS = 5000;
export const RESOURCE_STALE_MS = 20_000;

export function machineHealth(history: MachineSample[]): MachineTelemetry {
  const sample = history.at(-1)!;
  const observedSeconds = Math.min(60, Math.max(0, (sample.at - history[0].at) / 1000));
  const cpus = history.map((s) => s.cpuPercent).filter((n): n is number => n !== null);
  const cpuAveragePercent = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  const sustained = observedSeconds >= 60;
  const constraints: MachineTelemetry['constraints'] = [];
  const evidence: string[] = [];
  const cpuBusy = cpuAveragePercent !== null && cpuAveragePercent >= 85;
  const queued = sample.load1 !== null && sample.load1 > sample.cpus * 1.1;
  const runnable = history.every((s) => s.runnableThreads != null) ? history.reduce((sum, s) => sum + s.runnableThreads!, 0) / history.length : null;
  const cpuWaiting = sample.cpuStall !== null ? sample.cpuStall >= 20 : sustained && (runnable !== null
    ? runnable > sample.cpus * 1.1
    : queued && sample.ioStall !== null && sample.ioStall < 10);
  if (cpuBusy && cpuWaiting) {
    constraints.push('cpu');
    evidence.push(`CPU use averaged ${Math.round(cpuAveragePercent)}%; runnable work is waiting for CPU time.`);
  }
  if (sample.memoryPressure === 'critical' || sample.memoryPressure === 'warning' || (sample.memoryStall ?? 0) >= 5) {
    constraints.push('memory');
    evidence.push(sample.memoryPressure ? `The OS reports ${sample.memoryPressure} memory pressure.` : `Tasks spent ${sample.memoryStall!.toFixed(1)}% of the last minute stalled on memory.`);
  }
  if ((sample.ioStall ?? 0) >= 10) {
    constraints.push('io');
    evidence.push(`Tasks spent ${sample.ioStall!.toFixed(1)}% of the last minute waiting for I/O.`);
  }
  const base = { sample, observedSeconds, cpuAveragePercent, constraints };
  if (constraints.length) return { ...base, status: 'constrained', summary: `${constraints.map((c) => ({ cpu: 'CPU', memory: 'Memory', io: 'I/O' })[c]).join(' + ')} constrained`, evidence: evidence.join(' ') };
  if (cpuWaiting) return { ...base, status: 'busy', summary: 'CPU waits detected; cause unconfirmed', evidence: 'Work is waiting for CPU time despite lower overall utilisation. CPU limits or processor affinity may be restricting usable capacity.' };
  if (!sustained) return { ...base, status: 'observing', summary: 'Checking for sustained pressure', evidence: 'Building a one-minute baseline; brief bursts do not establish overload.' };
  const lowMemory = history.every((s) => s.memoryAvailable !== null && s.memoryTotal > 0 && s.memoryAvailable / s.memoryTotal < 0.1);
  if (cpuBusy || lowMemory) return { ...base, status: 'busy', summary: lowMemory ? 'Low memory headroom' : 'Busy, without confirmed CPU contention', evidence: lowMemory ? 'Less than 10% RAM has been available throughout the observation window. This alone does not prove memory contention.' : 'CPU use is high, but there is no confirmed queue waiting for CPU time.' };
  if (cpuAveragePercent === null || (sample.memoryAvailable === null && sample.memoryPressure === null)) return { ...base, status: 'unknown', summary: 'Insufficient resource evidence', evidence: 'CPU or memory pressure could not be measured reliably on this machine.' };
  return { ...base, status: 'healthy', summary: 'No sustained pressure detected', evidence: `No CPU or memory contention detected in the last minute.${sample.ioStall === null ? ' I/O pressure is unavailable on this OS.' : ''}` };
}

/** One pending sample at most. A failed read breaks the baseline; stopping also discards late replies. */
export function monitorResources(read: () => Promise<MachineSample>, changed: (value: MachineTelemetry | null) => void): () => void {
  let stopped = false;
  let pending = false;
  let history: MachineSample[] = [];
  const tick = async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      const value = await read();
      if (stopped) return;
      // Office receipt times avoid clock skew between the office and a remote box.
      const sample = { ...value, at: Date.now() };
      if (history.length && (sample.at - history.at(-1)!.at > RESOURCE_STALE_MS || sample.cpus !== history.at(-1)!.cpus)) history = [];
      // Keep one sample on the far side of a minute: timer jitter must not keep the window forever below 60s.
      while (history.length > 1 && sample.at - history[1].at >= 60_000) history.shift();
      history.push(sample);
      changed(machineHealth(history));
    } catch {
      history = [];
      if (!stopped) changed(null);
    } finally {
      pending = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), RESOURCE_INTERVAL_MS);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
