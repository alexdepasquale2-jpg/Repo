// Small math helpers. No physics engine anywhere in this project — weight is faked (F-N01).
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));

// Frame-rate independent exponential smoothing.
export const damp = (a, b, halfLife, dt) =>
  halfLife <= 0 ? b : lerp(a, b, 1 - Math.pow(2, -dt / halfLife));

export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

export const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

// Signed shortest delta between two angles, in (-PI, PI].
export const angleDelta = (from, to) => {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
};

export const approachAngle = (from, to, maxStep) => {
  const d = angleDelta(from, to);
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
};

export const len = (x, y) => Math.hypot(x, y);

export const normalize = (x, y) => {
  const l = Math.hypot(x, y);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: x / l, y: y / l };
};

// Point-in-cone test, used by target cycling and telegraph checks.
export const inCone = (ox, oy, facing, halfAngle, px, py) =>
  Math.abs(angleDelta(facing, angleTo(ox, oy, px, py))) <= halfAngle;

export const circleOverlap = (ax, ay, ar, bx, by, br) => {
  const r = ar + br;
  return dist2(ax, ay, bx, by) <= r * r;
};

// Distance from point p to segment ab. Line telegraphs (T7-N09) resolve with this.
export function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) return dist(px, py, ax, ay);
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
  return dist(px, py, ax + abx * t, ay + aby * t);
}
