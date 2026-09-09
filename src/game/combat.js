// T1-N05 · Damage & health, and T1-N07 · combat feel (hitstop, shake, knockback, flash).
import { clamp, normalize } from '../core/math.js';
import { damageTakenFactor, hasStatus } from './status.js';

// A damage packet, not a number. Flags travel with it so systems downstream
// (root window, husks, allocation payout) can read intent rather than guess.
export function makeDamage(amount, opts = {}) {
  return {
    amount,
    type: opts.type ?? 'physical',
    source: opts.source ?? null,
    knockback: opts.knockback ?? 0,
    ignoreArmor: opts.ignoreArmor ?? false,
    ignoreIframes: opts.ignoreIframes ?? false,
    silent: opts.silent ?? false,
    crit: opts.crit ?? false,
  };
}

export function createCombat({ particles, camera, fx, events }) {
  const floaters = [];
  let hitstop = 0;

  function addFloater(x, y, text, color, big = false) {
    floaters.push({ x, y: y - 8, text, color, life: 0.85, maxLife: 0.85, vy: -46, big });
    if (floaters.length > 60) floaters.shift();
  }

  function applyDamage(target, packet) {
    if (!target || target.dead) return 0;
    if (target.invulnerable) { addFloater(target.x, target.y, 'warded', '#f4f1e8'); return 0; }
    if (hasStatus(target, 'immune') && !packet.ignoreIframes) {
      addFloater(target.x, target.y, 'warded', '#f4f1e8');
      return 0;
    }
    if (target.iframes > 0 && !packet.ignoreIframes) return 0;

    let amount = packet.amount;
    if (!packet.ignoreArmor) amount *= 1 - clamp(target.armor ?? 0, 0, 0.98);
    amount *= damageTakenFactor(target);
    amount = Math.max(0, amount);

    // Fully armored targets still report the hit, so "immune" reads as armor
    // working rather than as the game swallowing input (T2-N21).
    if (amount < 0.5 && packet.amount > 0) {
      if (!packet.silent) addFloater(target.x, target.y, 'blunted', '#8a8578');
      events?.emit('damage-blocked', { target, packet });
      return 0;
    }

    target.hp -= amount;
    target.hitFlash = 0.14;

    if (!packet.silent) {
      addFloater(target.x, target.y, Math.round(amount).toString(), packet.crit ? '#f7e08a' : '#f4f1e8', packet.crit);
    }

    if (packet.knockback > 0 && !target.immovable) {
      const src = packet.source;
      const n = src ? normalize(target.x - src.x, target.y - src.y) : { x: 0, y: -1 };
      const k = packet.knockback / Math.max(0.2, target.mass);
      target.knockVx += n.x * k;
      target.knockVy += n.y * k;
    }

    particles?.burst(target.x, target.y, packet.crit ? 10 : 5, {
      color: packet.type === 'rot' ? '#8fbf5a' : '#e8c9a0',
      speed: 90 + packet.knockback * 0.4,
      life: 0.3, size: 2.4,
    });

    // Hitstop is frames, not seconds — it must not scale with damage or big hits
    // turn into stutter. F-N02.
    hitstop = Math.max(hitstop, packet.crit ? 0.075 : 0.035);
    if (packet.source?.isPlayerControlled) camera?.addShake(packet.crit ? 0.32 : 0.13);

    events?.emit('damage', { target, packet, amount });

    if (target.hp <= 0) kill(target, packet.source);
    return amount;
  }

  function kill(target, killer) {
    if (target.dead) return;
    target.dead = true;
    target.hp = 0;
    target.corpseTimer = target.persistent ? Infinity : 4;
    target.solid = false;
    target.targetable = false;
    particles?.burst(target.x, target.y, 22, { color: '#c25b4e', speed: 190, life: 0.6, size: 3 });
    camera?.addShake(0.2);
    events?.emit('death', { entity: target, killer });
  }

  function heal(target, amount) {
    if (!target || target.dead) return 0;
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    const gained = target.hp - before;
    if (gained > 0.5) addFloater(target.x, target.y, `+${Math.round(gained)}`, '#8fd48a');
    return gained;
  }

  function update(dt) {
    if (hitstop > 0) hitstop = Math.max(0, hitstop - dt);
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy *= Math.pow(0.9, dt * 60);
      if (f.life <= 0) floaters.splice(i, 1);
    }
  }

  function drawFloaters(ctx) {
    ctx.textAlign = 'center';
    for (const f of floaters) {
      const t = f.life / f.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.font = `${f.big ? 700 : 500} ${f.big ? 17 : 13}px ui-monospace, monospace`;
      ctx.fillStyle = '#000';
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  return {
    applyDamage, kill, heal, update, drawFloaters, addFloater,
    // Hitstop freezes the sim, so the loop asks before stepping.
    get hitstop() { return hitstop; },
    isFrozen: () => hitstop > 0,
  };
}
