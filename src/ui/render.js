// T7-N01/T7-N03 · Drawing. Everything readable in grayscale at 50% zoom, because
// the silhouette test is the one that matters for the network (risk register).
import { TAU, clamp, dist } from '../core/math.js';
import { FACTION } from '../engine/entity.js';
import { NODE_TYPE } from '../game/network.js';
import { SHAPE } from '../game/telegraph.js';
import { MODE } from '../game/world.js';
import { bandOf, inBand } from '../game/weapons.js';
import { SIT_HOLD } from '../game/throne.js';
import { MONO } from './hud.js';

const PAL = {
  floor: '#15140f',
  floorAlt: '#1a1812',
  wall: '#3a352a',
  wallTop: '#4a4436',
  hazard: '#1d2a2c',
  fungus: '#2c3a20',
  scar: '#241f16',
  node: '#8fbf5a',
  nodeDark: '#4f6b30',
  player: '#e8e2d0',
  ally: '#9fb6c9',
  enemy: '#a8523f',
  husk: '#7d7263',
  throne: '#6b5c3f',
  root: '#c9a24a',
  ink: '#0b0a07',
};

export function drawWorld(ctx, world, camera, alpha) {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = PAL.floor;
  ctx.fillRect(0, 0, width, height);

  // Nothing has been loaded yet at the title, so there is no room to draw — and
  // drawing the default bounds anyway put a stray slab of floor behind the text.
  if (world.mode === MODE.TITLE) return;

  ctx.save();
  camera.apply(ctx);

  drawFloor(ctx, world, camera);
  drawHazards(ctx, world);
  if (world.camps?.length) drawCamps(ctx, world);
  drawFungusPatches(ctx, world);
  if (world.network) {
    drawScars(ctx, world.network);
    drawNetworkLinks(ctx, world.network);
  }
  drawWalls(ctx, world);
  drawDrops(ctx, world);
  drawHusks(ctx, world);
  if (world.throne) drawThrone(ctx, world);
  if (world.network) drawNodes(ctx, world);
  drawTelegraphs(ctx, world);
  drawEntities(ctx, world);
  drawProjectiles(ctx, world);
  world.particles.draw(ctx);
  world.combat.drawFloaters(ctx);
  if (world.exit) drawExit(ctx, world, world.exitOpen);

  ctx.restore();
}

function drawFloor(ctx, world, camera) {
  const b = world.bounds;
  ctx.fillStyle = PAL.floorAlt;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  // Slab grid: gives the camera something to move against without costing much.
  ctx.strokeStyle = 'rgba(255,255,255,0.028)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = b.x; x <= b.x + b.w; x += 128) { ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); }
  for (let y = b.y; y <= b.y + b.h; y += 128) { ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); }
  ctx.stroke();
}

function drawHazards(ctx, world) {
  for (const h of world.hazards) {
    ctx.fillStyle = PAL.hazard;
    ctx.fillRect(h.x, h.y, h.w, h.h);
    ctx.strokeStyle = 'rgba(140,190,200,0.22)';
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(h.x + 1, h.y + 1, h.w - 2, h.h - 2);
    ctx.setLineDash([]);
  }
}

// W-N09 · fungal presence rises level to level. It is background texture long
// before it is a mechanic.
function drawFungusPatches(ctx, world) {
  for (const p of world.fungusPatches) {
    ctx.globalAlpha = p.burned > 0 ? 0.15 : 0.5;
    ctx.fillStyle = p.burned > 0 ? '#4a3520' : PAL.fungus;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// T2-N25 · killed nodes leave a scar, not clean floor. Ground is contested,
// and the arena is a moving front line.
function drawScars(ctx, net) {
  ctx.fillStyle = PAL.scar;
  for (const s of net.scars) {
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 26, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#5c4a2e';
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

function drawNetworkLinks(ctx, net) {
  ctx.strokeStyle = 'rgba(143,191,90,0.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  const living = net.living;
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i], b = living[j];
      if (dist(a.x, a.y, b.x, b.y) > 132) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();
}

// T2-N12 · type is readable by SILHOUETTE, not colour alone.
function drawNodes(ctx, world) {
  const net = world.network;
  const selected = world.boss?.selectedNode;
  for (const n of net.living) {
    const burning = n.burning > 0;
    const hpFrac = clamp(n.hp / n.maxHp, 0, 1);
    const wobble = Math.sin(n.pulse) * 2;

    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.fillStyle = n.hitFlash > 0 ? '#fff' : burning ? '#6a4a28' : PAL.node;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;

    if (n.type === NODE_TYPE.SPORE) {
      // Three lobes.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + n.pulse * 0.1;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 9, Math.sin(a) * 9, 8 * hpFrac + 3, 0, TAU);
        ctx.fill(); ctx.stroke();
      }
    } else if (n.type === NODE_TYPE.LASH) {
      // Spiked spindle.
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const r = i % 2 === 0 ? 20 * hpFrac + 4 : 8;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else {
      // Concentric bulb.
      for (let r = 3; r >= 1; r--) {
        ctx.globalAlpha = r === 1 ? 1 : 0.35;
        ctx.beginPath();
        ctx.arc(0, 0, (r * 7 + wobble) * (0.5 + hpFrac * 0.5), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.stroke();
    }

    if (n.isRoot) {
      ctx.strokeStyle = PAL.root;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, TAU);
      ctx.stroke();
    }
    if (n === selected) {
      ctx.strokeStyle = '#f4f1e8';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (burning) {
      ctx.strokeStyle = '#ee8b3d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, TAU * clamp(n.burning / 6, 0, 1));
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawWalls(ctx, world) {
  for (const w of world.walls) {
    ctx.fillStyle = PAL.wall;
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = PAL.wallTop;
    ctx.fillRect(w.x, w.y, w.w, Math.min(6, w.h));
  }
  // W-N11 · the sealed door. It never opens.
  const d = world.sealedDoor;
  if (d) {
    ctx.fillStyle = '#2a2118';
    ctx.fillRect(d.x, d.y, d.w, d.h);
    ctx.strokeStyle = '#6b5c3f';
    ctx.lineWidth = 3;
    ctx.strokeRect(d.x, d.y, d.w, d.h);
    ctx.fillStyle = 'rgba(200,180,120,0.35)';
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('SEALED', d.x + d.w / 2, d.y + d.h + 14);
    ctx.textAlign = 'left';
  }
}

function drawThrone(ctx, world) {
  const t = world.throne;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.fillStyle = PAL.throne;
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-26, 20); ctx.lineTo(-26, -14); ctx.lineTo(-16, -40);
  ctx.lineTo(16, -40); ctx.lineTo(26, -14); ctx.lineTo(26, 20);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  if (t.sitProgress > 0 && !t.occupant) {
    // Deliberate hold, never a tap.
    ctx.strokeStyle = '#f4f1e8';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 44, -Math.PI / 2, -Math.PI / 2 + TAU * (t.sitProgress / SIT_HOLD));
    ctx.stroke();
  }
  ctx.restore();
}

function drawHusks(ctx, world) {
  for (const h of world.husks) {
    if (h.destroyed) continue;
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.globalAlpha = h.woken ? 1 : 0.8;
    ctx.fillStyle = PAL.husk;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;
    // Recognisably human, recognisably equipped.
    ctx.beginPath();
    ctx.ellipse(0, 4, 13, 16, 0, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -12, 7, 0, TAU);
    ctx.fill(); ctx.stroke();
    if (h.weapon) {
      ctx.strokeStyle = '#c9b98a';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(12, 12); ctx.lineTo(24, -8); ctx.stroke();
    }
    if (h.waking > 0) {
      ctx.strokeStyle = '#8fbf5a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 28, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - h.waking / 2.2));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

function drawDrops(ctx, world) {
  for (const d of world.drops) {
    ctx.save();
    ctx.translate(d.x, d.y);
    if (d.kind === 'salvage') {
      ctx.fillStyle = '#c9a24a';
      ctx.fillRect(-4, -4, 8, 8);
    } else if (d.kind === 'weapon') {
      ctx.strokeStyle = '#d8cfa8';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-8, 8); ctx.lineTo(8, -8); ctx.stroke();
    } else {
      ctx.fillStyle = '#a074c9';
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(8, 0); ctx.lineTo(0, 9); ctx.lineTo(-8, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}

function drawExit(ctx, world, open) {
  const e = world.exit;
  ctx.save();
  // Shut is drawn too, and drawn differently — you should always know where the
  // way on is, and whether it will let you through.
  ctx.globalAlpha = open ? 1 : 0.4;
  ctx.strokeStyle = open ? '#c9a24a' : '#6b5c3f';
  ctx.lineWidth = 3;
  ctx.setLineDash(open ? [8, 6] : [3, 9]);
  ctx.beginPath();
  ctx.arc(e.x, e.y, 42, 0, TAU);
  ctx.stroke();
  if (!open) {
    ctx.beginPath();
    ctx.moveTo(e.x - 22, e.y - 22); ctx.lineTo(e.x + 22, e.y + 22);
    ctx.moveTo(e.x + 22, e.y - 22); ctx.lineTo(e.x - 22, e.y + 22);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

// Camps read as territory: you can see where the ground belongs to something
// before you walk into it.
function drawCamps(ctx, world) {
  for (const c of world.camps) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#a8523f';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.radius, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// T7-N09 · shape encodes type, fill encodes timing, intensity encodes severity.
// Never colour alone.
function drawTelegraphs(ctx, world) {
  const tg = world.telegraphs;
  for (const t of tg.list) {
    const p = tg.progress(t);
    const cancelled = t.cancelled;
    ctx.save();
    ctx.globalAlpha = cancelled ? 0.3 : 0.55 + p * 0.35;

    if (t.shape === SHAPE.LINE) {
      const a = Math.atan2(t.y2 - t.y, t.x2 - t.x);
      const len = dist(t.x, t.y, t.x2, t.y2);
      ctx.translate(t.x, t.y);
      ctx.rotate(a);
      ctx.strokeStyle = '#f4f1e8';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, -t.width / 2, len, t.width);
      // The fill IS the countdown.
      ctx.fillStyle = cancelled ? 'rgba(180,170,150,0.25)' : 'rgba(230,120,90,0.45)';
      ctx.fillRect(0, -t.width / 2, len * p, t.width);
    } else if (t.shape === SHAPE.RING) {
      const r = t.radius > 5000 ? 4000 : t.radius;
      ctx.strokeStyle = '#f4f1e8';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.stroke();
      ctx.fillStyle = cancelled ? 'rgba(180,170,150,0.15)' : 'rgba(230,120,90,0.32)';
      ctx.beginPath(); ctx.arc(t.x, t.y, r * p, 0, TAU); ctx.fill();
    } else if (t.shape === SHAPE.THREAD) {
      ctx.strokeStyle = '#f4f1e8';
      ctx.lineWidth = 2;
      ctx.setLineDash([9, 7]);
      ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.x2, t.y2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = cancelled ? 'rgba(180,170,150,0.4)' : 'rgba(201,106,156,0.8)';
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + (t.x2 - t.x) * p, t.y + (t.y2 - t.y) * p);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawEntities(ctx, world) {
  const playerIsBoss = world.boss?.isPlayerControlled && world.mode === MODE.FIGHT;
  const bossId = world.bossEntity?.id;
  const sorted = [...world.entities.list].sort((a, b) => a.y - b.y);

  for (const e of sorted) {
    if (e.kind === 'throne') continue;

    // T2-N14 · boss vision. Hidden attackers are not drawn at all; the last-known
    // ghost is all the boss gets. (Server-filtered in the netcode model — the
    // client is never told where they are.)
    if (playerIsBoss && e.faction === FACTION.PLAYER && e.hiddenFrom?.has(bossId)) {
      if (e.lastKnown && e.lastKnown.age < 5) drawGhost(ctx, e.lastKnown);
      continue;
    }

    ctx.save();
    ctx.translate(e.x, e.y);

    if (e.dead) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#4a4238';
      ctx.beginPath(); ctx.ellipse(0, 0, e.radius * 1.3, e.radius * 0.6, 0, 0, TAU); ctx.fill();
      ctx.restore();
      continue;
    }

    // Shadow first: grounds everything and costs one ellipse.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(0, e.radius * 0.7, e.radius * 0.9, e.radius * 0.4, 0, 0, TAU); ctx.fill();

    const body = e.hitFlash > 0 ? '#fff'
      : e.kind === 'boss' ? '#6f8f45'
      : e.faction === FACTION.HOSTILE ? (e.color ?? PAL.enemy)
      : e.kind === 'husk' ? PAL.husk
      : e.isPlayerControlled ? PAL.player
      : (e.color ?? PAL.ally);

    ctx.fillStyle = body;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;

    if (e.kind === 'boss') {
      // The body is consumed. What sits there is mostly network.
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        const r = e.radius + Math.sin(i * 2.3 + performance.now() / 400) * 6;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, e.radius, 0, TAU);
      ctx.fill(); ctx.stroke();
      // P-N02 · facing is readable, and gear changes the silhouette.
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(e.facing) * (e.radius + 7), Math.sin(e.facing) * (e.radius + 7));
      ctx.stroke();
    }

    // Elites carry a broken outer ring — legible in grayscale, unlike colour.
    if (e.elite) {
      ctx.strokeStyle = '#f0b06a';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, e.radius + 6, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // G-N15 · possession is visible on the character. You can see who is running
    // hot before you decide who to trust with the chair.
    if (e.possession > 0) {
      const rings = Math.min(3, Math.floor(e.possession / 6));
      ctx.strokeStyle = 'rgba(160,116,201,0.6)';
      ctx.lineWidth = 1.5;
      for (let i = 1; i <= rings; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, e.radius + 4 + i * 4 + Math.sin(performance.now() / 300 + i) * 1.5, 0, TAU);
        ctx.stroke();
      }
    }

    // T2-N30 · the mark is a halo only the OTHERS can see.
    if (world.boss?.marked === e && !(e === world.player && world.boss.isPlayerControlled)) {
      ctx.strokeStyle = '#c96a9c';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(0, 0, e.radius + 12, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    // T2-N27 · spore taint. Indicates exposure, not corruption — which is
    // exactly why the accusations are fun.
    if (e.statuses?.some((s) => s.type === 'taint')) {
      ctx.fillStyle = 'rgba(160,116,201,0.75)';
      ctx.beginPath(); ctx.arc(e.radius * 0.6, -e.radius - 8, 3.5, 0, TAU); ctx.fill();
    }

    ctx.restore();

    drawHealthBar(ctx, e);
    if (e === world.player?.target) drawTargetRing(ctx, e);
    if (e.kind === 'attacker' && !e.isPlayerControlled) drawName(ctx, e);
  }
}

function drawGhost(ctx, lk) {
  ctx.save();
  ctx.globalAlpha = clamp(1 - lk.age / 5, 0, 1) * 0.5;
  ctx.strokeStyle = '#f4f1e8';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(lk.x, lk.y, 15, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawHealthBar(ctx, e) {
  if (e.dead || e.hp >= e.maxHp) return;
  const w = Math.max(26, e.radius * 2.4);
  const frac = clamp(e.hp / e.maxHp, 0, 1);
  const y = e.y - e.radius - 12;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(e.x - w / 2 - 1, y - 1, w + 2, 5);
  ctx.fillStyle = e.faction === FACTION.PLAYER ? '#7fc08a' : '#c25b4e';
  ctx.fillRect(e.x - w / 2, y, w * frac, 3);
}

function drawTargetRing(ctx, e) {
  // F-N04 · the lock should feel like a magnetic click. The ring snaps in.
  const t = clamp((e.targetAcquiredAt ?? 1) / 0.12, 0, 1);
  const r = e.radius + 16 + (1 - t) * 26;
  ctx.save();
  ctx.strokeStyle = '#f4f1e8';
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.4 + t * 0.6;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU + performance.now() / 1400;
    ctx.arc(e.x, e.y, r, a0, a0 + 0.55);
    ctx.stroke();
    ctx.beginPath();
  }
  ctx.restore();
}

function drawName(ctx, e) {
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(230,226,214,0.55)';
  ctx.fillText(e.pledged ? `${e.name} · pledged` : e.name, e.x, e.y - e.radius - 17);
  ctx.textAlign = 'left';
}

function drawProjectiles(ctx, world) {
  for (const p of world.projectiles) {
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, TAU);
    ctx.fill();
    // Trail: the cheapest legibility win in the whole renderer.
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// Band feedback: the player must be able to SEE the band they are supposed to
// hold, or F-N03's skill ceiling is invisible and therefore not a skill.
export function drawBandIndicator(ctx, world, camera) {
  const p = world.player;
  if (!p || p.dead || !p.weapon || !p.target || p.target.dead) return;
  if (world.boss?.isPlayerControlled && world.mode === MODE.FIGHT) return;
  const [lo, hi] = bandOf(p.weapon);
  const d = dist(p.x, p.y, p.target.x, p.target.y);
  const ok = inBand(p.weapon, d);
  ctx.save();
  camera.apply(ctx);
  ctx.globalAlpha = ok ? 0.5 : 0.28;
  ctx.strokeStyle = ok ? '#8fd48a' : '#c9a24a';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.beginPath(); ctx.arc(p.x, p.y, hi, 0, TAU); ctx.stroke();
  if (lo > 4) { ctx.beginPath(); ctx.arc(p.x, p.y, lo, 0, TAU); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.restore();
  ctx.globalAlpha = 1;
}
