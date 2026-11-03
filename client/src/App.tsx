import { useEffect } from 'react';
import { useStore } from './store';
import { StatsReadout, statsEnabled } from './perf';
import { Game } from './world/Game';
import { ConfirmDialog } from './ui/Confirm';
import { HUD } from './ui/HUD';
import { Overlays } from './ui/Overlays';
import { StartScreen } from './ui/StartScreen';
import { Tutorial } from './ui/Tutorial';

export function App() {
  useEffect(() => {
    // Resolve the link before entry so the open panel keeps the pointer free.
    const openIdea = () => {
      const id = window.location.hash.match(/^#idea\/([a-zA-Z0-9-]+)(?:\/prd\/[a-zA-Z0-9-]+)?$/)?.[1];
      if (id) useStore.getState().openOverlay({ kind: 'manager', tab: 'ideas', ideaId: id });
    };
    openIdea();
    window.addEventListener('hashchange', openIdea);
    return () => window.removeEventListener('hashchange', openIdea);
  }, []);
  return (
    <>
      <Game />
      <HUD />
      <Overlays />
      <Tutorial />
      <StartScreen />
      <ConfirmDialog />
      {statsEnabled && <StatsReadout />}
    </>
  );
}
