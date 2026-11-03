import { useEffect, useState } from 'react';
import { StatsReadout, statsEnabled } from './perf';
import { useStore } from './store';
import { Game } from './world/Game';
import { ConfirmDialog } from './ui/Confirm';
import { Dashboard } from './ui/Dashboard';
import { HUD, Toasts } from './ui/HUD';
import { Overlays } from './ui/Overlays';
import { StartScreen } from './ui/StartScreen';
import { Tutorial } from './ui/Tutorial';

const MODE_KEY = 'cubefarm:mode';

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'dashboard' ? 'dashboard' : 'office';
  } catch {
    return 'office';
  }
}

export function App() {
  const [mode, setMode] = useState(loadMode);
  const ready = useStore((s) => s.loaded && s.settings.setupDone);
  const dashboard = mode === 'dashboard';

  useEffect(() => {
    // Resolve the link before entry so the open panel keeps the pointer free.
    const openIdea = () => {
      const id = window.location.hash.match(/^#idea\/([a-zA-Z0-9-]+)$/)?.[1];
      if (id) useStore.getState().openOverlay({ kind: 'manager', tab: 'ideas', ideaId: id });
    };
    openIdea();
    window.addEventListener('hashchange', openIdea);
    return () => window.removeEventListener('hashchange', openIdea);
  }, []);
  const switchMode = (next: 'dashboard' | 'office') => {
    if (document.pointerLockElement) document.exitPointerLock();
    useStore.setState({ overlay: null, focus: null, locked: false, held: null, chargeAt: null });
    useStore.getState().start();
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // The switch still works when browser storage is unavailable.
    }
  };

  return (
    <>
      {dashboard ? (
        ready && <Dashboard onOffice={() => switchMode('office')} />
      ) : (
        <>
          <Game />
          <HUD onDashboard={() => switchMode('dashboard')} />
          <Tutorial />
          <Overlays />
          {statsEnabled && <StatsReadout />}
        </>
      )}
      {(!dashboard || !ready) && <StartScreen onDashboard={() => switchMode('dashboard')} />}
      <Toasts />
      <ConfirmDialog />
    </>
  );
}
