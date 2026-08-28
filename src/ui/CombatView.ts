import type { Viewport } from '../engine/Viewport';
import type { Game } from '../game/Game';
import { ELEMENT_BY_ID } from '../game/content';
import { fmt } from '../game/numbers';

interface Floater {
  x: number;
  y: number;
  vy: number;
  life: number;
  text: string;
  color: string;
  scale: number;
}

const BG = '#0b1020';
const NEUTRAL = '#6d7ba0';

/**
 * The fight: one entity, its health, and feedback for every hit.
 *
 * Deliberately procedural — an idle game spends hours on this screen, and
 * shapes derived from the enemy's identity stay varied without an asset budget.
 */
export class CombatView {
  #vp: Viewport;
  #game: Game;
  #floaters: Floater[] = [];
  #shake = 0;
  #hitFlash = 0;

  constructor(viewport: Viewport, game: Game) {
    this.#vp = viewport;
    this.#game = game;
  }

  /** Spawns a damage number near the entity. */
  pop(text: string, color: string, big = false): void {
    const { width, height } = this.#vp;
    this.#floaters.push({
      x: width / 2 + (Math.random() - 0.5) * width * 0.35,
      y: height * 0.46,
      vy: -55 - Math.random() * 25,
      life: 1,
      text,
      color,
      scale: big ? 1.5 : 1,
    });
    // Cap the pool: at high click rates this would otherwise grow without bound.
    if (this.#floaters.length > 40) this.#floaters.splice(0, this.#floaters.length - 40);

    this.#shake = Math.min(1, this.#shake + (big ? 0.6 : 0.25));
    this.#hitFlash = 1;
  }

  draw(dt: number, elapsed: number): void {
    const { ctx, width: w, height: h } = this.#vp;
    const game = this.#game;

    ctx.save();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    this.#shake = Math.max(0, this.#shake - dt * 3);
    this.#hitFlash = Math.max(0, this.#hitFlash - dt * 5);
    if (this.#shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.#shake * 7, (Math.random() - 0.5) * this.#shake * 7);
    }

    const element = game.resonantElement ? ELEMENT_BY_ID.get(game.resonantElement) : undefined;
    const tint = element?.color ?? NEUTRAL;
    const cx = w / 2;
    const cy = h * 0.45;
    // Bounded on both axes rather than by the smaller one: phone canvases are
    // far taller than wide, and keying off `min` alone leaves the entity
    // marooned in dead space.
    const radius = Math.min(w * 0.3, h * 0.28);

    this.#drawEntity(cx, cy, radius, tint, elapsed, game);
    this.#drawHealthRing(cx, cy, radius * 1.42, game, tint);
    this.#drawFloaters(dt);

    ctx.restore();
  }

  #drawEntity(cx: number, cy: number, r: number, tint: string, t: number, game: Game): void {
    const { ctx } = this.#vp;

    // Breathing scale, plus a kick on hit.
    const pulse = 1 + Math.sin(t * 1.8) * 0.035 + this.#hitFlash * 0.07;
    const rr = r * pulse;

    // Aura.
    const glow = ctx.createRadialGradient(cx, cy, rr * 0.3, cx, cy, rr * 2.1);
    glow.addColorStop(0, `${tint}44`);
    glow.addColorStop(1, `${tint}00`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 2.1, 0, Math.PI * 2);
    ctx.fill();

    // Body: a wobbling blob whose lobe count keys off the archetype, so each
    // enemy reads as a distinct silhouette without any art.
    const lobes = 5 + (game.archetype.id.charCodeAt(0) % 4);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const wobble = 1 + Math.sin(a * lobes + t * 1.3) * 0.11 + Math.sin(a * 3 - t * 0.8) * 0.05;
      const x = cx + Math.cos(a) * rr * wobble;
      const y = cy + Math.sin(a) * rr * wobble;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const body = ctx.createLinearGradient(cx, cy - rr, cx, cy + rr);
    body.addColorStop(0, `${tint}dd`);
    body.addColorStop(1, `${tint}55`);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = tint;
    ctx.lineWidth = 2;
    ctx.stroke();

    // White-out on impact.
    if (this.#hitFlash > 0) {
      ctx.globalAlpha = this.#hitFlash * 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Core.
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1020';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = tint;
    ctx.fill();
  }

  #drawHealthRing(cx: number, cy: number, r: number, game: Game, tint: string): void {
    const { ctx } = this.#vp;
    const frac = Math.max(0, Math.min(1, game.enemyHp / game.enemyMaxHp));

    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.stroke();

    if (frac > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.strokeStyle = tint;
      ctx.stroke();
    }

    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(232,236,247,0.75)';
    ctx.fillText(`${fmt(Math.max(0, game.enemyHp))} / ${fmt(game.enemyMaxHp)}`, cx, cy + r + 12);
  }

  #drawFloaters(dt: number): void {
    const { ctx } = this.#vp;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = this.#floaters.length - 1; i >= 0; i--) {
      const f = this.#floaters[i]!;
      f.life -= dt * 1.1;
      if (f.life <= 0) {
        this.#floaters.splice(i, 1);
        continue;
      }
      f.y += f.vy * dt;
      f.vy += 40 * dt;

      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.font = `700 ${Math.round(17 * f.scale)}px system-ui, sans-serif`;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}
