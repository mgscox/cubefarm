import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DPR, dprSample, dprSettle, newDpr } from './dprControl';
import { coversView, useStore } from './store';

// Keeping the office cheap to leave open all day: the 3D view stops drawing while a panel hides it or
// the tab is in the background, the resolution steps down when frames get slow, and `?stats` shows
// what the canvas costs.

/** Highest device pixel ratio the canvas renders at (the adaptive resolution never goes below 1). */
export const MAX_DPR = 1.75;

/** `?stats` in the URL shows the FPS readout. Without it nothing is mounted or measured. */
export const statsEnabled = new URLSearchParams(window.location.search).has('stats');

function subscribeVisibility(cb: () => void) {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

export function usePageHidden() {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden);
}

/** True while nobody can see the office: a full-screen panel covers it or the tab is hidden. */
export function useRenderPaused() {
  const covered = useStore((s) => coversView(s.overlay));
  const hidden = usePageHidden();
  return covered || hidden;
}

/**
 * Lives inside the Canvas. With the loop stopped nothing redraws, so if the window is resized (which
 * clears the canvas) while paused, draw one frame so the edges around the panel aren't left blank.
 */
export function FrameWhilePaused({ paused }: { paused: boolean }) {
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const advance = useThree((s) => s.advance);
  const clock = useThree((s) => s.clock);
  const last = useRef({ size, dpr });
  useEffect(() => {
    const changed = last.current.size !== size || last.current.dpr !== dpr;
    last.current = { size, dpr };
    // Passing the clock's own time gives every useFrame a delta of 0, so nothing moves in this frame.
    if (paused && changed) advance(clock.elapsedTime);
  }, [paused, size, dpr, advance, clock]);
  return null;
}

// The adaptive resolution's state (its decisions are in dprControl.ts), outside React: a step changes the Canvas's
// pixel ratio through R3F's own setDpr, so it never re-renders Game and the whole scene under it.
const dprCap = () => Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
const dprState = newDpr(dprCap());
// Its max follows the screen the window is on (moving to another monitor); updated in place, no per-sample object.
const dprConfig = { ...DPR };

/** The pixel ratio the view draws at now. Game passes it to the Canvas, so a re-render never resets a step. */
export const currentDpr = () => Math.min(dprState.dpr, dprCap());

/**
 * Lives inside the Canvas. Steps the pixel ratio down toward 1 after sustained slow frames and back up toward
 * MAX_DPR after sustained headroom, waiting longer after every step up that didn't hold (dprControl.ts): walking
 * between busy and quiet parts of a floor never bounces it, and it never gives up and stays low all day.
 */
export function AdaptiveResolution({ paused }: { paused: boolean }) {
  const setDpr = useThree((s) => s.setDpr);
  const onSample = useCallback(
    (fps: number, ms: number) => {
      dprConfig.max = dprCap();
      const next = dprSample(dprState, fps, ms, dprConfig);
      if (next !== null) setDpr(next);
    },
    [setDpr],
  );
  const onPause = useCallback(() => dprSettle(dprState, dprConfig), []);
  return <FrameRateSampler paused={paused} onSample={onSample} onPause={onPause} />;
}

/**
 * Lives inside the Canvas: every half second of drawing, `onSample` gets the average fps over it. A pause (panel
 * open, tab hidden) calls `onPause` and starts a fresh window, so time the view wasn't drawing never counts as slow
 * frames; a genuinely slow frame (software WebGL) does.
 */
export function FrameRateSampler({ paused, onSample, onPause }: { paused: boolean; onSample: (fps: number, ms: number) => void; onPause?: () => void }) {
  const acc = useRef({ start: 0, frames: 0 });
  useEffect(() => {
    acc.current.start = 0;
    if (paused) onPause?.();
  }, [paused, onPause]);
  useFrame(() => {
    if (paused) return; // FrameWhilePaused's one-off frames
    const now = performance.now();
    const a = acc.current;
    if (!a.start) {
      a.start = now;
      a.frames = 0;
      return;
    }
    a.frames++;
    const elapsed = now - a.start;
    if (elapsed < 500) return;
    onSample((a.frames * 1000) / elapsed, elapsed);
    a.start = now;
    a.frames = 0;
  });
  return null;
}

// The probe inside the Canvas writes straight into this element, so the readout never re-renders React.
let readoutEl: HTMLSpanElement | null = null;

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Lives inside the Canvas (only with `?stats`). Samples the frame rate and the renderer's counters twice a second. */
export function StatsProbe({ paused }: { paused: boolean }) {
  const gl = useThree((s) => s.gl);
  const acc = useRef({ start: 0, prev: 0, frames: 0 });
  // After a pause (panel open, tab hidden) start a fresh window instead of averaging over the gap.
  useEffect(() => {
    acc.current.start = 0;
  }, [paused]);
  useFrame(() => {
    const now = performance.now();
    const a = acc.current;
    if (!a.start || now - a.prev > 1000) {
      a.start = now;
      a.frames = 0;
    }
    a.prev = now;
    a.frames++;
    const elapsed = now - a.start;
    if (elapsed < 500 || !readoutEl) return;
    // gl.info holds the previous frame's totals (shadow passes included) until this frame renders.
    const { calls, triangles } = gl.info.render;
    const fps = (a.frames * 1000) / elapsed;
    readoutEl.textContent = `${Math.round(fps)} fps · ${(elapsed / a.frames).toFixed(1)} ms · ${calls} calls · ${fmt(triangles)} tris · dpr ${gl.getPixelRatio().toFixed(2)}`;
    a.start = now;
    a.frames = 0;
  });
  return null;
}

/** The corner readout for `?stats`. Shows when the 3D view is paused, since the numbers stop updating then. */
export function StatsReadout() {
  const paused = useRenderPaused();
  return (
    <div className="stats" aria-hidden="true">
      <span
        ref={(el) => {
          readoutEl = el;
        }}
        hidden={paused}
      >
        measuring…
      </span>
      {paused && <span>⏸ 3D view paused</span>}
    </div>
  );
}
