// src/ui/pinboard.js — Agent D
//
// The player's manual rumor tracker. Index cards of things they overheard,
// dragged wherever they like, with string they run between cards themselves.
//
// THE GAME NEVER CONFIRMS A LINK.
// There is no validation pass, no correct-link highlight, no score, no hint, no
// "you've connected N of M", no colour change on a true edge, no ordering by
// relevance. A link the player draws is stored verbatim and rendered verbatim
// and that is the entire lifecycle. Search this file for a truth table; there
// isn't one, and adding one would remove the only thing the board is for.
//
// It is a place to be wrong in.

import { PALETTE, noNumerals } from './ui.js';

const STORE_KEY = 'cds.pinboard.v1';

/** localStorage can throw (private mode, blocked cookies) or come back junk. */
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { cards: [], links: [] };
    const parsed = JSON.parse(raw);
    return {
      cards: Array.isArray(parsed?.cards) ? parsed.cards : [],
      links: Array.isArray(parsed?.links) ? parsed.links : [],
    };
  } catch (_) {
    return { cards: [], links: [] };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (_) {
    // Quota, private mode, or an embargoed origin. The board still works for
    // this sitting; it just will not survive the night. Say nothing.
  }
}

let uid = 0;
function nextId() {
  uid += 1;
  return 'c' + Date.now().toString(36) + '-' + uid.toString(36);
}

export class Pinboard {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.state = loadState();
    this.linkFrom = null;
    this.drag = null;
    this._build();
    this.render();
  }

  _build() {
    this.el = document.createElement('div');
    this.el.className = 'cds-pinboard';
    this.el.hidden = true;

    this.el.innerHTML = '';
    const cork = document.createElement('div');
    cork.className = 'cds-cork';
    this.el.appendChild(cork);
    this.cork = cork;

    this.strings = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.strings.setAttribute('class', 'cds-strings');
    this.strings.setAttribute('viewBox', '0 0 375 812');
    cork.appendChild(this.strings);

    this.cardLayer = document.createElement('div');
    this.cardLayer.className = 'cds-cards';
    cork.appendChild(this.cardLayer);

    const bar = document.createElement('div');
    bar.className = 'cds-boardbar';
    cork.appendChild(bar);

    this.hint = document.createElement('span');
    this.hint.className = 'cds-boardhint';
    this.hint.textContent = 'drag a card. tap a pin, then another, to run string.';
    bar.appendChild(this.hint);

    const close = document.createElement('button');
    close.className = 'cds-close';
    close.textContent = 'leave it up';
    close.addEventListener('click', () => this.hide());
    bar.appendChild(close);

    this.root.appendChild(this.el);

    // dragging
    this.cardLayer.addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.cds-card');
      if (!card) return;
      if (e.target.closest('.cds-cardpin')) { this._pinTap(card.dataset.id); return; }
      const rec = this.state.cards.find((c) => c.id === card.dataset.id);
      if (!rec) return;
      const r = this.cork.getBoundingClientRect();
      const sx = 375 / r.width, sy = 812 / r.height;
      this.drag = {
        id: rec.id,
        dx: rec.x - (e.clientX - r.left) * sx,
        dy: rec.y - (e.clientY - r.top) * sy,
        sx, sy, left: r.left, top: r.top,
      };
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    });

    this.cardLayer.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      const rec = this.state.cards.find((c) => c.id === d.id);
      if (!rec) return;
      rec.x = Math.max(4, Math.min(263, (e.clientX - d.left) * d.sx + d.dx));
      rec.y = Math.max(52, Math.min(712, (e.clientY - d.top) * d.sy + d.dy));
      this._position(rec);
      this._drawStrings();
    });

    const end = () => {
      if (!this.drag) return;
      const node = this.cardLayer.querySelector('.cds-card.dragging');
      if (node) node.classList.remove('dragging');
      this.drag = null;
      this._save();
    };
    this.cardLayer.addEventListener('pointerup', end);
    this.cardLayer.addEventListener('pointercancel', end);

    // tapping a string removes it. Unpicking is as unjudged as pinning.
    this.strings.addEventListener('click', (e) => {
      const id = e.target.getAttribute && e.target.getAttribute('data-link');
      if (!id) return;
      this.state.links = this.state.links.filter((l) => l.id !== id);
      this._save();
      this._drawStrings();
    });
  }

  show() { this.el.hidden = false; this.render(); }
  hide() { this.el.hidden = true; }
  toggle() { this.el.hidden ? this.show() : this.hide(); }

  /**
   * Pin an overheard fragment. Duplicates are allowed on purpose — hearing the
   * same thing twice from two mouths is information the player may want to
   * arrange, and the game is not going to arrange it for them.
   * @param {string} text
   * @param {{ from?: string }} [meta] who it came off, if the player noticed
   */
  addFragment(text, meta = {}) {
    const n = this.state.cards.length;
    const card = {
      id: nextId(),
      text: noNumerals(text),
      from: meta.from || '',
      // a loose spiral so a fresh card never lands exactly on the last one
      x: 22 + (n % 3) * 92 + ((n * 37) % 17),
      y: 96 + Math.floor(n / 3) * 104 + ((n * 23) % 21),
      tilt: ((n * 53) % 9) - 4,
      pin: n % 4 === 3 ? 'alt' : 'main',
    };
    this.state.cards.push(card);
    this._save();
    this.render();
    return card.id;
  }

  /** The player asserts a connection. Nothing checks it. Nothing ever will. */
  link(aId, bId) {
    if (!aId || !bId || aId === bId) return null;
    const dupe = this.state.links.some(
      (l) => (l.a === aId && l.b === bId) || (l.a === bId && l.b === aId),
    );
    if (dupe) return null;
    const rec = { id: nextId(), a: aId, b: bId };
    this.state.links.push(rec);
    this._save();
    this._drawStrings();
    return rec.id;
  }

  clear() {
    this.state = { cards: [], links: [] };
    this._save();
    this.render();
  }

  _pinTap(id) {
    if (this.linkFrom === id) { this.linkFrom = null; this._marks(); return; }
    if (!this.linkFrom) { this.linkFrom = id; this._marks(); return; }
    this.link(this.linkFrom, id);
    this.linkFrom = null;
    this._marks();
  }

  _marks() {
    this.cardLayer.querySelectorAll('.cds-card').forEach((n) => {
      n.classList.toggle('arming', n.dataset.id === this.linkFrom);
    });
  }

  _position(rec) {
    const node = this.cardLayer.querySelector('[data-id="' + rec.id + '"]');
    if (!node) return;
    node.style.left = rec.x + 'px';
    node.style.top = rec.y + 'px';
  }

  render() {
    this.cardLayer.replaceChildren();
    for (const rec of this.state.cards) {
      const node = document.createElement('div');
      node.className = 'cds-card';
      node.dataset.id = rec.id;
      node.style.left = rec.x + 'px';
      node.style.top = rec.y + 'px';
      node.style.setProperty('--tilt', rec.tilt + 'deg');

      const pin = document.createElement('div');
      pin.className = 'cds-cardpin' + (rec.pin === 'alt' ? ' alt' : '');
      pin.style.background = rec.pin === 'alt' ? PALETTE.pinAlt : PALETTE.pin;
      node.appendChild(pin);

      const body = document.createElement('div');
      body.className = 'cds-cardtext';
      body.textContent = noNumerals(rec.text);
      node.appendChild(body);

      if (rec.from) {
        const from = document.createElement('div');
        from.className = 'cds-cardfrom';
        // no attribution of truth — only of mouth
        from.textContent = noNumerals('— ' + rec.from);
        node.appendChild(from);
      }
      this.cardLayer.appendChild(node);
    }
    this._marks();
    this._drawStrings();
  }

  _drawStrings() {
    this.strings.replaceChildren();
    const byId = {};
    for (const c of this.state.cards) byId[c.id] = c;
    for (const l of this.state.links) {
      const a = byId[l.a], b = byId[l.b];
      if (!a || !b) continue; // a card was removed; the string just isn't there
      const ax = a.x + 44, ay = a.y + 8, bx = b.x + 44, by = b.y + 8;
      // sag, because it is string and not a graph edge
      const mx = (ax + bx) / 2, my = (ay + by) / 2 + Math.min(30, Math.abs(bx - ax) * 0.16 + 10);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${ax} ${ay} Q${mx} ${my} ${bx} ${by}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', PALETTE.string);
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('opacity', '0.82');
      path.setAttribute('data-link', l.id);
      path.setAttribute('class', 'cds-string');
      this.strings.appendChild(path);
      // NOTE: every string is drawn the same. There is deliberately no branch
      // here on whether the two fragments are actually related.
    }
  }

  _save() { saveState(this.state); }
}

// SELF-TEST:
//   import { Pinboard } from './src/ui/pinboard.js';
//   const b = new Pinboard(document.body); b.show();
//   1. b.addFragment('she was already gone by the time the truck came', {from:'Marge'})
//      three or four times with different text -> cards land on a loose spiral,
//      each tilted a different way, each pinned.
//   2. Drag a card anywhere. Reload the page. It is where you left it (unless
//      localStorage is blocked, in which case the board is simply empty and
//      says nothing about why).
//   3. Tap one card's pin, then another card's pin -> a sagging red string.
//      Tap the string -> it comes off. At no point does the game indicate
//      whether the two fragments have anything to do with each other. Confirm
//      by grepping this file: there is no correctness check to find.
//   4. b.clear() empties it.
//   5. Guard: no digits render — b.addFragment('at four in the morning') keeps
//      the word, and noNumerals() strips any numeral that arrives in the text.
