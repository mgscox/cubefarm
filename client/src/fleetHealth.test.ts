import { describe, expect, it } from 'vitest';
import { machineHealth } from '../../server/machineHealth';
import type { MachineSample } from '../../shared/types';
import { machineAdvice, spareMachine, telemetryFresh, type FleetTarget } from './fleetHealth';

const now = 60_000;
const health = (patch: Partial<MachineSample> = {}) => machineHealth(Array.from({ length: 13 }, (_, i) => ({ at: i * 5000, cpus: 4, cpuPercent: 20, load1: 1, memoryTotal: 1000, memoryAvailable: 600, memoryPressure: null, cpuStall: 0, memoryStall: 0, ioStall: 0, ...patch })));
const spare: FleetTarget = { id: 'new-vps', name: 'New VPS', online: true, telemetry: health() };

describe('dynamic fleet advice', () => {
  it('recommends the constrained resource for resizable machines', () => {
    expect(machineAdvice('any', health({ cpuPercent: 97, cpuStall: 30 }), 'resizable', [], now)).toMatch(/Increase the allocated CPUs/);
    expect(machineAdvice('any', health({ memoryStall: 20 }), 'resizable', [], now)).toMatch(/Increase the allocated RAM/);
    expect(machineAdvice('any', health({ memoryStall: 20 }), 'resizable', [], now)).not.toMatch(/CPUs/);
  });
  it('recommends a dynamically added destination for fixed hardware, independent of names', () => {
    const advice = machineAdvice('fixed-lan-host', health({ cpuPercent: 97, cpuStall: 30 }), 'fixed', [spare], now);
    expect(advice).toContain('New VPS has measured spare capacity');
    expect(advice).not.toContain('Increase');
    expect(machineAdvice('any', health({ memoryStall: 20 }), 'unknown', [], now)).toContain('Reduce concurrent agents');
  });
  it('rejects offline, stale, warming-up, self and low-headroom destinations', () => {
    expect(spareMachine('new-vps', [spare], now)).toBeUndefined();
    expect(spareMachine('any', [{ ...spare, online: false }], now)).toBeUndefined();
    expect(spareMachine('any', [spare], now + 30_000)).toBeUndefined();
    expect(spareMachine('any', [{ ...spare, telemetry: { ...health(), observedSeconds: 5 } }], now)).toBeUndefined();
    expect(spareMachine('any', [{ ...spare, telemetry: health({ memoryAvailable: 200 }) }], now)).toBeUndefined();
  });
  it('does not claim extra CPU resolves I/O, or propose hardware changes for busy CPUs alone', () => {
    expect(machineAdvice('any', health({ ioStall: 30 }), 'resizable', [], now)).toContain('check storage latency');
    expect(machineAdvice('any', health({ cpuPercent: 95 }), 'resizable', [], now)).toContain('does not justify a hardware upgrade');
    expect(machineAdvice('any', health({ cpuPercent: 20, cpuStall: 30 }), 'resizable', [], now)).toContain('Check CPU limits');
  });
  it('does not infer healthy capacity from absent or stale readings', () => {
    expect(telemetryFresh(null, now)).toBe(false);
    expect(telemetryFresh(health(), now + 21_000)).toBe(false);
    expect(machineAdvice('any', health(), 'resizable', [], now + 21_000)).toContain('Wait for fresh readings');
  });
});
