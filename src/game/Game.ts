import {
  BOSS_TIMER,
  DAEMONS,
  FOCUS,
  RESONANCE_MULTIPLIER,
  archetypeFor,
  enemyHp,
  enemyReward,
  insightFor,
  insightMultiplier,
  isBossLayer,
  killsToClear,
  type Archetype,
} from './content';
import { costOf } from './numbers';
import { initialState, type Relic, type SaveState } from './state';

export interface Buff {
  kind: 'fervour' | 'dread';
  /** Seconds remaining. */
  remaining: number;
  /** Damage multiplier (fervour) or DoT fraction per second (dread). */
  power: number;
}

export interface HitReport {
  amount: number;
  crit: boolean;
  resonant: boolean;
  killed: boolean;
}

/** Fired for anything the UI wants to announce or animate. */
export type GameEvent =
  | { type: 'hit'; report: HitReport }
  | { type: 'kill'; layer: number; reward: number }
  | { type: 'descend'; layer: number }
  | { type: 'bossFailed'; layer: number }
  | { type: 'relic'; relic: Relic };

/**
 * Rules and simulation. Knows nothing about the DOM, and nothing about the
 * models directly — AI answers are pushed in by the caller (see `main.ts`),
 * so the whole game is playable and testable with no pipeline loaded.
 */
export class Game {
  state: SaveState;

  /** Current enemy. */
  enemyMaxHp = 0;
  enemyHp = 0;
  archetype: Archetype;

  /** Seconds left on a boss fight, or null outside one. */
  bossTimer: number | null = null;

  /** Element the player is currently striking with. */
  activeElement: string | null = null;

  buff: Buff | null = null;

  /** Crit chance contributed by Resonance, 0–1. Set by the caller. */
  sigilAffinity = 0;

  listeners: ((e: GameEvent) => void)[] = [];

  constructor(state: SaveState = initialState()) {
    this.state = state;
    this.archetype = archetypeFor(state.layer);
    this.#spawn();
  }

  on(fn: (e: GameEvent) => void): void {
    this.listeners.push(fn);
  }

  #emit(e: GameEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /* ------------------------------------------------------------ modifiers -- */

  #relicBonus(mod: Relic['mod']): number {
    let total = 0;
    for (const r of this.state.relics) if (r.mod === mod) total += r.value;
    return 1 + total;
  }

  get damageMultiplier(): number {
    const fervour = this.buff?.kind === 'fervour' ? this.buff.power : 1;
    return insightMultiplier(this.state.insight) * this.#relicBonus('damage') * fervour;
  }

  get clickDamage(): number {
    return (1 + this.state.focusLevel * FOCUS.damagePerLevel) * this.damageMultiplier;
  }

  get dps(): number {
    let raw = 0;
    for (const d of DAEMONS) raw += (this.state.daemons[d.id] ?? 0) * d.baseDps;
    return raw * this.damageMultiplier * this.#relicBonus('idle');
  }

  /** Element this enemy resonates with, if Divination has answered for it. */
  get resonantElement(): string | null {
    return this.state.resonance[this.archetype.id] ?? null;
  }

  get isResonating(): boolean {
    const res = this.resonantElement;
    return res !== null && this.activeElement === res;
  }

  /* --------------------------------------------------------------- combat -- */

  /** A tap. Rolls crit from Resonance and applies elemental resonance. */
  tap(): HitReport {
    const crit = Math.random() < this.critChance;
    let amount = this.clickDamage;
    if (crit) amount *= 3;
    const resonant = this.isResonating;
    if (resonant) amount *= RESONANCE_MULTIPLIER;

    const killed = this.#damage(amount);
    const report: HitReport = { amount, crit, resonant, killed };
    this.#emit({ type: 'hit', report });
    return report;
  }

  /** Resonance turns sigil affinity into crit chance, capped at 60%. */
  get critChance(): number {
    return Math.min(0.6, this.sigilAffinity * 0.6);
  }

  /** Advances idle damage, buffs and the boss clock. */
  tick(dt: number): void {
    if (this.buff) {
      this.buff.remaining -= dt;
      if (this.buff.remaining <= 0) this.buff = null;
    }

    let damage = this.dps * dt;
    // Dread burns a fraction of the enemy's maximum health per second, which
    // keeps it relevant deep down where flat idle damage falls behind.
    if (this.buff?.kind === 'dread') damage += this.enemyMaxHp * this.buff.power * dt;
    if (this.isResonating) damage *= RESONANCE_MULTIPLIER;

    if (damage > 0) this.#damage(damage);

    if (this.bossTimer !== null) {
      this.bossTimer -= dt;
      if (this.bossTimer <= 0) this.#failBoss();
    }
  }

  #damage(amount: number): boolean {
    this.enemyHp -= amount;
    if (this.enemyHp > 0) return false;
    this.#kill();
    return true;
  }

  #kill(): void {
    const reward = enemyReward(this.state.layer) * this.#relicBonus('weights');
    this.state.weights += reward;
    this.state.lifetimeWeights += reward;
    this.state.killsThisLayer += 1;
    this.#emit({ type: 'kill', layer: this.state.layer, reward });

    if (this.state.killsThisLayer >= killsToClear(this.state.layer)) {
      this.state.layer += 1;
      this.state.killsThisLayer = 0;
      this.state.deepestLayer = Math.max(this.state.deepestLayer, this.state.layer);
      this.#emit({ type: 'descend', layer: this.state.layer });
    }

    this.#spawn();
  }

  #failBoss(): void {
    const layer = this.state.layer;
    // Pushed back one layer rather than reset — a wall should cost minutes, not
    // the run, on a game that is meant to be left alone.
    this.state.layer = Math.max(1, layer - 1);
    this.state.killsThisLayer = 0;
    this.#emit({ type: 'bossFailed', layer });
    this.#spawn();
  }

  #spawn(): void {
    this.archetype = archetypeFor(this.state.layer);
    this.enemyMaxHp = enemyHp(this.state.layer);
    this.enemyHp = this.enemyMaxHp;
    this.bossTimer = isBossLayer(this.state.layer) ? BOSS_TIMER : null;
  }

  /* -------------------------------------------------------------- economy -- */

  focusCost(): number {
    return costOf(FOCUS.baseCost, FOCUS.costGrowth, this.state.focusLevel);
  }

  buyFocus(): boolean {
    const cost = this.focusCost();
    if (this.state.weights < cost) return false;
    this.state.weights -= cost;
    this.state.focusLevel += 1;
    return true;
  }

  daemonCost(id: string): number {
    const spec = DAEMONS.find((d) => d.id === id);
    if (!spec) return Infinity;
    return costOf(spec.baseCost, spec.costGrowth, this.state.daemons[id] ?? 0);
  }

  buyDaemon(id: string): boolean {
    const cost = this.daemonCost(id);
    if (this.state.weights < cost) return false;
    this.state.weights -= cost;
    this.state.daemons[id] = (this.state.daemons[id] ?? 0) + 1;
    return true;
  }

  unlock(abilityId: string, cost: number): boolean {
    if (this.state.unlocked.includes(abilityId)) return false;
    if (this.state.weights < cost) return false;
    this.state.weights -= cost;
    this.state.unlocked.push(abilityId);
    return true;
  }

  has(abilityId: string): boolean {
    return this.state.unlocked.includes(abilityId);
  }

  addRelic(relic: Relic): void {
    this.state.relics.push(relic);
    this.#emit({ type: 'relic', relic });
  }

  /* ------------------------------------------------------------- prestige -- */

  pendingInsight(): number {
    return insightFor(this.state.deepestLayer);
  }

  /**
   * Retrain: reset depth and the economy, keep Insight, unlocked pipelines and
   * relics. Losing a paid-for model download on prestige would be hostile.
   */
  retrain(): boolean {
    const gain = this.pendingInsight();
    if (gain <= 0) return false;

    const keep = {
      insight: this.state.insight + gain,
      unlocked: this.state.unlocked,
      // Model-derived answers survive prestige: recomputing them would cost a
      // download and produce identical values.
      resonance: this.state.resonance,
      affinities: this.state.affinities,
      affinitySigil: this.state.affinitySigil,
      relics: this.state.relics,
      sigil: this.state.sigil,
      cry: this.state.cry,
      lifetimeWeights: this.state.lifetimeWeights,
    };

    this.state = { ...initialState(), ...keep, lastSeen: Date.now() };
    this.buff = null;
    this.#spawn();
    return true;
  }

  /* -------------------------------------------------------------- offline -- */

  /** Caps out at 8h so leaving the game for a week is not an instant win. */
  static readonly OFFLINE_CAP = 8 * 3600;

  /**
   * Credits idle damage accrued while away, as weights only. Layers do not
   * advance offline — waking up somewhere unrecognisable reads as a bug.
   */
  applyOffline(seconds: number): { seconds: number; weights: number } {
    const elapsed = Math.max(0, Math.min(seconds, Game.OFFLINE_CAP));
    const dps = this.dps;
    if (elapsed < 60 || dps <= 0) return { seconds: 0, weights: 0 };

    const hp = enemyHp(this.state.layer);
    const kills = Math.floor((dps * elapsed) / hp);
    if (kills <= 0) return { seconds: 0, weights: 0 };

    const weights = kills * enemyReward(this.state.layer) * this.#relicBonus('weights');
    this.state.weights += weights;
    this.state.lifetimeWeights += weights;
    return { seconds: elapsed, weights };
  }
}
