// T2-N04 · Fungal network structure, T2-N12 · node types, T2-N25 · scars & regrowth.
//
// The network is the boss's weapon, his armor, his income and his eyes. Every
// node is all four at once, which is why "which node do I kill first" is an
// argument worth having.
import { TAU, clamp, dist } from '../core/math.js';
import { hasLineOfSight } from '../engine/collision.js';

export const NODE_TYPE = {
  // Readable by silhouette, not colour alone (T7-N04/T7-N09).
  SPORE: 'spore',   // three-lobed cluster — spreads fastest, fragile; income
  LASH:  'lash',    // spiked spindle — high HP, fires line attacks
  PULSE: 'pulse',   // concentric bulb — feeds the idle AOE, heals neighbours
};

export const NODE_DEFS = {
  [NODE_TYPE.SPORE]: { hp: 30,  cost: 8,  growth: 1.9, income: 0.8, armorPer: 0.9, radius: 30 },
  [NODE_TYPE.LASH]:  { hp: 78,  cost: 16, growth: 0.6, income: 0.25, armorPer: 1.6, radius: 26 },
  [NODE_TYPE.PULSE]: { hp: 52,  cost: 14, growth: 0.8, income: 0.45, armorPer: 1.3, radius: 34 },
};

const LINK_RANGE = 132;   // nodes must chain — the network cannot teleport

export function createNetwork({ bounds, walls, rng, particles, events }) {
  let nextNodeId = 1;

  const net = {
    nodes: [],
    scars: [],          // T2-N25 · killed nodes leave ground, not clean floor
    bounds, walls, rng, particles, events,
    growthAccum: 0,
    peakNodes: 0,

    get living() { return net.nodes.filter((n) => !n.dead); },
    get count() { return net.living.length; },

    seed(x, y) {
      net.nodes.length = 0;
      net.scars.length = 0;
      const root = net.addNode(x, y, NODE_TYPE.PULSE, null);
      root.isRoot = true;
      root.hp = root.maxHp = 200;
      // A starter ring so phase 1 opens with the boss genuinely dominant.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const d = 105;
        const type = i % 3 === 0 ? NODE_TYPE.LASH : i % 3 === 1 ? NODE_TYPE.PULSE : NODE_TYPE.SPORE;
        net.addNode(x + Math.cos(a) * d, y + Math.sin(a) * d, type, root);
      }
      net.peakNodes = net.count;
      return root;
    },

    addNode(x, y, type, parent) {
      const def = NODE_DEFS[type];
      const n = {
        id: nextNodeId++,
        x, y, type, def,
        hp: def.hp, maxHp: def.hp,
        radius: def.radius,
        parent: parent ? parent.id : null,
        dead: false,
        burning: 0,          // cauterized: cannot be fired from, cannot see
        grownAt: 0,
        pulse: rng.next() * TAU,
        selected: false,
        hitFlash: 0,
      };
      net.nodes.push(n);
      net.peakNodes = Math.max(net.peakNodes, net.count);
      events?.emit('node-grown', { node: n });
      return n;
    },

    // Growth only ever happens adjacent to a living node, so cleared territory
    // stays cleared until the front line moves back (T2-N25).
    canGrowAt(x, y) {
      if (x < bounds.x + 40 || x > bounds.x + bounds.w - 40) return false;
      if (y < bounds.y + 40 || y > bounds.y + bounds.h - 40) return false;
      for (const w of walls) {
        if (x > w.x - 18 && x < w.x + w.w + 18 && y > w.y - 18 && y < w.y + w.h + 18) return false;
      }
      for (const n of net.living) if (dist(x, y, n.x, n.y) < 62) return false;
      return true;
    },

    // Attackers standing near a scar suppress regrowth entirely. Hold the ground
    // or lose it back.
    isSuppressed(x, y, suppressors) {
      for (const s of suppressors) {
        if (!s.dead && dist(x, y, s.x, s.y) < 108) return true;
      }
      return false;
    },

    tryGrow(type, suppressors = []) {
      const living = net.living.filter((n) => n.burning <= 0);
      if (!living.length) return null;
      // Prefer growing from the frontier — nodes with the fewest neighbours.
      const scored = living.map((n) => ({ n, nb: net.neighbours(n).length }));
      scored.sort((a, b) => a.nb - b.nb || a.n.id - b.n.id);
      const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.6)));

      for (let attempt = 0; attempt < 14; attempt++) {
        const from = rng.pick(pool).n;
        const a = rng.range(0, TAU);
        const d = rng.range(70, LINK_RANGE - 8);
        const x = from.x + Math.cos(a) * d;
        const y = from.y + Math.sin(a) * d;
        if (!net.canGrowAt(x, y)) continue;
        if (net.isSuppressed(x, y, suppressors)) continue;
        if (!hasLineOfSight(from.x, from.y, x, y, walls)) continue;
        const n = net.addNode(x, y, type, from);
        // A scar regrown into is cheap and fast — it remembers.
        const scarIdx = net.scars.findIndex((s) => dist(s.x, s.y, x, y) < 50);
        if (scarIdx >= 0) { n.hp = n.maxHp; net.scars.splice(scarIdx, 1); n.fromScar = true; }
        particles?.burst(x, y, 12, { color: '#7ea34f', speed: 70, life: 0.6 });
        return n;
      }
      return null;
    },

    neighbours(n) {
      return net.living.filter((o) => o !== n && dist(o.x, o.y, n.x, n.y) <= LINK_RANGE);
    },

    nodesNear(x, y, radius) {
      return net.living.filter((n) => dist(x, y, n.x, n.y) <= radius);
    },

    nearestNode(x, y, { excludeBurning = false } = {}) {
      let best = null, bd = Infinity;
      for (const n of net.living) {
        if (excludeBurning && n.burning > 0) continue;
        const d = dist(x, y, n.x, n.y);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    },

    // Is this point standing on fungal ground? Drives boss vision (T2-N14),
    // spore taint (T2-N27) and the inefficiency of fighting off the network.
    covers(x, y, pad = 0) {
      for (const n of net.living) {
        if (dist(x, y, n.x, n.y) <= n.radius + pad) return n;
      }
      return null;
    },

    damageNode(n, amount, source) {
      if (!n || n.dead) return 0;
      n.hp -= amount;
      n.hitFlash = 0.15;
      particles?.burst(n.x, n.y, 6, { color: '#9fd06a', speed: 110, life: 0.3 });
      if (n.hp <= 0) net.killNode(n, source);
      events?.emit('node-damaged', { node: n, amount, source });
      return amount;
    },

    burnNode(n, duration) {
      if (!n || n.dead) return;
      n.burning = Math.max(n.burning, duration);
      events?.emit('node-burned', { node: n });
    },

    killNode(n, source) {
      if (n.dead) return;
      if (n.isRoot) { n.hp = 1; return; }   // the root dies with the boss, not before
      n.dead = true;
      net.scars.push({ x: n.x, y: n.y, age: 0 });
      if (net.scars.length > 90) net.scars.shift();
      particles?.burst(n.x, n.y, 20, { color: '#6f8f45', speed: 160, life: 0.55 });
      events?.emit('node-killed', { node: n, killer: source });
      // Orphaned children are not culled — the graph is a map, not a tree.
    },

    income() {
      let n = 0;
      for (const node of net.living) {
        if (node.burning > 0) continue;      // burning nodes pay nothing
        n += node.def.income;
      }
      return n;
    },

    // T2-N21 · root armor is a direct function of living nodes. Spending nodes
    // on attacks literally thins the boss's armor.
    // Measured against the network's own peak, not a magic constant, so the
    // curve holds at 4 players and at 8 (T2-N32 scaling lever #2).
    rootArmor() {
      let a = 0, peak = 0;
      for (const n of net.living) if (!n.isRoot) a += n.def.armorPer;
      for (const n of net.nodes) if (!n.isRoot) peak += n.def.armorPer;
      if (peak <= 0) return 0;
      return clamp(0.97 * Math.pow(a / peak, 0.7), 0, 0.97);
    },

    typeCount(type) { return net.living.filter((n) => n.type === type).length; },

    update(dt) {
      for (const n of net.nodes) {
        if (n.dead) continue;
        n.pulse += dt * 1.6;
        if (n.burning > 0) n.burning -= dt;
        if (n.hitFlash > 0) n.hitFlash -= dt;
        // Pulse nodes heal their neighbours — kill them to soften everything else.
        if (n.type === NODE_TYPE.PULSE && n.burning <= 0) {
          for (const o of net.neighbours(n)) {
            if (o.hp < o.maxHp) o.hp = Math.min(o.maxHp, o.hp + 1.4 * dt);
          }
        }
      }
      for (const s of net.scars) s.age += dt;
      // Purge dead nodes lazily so iteration during a kill cascade stays safe.
      if (net.nodes.length > 200) net.nodes = net.nodes.filter((n) => !n.dead);
    },

    reset() { net.nodes.length = 0; net.scars.length = 0; },
  };

  return net;
}
