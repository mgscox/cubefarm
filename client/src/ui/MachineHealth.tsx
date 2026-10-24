// Show a machine diagnosis, supporting evidence and its manager-declared resize capability.
import { useEffect, useState } from 'react';
import type { MachineCapacity, MachineTelemetry } from '../../../shared/types';
import { api } from '../api';
import { machineAdvice, telemetryFresh, type FleetTarget } from '../fleetHealth';
import { useStore } from '../store';

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function MachineHealth({ id, online, telemetry, capacity = 'unknown', machines }: {
  id: string; online: boolean; telemetry?: MachineTelemetry | null; capacity?: MachineCapacity; machines: FleetTarget[];
}) {
  const connected = useStore((s) => s.connected);
  const demo = useStore((s) => s.demo);
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const fresh = online && connected && telemetryFresh(telemetry, now);
  return <div className="fleet-health" data-health={fresh ? telemetry.status : 'unknown'}>
    <div><b>{fresh ? telemetry.summary : 'Load unknown'}</b>{demo && <span className="muted small"> · simulated readings</span>}</div>
    <div className="small">{fresh ? machineAdvice(id, telemetry, capacity, machines, now) : !online ? 'This machine is offline; load cannot be assessed.' : 'Fresh resource readings are unavailable. Do not infer spare capacity from its online status.'}</div>
    {fresh && <details className="small">
      <summary>Why this advice?</summary>
      <p>{telemetry.evidence}</p>
      <div>{telemetry.sample.cpus} logical CPUs · {gib(telemetry.sample.memoryTotal)} RAM</div>
      <div>CPU average: {telemetry.cpuAveragePercent === null ? 'unavailable' : `${Math.round(telemetry.cpuAveragePercent)}%`} · {telemetry.sample.memoryAvailable === null ? `Memory pressure: ${telemetry.sample.memoryPressure ?? 'unavailable'}` : `${gib(telemetry.sample.memoryAvailable)} RAM available`}</div>
      <div className="muted">Whole machine, including other apps. A VM reports its guest allocation. Updated every 5 seconds.</div>
    </details>}
    <label className="small fleet-capacity">Capacity
      <select aria-label={`Capacity for ${machines.find((m) => m.id === id)?.name ?? 'this machine'}`} value={capacity} disabled={saving} onChange={(e) => {
        setSaving(true);
        void api.machineCapacity(id, e.target.value as MachineCapacity).catch(() => undefined).finally(() => setSaving(false));
      }}>
        <option value="unknown">Not specified</option>
        <option value="fixed">Fixed hardware</option>
        <option value="resizable">CPU / RAM can be increased</option>
      </select>
    </label>
  </div>;
}
