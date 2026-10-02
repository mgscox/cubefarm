// Keyboard camera rotation, in radians per second, independent of mouse preferences.
const SPEED = 1.5;
const PITCH_LIMIT = 1.35;

export function keyboardLook(look: { yaw: number; pitch: number }, keys: ReadonlySet<string>, dt: number) {
  const yaw = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyR') ? 1 : 0);
  const pitch = (keys.has('KeyX') ? 1 : 0) - (keys.has('KeyZ') ? 1 : 0);
  return {
    yaw: look.yaw + yaw * SPEED * dt,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, look.pitch + pitch * SPEED * dt)),
  };
}
