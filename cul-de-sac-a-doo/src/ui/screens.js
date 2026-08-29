// src/ui/screens.js — Agent D
//
// Phase transitions and the morning after.
//
// There is no results screen in this game. A night does not produce a table of
// figures; it produces things you noticed and things you have to live beside.
// The morning after a run is index cards on the kitchen table, worded the way
// you would word them to yourself, and a couple of images. Nothing is totalled.

import { PALETTE, noNumerals } from './ui.js';

function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = noNumerals(text);
  if (parent) parent.appendChild(n);
  return n;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Language ladders for a run's shape. Five rungs each, all qualitative.
const KILL_WORDS = [
  'you barely touched anything',
  'a few of them stopped',
  'it went on for a while',
  'the street was full of it',
  'you did not stop when they did',
];
const NOISE_WORDS = [
  'nobody heard a thing',
  'a dog woke up somewhere',
  'a porch light came on',
  'two porch lights came on',
  'every curtain on the street moved',
];
const HURT_WORDS = [
  'you came back the way you left',
  'something on your arm you do not remember',
  'you are walking differently',
  'you had to sit down on the step',
  'you do not remember the last part',
];
const LOOT_WORDS = [
  'your pockets are empty',
  'one thing you kept',
  'a handful of things',
  'more than you can put down at once',
  'you are carrying somebody else\'s life around',
];

export class Screens {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.el = el('div', 'cds-screens', root);
    this.el.hidden = true;
    this.audio = null;
  }

  _open(cls) {
    this.el.hidden = false;
    this.el.replaceChildren();
    this.el.className = 'cds-screens ' + cls;
    return this.el;
  }

  close() {
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  /**
   * Day -> night, or night -> day. A wipe of light, not a loading bar.
   * @param {'day'|'night'} to
   * @returns {Promise<void>} resolves when the wipe is over
   */
  transition(to, ms = 1500) {
    const layer = el('div', 'cds-transition to-' + to, this.root);
    if (this.audio) this.audio.sfx('transition');
    if (this.audio) this.audio.music(to, { fade: ms / 1000 });
    // A line of nothing at all. Never "Night 3". Never a count of days.
    el('div', 'cds-transition-word', layer,
      to === 'night' ? 'the streetlights come on one at a time'
        : 'and then it is a very ordinary morning');
    requestAnimationFrame(() => layer.classList.add('in'));
    return new Promise((res) => {
      setTimeout(() => {
        layer.classList.remove('in');
        setTimeout(() => { layer.remove(); res(); }, 480);
      }, ms);
    });
  }

  /**
   * The morning after.
   * @param {{kills,damageTaken,noise,itemsLooted,wavesCleared,bossDefeated,durationSec}} summary
   * @param {{ onPin?: (text)=>void, onDone?: ()=>void }} hooks
   *
   * Everything in the summary is a number. Nothing that leaves this function is.
   * Each figure is put through a five-rung ladder and comes out the other side
   * as a sentence somebody might actually say, then pinned to an index card the
   * player can carry to the board and be wrong about later.
   */
  showRunOutcome(summary = {}, hooks = {}) {
    const s = this._open('cds-outcome');
    el('div', 'cds-outcome-title', s, 'the morning after');

    const rung = (v, scale) => Math.max(0, Math.min(4, Math.floor(clamp01(v / scale) * 5)));
    const lines = [
      KILL_WORDS[rung(summary.kills || 0, 120)],
      NOISE_WORDS[rung(summary.noise || 0, 100)],
      HURT_WORDS[rung(summary.damageTaken || 0, 90)],
      LOOT_WORDS[rung((summary.itemsLooted || []).length, 9)],
    ];
    if (summary.bossDefeated) lines.push('the thing at the drain was not there when you looked again');
    // A long night is a longer card, not a duration. Length is the only clock.
    if ((summary.durationSec || 0) > 700) lines.push('it was light before you were finished');

    const table = el('div', 'cds-table', s);
    lines.forEach((text, i) => {
      const card = el('div', 'cds-outcard', table);
      card.style.setProperty('--tilt', (((i * 47) % 7) - 3) + 'deg');
      el('div', 'cds-cardpin', card).style.background = i % 3 === 2 ? PALETTE.pinAlt : PALETTE.pin;
      el('div', 'cds-cardtext', card, text);
      const pin = el('button', 'cds-pinbtn', card, 'keep');
      pin.addEventListener('click', () => {
        card.classList.add('kept');
        pin.disabled = true;
        pin.textContent = 'kept';
        if (hooks.onPin) hooks.onPin(text);
      });
    });

    // Loot is shown as objects on a table, arranged by nothing.
    const shelf = el('div', 'cds-outshelf', s);
    (summary.itemsLooted || []).slice(0, 12).forEach((item, i) => {
      const chip = el('div', 'cds-outchip', shelf);
      chip.style.background = ['#e9e2d6', '#dfe6ea', '#e8dcea', '#f0e0cc'][item.rarity | 0] || '#e9e2d6';
      chip.style.setProperty('--tilt', (((i * 31) % 11) - 5) + 'deg');
      chip.title = noNumerals(item.name || '');
    });

    const go = el('button', 'cds-close', s, 'put the kettle on');
    go.addEventListener('click', () => { this.close(); if (hooks.onDone) hooks.onDone(); });
    return s;
  }

  /**
   * Render a resolved ending (from src/systems/ending.js).
   * @param {{id, title, lines: string[], palette?: string, image?: string}} ending
   */
  showEnding(ending, hooks = {}) {
    const s = this._open('cds-ending cds-ending-' + (ending.id || 'unknown'));
    s.style.setProperty('--ground', ending.palette || PALETTE.nightGround);
    if (this.audio) this.audio.stopMusic({ fade: 2 });

    const plate = el('div', 'cds-endplate', s);
    el('div', 'cds-endtitle', plate, ending.title || '');
    const body = el('div', 'cds-endbody', plate);
    (ending.lines || []).forEach((line, i) => {
      const p = el('p', 'cds-endline', body, line);
      p.style.setProperty('--i', i);
    });
    // No tally, no "you gifted X times", no reveal of whether the player's
    // theory was right. The last thing on screen is a blank strip.
    el('div', 'cds-endsilence', plate);

    const again = el('button', 'cds-close cds-close-quiet', plate, 'close the door behind you');
    again.addEventListener('click', () => { this.close(); if (hooks.onDone) hooks.onDone(); });
    return s;
  }

  /** A single held image between beats — used by the ending and by night intros. */
  showFragmentCard(text, ms = 3200) {
    const s = this._open('cds-solocard');
    const card = el('div', 'cds-outcard cds-solo', s);
    el('div', 'cds-cardpin', card).style.background = PALETTE.pin;
    el('div', 'cds-cardtext', card, text);
    return new Promise((res) => setTimeout(() => { this.close(); res(); }, ms));
  }
}

// SELF-TEST:
//   import { Screens } from './src/ui/screens.js';
//   const sc = new Screens(document.body);
//   1. await sc.transition('night') -> the light drains out, one line of text
//      that is not a day count, then it is gone.
//   2. sc.showRunOutcome({ kills: 88, noise: 71, damageTaken: 40,
//        itemsLooted: [{name:'a brass key', rarity:2}], durationSec: 800,
//        bossDefeated: true }) -> five or six index cards on a table, each a
//      sentence, none of them a figure. "keep" pins one to the board.
//      Confirm: document.querySelector('.cds-outcome').innerText has no digit.
//   3. sc.showEnding(resolveEnding(...)) -> a plate of short lines, a blank
//      strip under them, and a door. Nothing is explained.
