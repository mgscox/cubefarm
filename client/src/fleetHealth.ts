// Fleet advice follows measured pressure and declared resize capability, independent of hostnames and providers.
import { RESOURCE_STALE_MS, type MachineCapacity, type MachineTelemetry } from '../../shared/types';

export const telemetryFresh = (value: MachineTelemetry | null | undefined, now: number): value is MachineTelemetry => !!value && now - value.sample.at >= -5000 && now - value.sample.at <= RESOURCE_STALE_MS;

export interface FleetTarget {
  id: string;
  name: string;
  online: boolean;
  telemetry?: MachineTelemetry | null;
}

/** A destination is a candidate, not a promise that an arbitrary floor will fit. */
export function spareMachine(id: string, machines: FleetTarget[], now: number): FleetTarget | undefined {
  return machines.filter((m) => {
    const t = m.telemetry;
    return m.id !== id && m.online && telemetryFresh(t, now) && t.status === 'healthy' && t.observedSeconds >= 60
      && t.cpuAveragePercent !== null && t.cpuAveragePercent < 60 && t.sample.memoryAvailable !== null
      && t.sample.memoryTotal > 0 && t.sample.memoryAvailable / t.sample.memoryTotal >= 0.25;
  }).sort((a, b) => a.telemetry!.cpuAveragePercent! - b.telemetry!.cpuAveragePercent!)[0];
}

export function machineAdvice(id: string, telemetry: MachineTelemetry, capacity: MachineCapacity, machines: FleetTarget[], now: number): string {
  if (!telemetryFresh(telemetry, now)) return 'Wait for fresh readings before adding or moving work here.';
  const { constraints, status } = telemetry;
  if (status === 'observing') return 'Keep the current workload while the one-minute check completes.';
  if (status === 'unknown') return 'Resource evidence is incomplete; leave capacity unchanged until it can be measured.';
  if (status === 'healthy') return 'Keep the current allocation. No capacity change is indicated for this workload.';
  if (!constraints.length) return telemetry.cpuAveragePercent !== null && telemetry.cpuAveragePercent < 85 && (telemetry.sample.cpuStall ?? 0) >= 20
    ? 'Check CPU limits or processor affinity before adding workers or resizing this machine.'
    : 'Avoid adding workers for now; high utilisation alone does not justify a hardware upgrade.';
  const actions: string[] = [];
  const target = constraints.some((c) => c !== 'io') ? spareMachine(id, machines, now) : undefined;
  if (target) actions.push(`${target.name} has measured spare capacity. Move some work there for its next tasks, then recheck both machines.`);
  if (capacity === 'resizable') {
    const prefix = target ? 'If work must stay here, increase' : 'Increase';
    if (constraints.includes('cpu')) actions.push(`${prefix} the allocated CPUs, then recheck under the same workload.`);
    if (constraints.includes('memory')) actions.push(`${prefix} the allocated RAM, then recheck under the same workload.`);
  }
  if (constraints.includes('io')) actions.push('Reduce parallel builds and check storage latency; extra CPUs alone will not resolve the I/O stalls.');
  if (!target && capacity !== 'resizable' && constraints.some((c) => c !== 'io')) {
    actions.push('Reduce concurrent agents here. No other online machine currently has confirmed spare capacity.');
  }
  return actions.join(' ');
}
