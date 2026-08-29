// src/ui/ui.js — Agent D
// UI for Cul-de-Sac-a-Doo. DOM + SVG overlay above Agent A's canvas.
//
// THE RULE: no numeral ever reaches the screen. Not a price, not a timer, not a
// hit point, not a count. State is carried by position, size, colour temperature,
// density, tremor, wear and language. Internally we use numbers freely; they die
// at the render boundary. `noNumerals()` at the bottom of this file is the guard.

// ---------------------------------------------------------------------------
// PALETTE — flat placeholder art. Sprites drop into these exact slots later
// without moving anything. Pastel, pristine, quietly wrong.
// ---------------------------------------------------------------------------

export const PALETTE = {
  // Day — bleached suburban daylight, a postcard nobody sent.
  daySkyHigh: '#e6eef7',
  daySkyLow: '#f8ecef',
  treeline: '#cddcd2',
  asphalt: '#d7d3dc',
  asphaltSeam: '#c6c0cf',
  curb: '#f3eff3',
  lawn: '#d0e6c9',
  lawnAlt: '#c2ddce',
  hedge: '#b6d2b8',
  soil: '#c9b6a4',
  soilDark: '#b39c88',

  // Houses. Four facades, each a different sweet, none of them warm.
  houseBlush: '#f7dee4',
  houseLilac: '#e7e2f4',
  houseButter: '#fdf1d9',
  houseMint: '#d9ecea',
  roof: '#bcb0c4',
  roofDark: '#a79ab0',
  door: '#b7a3b6',
  window: '#edf5fb',
  windowDark: '#9fa8bd',

  // Stalls.
  stallSheila: '#f6d3de', // HOA — laminated, pink, immovable
  stallColonel: '#ebd9c0', // barter crate — canvas and splinters
  stallFrog: '#c2d6d0', // storm drain — damp, cold, patient
  frogSkin: '#8fb0a6',
  drain: '#8d8f9c',

  // Ink.
  ink: '#463f4e',
  inkSoft: '#7b7286',
  inkFaint: '#a89fb0',

  // Index cards & string.
  card: '#fdf8ee',
  cardEdge: '#e0d6c5',
  cardShadow: 'rgba(70,63,78,0.18)',
  pin: '#d1837f',
  pinAlt: '#7f9ec4',
  string: '#b1524e',

  // Night — the same street with the sweetness drained out.
  nightSky: '#151829',
  nightGround: '#1f2138',
  nightGlow: '#3a4265',
  dread: '#5a4a5d',
  bloodMist: '#7d3f4c',

  // Price temperature ramp, tier 0 (freely given) -> tier 4 (withheld).
  tierWarm: ['#f6e2c2', '#eddfcd', '#dcdcda', '#c6d2d8', '#aebfcb'],
  tierEdge: ['#d9bd94', '#cfbda4', '#b9bcb9', '#9fb2bb', '#8697a6'],
};

// Neighbour ids are frozen by the contract. Positions are art direction.
export const NEIGHBOR_SLOTS = {
  sheila: { x: 62, y: 424, facing: 1, label: 'Sheila Vance' },
  colonel: { x: 188, y: 452, facing: -1, label: 'The Colonel' },
  frog: { x: 313, y: 430, facing: -1, label: '' }, // it does not offer a name
  marge: { x: 104, y: 300, facing: 1, label: 'Marge Tillery' },
  dwayne: { x: 268, y: 296, facing: -1, label: 'Dwayne Boggs' },
  newlyweds: { x: 196, y: 268, facing: 1, label: 'The Prices' },
  previous: { x: 300, y: 196, facing: -1, label: '' }, // an upstairs window
};

const STALLS = {
  sheila: { x: 30, y: 386, w: 96, h: 60, fill: PALETTE.stallSheila },
  colonel: { x: 152, y: 414, w: 84, h: 54, fill: PALETTE.stallColonel },
  frog: { x: 274, y: 392, w: 78, h: 56, fill: PALETTE.stallFrog },
};

const GARDEN = { x: 34, y: 578, w: 130, h: 92 };

// Language ladders. Five rungs each, chosen so no rung implies arithmetic.
const TIER_OFFER = [
  'pressed into your hands',
  'set down where you can reach',
  'held, then held a little longer',
  'kept nearer the chest',
  'not brought out at all',
];
const TIER_MOOD = ['given', 'offered', 'considered', 'withheld', 'refused'];
const UNAFFORDABLE = 'the hand does not move';

// Health has five rungs too, but they are never shown as a rung — they select a
// vignette inset, a tremor amplitude and a mist saturation. See applyVitals().
const VITALS_WORDS = ['steady', 'warm', 'thin', 'loud', 'nearly'];

// ---------------------------------------------------------------------------

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function svg(tag, attrs, parent) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map any 0..1 ratio onto a coarse 0..4 bucket. Buckets, never figures. */
export function bucket(ratio) {
  const b = Math.floor(clamp01(ratio) * 5);
  return b > 4 ? 4 : b;
}

/** Strip every digit from anything about to be shown. Belt and braces. */
export function noNumerals(text) {
  return String(text).replace(/[0-9٠-٩۰-۹]/g, '');
}

// ---------------------------------------------------------------------------

export class UIManager {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.root.classList.add('cds-root');
    this.hooks = {}; // { onApproach, onBuy, onGift, onEnterNight, onOpenPinboard }
    this.player = { x: 188, y: 500 };
    this.nearId = null;
    this.audio = null; // orchestrator may assign an AudioManager
    this._build();
  }

  /** Orchestrator wiring point. All optional. */
  on(name, fn) {
    this.hooks[name] = fn;
    return this;
  }

  // -- scaffolding ---------------------------------------------------------

  _build() {
    this.stage = el('div', 'cds-stage', this.root);

    this.dayLayer = el('div', 'cds-layer cds-day', this.stage);
    this.nightLayer = el('div', 'cds-layer cds-night', this.stage);
    this.overlay = el('div', 'cds-layer cds-overlay', this.stage);
    this.fragmentLayer = el('div', 'cds-layer cds-fragments', this.stage);
    this.veil = el('div', 'cds-veil', this.stage);

    this._buildStreet();
    this._buildNightVitals();
    this.hideAll();
  }

  _buildStreet() {
    const s = svg('svg', {
      viewBox: '0 0 375 812',
      preserveAspectRatio: 'xMidYMid slice',
      class: 'cds-scene',
    }, this.dayLayer);
    this.scene = s;

    const defs = svg('defs', {}, s);
    const sky = svg('linearGradient', { id: 'cds-sky', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    svg('stop', { offset: '0', 'stop-color': PALETTE.daySkyHigh }, sky);
    svg('stop', { offset: '1', 'stop-color': PALETTE.daySkyLow }, sky);

    // sky + treeline
    svg('rect', { x: 0, y: 0, width: 375, height: 240, fill: 'url(#cds-sky)' }, s);
    svg('path', {
      d: 'M0 216 q 26 -26 52 -4 q 24 -30 54 -6 q 30 -28 58 -2 q 26 -26 56 -6 q 30 -24 60 2 q 22 -18 45 4 L375 240 L0 240 Z',
      fill: PALETTE.treeline, opacity: '0.85',
    }, s);

    // house facades — four, staggered, none quite aligned with the next
    const houses = [
      { x: -6, w: 108, y: 150, fill: PALETTE.houseBlush },
      { x: 96, w: 96, y: 162, fill: PALETTE.houseLilac },
      { x: 186, w: 100, y: 146, fill: PALETTE.houseButter },
      { x: 280, w: 104, y: 158, fill: PALETTE.houseMint },
    ];
    houses.forEach((h, i) => {
      const g = svg('g', {}, s);
      svg('path', {
        d: `M${h.x - 8} ${h.y} L${h.x + h.w / 2} ${h.y - 34} L${h.x + h.w + 8} ${h.y} Z`,
        fill: i % 2 ? PALETTE.roofDark : PALETTE.roof,
      }, g);
      svg('rect', { x: h.x, y: h.y, width: h.w, height: 96, fill: h.fill }, g);
      svg('rect', {
        x: h.x + h.w / 2 - 11, y: h.y + 52, width: 22, height: 44,
        fill: PALETTE.door, rx: 2,
      }, g);
      svg('rect', { x: h.x + 12, y: h.y + 20, width: 22, height: 20, fill: PALETTE.window }, g);
      svg('rect', { x: h.x + h.w - 34, y: h.y + 20, width: 22, height: 20, fill: PALETTE.window }, g);
    });

    // the upstairs window that is always a little darker than the others
    this.previousWindow = svg('rect', {
      x: 288, y: 178, width: 24, height: 22, fill: PALETTE.windowDark, opacity: '0.9',
    }, s);

    // front lawns
    svg('rect', { x: 0, y: 246, width: 375, height: 78, fill: PALETTE.lawn }, s);
    svg('rect', { x: 0, y: 246, width: 375, height: 78, fill: PALETTE.lawnAlt, opacity: '0.35' }, s);
    for (let i = 0; i < 5; i++) {
      svg('rect', { x: 12 + i * 76, y: 250, width: 3, height: 70, fill: PALETTE.hedge, opacity: '0.5' }, s);
    }

    // curb + street
    svg('rect', { x: 0, y: 324, width: 375, height: 10, fill: PALETTE.curb }, s);
    svg('rect', { x: 0, y: 334, width: 375, height: 196, fill: PALETTE.asphalt }, s);
    for (let i = 0; i < 6; i++) {
      svg('rect', {
        x: 26 + i * 62, y: 470, width: 34, height: 4, rx: 2,
        fill: PALETTE.asphaltSeam, opacity: '0.7',
      }, s);
    }
    svg('rect', { x: 0, y: 530, width: 375, height: 10, fill: PALETTE.curb }, s);

    // the storm drain the frog lives behind
    svg('rect', { x: 288, y: 456, width: 54, height: 12, rx: 2, fill: PALETTE.drain }, s);
    for (let i = 0; i < 4; i++) {
      svg('rect', { x: 293 + i * 12, y: 458, width: 6, height: 8, fill: '#5f616d' }, s);
    }

    // near-side yard
    svg('rect', { x: 0, y: 540, width: 375, height: 200, fill: PALETTE.lawn }, s);
    svg('rect', {
      x: GARDEN.x, y: GARDEN.y, width: GARDEN.w, height: GARDEN.h,
      fill: PALETTE.soil, rx: 3,
    }, s);
    for (let r = 0; r < 4; r++) {
      svg('rect', {
        x: GARDEN.x + 8, y: GARDEN.y + 10 + r * 21, width: GARDEN.w - 16, height: 5,
        fill: PALETTE.soilDark, opacity: '0.55', rx: 2,
      }, s);
    }
    this.gardenBeds = svg('g', {}, s);

    // stalls
    for (const id in STALLS) {
      const st = STALLS[id];
      const g = svg('g', {}, s);
      svg('rect', { x: st.x, y: st.y + st.h - 16, width: st.w, height: 16, rx: 2, fill: st.fill }, g);
      svg('rect', {
        x: st.x + 4, y: st.y, width: st.w - 8, height: 12, rx: 5,
        fill: st.fill, opacity: '0.85',
      }, g);
      svg('rect', { x: st.x + 6, y: st.y + 12, width: 4, height: st.h - 28, fill: PALETTE.inkFaint, opacity: '0.4' }, g);
      svg('rect', { x: st.x + st.w - 10, y: st.y + 12, width: 4, height: st.h - 28, fill: PALETTE.inkFaint, opacity: '0.4' }, g);
    }

    // bottom band — the porch you stand on. Holds the pinboard tab and the
    // night door. No counters live here. Nothing lives here that counts.
    svg('rect', { x: 0, y: 740, width: 375, height: 72, fill: '#efe7ec' }, s);
    svg('rect', { x: 0, y: 740, width: 375, height: 2, fill: PALETTE.inkFaint, opacity: '0.4' }, s);

    // actors go in DOM so they can be tweened cheaply
    this.actors = el('div', 'cds-actors', this.dayLayer);
    this.actorNodes = {};
    for (const id in NEIGHBOR_SLOTS) {
      const slot = NEIGHBOR_SLOTS[id];
      const a = el('div', 'cds-actor cds-actor-' + id, this.actors);
      a.style.left = slot.x + 'px';
      a.style.top = slot.y + 'px';
      el('div', 'cds-body', a);
      el('div', 'cds-head', a);
      const halo = el('div', 'cds-halo', a);
      halo.setAttribute('aria-hidden', 'true');
      a.addEventListener('click', () => this._approach(id));
      this.actorNodes[id] = a;
    }
    this.playerNode = el('div', 'cds-actor cds-player', this.actors);
    el('div', 'cds-body', this.playerNode);
    el('div', 'cds-head', this.playerNode);
    this._placePlayer(this.player.x, this.player.y);

    // porch controls
    this.porch = el('div', 'cds-porch', this.dayLayer);
    this.pinTab = el('button', 'cds-porch-btn', this.porch);
    this.pinTab.textContent = 'the board';
    this.pinTab.addEventListener('click', () => this.hooks.onOpenPinboard && this.hooks.onOpenPinboard());
    this.nightBtn = el('button', 'cds-porch-btn cds-porch-night', this.porch);
    this.nightBtn.textContent = 'let it get dark';
    this.nightBtn.addEventListener('click', () => this.hooks.onEnterNight && this.hooks.onEnterNight());

    this._bindWalking();
  }

  _buildNightVitals() {
    // Night HUD. No bar, no figure. A vignette that closes in, a mist that
    // warms toward the wrong colour, and a tremor on the whole frame.
    this.vitalVignette = el('div', 'cds-vignette', this.nightLayer);
    this.vitalMist = el('div', 'cds-mist', this.nightLayer);
    this.nightWord = el('div', 'cds-nightword', this.nightLayer);
    // The one non-vignette tell: the porch light behind you. It dims as the
    // night takes more from you, and it is the only thing you can look at.
    this.porchLight = el('div', 'cds-porchlight', this.nightLayer);
  }

  // -- movement ------------------------------------------------------------

  _bindWalking() {
    const step = (dx, dy) => {
      this._placePlayer(
        Math.max(14, Math.min(361, this.player.x + dx)),
        Math.max(258, Math.min(736, this.player.y + dy)),
      );
      this._proximity();
    };
    this._keyHandler = (e) => {
      if (this.dayLayer.hidden) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a') step(-14, 0);
      else if (k === 'ArrowRight' || k === 'd') step(14, 0);
      else if (k === 'ArrowUp' || k === 'w') step(0, -14);
      else if (k === 'ArrowDown' || k === 's') step(0, 14);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', this._keyHandler);

    // tap-to-walk, because this is a portrait game held in one hand
    this.dayLayer.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cds-porch') || e.target.closest('.cds-actor')) return;
      const r = this.stage.getBoundingClientRect();
      const sx = 375 / r.width, sy = 812 / r.height;
      this._placePlayer(
        Math.max(14, Math.min(361, (e.clientX - r.left) * sx)),
        Math.max(258, Math.min(736, (e.clientY - r.top) * sy)),
      );
      this._proximity();
    });
  }

  _placePlayer(x, y) {
    this.player.x = x;
    this.player.y = y;
    this.playerNode.style.left = x + 'px';
    this.playerNode.style.top = y + 'px';
    // depth: further up the street is smaller. Reads as distance without a ruler.
    const depth = 0.72 + 0.34 * clamp01((y - 250) / 480);
    this.playerNode.style.setProperty('--depth', depth.toFixed(3));
  }

  _proximity() {
    let near = null, best = 54;
    for (const id in NEIGHBOR_SLOTS) {
      const s = NEIGHBOR_SLOTS[id];
      const d = Math.hypot(s.x - this.player.x, s.y - this.player.y);
      if (d < best) { best = d; near = id; }
    }
    if (near !== this.nearId) {
      if (this.nearId) this.actorNodes[this.nearId].classList.remove('near');
      this.nearId = near;
      if (near) {
        this.actorNodes[near].classList.add('near');
        if (this.hooks.onApproach) this.hooks.onApproach(near);
      }
    }
    const inGarden = this.player.x > GARDEN.x && this.player.x < GARDEN.x + GARDEN.w &&
      this.player.y > GARDEN.y && this.player.y < GARDEN.y + GARDEN.h + 30;
    this.dayLayer.classList.toggle('in-garden', inGarden);
  }

  _approach(id) {
    const s = NEIGHBOR_SLOTS[id];
    this._placePlayer(s.x + (id === 'previous' ? 0 : s.facing * -30), Math.min(736, s.y + 34));
    this._proximity();
  }

  // -- phases --------------------------------------------------------------

  /**
   * @param {{ neighbors?: Array, garden?: Array, weather?: string, dayIndex?: number }} state
   * dayIndex is used only to pick a word. It is never printed.
   */
  renderDay(state = {}) {
    this.hideAll();
    this.dayLayer.hidden = false;
    this.stage.dataset.phase = 'day';

    const neighbors = state.neighbors || [];
    for (const n of neighbors) {
      const node = this.actorNodes[n.id];
      if (!node) continue;
      // Opinion is never a number on screen. It is posture: how square the
      // shoulders are, how far the body has turned away, how still it stands.
      const op = typeof n.opinion === 'number' ? clamp01((n.opinion + 1) / 2) : 0.5;
      node.style.setProperty('--turn', ((0.5 - op) * 46).toFixed(1) + 'deg');
      node.style.setProperty('--lean', ((0.5 - op) * 5).toFixed(2) + 'px');
      node.style.setProperty('--still', (0.35 + op * 0.65).toFixed(2));
      node.classList.toggle('withdrawn', op < 0.3);
      node.classList.toggle('open', op > 0.72);
      node.hidden = n.present === false;
    }

    // garden: growth is bed height and leaf count, capped low so it never
    // becomes a tally you can read off.
    while (this.gardenBeds.firstChild) this.gardenBeds.removeChild(this.gardenBeds.firstChild);
    (state.garden || []).slice(0, 8).forEach((plot, i) => {
      const gx = GARDEN.x + 14 + (i % 4) * 28;
      const gy = GARDEN.y + 18 + Math.floor(i / 4) * 42;
      const g = clamp01(plot.growth == null ? 0.4 : plot.growth);
      svg('rect', {
        x: gx, y: gy + 16 - g * 16, width: 5, height: Math.max(2, g * 16),
        rx: 2, fill: plot.wilted ? '#b9b39c' : PALETTE.hedge,
      }, this.gardenBeds);
      if (g > 0.55) {
        svg('circle', { cx: gx + 2.5, cy: gy + 16 - g * 16, r: 3.6, fill: plot.wilted ? '#c9c2ab' : '#a9cf9f' }, this.gardenBeds);
      }
    });

    // The Previous Owner's window darkens with the number of days you have not
    // looked at it. The player will never be told this is what it is doing.
    const dim = clamp01(((state.dayIndex || 0) % 9) / 9);
    this.previousWindow.setAttribute('opacity', (0.55 + dim * 0.45).toFixed(2));

    this._proximity();
  }

  /**
   * @param {{ hp?, maxHp?, noise?, elapsed?, duration? }} state
   */
  renderNight(state = {}) {
    this.dayLayer.hidden = true;
    this.nightLayer.hidden = false;
    this.stage.dataset.phase = 'night';
    this.applyVitals(state);
  }

  /** Health, noise and time-left — all of it, with no figure anywhere. */
  applyVitals(state = {}) {
    const hp = state.hp == null ? 1 : state.hp;
    const maxHp = state.maxHp == null ? 1 : (state.maxHp || 1);
    const ratio = clamp01(hp / maxHp);
    const b = bucket(ratio); // 0 worst .. 4 best

    // 1. the vignette closes in
    this.vitalVignette.style.setProperty('--inset', (8 + (4 - b) * 17) + 'px');
    // 2. the mist warms to the wrong colour
    this.vitalMist.style.setProperty('--mist', (0.06 + (4 - b) * 0.13).toFixed(3));
    // 3. the whole frame trembles
    this.nightLayer.style.setProperty('--tremor', ((4 - b) * 0.55).toFixed(2) + 'px');
    // 4. the porch light behind you goes out slowly
    this.porchLight.style.setProperty('--lit', (0.2 + ratio * 0.8).toFixed(2));
    // 5. one word, only when it is bad enough to say something
    this.nightWord.textContent = b <= 1 ? noNumerals(VITALS_WORDS[b]) : '';

    // Time left is the sky, not a clock: it lightens toward dawn.
    if (state.duration) {
      const t = clamp01((state.elapsed || 0) / state.duration);
      this.nightLayer.style.setProperty('--dawn', t.toFixed(3));
    }
    // Noise is grain density on the mist. Louder runs look dirtier.
    if (state.noise != null) {
      this.nightLayer.style.setProperty('--grain', clamp01(state.noise / 100).toFixed(3));
    }
  }

  hideAll() {
    this.dayLayer.hidden = true;
    this.nightLayer.hidden = true;
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
    this.stage.dataset.phase = '';
  }

  closePanel() {
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
  }

  _panel(cls, title) {
    this.overlay.hidden = false;
    this.overlay.replaceChildren();
    const scrim = el('div', 'cds-scrim', this.overlay);
    scrim.addEventListener('click', () => this.closePanel());
    const p = el('div', 'cds-panel ' + cls, this.overlay);
    if (title) {
      const h = el('div', 'cds-panel-title', p);
      h.textContent = noNumerals(title);
    }
    return p;
  }

  // -- fragments -----------------------------------------------------------

  /** An overheard scrap. Drifts, fades, is not saved anywhere by the game. */
  showFragment(text) {
    const f = el('div', 'cds-fragment', this.fragmentLayer);
    f.textContent = noNumerals(text);
    f.style.left = (30 + Math.random() * 140) + 'px';
    f.style.top = (330 + Math.random() * 230) + 'px';
    requestAnimationFrame(() => f.classList.add('in'));
    setTimeout(() => {
      f.classList.remove('in');
      setTimeout(() => f.remove(), 1200);
    }, 4600);
    return f;
  }

  // -- vendor --------------------------------------------------------------

  /**
   * @param {{ id, name?, stock: Array<{ item, price:{tier,affordable} }> }} vendor
   * `price` comes from Agent C as a coarse bucket. There is no figure to show
   * and there never was one. Tier is rendered as reluctance.
   */
  showVendor(vendor) {
    const silent = vendor.id === 'frog';
    const p = this._panel('cds-vendor cds-vendor-' + vendor.id, silent ? '' : (vendor.name || ''));
    p.style.setProperty('--stall', PALETTE['stall' + cap(vendor.id)] || PALETTE.stallColonel);

    if (silent) {
      // No title, no greeting, no name. It has never introduced itself.
      const eye = el('div', 'cds-frog-eyes', p);
      el('div', 'cds-frog-eye', eye);
      el('div', 'cds-frog-eye', eye);
      this._frogEye = eye;
    } else {
      const sub = el('div', 'cds-panel-sub', p);
      sub.textContent = noNumerals(vendor.id === 'sheila'
        ? 'everything here is already approved'
        : 'bring me something with a story on it');
    }

    const list = el('div', 'cds-stock', p);
    (vendor.stock || []).forEach((entry) => {
      const price = entry.price || { tier: 2, affordable: true };
      const tier = Math.max(0, Math.min(4, price.tier | 0));
      const row = el('div', 'cds-offer', list);
      row.classList.add('tier-' + tier);
      if (!price.affordable) row.classList.add('unaffordable');

      // COST WITHOUT A FIGURE, five channels at once:
      //  (a) withdrawal — how far the goods sit back from your side of the counter
      row.style.setProperty('--withdraw', (tier * 9) + 'px');
      //  (b) weight — dear things are drawn heavier and cast a deeper shadow
      row.style.setProperty('--weight', (1 + tier * 0.09).toFixed(2));
      row.style.setProperty('--shadow', (2 + tier * 3) + 'px');
      //  (c) colour temperature — butter at the cheap end, slate at the dear end
      row.style.setProperty('--temp', PALETTE.tierWarm[tier]);
      row.style.setProperty('--temp-edge', PALETTE.tierEdge[tier]);
      //  (d) density — dear things are hatched, crowded, harder to look at
      row.style.setProperty('--hatch', (tier * 0.11).toFixed(2));
      //  (e) language — a rung on a ladder of reluctance, never a quantity
      const chip = el('div', 'cds-chip', row);
      chip.style.background = PALETTE.tierWarm[tier];
      chip.style.borderColor = PALETTE.tierEdge[tier];
      const nm = el('div', 'cds-offer-name', row);
      nm.textContent = noNumerals(entry.item?.name || 'something');
      const mood = el('div', 'cds-offer-mood', row);
      mood.textContent = noNumerals(price.affordable ? TIER_OFFER[tier] : UNAFFORDABLE);
      const rung = el('div', 'cds-offer-rung', row);
      rung.dataset.mood = TIER_MOOD[tier];
      // the rung is drawn as filled/empty pips — five of them, always five, so
      // the shape is a temperature and not a count you can do sums with
      for (let i = 0; i < 5; i++) {
        const pip = el('span', 'cds-pip' + (i <= tier ? ' on' : ''), rung);
        pip.setAttribute('aria-hidden', 'true');
      }

      if (price.affordable) {
        row.addEventListener('click', () => this._take(vendor, entry, row, silent));
      }
    });

    if (!silent) {
      const done = el('button', 'cds-close', p);
      done.textContent = 'that will do';
      done.addEventListener('click', () => this.closePanel());
    } else {
      // The frog's stall has no way to say you are finished. You simply leave.
      const done = el('button', 'cds-close cds-close-quiet', p);
      done.textContent = 'step back';
      done.addEventListener('click', () => this.closePanel());
    }
    return p;
  }

  /**
   * Buying.
   *
   * THE FROG'S SILENCE. For Sheila and the Colonel a purchase is an event: a
   * confirmation, a sound, the row acknowledging that it left. At the frog's
   * stall the identical transaction produces NO confirmation step, NO sound,
   * NO receipt, NO acknowledgement that a Debt was added — because a Debt was.
   * The row simply is not there any more. The only difference you could ever
   * point at is that the eyes stop blinking for a moment, and you cannot prove
   * you saw it. That absence is the mechanic; do not "fix" it.
   */
  _take(vendor, entry, row, silent) {
    if (silent) {
      row.remove();
      if (this._frogEye) {
        this._frogEye.classList.add('held');
        setTimeout(() => this._frogEye && this._frogEye.classList.remove('held'), 900);
      }
      // no sfx, no toast, no flash, no debt indicator, no callback confirmation
      if (this.hooks.onBuy) this.hooks.onBuy(vendor.id, entry, { silent: true });
      return;
    }
    row.classList.add('confirming');
    const yes = el('button', 'cds-confirm', row);
    yes.textContent = 'take it';
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.audio) this.audio.sfx('shop');
      row.classList.add('taken');
      setTimeout(() => row.remove(), 260);
      if (this.hooks.onBuy) this.hooks.onBuy(vendor.id, entry, { silent: false });
    });
  }

  // -- gifting -------------------------------------------------------------

  /**
   * Approach a neighbour, a menu of what you are carrying opens, you pick one.
   * There is no dialog tree and there is no line of dialogue. The reaction is a
   * posture and a duration: a shift, a pause, and a door that closes a little
   * sooner than a door should.
   */
  showGiftMenu(neighbor, inventory = []) {
    const p = this._panel('cds-gift', neighbor.name || NEIGHBOR_SLOTS[neighbor.id]?.label || '');
    const sub = el('div', 'cds-panel-sub', p);
    sub.textContent = 'hold something out';

    const shelf = el('div', 'cds-shelf', p);
    if (!inventory.length) {
      const empty = el('div', 'cds-empty', shelf);
      empty.textContent = 'your hands are empty and she can see that';
    }
    inventory.forEach((item) => {
      const b = el('button', 'cds-giftitem', shelf);
      b.style.setProperty('--rare', ['#e9e2d6', '#dfe6ea', '#e8dcea', '#f0e0cc'][item.rarity | 0] || '#e9e2d6');
      const sw = el('span', 'cds-giftswatch', b);
      sw.setAttribute('aria-hidden', 'true');
      const nm = el('span', '', b);
      nm.textContent = noNumerals(item.name || 'a thing');
      b.addEventListener('click', () => this._give(neighbor, item, p));
    });

    const leave = el('button', 'cds-close', p);
    leave.textContent = 'keep them';
    leave.addEventListener('click', () => this.closePanel());
    return p;
  }

  _give(neighbor, item, panel) {
    const react = (this.hooks.onGift && this.hooks.onGift(neighbor.id, item)) || {};
    // Reaction vocabulary is entirely non-verbal. `tone` is -1..1 if supplied.
    const tone = typeof react.tone === 'number' ? react.tone : 0;
    const node = this.actorNodes[neighbor.id];
    panel.classList.add('cds-reacting');
    panel.dataset.tone = tone > 0.25 ? 'warm' : tone < -0.25 ? 'cool' : 'flat';

    // the pause. Warmth takes its time; suspicion does not.
    const pause = tone > 0.25 ? 900 : tone < -0.25 ? 260 : 520;
    if (node) {
      node.classList.add('shifting');
      node.style.setProperty('--turn', ((-tone) * 40).toFixed(1) + 'deg');
      setTimeout(() => node.classList.remove('shifting'), pause + 500);
    }
    if (this.audio) this.audio.sfx('pickup');
    setTimeout(() => {
      // the door. It always closes; the only tell is how soon.
      panel.classList.add('cds-door');
      setTimeout(() => this.closePanel(), tone < -0.25 ? 180 : 460);
    }, pause);
  }

  // -- housekeeping --------------------------------------------------------

  destroy() {
    window.removeEventListener('keydown', this._keyHandler);
    this.root.replaceChildren();
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// SELF-TEST:
//   import { UIManager } from './src/ui/ui.js';
//   const ui = new UIManager(document.getElementById('game-container'));
//   1. ui.renderDay({ neighbors: [{id:'sheila',opinion:0.8},{id:'colonel',opinion:-0.7}] })
//      -> pastel street, seven actors, garden plot, porch strip. Sheila stands
//      square on; the Colonel is turned away. Arrow keys or a tap walks you;
//      walking within reach of an actor rings its halo.
//   2. ui.showVendor({ id:'sheila', name:'Sheila Vance', stock:[
//        {item:{name:'edging shears'}, price:{tier:0, affordable:true}},
//        {item:{name:'a good hose'},   price:{tier:4, affordable:false}} ]})
//      -> the cheap row sits forward, butter-warm, lightly drawn; the dear row
//      is pushed back, slate-cold, heavy, and says the hand does not move.
//      Nowhere on screen is there a figure.
//   3. ui.showVendor({ id:'frog', stock:[{item:{name:'the good one'},
//        price:{tier:3, affordable:true}}] }) then click the row -> the row
//      disappears with no confirm button, no sound, no message. Correct.
//   4. ui.showGiftMenu({id:'marge',name:'Marge Tillery'}, [{name:'jam',rarity:1}])
//      with ui.on('onGift', () => ({tone:-0.8})) -> a fast turn away and a door
//      that shuts sooner than it should.
//   5. ui.renderNight({hp:8,maxHp:40}) -> vignette closes in, mist warms, the
//      frame trembles, the porch light behind you is nearly out. No bar.
//   6. Guard: document.body.innerText.match(/[0-9]/) must be null in every state.
