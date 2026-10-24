import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineSample } from '../shared/types.ts';
import { machineHealth, monitorResources } from './machineHealth.ts';

const sample = (at = 60_000, patch: Partial<MachineSample> = {}): MachineSample => ({ at, cpus: 4, cpuPercent: 25, load1: 1, memoryTotal: 1000, memoryAvailable: 500, memoryPressure: null, cpuStall: 0, memoryStall: 0, ioStall: 0, ...patch });
const minute = (patch: Partial<MachineSample> = {}) => Array.from({ length: 13 }, (_, i) => sample(i * 5000, patch));

afterEach(() => { vi.useRealTimers(); });

describe('machine diagnosis', () => {
  it('waits for evidence, then identifies spare headroom', () => {
    expect(machineHealth([sample()]).status).toBe('observing');
    expect(machineHealth(minute()).status).toBe('healthy');
  });
  it('distinguishes busy CPUs from work waiting for CPU', () => {
    expect(machineHealth(minute({ cpuPercent: 97, load1: 4 })).status).toBe('busy');
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: 30 })).constraints).toEqual(['cpu']);
    expect(machineHealth(minute({ cpuPercent: 20, cpuStall: 30 })).status).toBe('busy');
  });
  it('does not treat a short compile burst as sustained contention', () => {
    const history = minute();
    history[12] = sample(60_000, { cpuPercent: 100, load1: 8, cpuStall: 30 });
    expect(machineHealth(history).constraints).toEqual([]);
  });
  it('only uses load fallback with I/O evidence, avoiding false CPU diagnoses on macOS', () => {
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: null })).constraints).toEqual(['cpu']);
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: null, ioStall: null })).status).toBe('busy');
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: null, ioStall: null, runnableThreads: 8 })).constraints).toEqual(['cpu']);
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: null, ioStall: null, runnableThreads: 3 })).status).toBe('busy');
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: null, ioStall: 20 })).constraints).toEqual(['io']);
    expect(machineHealth(minute({ cpuPercent: 97, load1: 8, cpuStall: 0, ioStall: 20 })).constraints).toEqual(['io']);
  });
  it('uses actual memory pressure rather than occupied RAM or old swap allocations', () => {
    expect(machineHealth(minute({ memoryAvailable: 20 })).status).toBe('busy');
    expect(machineHealth(minute({ memoryAvailable: 20 })).constraints).toEqual([]);
    expect(machineHealth([sample(0, { memoryStall: 12 })]).constraints).toEqual(['memory']);
    expect(machineHealth([sample(0, { memoryPressure: 'critical', memoryAvailable: null })]).status).toBe('observing');
    expect(machineHealth(minute({ memoryPressure: 'critical', memoryAvailable: null })).constraints).toEqual(['memory']);
    expect(machineHealth(minute({ memoryAvailable: null, memoryPressure: 'normal', ioStall: null })).status).toBe('healthy');
  });
  it('does not recommend a RAM upgrade for a brief macOS pressure spike', () => {
    const history = minute({ memoryAvailable: null, memoryPressure: 'normal' });
    history[12] = sample(60_000, { memoryAvailable: null, memoryPressure: 'warning' });
    expect(machineHealth(history).constraints).toEqual([]);
    expect(machineHealth(history).status).toBe('observing');
  });
  it('does not count incomplete CPU or memory readings as a healthy baseline', () => {
    for (const patch of [{ cpuPercent: null }, { memoryAvailable: null }]) {
      const history = minute();
      history[6] = sample(30_000, patch);
      expect(machineHealth(history).status).toBe('unknown');
    }
  });
  it('reports combined bottlenecks and missing evidence honestly', () => {
    expect(machineHealth(minute({ cpuPercent: 95, cpuStall: 40, memoryStall: 10, ioStall: 20 })).constraints).toEqual(['cpu', 'memory', 'io']);
    expect(machineHealth(minute({ memoryAvailable: null })).status).toBe('unknown');
    expect(machineHealth(minute({ cpuPercent: null })).status).toBe('unknown');
  });
});

describe('resource monitor lifecycle', () => {
  it('builds a full minute despite timer jitter and resets after resize', async () => {
    vi.useFakeTimers();
    let cpus = 4;
    const changed = vi.fn();
    const stop = monitorResources(async () => sample(0, { cpus }), changed);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(changed.mock.lastCall![0].status).toBe('healthy');
    cpus = 8;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall![0].status).toBe('observing');
    stop();
  });
  it('never overlaps slow requests or accepts a reply after stop', async () => {
    vi.useFakeTimers();
    let resolve!: (v: MachineSample) => void;
    const read = vi.fn(() => new Promise<MachineSample>((r) => { resolve = r; }));
    const changed = vi.fn();
    const stop = monitorResources(read, changed);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    resolve(sample());
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).not.toHaveBeenCalled();
  });
  it('starts a fresh baseline after a signal disappears and recovers', async () => {
    vi.useFakeTimers();
    let memoryAvailable: number | null = 500;
    const changed = vi.fn();
    const stop = monitorResources(async () => sample(0, { memoryAvailable }), changed);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed.mock.lastCall![0].status).toBe('healthy');
    memoryAvailable = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall![0].observedSeconds).toBe(0);
    memoryAvailable = 500;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall![0]).toMatchObject({ observedSeconds: 0, status: 'observing' });
    stop();
  });
  it('clears failed readings and starts a new baseline on recovery', async () => {
    vi.useFakeTimers();
    let fail = false;
    const changed = vi.fn();
    const stop = monitorResources(async () => { if (fail) throw new Error('unavailable'); return sample(); }, changed);
    await vi.advanceTimersByTimeAsync(60_000);
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall).toEqual([null]);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall![0].observedSeconds).toBe(0);
    stop();
  });
});
