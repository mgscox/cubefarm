import { describe, expect, it } from 'vitest';
import { keyboardLook } from './keyboardLook';

describe('keyboard camera rotation', () => {
  const level = { yaw: 0, pitch: 0 };

  it.each([
    ['KeyQ', 1.5, 0],
    ['KeyR', -1.5, 0],
    ['KeyZ', 0, -1.35],
    ['KeyX', 0, 1.35],
  ])('%s turns in the requested direction', (key, yaw, pitch) => {
    expect(keyboardLook(level, new Set([key]), 1)).toEqual({ yaw, pitch });
  });

  it('cancels opposing keys and ignores movement keys', () => {
    expect(keyboardLook(level, new Set(['KeyQ', 'KeyR', 'KeyZ', 'KeyX', 'KeyW']), 1)).toEqual(level);
    expect(keyboardLook(level, new Set(), 1)).toEqual(level);
  });

  it('rotates at the same rate across frame sizes', () => {
    const keys = new Set(['KeyQ', 'KeyX']);
    const once = keyboardLook(level, keys, 0.04);
    const twice = keyboardLook(keyboardLook(level, keys, 0.02), keys, 0.02);
    expect(twice).toEqual(once);
  });

  it('clamps pitch and lets you turn away from either limit', () => {
    expect(keyboardLook({ yaw: 0, pitch: 1.3 }, new Set(['KeyX']), 0.1).pitch).toBe(1.35);
    expect(keyboardLook({ yaw: 0, pitch: -1.3 }, new Set(['KeyZ']), 0.1).pitch).toBe(-1.35);
    expect(keyboardLook({ yaw: 0, pitch: 1.35 }, new Set(['KeyZ']), 0.1).pitch).toBeCloseTo(1.2);
    expect(keyboardLook({ yaw: 0, pitch: -1.35 }, new Set(['KeyX']), 0.1).pitch).toBeCloseTo(-1.2);
  });
});
