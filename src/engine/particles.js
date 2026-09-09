// F-N02 · Hit confirmation stack (the visual layers) + T7-N03 juice.
// Pooled — allocation during a 7-player fight is the enemy (T7-N05).
const POOL = 900;

export function createParticles() {
  const p = new Array(POOL);
  for (let i = 0; i < POOL; i++) {
    p[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', drag: 0.9, glow: false };
  }
  let cursor = 0;

  function spawn(opts) {
    // Round-robin: when the pool is full the oldest particle is recycled rather
    // than dropping the new one, so heavy moments still read.
    let tries = 0;
    while (p[cursor].active && tries < POOL) { cursor = (cursor + 1) % POOL; tries++; }
    const q = p[cursor];
    cursor = (cursor + 1) % POOL;
    q.active = true;
    q.x = opts.x; q.y = opts.y;
    q.vx = opts.vx ?? 0; q.vy = opts.vy ?? 0;
    q.life = q.maxLife = opts.life ?? 0.4;
    q.size = opts.size ?? 2.5;
    q.color = opts.color ?? '#fff';
    q.drag = opts.drag ?? 0.9;
    q.glow = opts.glow ?? false;
    return q;
  }

  return {
    spawn,
    burst(x, y, count, { color = '#fff', speed = 120, life = 0.4, size = 2.5, spread = Math.PI * 2, dir = 0, glow = false } = {}) {
      for (let i = 0; i < count; i++) {
        const a = dir + (Math.random() - 0.5) * spread;
        const s = speed * (0.35 + Math.random() * 0.65);
        spawn({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.6 + Math.random() * 0.6), size, color, glow });
      }
    },
    update(dt) {
      for (let i = 0; i < POOL; i++) {
        const q = p[i];
        if (!q.active) continue;
        q.life -= dt;
        if (q.life <= 0) { q.active = false; continue; }
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        const d = Math.pow(q.drag, dt * 60);
        q.vx *= d; q.vy *= d;
      }
    },
    draw(ctx) {
      for (let i = 0; i < POOL; i++) {
        const q = p[i];
        if (!q.active) continue;
        const t = q.life / q.maxLife;
        ctx.globalAlpha = Math.min(1, t * 1.4);
        ctx.fillStyle = q.color;
        const s = q.size * (0.4 + t * 0.6);
        ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    },
    clear() { for (let i = 0; i < POOL; i++) p[i].active = false; },
  };
}
