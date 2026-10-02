import { describe, expect, it } from 'vitest';
import { keyboardLook } from './keyboardLook';

const turned = (look: { yaw: number; pitch: number }, keys: string[], dt: number) => {
  const next = { ...look };
  keyboardLook(next, new Set(keys), dt);
  return next;
};

describe('keyboard camera rotation', () => {
  const level = { yaw: 0, pitch: 0 };

  it.each([
    ['KeyQ', 1.5, 0],
    ['KeyE', -1.5, 0],
    ['KeyZ', 0, -1.35],
    ['KeyX', 0, 1.35],
  ])('%s turns in the requested direction', (key, yaw, pitch) => {
    expect(turned(level, [key], 1)).toEqual({ yaw, pitch });
  });

  it('cancels opposing keys and ignores movement keys', () => {
    expect(turned(level, ['KeyQ', 'KeyE', 'KeyZ', 'KeyX', 'KeyW'], 1)).toEqual(level);
    expect(turned(level, ['KeyR'], 1)).toEqual(level);
    expect(turned(level, [], 1)).toEqual(level);
  });

  it('updates the look in place instead of returning a new one', () => {
    const look = { yaw: 0.2, pitch: 0.1 };
    expect(keyboardLook(look, new Set(['KeyQ', 'KeyX']), 0.1)).toBeUndefined();
    expect(look.yaw).toBeCloseTo(0.35);
    expect(look.pitch).toBeCloseTo(0.25);
  });

  it('rotates at the same rate across frame sizes', () => {
    const keys = ['KeyQ', 'KeyX'];
    const once = turned(level, keys, 0.04);
    const twice = turned(turned(level, keys, 0.02), keys, 0.02);
    expect(twice).toEqual(once);
  });

  it('clamps pitch and lets you turn away from either limit', () => {
    expect(turned({ yaw: 0, pitch: 1.3 }, ['KeyX'], 0.1).pitch).toBe(1.35);
    expect(turned({ yaw: 0, pitch: -1.3 }, ['KeyZ'], 0.1).pitch).toBe(-1.35);
    expect(turned({ yaw: 0, pitch: 1.35 }, ['KeyZ'], 0.1).pitch).toBeCloseTo(1.2);
    expect(turned({ yaw: 0, pitch: -1.35 }, ['KeyX'], 0.1).pitch).toBeCloseTo(-1.2);
  });
});
