import { describe, expect, it } from 'vitest';
import { availableMemory, cpuUsage, createResourceReader, pressureAverage, runnableThreads } from './machineResources.ts';

const cpu = (idle: number, user: number) => ({ times: { idle, user, sys: 0, irq: 0, nice: 0 } });
const threads = 'USER PID %CPU STAT PRI STIME UTIME COMMAND\nme   123  2.0 R    31T  0:00.00 0:00.00 app\n          100.0 R+ 31T  0:00.00 0:00.00 thread\n          0.0 S    31  0:00.00 0:00.00 thread\n          0.0 U    31T  0:00.00 0:00.00 thread\n';

describe('OS resource readings', () => {
  it('measures total-machine CPU deltas and handles counter resets or resize', () => {
    expect(cpuUsage([cpu(10, 10), cpu(10, 10)], [cpu(60, 60), cpu(110, 10)])).toBe(25);
    expect(cpuUsage([cpu(10, 10)], [cpu(10, 10)])).toBeNull();
    expect(cpuUsage([cpu(10, 10)], [cpu(0, 10)])).toBeNull();
    expect(cpuUsage([], [cpu(10, 10)])).toBeNull();
  });
  it('uses Linux MemAvailable, including reclaimable caches, and preserves unknown', () => {
    expect(availableMemory('MemFree: 100 kB\nMemAvailable: 2000 kB\n')).toBe(2048000);
    expect(availableMemory('MemFree: 100 kB')).toBeNull();
    expect(pressureAverage('some avg10=20.0 avg60=12.34 avg300=1.0 total=55\nfull avg10=0 avg60=0')).toBe(12.34);
    expect(pressureAverage('not supported')).toBeNull();
  });
  it('collects guest resources without invoking commands on Linux', async () => {
    const read = createResourceReader({ platform: 'linux', cpus: () => [cpu(1, 1)], totalmem: () => 5000,
      readText: async (file) => file === '/proc/meminfo' ? 'MemAvailable: 2 kB' : 'some avg10=0 avg60=6.00 avg300=0 total=5',
      command: async () => { throw new Error('must not invoke commands'); },
    });
    expect(await read()).toMatchObject({ cpus: 1, memoryTotal: 5000, memoryAvailable: 2048, memoryStall: 6, ioStall: 6 });
  });
  it('does not substitute Linux free RAM when reliable available RAM cannot be read', async () => {
    const read = createResourceReader({ platform: 'linux', readText: async () => { throw new Error('denied'); }, freemem: () => 1 });
    expect(await read()).toMatchObject({ memoryAvailable: null, cpuStall: null, memoryStall: null, ioStall: null });
  });
  it('uses a bounded read-only macOS pressure query and does not mislabel cached RAM', async () => {
    const calls: unknown[] = [];
    const read = createResourceReader({ platform: 'darwin', command: async (...args) => { calls.push(args); return args[0] === '/bin/ps' ? threads : '2\n'; } });
    expect(await read()).toMatchObject({ memoryPressure: 'warning', memoryAvailable: null, runnableThreads: 1 });
    expect(calls).toEqual([['/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 2000 }], ['/bin/ps', ['-A', '-M'], { timeoutMs: 2000 }]]);
    expect(runnableThreads(threads.replace('R+', 'S '))).toBe(0);
    expect(runnableThreads('')).toBeNull();
    expect(runnableThreads('permission denied')).toBeNull();
  });
  it('preserves unsupported OS and failed macOS pressure readings as unknown', async () => {
    expect(await createResourceReader({ platform: 'other' })()).toMatchObject({ memoryAvailable: null, memoryPressure: null });
    expect(await createResourceReader({ platform: 'darwin', command: async () => { throw new Error('missing'); } })()).toMatchObject({ memoryPressure: null });
    expect(await createResourceReader({ platform: 'win32', freemem: () => 100, totalmem: () => 1000 })()).toMatchObject({ memoryAvailable: 100, load1: null });
  });
});
