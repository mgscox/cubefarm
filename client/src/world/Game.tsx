import { Suspense, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { AdaptiveResolution, currentDpr, FrameWhilePaused, StatsProbe, statsEnabled, useRenderPaused } from '../perf';
import { repoOnFloor, useStore } from '../store';
import { ding, whoosh } from '../ui/sfx';
import { lobbyColliders, officeColliders } from './layout';
import { Lobby } from './Lobby';
import { OfficeFloor } from './OfficeFloor';
import { Player } from './Player';
import { Lights } from './Shell';

/** The floor's room, re-rendered when its own repo changes, not Game. */
function OfficeRoom({ repoId }: { repoId: string }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  return repo ? <OfficeFloor repo={repo} /> : null;
}

function Travel() {
  const travel = useStore((s) => s.travel);
  const finish = useStore((s) => s.finishTravel);
  useEffect(() => {
    if (!travel) return;
    if (travel.phase === 'closing') whoosh(0.75);
    const t = setTimeout(
      () => {
        if (travel.phase === 'closing') {
          finish('arrived');
          ding();
        } else finish('done');
      },
      travel.phase === 'closing' ? 750 : 650,
    );
    return () => clearTimeout(t);
  }, [travel, finish]);
  return null;
}

export function Game() {
  const floor = useStore((s) => s.floor);
  // Only this floor's id: any floor's repo event re-rendering Game would re-render the whole scene.
  const repoId = useStore((s) => (floor === 0 ? null : (repoOnFloor(s.repos, floor)?.id ?? null)));
  const isOffice = !!repoId;
  const colliders = useMemo(() => (isOffice ? officeColliders() : lobbyColliders()), [isOffice]);
  // Stop drawing while nobody can see the office; switching back to 'always' draws a fresh frame at once.
  const paused = useRenderPaused();

  return (
    <Canvas
      shadows
      frameloop={paused ? 'never' : 'always'}
      dpr={currentDpr()}
      camera={{ fov: 72, near: 0.05, far: 90, position: [0, 1.65, 10] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
      }}
    >
      <color attach="background" args={['#bfe3ff']} />
      <fog attach="fog" args={['#f3ece2', 30, 70]} />
      <Lights />
      <Suspense fallback={null}>{repoId ? <OfficeRoom key={repoId} repoId={repoId} /> : <Lobby />}</Suspense>
      <Player colliders={colliders} floor={floor} />
      <Travel />
      <FrameWhilePaused paused={paused} />
      <AdaptiveResolution paused={paused} />
      {statsEnabled && <StatsProbe paused={paused} />}
    </Canvas>
  );
}
