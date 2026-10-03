// Manual closure has no clock or forced-stop decision.
import type { OfficeLifecycleView } from '../shared/types.ts';

export function officeLifecycle(held: boolean, running: number, saved: boolean): OfficeLifecycleView {
  return { state: !held ? 'open' : running > 0 || !saved ? 'closing' : 'closed', running };
}
