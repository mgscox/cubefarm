// Office-wide notices shared by the 3D HUD and the dashboard.
import { officeUpdateChip } from '../officeUpdate';
import { useStore } from '../store';

export function OfficeNotices() {
  const update = useStore((s) => (s.restarting ? '⟳ Office restarting…' : officeUpdateChip(s.officeUpdate)));
  const showUpdate = useStore((s) => s.overlay?.kind !== 'manager');
  const githubError = useStore((s) => s.ghReady ? null : s.ghError);
  const openOverlay = useStore((s) => s.openOverlay);
  return (
    <>
      {update && showUpdate && (
        <button className="office-chip" onClick={() => openOverlay({ kind: 'manager', tab: 'floors' })} title="The office is updating itself. Open the manager's console">
          {update}
        </button>
      )}
      {githubError && <div className="hud-banner">⚠️ {githubError}</div>}
    </>
  );
}
