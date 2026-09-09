// T3-N05 · HUD. All state readable without opening a menu — and the idle timer
// is legible to EVERYONE, attackers included, because it is the shared clock the
// whole fight is scheduled around.
import { clamp } from '../core/math.js';
import { MODE } from '../game/world.js';
import { BOSS_ABILITIES } from '../game/boss.js';
import { SPIRITS, possessionTier } from '../game/spirits.js';
import { swingUptime, bandOf } from '../game/weapons.js';
import { INTENT } from '../core/input.js';
import { LEVELS, LEVEL_FOR_THRONE } from '../game/levels.js';

// One mono for every number in the game, one condensed face for the few places
// the game speaks in its own voice. Both fall back cleanly if the webfont never
// arrives — canvas re-renders every frame, so there is no flash to manage.
export const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const DISPLAY = '"IBM Plex Sans Condensed", "IBM Plex Mono", ui-monospace, sans-serif';

const F = (px, weight = 400) => `${weight} ${px}px ${MONO}`;
const D = (px, weight = 700) => `${weight} ${px}px ${DISPLAY}`;

export function drawHud(ctx, world, input, loopState) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  const playerIsBoss = world.boss?.isPlayerControlled && world.mode === MODE.FIGHT;

  if (world.mode === MODE.TITLE) { drawTitle(ctx, W, H); ctx.restore(); return; }

  // The idle timer belongs to the room, not to one side.
  if (world.boss && (world.mode === MODE.FIGHT || world.mode === MODE.TRANSFORMATION)) {
    drawIdleTimer(ctx, world, W);
    drawRootArmor(ctx, world, W, H);
  }

  if (playerIsBoss) drawBossHud(ctx, world, input, W, H);
  else drawAttackerHud(ctx, world, input, W, H);

  if (world.level?.openWorld && world.mode === MODE.RUNUP) drawObjective(ctx, world, W, H);
  drawLog(ctx, world, W, H);
  drawPrompts(ctx, world, input, W, H);

  if (world.mode === MODE.SAFEROOM) drawSafeRoom(ctx, world, input, W, H);
  if (world.mode === MODE.MERCY) drawMercy(ctx, world, W, H);
  if (world.mode === MODE.ALLOCATION) drawAllocation(ctx, world, input, W, H);
  if (world.mode === MODE.RESULT) drawResult(ctx, world, W, H);
  if (world.mode === MODE.TRANSFORMATION) drawTransformVeil(ctx, world, W, H);
  if (world.debug) drawDebug(ctx, world, loopState, W, H);

  ctx.restore();
}

// ── shared ──────────────────────────────────────────────────────────────────
function bar(ctx, x, y, w, h, frac, fill, bg = 'rgba(0,0,0,0.55)') {
  ctx.fillStyle = bg;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,9,7,0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(200,185,140,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

// ── the shared clock (T2-N06) ───────────────────────────────────────────────
function drawIdleTimer(ctx, world, W) {
  const b = world.boss;
  const frac = clamp(b.idleTimer / b.idleLimit, 0, 1);
  const urgent = b.idleTimer < 6;
  const w = 420, x = (W - w) / 2, y = 18;

  panel(ctx, x - 10, y - 14, w + 20, 46);
  ctx.font = F(10, 600);
  ctx.fillStyle = urgent ? '#e2685f' : 'rgba(230,226,214,0.7)';
  ctx.textAlign = 'center';
  // T7-N04 · timer as colour AND number. Never colour alone.
  ctx.fillText(
    urgent ? `SOMETHING IS BUILDING — ${b.idleTimer.toFixed(1)}s` : `QUIET FOR ${(b.idleLimit - b.idleTimer).toFixed(1)}s`,
    W / 2, y,
  );
  bar(ctx, x, y + 8, w, 10, frac, urgent ? '#e2685f' : '#c9a24a');
  ctx.textAlign = 'left';
}

// T2-N21 · armor ticks down visibly as nodes die, so clearing reads as progress.
function drawRootArmor(ctx, world, W, H) {
  const b = world.boss;
  const armor = b.currentArmor();
  const open = b.rootWindow > 0;
  const w = 260, x = W - w - 20, y = 20;
  panel(ctx, x - 10, y - 14, w + 20, 62);
  ctx.font = F(10, 600);
  ctx.fillStyle = open ? '#8fd48a' : 'rgba(230,226,214,0.7)';
  ctx.fillText(open ? 'ROOT OPEN' : `ROOT ARMOUR ${Math.round(armor * 100)}%`, x, y);
  bar(ctx, x, y + 8, w, 9, open ? b.rootWindow / 2.4 : armor, open ? '#8fd48a' : '#7a6f58');
  ctx.font = F(9);
  ctx.fillStyle = 'rgba(230,226,214,0.45)';
  ctx.fillText(`${world.network.count} nodes · phase ${b.phase}`, x, y + 34);
  if (world.escapeTimer > 0) {
    ctx.fillStyle = '#c9a24a';
    ctx.fillText(`STARVING — hold ${(14 - world.escapeTimer).toFixed(1)}s`, x, y + 46);
  }
}

// ── attacker HUD ────────────────────────────────────────────────────────────
function drawAttackerHud(ctx, world, input, W, H) {
  const p = world.player;
  // The seated player has no weapon and no abilities — they were torn down by
  // the swap. Fall back to the spectator/downed read rather than the kit read.
  if (!p || !p.weapon) return;
  const x = 20, y = H - 128;
  panel(ctx, x - 10, y - 14, 340, 128);

  ctx.font = F(11, 600);
  ctx.fillStyle = p.spectating ? '#a074c9' : '#e8e2d0';
  ctx.fillText(p.spectating ? 'DOWN — SPECTATING' : `LVL ${p.level}`, x, y);
  bar(ctx, x, y + 8, 300, 12, p.hp / p.maxHp, p.spectating ? '#5b4a6b' : '#7fc08a');
  ctx.font = F(9);
  ctx.fillStyle = 'rgba(230,226,214,0.6)';
  ctx.fillText(`${Math.max(0, Math.round(p.hp))}/${p.maxHp}`, x + 4, y + 18);
  bar(ctx, x, y + 26, 300, 5, p.xp / p.xpToNext, '#6ec1e4');

  // Target frame.
  const t = p.target;
  ctx.font = F(10, 600);
  ctx.fillStyle = 'rgba(230,226,214,0.85)';
  ctx.fillText(t && !t.dead ? `» ${t.name || t.kind}` : '» no target', x, y + 48);
  if (t && !t.dead) bar(ctx, x, y + 54, 300, 6, t.hp / t.maxHp, '#c25b4e');

  // F-N03 · effective swing uptime. Both skilled and unskilled players see it,
  // which is the whole point of the exit gate.
  const up = swingUptime(p.weapon);
  ctx.font = F(9);
  ctx.fillStyle = up > 0.6 ? '#8fd48a' : up > 0.35 ? '#c9a24a' : '#c25b4e';
  ctx.fillText(`${p.weapon.def.name} · band ${bandOf(p.weapon).map(Math.round).join('–')} · uptime ${Math.round(up * 100)}%`, x, y + 74);

  ctx.fillStyle = '#c9a24a';
  ctx.fillText(`salvage ${p.salvage}  banked ${p.bankedSalvage}`, x, y + 88);

  // Possession, stated as a number and never explained.
  const tier = possessionTier(p.possession ?? 0);
  ctx.fillStyle = p.possession > 13 ? '#a074c9' : 'rgba(230,226,214,0.6)';
  ctx.fillText(`possession ${p.possession ?? 0} · ${tier.label}`, x, y + 100);

  drawAbilityBar(ctx, p, input, W, H);
}

function drawAbilityBar(ctx, p, input, W, H) {
  const slots = p.abilities ?? [];
  const size = 46, gap = 8;
  const total = slots.length * (size + gap) - gap;
  let x = (W - total) / 2, y = H - 66;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const ready = s.cooldown <= 0;
    panel(ctx, x, y, size, size);
    ctx.font = F(9, 600);
    ctx.fillStyle = ready ? '#e8e2d0' : 'rgba(230,226,214,0.35)';
    ctx.textAlign = 'center';
    ctx.fillText(s.def.name.split(' ')[0].slice(0, 8), x + size / 2, y + 20);
    ctx.font = F(9);
    ctx.fillStyle = 'rgba(230,226,214,0.45)';
    ctx.fillText(input.keyFor([INTENT.ABILITY_1, INTENT.ABILITY_2, INTENT.ABILITY_3, INTENT.ABILITY_4][i]), x + size / 2, y + 40);
    if (!ready) {
      // A-N11 · readiness legible at a glance, for you and for your allies.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const h = size * (s.cooldown / s.def.cooldown);
      ctx.fillRect(x, y + size - h, size, h);
      ctx.fillStyle = '#c9a24a';
      ctx.fillText(s.cooldown.toFixed(1), x + size / 2, y + 30);
    }
    ctx.textAlign = 'left';
    x += size + gap;
  }
}

// ── boss HUD (T2-N13) ───────────────────────────────────────────────────────
function drawBossHud(ctx, world, input, W, H) {
  const b = world.boss;
  const x = 20, y = H - 150;
  panel(ctx, x - 10, y - 14, 380, 150);

  ctx.font = F(11, 600);
  ctx.fillStyle = '#8fbf5a';
  ctx.fillText('SEATED', x, y);
  bar(ctx, x, y + 8, 340, 12, b.entity.hp / b.entity.maxHp, '#6f8f45');

  ctx.font = F(10, 600);
  ctx.fillStyle = '#c9a24a';
  ctx.fillText(`BIOMASS ${Math.floor(b.biomass)}  (+${world.network.income().toFixed(1)}/s)`, x, y + 38);
  bar(ctx, x, y + 44, 340, 8, b.biomass / 220, '#c9a24a');

  // T2-N19 · the whole game in one meter. Power on condition you stop deciding.
  ctx.fillStyle = b.overgrowth > 50 ? '#a074c9' : 'rgba(230,226,214,0.6)';
  ctx.fillText(`OVERGROWTH ${Math.round(b.overgrowth)}%`, x, y + 68);
  bar(ctx, x, y + 74, 340, 8, b.overgrowth / 100, '#a074c9');

  ctx.font = F(9);
  ctx.fillStyle = 'rgba(230,226,214,0.5)';
  ctx.fillText(`gaze: ${b.selectedNode ? `${b.selectedNode.type} node` : 'nothing left'} · ${input.keyFor(INTENT.TARGET_NEXT)} to move it`, x, y + 96);
  ctx.fillText(`growing: ${b.growType} (${input.keyFor(INTENT.CANCEL)} to change)`, x, y + 108);
  if (b.marked) ctx.fillText(`marked: ${b.marked.name}`, x, y + 120);
  if (b.spared) ctx.fillText(`sparing: ${b.spared.name}`, x + 170, y + 120);

  // Boss ability bar, keyed identically to the attacker one so the role swap
  // does not feel like switching games.
  const ids = ['line', 'bloom', 'tether'];
  const size = 52, gap = 8;
  let bx = (W - (4 * (size + gap) - gap)) / 2, by = H - 74;
  ids.forEach((id, i) => {
    const def = BOSS_ABILITIES[id];
    const cd = b.cooldowns[id];
    const cost = b.costOf(id);
    const affordable = b.biomass >= cost;
    panel(ctx, bx, by, size, size);
    ctx.textAlign = 'center';
    ctx.font = F(10, 600);
    ctx.fillStyle = cd <= 0 && affordable ? '#e8e2d0' : 'rgba(230,226,214,0.3)';
    ctx.fillText(def.name, bx + size / 2, by + 20);
    ctx.font = F(9);
    ctx.fillStyle = affordable ? '#c9a24a' : '#c25b4e';
    ctx.fillText(`${cost}`, bx + size / 2, by + 33);
    ctx.fillStyle = 'rgba(230,226,214,0.45)';
    ctx.fillText(input.keyFor([INTENT.ABILITY_1, INTENT.ABILITY_2, INTENT.ABILITY_3][i]), bx + size / 2, by + 46);
    if (cd > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const h = size * (cd / def.cooldown);
      ctx.fillRect(bx, by + size - h, size, h);
    }
    ctx.textAlign = 'left';
    bx += size + gap;
  });
  // Grow.
  panel(ctx, bx, by, size, size);
  ctx.textAlign = 'center';
  ctx.font = F(10, 600);
  ctx.fillStyle = b.cooldowns.grow <= 0 ? '#8fbf5a' : 'rgba(230,226,214,0.3)';
  ctx.fillText('Grow', bx + size / 2, by + 20);
  ctx.font = F(9);
  ctx.fillStyle = 'rgba(230,226,214,0.45)';
  ctx.fillText(input.keyFor(INTENT.ABILITY_4), bx + size / 2, by + 46);
  ctx.textAlign = 'left';

  if (b.casting) {
    ctx.textAlign = 'center';
    ctx.font = F(11, 600);
    ctx.fillStyle = '#e2685f';
    ctx.fillText(`${BOSS_ABILITIES[b.casting.id].name} — ${input.keyFor(INTENT.STEP)} to pull it`, W / 2, by - 14);
    ctx.textAlign = 'left';
  }
}

// ── contextual prompts ──────────────────────────────────────────────────────
function drawPrompts(ctx, world, input, W, H) {
  const p = world.player;
  if (!p || p.spectating) return;
  const lines = [];

  if (world.mode === MODE.THRONE_STANDOFF) {
    const d = Math.hypot(p.x - world.throne.x, p.y - world.throne.y);
    if (d < 90) lines.push(`HOLD ${input.keyFor(INTENT.INTERACT)} TO SIT`);
    else lines.push(`${Math.ceil(world.standoffTimer)}s — someone is going to sit`);
  }
  if (world.mode === MODE.SAFEROOM) lines.push(`${input.keyFor(INTENT.CONFIRM)} to go on`);
  if (world.exitOpen && !world.level?.openWorld) lines.push('the way on is open');

  if (!lines.length) return;
  ctx.textAlign = 'center';
  ctx.font = F(13, 700);
  let y = H - 190;
  for (const l of lines) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(l, W / 2 + 1, y + 1);
    ctx.fillStyle = '#f4f1e8';
    ctx.fillText(l, W / 2, y);
    y += 20;
  }
  ctx.textAlign = 'left';
}

// The open world has no body count to clear, so it needs a stated goal and a
// direction. Both live here rather than in a tutorial box.
function drawObjective(ctx, world, W, H) {
  const p = world.player;
  if (!p) return;
  const ready = p.level >= LEVEL_FOR_THRONE;
  const x = W - 270, y = 34;
  panel(ctx, x - 12, y - 20, 262, ready ? 52 : 66);

  ctx.font = F(10, 700);
  ctx.fillStyle = ready ? '#8fd48a' : '#c9a24a';
  ctx.fillText(ready ? 'THE WAY DOWN IS OPEN' : `REACH LEVEL ${LEVEL_FOR_THRONE}`, x, y);

  ctx.font = F(9);
  ctx.fillStyle = 'rgba(230,226,214,0.6)';
  if (ready) {
    ctx.fillText('or stay up here as long as you like', x, y + 16);
  } else {
    ctx.fillText(`level ${p.level} — ${p.xpToNext - p.xp} xp to go`, x, y + 16);
    bar(ctx, x, y + 24, 238, 6, p.xp / p.xpToNext, '#6ec1e4');
    ctx.fillStyle = 'rgba(230,226,214,0.4)';
    ctx.fillText('camps refill. nothing here stays cleared.', x, y + 42);
  }

  // A pointer to the exit, drawn at the screen edge when it is off-camera.
  if (world.exit) drawExitPointer(ctx, world, W, H, ready);
}

function drawExitPointer(ctx, world, W, H, ready) {
  const p = world.player;
  const dx = world.exit.x - p.x, dy = world.exit.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 300) return;
  const a = Math.atan2(dy, dx);
  const r = Math.min(W, H) * 0.36;
  const cx = W / 2 + Math.cos(a) * r;
  const cy = H / 2 + Math.sin(a) * r;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.globalAlpha = ready ? 0.8 : 0.3;
  ctx.fillStyle = ready ? '#c9a24a' : '#6b5c3f';
  ctx.beginPath();
  ctx.moveTo(12, 0); ctx.lineTo(-8, 7); ctx.lineTo(-8, -7);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawLog(ctx, world, W, H) {
  ctx.font = F(11);
  let y = 92;
  for (const l of world.log) {
    const a = clamp(l.life / 2, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = l.tone === 'grave' ? '#c9a24a'
      : l.tone === 'boss' ? '#a074c9'
      : l.tone === 'warn' ? '#e2685f'
      : l.tone === 'hint' ? 'rgba(230,226,214,0.55)'
      : 'rgba(230,226,214,0.8)';
    ctx.fillText(l.text, 20, y);
    y += 17;
  }
  ctx.globalAlpha = 1;
}

// ── D4 · the mercy choice ───────────────────────────────────────────────────
function drawMercy(ctx, world, W, H) {
  const m = world.mercy;
  ctx.fillStyle = 'rgba(8,7,5,0.86)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = D(30, 700);
  ctx.fillStyle = '#f4f1e8';
  ctx.fillText('The fungus lets go.', W / 2, H / 2 - 90);
  ctx.font = F(13);
  ctx.fillStyle = 'rgba(230,226,214,0.75)';
  ctx.fillText(`${m.sitter.name} is on the floor, human again, dying.`, W / 2, H / 2 - 60);
  ctx.fillText('Spare them and they decide who gets paid. Kill them and nobody does.', W / 2, H / 2 - 38);

  if (m.playerDecides) {
    ctx.font = F(15, 700);
    ctx.fillStyle = '#8fd48a';
    ctx.fillText('ENTER — spare them', W / 2, H / 2 + 20);
    ctx.fillStyle = '#c25b4e';
    ctx.fillText('ESC — finish it', W / 2, H / 2 + 48);
    ctx.font = F(11);
    ctx.fillStyle = 'rgba(230,226,214,0.5)';
    ctx.fillText(`${Math.ceil(m.timer)}s`, W / 2, H / 2 + 82);
  } else {
    ctx.font = F(13);
    ctx.fillStyle = 'rgba(230,226,214,0.6)';
    ctx.fillText('The others are deciding. You are not part of it.', W / 2, H / 2 + 24);
  }
  ctx.textAlign = 'left';
}

// ── T2-N34 · the allocation ─────────────────────────────────────────────────
function drawAllocation(ctx, world, input, W, H) {
  const a = world.allocation;
  ctx.fillStyle = 'rgba(8,7,5,0.9)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = D(28, 700);
  ctx.fillStyle = '#c9a24a';
  ctx.fillText('THE ALLOCATION', W / 2, 90);
  ctx.font = F(12);
  ctx.fillStyle = 'rgba(230,226,214,0.7)';
  const mine = a.allocator === world.player;
  ctx.fillText(mine
    ? 'You hold the chair. You decide who gets paid.'
    : `${a.allocator.name} holds the chair. You are waiting to hear your number.`, W / 2, 116);
  ctx.fillText(`pot ${a.pot} · unassigned ${a.remaining} · ${Math.ceil(a.timer)}s`, W / 2, 138);

  let y = 190;
  a.claimants.forEach((c, i) => {
    const share = a.shares.get(c.id) ?? 0;
    const sel = mine && i === a.cursor;
    ctx.textAlign = 'left';
    const x = W / 2 - 200;
    if (sel) {
      ctx.fillStyle = 'rgba(201,162,74,0.16)';
      ctx.fillRect(x - 10, y - 16, 420, 26);
    }
    ctx.font = F(13, sel ? 700 : 400);
    ctx.fillStyle = c === a.allocator ? '#a074c9' : c === world.player ? '#f4f1e8' : 'rgba(230,226,214,0.75)';
    ctx.fillText(`${c === world.player ? 'You' : c.name}${c === a.allocator ? ' (the one who sat)' : ''}`, x, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = share > 0 ? '#c9a24a' : 'rgba(230,226,214,0.3)';
    ctx.fillText(String(share), x + 400, y);
    y += 30;
  });

  if (mine) {
    ctx.textAlign = 'center';
    ctx.font = F(11);
    ctx.fillStyle = 'rgba(230,226,214,0.55)';
    ctx.fillText(`${input.keyFor(INTENT.TARGET_NEXT)} choose · 1 give 10% · 2 give 25% · 3 take back · ENTER finish`, W / 2, H - 80);
    ctx.fillStyle = 'rgba(230,226,214,0.35)';
    ctx.fillText('Anything you do not assign simply burns.', W / 2, H - 60);
  }
  ctx.textAlign = 'left';
}

function drawResult(ctx, world, W, H) {
  const r = world.result;
  ctx.fillStyle = 'rgba(8,7,5,0.92)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = D(32, 700);
  ctx.fillStyle = r.kind === 'escaped' ? '#8fd48a' : '#f4f1e8';
  ctx.fillText(r.title, W / 2, H / 2 - 60);
  ctx.font = F(13);
  ctx.fillStyle = 'rgba(230,226,214,0.72)';
  ctx.fillText(r.body, W / 2, H / 2 - 26);

  if (r.payout?.payouts?.length) {
    let y = H / 2 + 10;
    for (const p of r.payout.payouts) {
      ctx.fillStyle = p.who === world.player ? '#c9a24a' : 'rgba(230,226,214,0.6)';
      ctx.fillText(`${p.who === world.player ? 'You' : p.who.name}: ${p.amount}`, W / 2, y);
      y += 20;
    }
    if (r.payout.burned > 0) {
      ctx.fillStyle = 'rgba(194,91,78,0.8)';
      ctx.fillText(`${r.payout.burned} burned`, W / 2, y + 6);
    }
  }
  ctx.font = F(11);
  ctx.fillStyle = 'rgba(230,226,214,0.45)';
  ctx.fillText('ENTER to begin again', W / 2, H - 70);
  ctx.textAlign = 'left';
}

function drawTransformVeil(ctx, world, W, H) {
  const t = clamp(1 - world.transformTimer / 4.2, 0, 1);
  ctx.fillStyle = `rgba(20,30,12,${0.15 + Math.sin(t * Math.PI) * 0.5})`;
  ctx.fillRect(0, 0, W, H);
}

// W-N10 · the room with no combat in it.
function drawSafeRoom(ctx, world, input, W, H) {
  const p = world.player;
  ctx.fillStyle = 'rgba(8,7,5,0.88)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.font = D(26, 700);
  ctx.fillStyle = '#f4f1e8';
  ctx.fillText('Nothing follows you in here.', W / 2, 90);
  ctx.font = F(12);
  ctx.fillStyle = 'rgba(230,226,214,0.65)';
  ctx.fillText(`banked ${p.bankedSalvage} salvage · capacity ${p.loadout.capacity}`, W / 2, 118);

  ctx.textAlign = 'left';
  let y = 170;
  const x = W / 2 - 250;
  ctx.font = F(12, 700);
  ctx.fillStyle = '#c9a24a';
  ctx.fillText('BOUND SPIRITS', x, y);
  y += 22;
  ctx.font = F(11);
  for (const id of p.loadout.equipped) {
    const s = SPIRITS[id];
    ctx.fillStyle = s.possession >= 5 ? '#a074c9' : 'rgba(230,226,214,0.75)';
    ctx.fillText(`${s.name} — ${s.desc}`, x, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(230,226,214,0.4)';
    ctx.fillText(`cap ${s.capacity} · poss ${s.possession}`, x + 500, y);
    ctx.textAlign = 'left';
    y += 18;
  }
  if (!p.loadout.equipped.length) {
    ctx.fillStyle = 'rgba(230,226,214,0.4)';
    ctx.fillText('nothing yet. Break a husk.', x, y);
    y += 18;
  }

  y += 24;
  ctx.font = F(12, 700);
  ctx.fillStyle = '#c9a24a';
  ctx.fillText('NEXT', x, y);
  y += 20;
  ctx.font = F(11);
  const next = LEVELS[world.levelIndex + 1];
  ctx.fillStyle = 'rgba(230,226,214,0.7)';
  if (next) {
    ctx.fillText(`${next.name} — ${next.subtitle}`, x, y);
    if (next.unlocks) {
      y += 18;
      ctx.fillStyle = '#8fd48a';
      ctx.fillText(`you will be given: ${next.unlocks.replace(/_/g, ' ')}`, x, y);
    }
  }
  ctx.textAlign = 'center';
  ctx.font = F(12, 700);
  ctx.fillStyle = '#f4f1e8';
  ctx.fillText(`ENTER — go on`, W / 2, H - 70);
  ctx.textAlign = 'left';
}

function drawTitle(ctx, W, H) {
  ctx.textAlign = 'center';
  ctx.font = D(42, 700);
  ctx.fillStyle = '#c9a24a';
  ctx.fillText('THE CHAIR IS NOT LOCKED', W / 2, H / 2 - 70);
  ctx.font = F(13);
  ctx.fillStyle = 'rgba(230,226,214,0.7)';
  const lines = [
    'You are a salvager. There is a rumour of something at the bottom of this place.',
    '',
    'WASD move · TAB target · SPACE step · E interact/loot · 1-4 abilities',
    'Your weapon swings itself, but only inside its band. Holding that band is the game.',
    '',
    'ENTER to begin',
  ];
  let y = H / 2 - 20;
  for (const l of lines) { ctx.fillText(l, W / 2, y); y += 22; }
  ctx.textAlign = 'left';
}

// T0-N06 · debug overlay. Built early; pays for itself by Tier 2.
function drawDebug(ctx, world, loop, W, H) {
  const p = world.player;
  panel(ctx, W - 250, H - 190, 240, 176);
  ctx.font = F(10);
  ctx.fillStyle = '#8fd48a';
  const lines = [
    `fps ${loop.fps}  tick ${loop.tickMs.toFixed(2)}ms`,
    `render ${loop.renderMs.toFixed(2)}ms  x${loop.timescale}`,
    `entities ${world.entities.list.length}`,
    `projectiles ${world.projectiles.length}`,
    `particles/telegraphs ${world.telegraphs.list.length}`,
    `mode ${world.mode}`,
    `nodes ${world.network?.count ?? 0} / peak ${world.network?.peakNodes ?? 0}`,
    `biomass ${world.boss ? Math.floor(world.boss.biomass) : '-'}`,
    `overgrowth ${world.boss ? Math.round(world.boss.overgrowth) : '-'}`,
    `cruelty ${world.boss ? Math.round(world.boss.cruelty ?? 0) : '-'}`,
    `uptime ${p?.weapon ? Math.round(swingUptime(p.weapon) * 100) : 0}%`,
    `node kills ${world.stats.nodeKills} · window hits ${world.stats.windowHits}`,
    `t/first death ${world.stats.timeToFirstDeath?.toFixed(1) ?? '-'}`,
  ];
  let y = H - 172;
  for (const l of lines) { ctx.fillText(l, W - 240, y); y += 13; }
}
