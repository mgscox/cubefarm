export interface MaintenanceResult {
  automaticUpdates: boolean;
  folder: unknown;
  office: unknown;
  boxes: { name: string; status: string; sync: unknown }[];
  errors: string[];
}
export function maintainOffice(opts?: { url?: string; repo?: string; request?: typeof fetch }): Promise<MaintenanceResult>;
export function maintenanceLock(home: string): Promise<(() => Promise<void>) | null>;
