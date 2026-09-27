/* Essence Protocol: merge reveals. A full-screen sequence for live-baked designs:
 *   1 converge  the essences (or parents) fly in from the edges, color-coded by role
 *   2 fuse      they spiral into a core and flash (the core pulses while a design promise resolves)
 *   3 rarity    the %RARITY% roll counts down on a dial and the tier stamps in
 *   4 powers    the name types out, then effects pop in one by one and stat bars fill
 * REVEAL.play(o) queues a reveal and resolves when it closes (click, Esc or timeout).
 *   o = { kicker, parts: [{ color, label, role }], sprite?: genome key, prism?, design: value | Promise }
 *   design -> { name, desc, tier, tierName?, pct, odds, chips: [{ t, c }], bars: [{ label, v, max }], note } | null
 * No DOM outside #reveal and no game state: the game builds the objects. */
(function (root) {
  'use strict';
  const TIER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const TC = ['#aab4c8', '#9fe', '#ffd23d', '#ff5cf0', '#46f3ff'];
  const q = [];
  let busy = false;
  const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  function play(o) { return new Promise(res => { q.push({ o, res }); if (!busy) next(); }); }
  function next() {
    const job = q.shift();
    if (!job) { busy = false; return; }
    busy = true;
    run(job.o).then(() => { job.res(); next(); });
  }

  function run(o) {
    return new Promise(done => {
      const el = document.createElement('div');
      el.id = 'reveal';
      el.innerHTML = `<canvas></canvas><div class="rv-card"><div class="rv-kick">${esc(o.kicker || 'Merge')}</div>
        <div class="rv-parts">${(o.parts || []).map(p => `<span style="--c:${p.color}"><i></i>${esc(p.label)}${p.role ? `<small>${esc(p.role)}</small>` : ''}</span>`).join('')}</div>
        <div class="rv-status">Merging…</div><div class="rv-roll hidden"><div class="rv-dial"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" class="bg"/><circle cx="50" cy="50" r="42" class="fg"/></svg><b>100%</b></div><div class="rv-tier"></div></div>
        <div class="rv-body hidden"><div class="rv-sprite"></div><div class="rv-name"></div><div class="rv-desc"></div><div class="rv-chips"></div><div class="rv-bars"></div><div class="rv-note"></div></div>
        <div class="rv-skip">tap to ${o.design && o.design.then ? 'skip' : 'continue'}</div></div>`;
      document.body.appendChild(el);
      const cv = el.querySelector('canvas'), g = cv.getContext('2d');
      const card = el.querySelector('.rv-card'), $ = s => el.querySelector(s);
      let W = 0, H = 0;
      const fit = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
      fit(); addEventListener('resize', fit);
      const fast = reduced();
      const parts = (o.parts || []).slice(0, 7);
      const orbs = parts.map((p, i) => {
        const a = (i / Math.max(1, parts.length)) * Math.PI * 2 - Math.PI / 2;
        return { color: p.color, a, r0: Math.max(W, H) * 0.6, size: p.role === 'lead' || p.role === 'parent' ? 16 : p.role === 'follow' ? 13 : 9 };
      });
      const sparks = [];
      const burst = (n, color, speed) => { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = (0.4 + Math.random()) * speed; sparks.push({ x: W / 2, y: H * 0.2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color }); } };
      let phase = 'converge', t0 = performance.now(), design, tier = 0, rays = 0, closed = false;
      let skip = false;
      const close = () => { if (closed) return; closed = true; el.classList.add('out'); setTimeout(() => { removeEventListener('resize', fit); removeEventListener('keydown', key); el.remove(); done(); }, 260); };
      const key = e => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(); } };
      function onTap() { if (phase === 'done') close(); else skip = true; }
      el.addEventListener('click', onTap);
      addEventListener('keydown', key);
      Promise.resolve(o.design).then(d => { design = d || null; }, () => { design = null; });

      function showRoll() {
        phase = 'rarity'; t0 = performance.now();
        $('.rv-status').classList.add('hidden');
        if (!design) { phase = 'powers'; t0 = performance.now(); showBody(); return; }
        tier = design.tier == null ? 0 : design.tier;
        $('.rv-roll').classList.remove('hidden');
        card.style.setProperty('--tc', TC[tier]);
      }
      function showBody() {
        const b = $('.rv-body'); b.classList.remove('hidden');
        const d = design || { name: o.fallbackName || 'Merge', desc: o.fallbackDesc || '', chips: o.fallbackChips || [], bars: [], note: '' };
        if (o.sprite && root.SPRITES) { const c = document.createElement('canvas'); c.width = c.height = 96; root.SPRITES.paint(c, o.sprite, { prism: !!o.prism }); b.querySelector('.rv-sprite').appendChild(c); }
        const nm = b.querySelector('.rv-name');
        const full = String(d.name || '');
        let n = 0;
        const type = () => { if (closed) return; n = skip ? full.length : n + 1; nm.textContent = full.slice(0, n); if (n < full.length) setTimeout(type, fast ? 0 : 28); else afterName(); };
        type();
        function afterName() {
          b.querySelector('.rv-desc').textContent = d.desc || '';
          const chips = b.querySelector('.rv-chips');
          (d.chips || []).forEach((c, i) => setTimeout(() => { if (closed) return; const s = document.createElement('span'); s.className = 'rv-chip ' + (c.c || ''); s.textContent = c.t; chips.appendChild(s); if (root.REVEAL_SOUND) root.REVEAL_SOUND('chip', i); }, skip || fast ? 0 : 160 * i));
          const bars = b.querySelector('.rv-bars');
          bars.innerHTML = (d.bars || []).map(x => `<div class="rv-bar"><span>${esc(x.label)}</span><i><b style="width:0"></b></i><em>${esc(x.text != null ? x.text : x.v)}</em></div>`).join('');
          setTimeout(() => bars.querySelectorAll('.rv-bar').forEach((r, i) => { const x = d.bars[i]; r.querySelector('b').style.width = Math.max(4, Math.min(100, x.v / (x.max || 100) * 100)) + '%'; }), 60);
          b.querySelector('.rv-note').textContent = d.note || '';
          phase = 'done'; setTimeout(close, o.hold || 9000); // a timer, not frame time: frames can stall while the tab is hidden
          el.querySelector('.rv-skip').textContent = 'tap to continue';
        }
      }

      function frame(now) {
        if (closed) return;
        const t = now - t0;
        g.clearRect(0, 0, W, H);
        g.fillStyle = 'rgba(5,8,16,0.82)'; g.fillRect(0, 0, W, H);
        const cx = W / 2, cy = H * 0.2;
        if (phase === 'converge') {
          const k = ease(t / (fast || skip ? 1 : 900));
          for (const ob of orbs) {
            const r = ob.r0 * (1 - k) + 70 * k, a = ob.a + k * 1.2;
            const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
            g.strokeStyle = ob.color + '55'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx + Math.cos(a - 0.25) * (r + 60), cy + Math.sin(a - 0.25) * (r + 60)); g.lineTo(x, y); g.stroke();
            orb(x, y, ob.size, ob.color);
          }
          if (k >= 1) { phase = 'fuse'; t0 = now; }
        } else if (phase === 'fuse' || phase === 'designing') {
          const k = ease(t / (fast || skip ? 1 : 700));
          const spin = now / 400;
          for (const ob of orbs) {
            const r = phase === 'fuse' ? 70 * (1 - k) + 8 : 10 + Math.sin(now / 200 + ob.a) * 4, a = ob.a + spin;
            orb(cx + Math.cos(a) * r, cy + Math.sin(a) * r, ob.size * (phase === 'fuse' ? 1 - k * 0.5 : 0.5), ob.color);
          }
          const pulse = phase === 'designing' ? 0.5 + Math.sin(now / 220) * 0.5 : k;
          core(cx, cy, 26 + pulse * 10, '#ffffff', 0.35 + pulse * 0.4);
          if (phase === 'fuse' && k >= 1) {
            burst(40, '#ffffff', 5); flash = 1;
            if (design !== undefined || skip) showRoll(); else { phase = 'designing'; t0 = now; $('.rv-status').textContent = 'Compiling…'; }
          } else if (phase === 'designing' && (design !== undefined || skip)) {
            if (design === undefined) design = null; // skipped while waiting: the toast brings it later
            showRoll();
          }
        } else if (phase === 'rarity') {
          const dur = fast || skip ? 1 : 1300, k = ease(t / dur);
          const pct = design.pct != null ? design.pct : 50;
          const shown = 100 - (100 - pct) * k;
          $('.rv-dial b').textContent = (shown < 10 ? shown.toFixed(2) : shown.toFixed(1)) + '%';
          $('.rv-dial .fg').style.strokeDashoffset = String(264 * (1 - shown / 100));
          core(cx, cy, 30, TC[tier], 0.4 + k * 0.4);
          if (k >= 1) {
            $('.rv-tier').innerHTML = `<b>${esc(design.tierName || TIER[tier])}</b>${design.odds > 1 ? `<span>about 1 in ${Number(design.odds).toLocaleString()}</span>` : ''}`;
            $('.rv-tier').classList.add('stamp');
            burst(30 + tier * 25, TC[tier], 3 + tier * 1.5); flash = 0.5 + tier * 0.15; rays = tier >= 3 ? 1 : 0;
            if (root.REVEAL_SOUND) root.REVEAL_SOUND('tier', tier);
            phase = 'powers'; t0 = now; setTimeout(showBody, fast || skip ? 0 : 450);
          }
        } else {
          core(cx, cy, 30, design ? TC[tier] : '#8e9abb', 0.55 + Math.sin(now / 500) * 0.1);
        }
        if (rays > 0) {
          g.save(); g.translate(cx, cy); g.rotate(now / 3000);
          for (let i = 0; i < 12; i++) { g.rotate(Math.PI / 6); const grd = g.createLinearGradient(0, 0, 0, -Math.max(W, H)); grd.addColorStop(0, TC[tier] + '66'); grd.addColorStop(1, TC[tier] + '00'); g.fillStyle = grd; g.beginPath(); g.moveTo(-14, 0); g.lineTo(14, 0); g.lineTo(0, -Math.max(W, H)); g.fill(); }
          g.restore();
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i]; s.x += s.vx; s.y += s.vy; s.vx *= 0.97; s.vy = s.vy * 0.97 + 0.03; s.life -= 0.012;
          if (s.life <= 0) { sparks.splice(i, 1); continue; }
          g.globalAlpha = s.life; g.fillStyle = s.color; g.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
        }
        g.globalAlpha = 1;
        if (flash > 0) { g.fillStyle = `rgba(255,255,255,${flash * 0.5})`; g.fillRect(0, 0, W, H); flash = Math.max(0, flash - 0.05); }
        requestAnimationFrame(frame);
      }
      let flash = 0;
      function orb(x, y, r, color) {
        const grd = g.createRadialGradient(x, y, 0, x, y, r * 2.4);
        grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.25, color); grd.addColorStop(1, color + '00');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r * 2.4, 0, Math.PI * 2); g.fill();
      }
      function core(x, y, r, color, alpha) {
        g.globalAlpha = Math.min(1, alpha); orb(x, y, r, color); g.globalAlpha = 1;
      }
      requestAnimationFrame(frame);
    });
  }

  root.REVEAL = { play, TIER, TC };
})(typeof self !== 'undefined' ? self : this);
