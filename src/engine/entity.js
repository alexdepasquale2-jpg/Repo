// T1-N01 · Entity/component structure.
// Entities are plain objects with an agreed shape. Combat code touches only the
// shared fields, so a new enemy type never requires a combat-code change.
import { TAU } from '../core/math.js';

export const FACTION = {
  PLAYER: 'player',      // the human and their allies — attackers
  HOSTILE: 'hostile',    // level enemies
  THRONE: 'throne',      // the seated boss and everything the network owns
  NEUTRAL: 'neutral',
};

// Attackers can hurt each other (T2-N26), but only once the throne is live.
export function areHostile(a, b, opts = {}) {
  if (!a || !b || a === b) return false;
  if (a.faction === b.faction) {
    return opts.friendlyFire === true && a.faction === FACTION.PLAYER;
  }
  if (a.faction === FACTION.NEUTRAL || b.faction === FACTION.NEUTRAL) return false;
  return true;
}

let nextId = 1;

export function createEntity(props = {}) {
  return {
    id: nextId++,
    kind: 'entity',
    name: '',
    x: 0, y: 0,
    vx: 0, vy: 0,
    radius: 12,
    facing: 0,
    faction: FACTION.NEUTRAL,

    hp: 100, maxHp: 100,
    armor: 0,              // flat fraction 0..1 of damage ignored
    dead: false,
    corpseTimer: 0,

    targetable: true,
    solid: true,
    mass: 1,               // resists knockback; faked weight, not simulated (F-N01)

    statuses: [],          // T1-N06
    iframes: 0,
    hitFlash: 0,
    knockVx: 0, knockVy: 0,

    target: null,
    ...props,
  };
}

export function resetIdCounter(v = 1) { nextId = v; }

export class EntityStore {
  constructor() {
    this.list = [];
    this.byId = new Map();
  }
  add(e) {
    this.list.push(e);
    this.byId.set(e.id, e);
    return e;
  }
  get(id) { return this.byId.get(id); }
  remove(e) {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    this.byId.delete(e.id);
  }
  // Sweep corpses whose timer has run out. Husks opt out by setting corpseTimer
  // to Infinity — the dead are set dressing and a resource (T6-N06).
  sweep() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.dead && e.corpseTimer <= 0 && !e.persistent) {
        this.list.splice(i, 1);
        this.byId.delete(e.id);
      }
    }
  }
  *alive(faction = null) {
    for (const e of this.list) {
      if (e.dead) continue;
      if (faction && e.faction !== faction) continue;
      yield e;
    }
  }
  count(faction = null) {
    let n = 0;
    for (const _ of this.alive(faction)) n++;
    return n;
  }
  clear() {
    this.list.length = 0;
    this.byId.clear();
  }
}

export const facingOf = (e) => ((e.facing % TAU) + TAU) % TAU;
