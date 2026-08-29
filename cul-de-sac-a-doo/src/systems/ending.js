// src/systems/ending.js — Agent D
//
// Endings. Everything they resolve from arrives as arguments — Trust, Debt,
// neighbour opinions, whether the thing at the drain was answered. This module
// owns no state and imports nothing from other agents.
//
// TWO RULES, both load-bearing:
//
// 1. The best ending — the clean escape — mirrors what happened to the
//    Previous Owner. Not thematically. Literally: it is composed from the same
//    fragments the player has been finding on the board all game
//    (PREVIOUS_OWNER_ECHO below), in the same order, with the pronoun moved.
//    The player should recognise the sentences and not be told why.
//
// 2. THE GAME NEVER CONFIRMS WHETHER THE PLAYER'S INFERRED CAUSALITY WAS
//    CORRECT. There is no epilogue that tallies what you did. No ending says
//    "because you gifted Marge" or "because the rumor reached Sheila". No
//    ending lists what you spent, killed, grew or owed. `explain()` exists and
//    returns null, permanently, so that nobody downstream can be tempted.
//
// The player should finish uncertain and want to argue about it with someone.

/**
 * The fragments the player has been overhearing about the Previous Owner all
 * game. C's rumor data should seed from this list so the echo lands. When the
 * player earns the clean escape these come back with the pronoun moved.
 */
export const PREVIOUS_OWNER_ECHO = [
  'the bins went out on the right night, every week, right to the end',
  'nobody saw a van',
  'the lawn was cut the morning of',
  'she left the porch light on for whoever came next',
  'there was no forwarding address and nobody thought to ask for one',
  'the street agreed on a version of it within about a fortnight',
];

const ENDINGS = {
  // ---- the clean escape --------------------------------------------------
  clean_escape: {
    id: 'clean_escape',
    title: 'and then a very ordinary morning',
    palette: '#e6eef7',
    rank: 5,
    lines: [
      'The bins went out on the right night, every week, right to the end.',
      'Nobody saw a van.',
      'You cut the lawn the morning of.',
      'You left the porch light on for whoever came next.',
      'There was no forwarding address and nobody thought to ask for one.',
      'The street agreed on a version of it within about a fortnight.',
      '',
      'It is a good version. It is kind about you.',
      'It is not what happened.',
    ],
  },

  // ---- you stayed, and the house kept you --------------------------------
  the_window: {
    id: 'the_window',
    title: 'the upstairs light',
    palette: '#bcb0c4',
    rank: 3,
    lines: [
      'You meant to go in the spring.',
      'Then there was the hedge, and the guttering, and the business with the drain.',
      '',
      'The new family at the far end are pleasant. They wave.',
      'They have started to describe you to each other in a particular way.',
      'You have heard one of the phrases before, in your own mouth, about somebody else.',
      '',
      'The light in the upstairs room is on a timer now.',
      'You do not remember setting it.',
    ],
  },

  // ---- Debt won ----------------------------------------------------------
  collected: {
    id: 'collected',
    title: 'settled',
    palette: '#3a4265',
    rank: 1,
    lines: [
      'Nothing came for you.',
      'That is the part people get wrong.',
      '',
      'You went down to the drain of your own accord, on a Tuesday, with the good shears,',
      'and you were perfectly calm, and you have a clear memory of thinking it was overdue.',
      '',
      'The stall is still there.',
      'Somebody has to mind it.',
    ],
  },

  // ---- the street closed ranks -------------------------------------------
  quietly_removed: {
    id: 'quietly_removed',
    title: 'a matter for the association',
    palette: '#7b7286',
    rank: 1,
    lines: [
      'No meeting was called. There was no need; everyone had already spoken to everyone.',
      '',
      'The letter is very polite and cites a clause about frontage.',
      'It is signed by somebody who has been in your kitchen.',
      '',
      'On the last day four of them are out on their lawns at the same time, not watching.',
      'The Colonel raises a hand. You cannot tell if it is a wave.',
      '',
      'You take the porch light with you. You are not sure why you want it.',
    ],
  },

  // ---- you became the institution ----------------------------------------
  folded_in: {
    id: 'folded_in',
    title: 'welcome to the committee',
    palette: '#f6d3de',
    rank: 4,
    lines: [
      'Sheila hands over the folder without ceremony, the way you hand over something heavy.',
      '',
      'It is all in there. The bins. The frontage. The addresses of the last four.',
      'Your own name, in a column, in a hand that is not yours, dated before you moved in.',
      '',
      'You could ask her about that.',
      'You are already thinking about the hedge on the corner and whose it technically is.',
      '',
      'You will be very good at this.',
    ],
  },

  // ---- nothing resolved --------------------------------------------------
  still_here: {
    id: 'still_here',
    title: 'no change to report',
    palette: '#d7d3dc',
    rank: 2,
    lines: [
      'The nights stop. Not suddenly — the way rain stops, in stages, while you are doing something else.',
      '',
      'The lawn is fine. The neighbours are fine.',
      'Marge brings a dish back that you do not remember lending.',
      '',
      'Sometimes at the shops somebody you half know starts a sentence about the house',
      'and then decides against it, warmly, and asks about your garden instead.',
      '',
      'You will think about that sentence for a long time.',
      'You will assemble it yourself, several ways, and you will never find out which way was right.',
    ],
  },

  // ---- the mirror, but you did not get out --------------------------------
  the_version: {
    id: 'the_version',
    title: 'the version they settled on',
    palette: '#a89fb0',
    rank: 2,
    lines: [
      'Within about a fortnight the street has agreed on what you were.',
      '',
      'It is tidier than the truth and it accounts for everything,',
      'including the two or three things you had hoped nobody had lined up.',
      '',
      'Somebody new is being shown round the house on a Saturday.',
      'They ask what the last owner was like.',
      '',
      'They are told. They nod. They will find out for themselves, they think.',
    ],
  },
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * @param {{
 *   trust?: number, debt?: number,
 *   opinions?: Object<string, number>,   // -1..1 per neighbour id
 *   bossDefeated?: boolean,
 *   nightsSurvived?: number,
 *   pinnedFragments?: number             // read, never reported back
 * }} state
 * @returns {{id,title,lines:string[],palette:string,rank:number}}
 *
 * The thresholds live here and are never surfaced. The player is not told which
 * lever moved, and the endings do not differ in how much they explain — they
 * all explain nothing, so no ending can be read as the "answer" one.
 */
export function resolveEnding(state = {}) {
  const trust = state.trust || 0;
  const debt = state.debt || 0;
  const ops = state.opinions || {};
  const ids = Object.keys(ops);
  const vals = ids.map((k) => clamp(ops[k] || 0, -1, 1));
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const worst = vals.length ? Math.min.apply(null, vals) : 0;
  const hostile = vals.filter((v) => v < -0.4).length;
  const warm = vals.filter((v) => v > 0.45).length;

  // Debt is heavier than anything. It does not negotiate.
  const owed = debt - trust;

  if (owed > 60 || (debt > 90 && !state.bossDefeated)) return ENDINGS.collected;
  if (hostile >= 4 || worst < -0.85) return ENDINGS.quietly_removed;

  // The clean escape. It is narrow on purpose: you must be trusted, owe almost
  // nothing, have answered the drain, and have left nobody behind hating you.
  if (trust > 55 && debt < 25 && state.bossDefeated && warm >= 4 && worst > -0.3) {
    return ENDINGS.clean_escape;
  }

  if (trust > 45 && (ops.sheila || 0) > 0.5 && avg > 0.15) return ENDINGS.folded_in;
  if (debt > 35 && avg > -0.1) return ENDINGS.the_window;
  if (avg < -0.15 || hostile >= 2) return ENDINGS.the_version;
  return ENDINGS.still_here;
}

/**
 * Deliberately, permanently null.
 *
 * This function exists so that the absence is a decision somebody made and
 * signed, rather than a feature nobody got round to. Do not implement it. The
 * game does not tell the player whether they were right about why any of it
 * happened, and there is no debug flag, no post-credits card, and no achievement
 * text that leaks it either.
 */
export function explain() {
  return null;
}

/** All ending ids, for the orchestrator's testing harness only. */
export function allEndingIds() { return Object.keys(ENDINGS); }

/** Fetch one by id, for previewing. Not reachable from play. */
export function endingById(id) { return ENDINGS[id] || null; }

// SELF-TEST:
//   import { resolveEnding, explain, allEndingIds } from './src/systems/ending.js';
//   1. resolveEnding({ trust: 80, debt: 5, bossDefeated: true, opinions: {
//        sheila:.8, colonel:.7, marge:.9, dwayne:.6, newlyweds:.5, frog:0,
//        previous:0 } }).id === 'clean_escape'
//      -> and read its lines beside PREVIOUS_OWNER_ECHO: same six statements,
//      same order, pronoun moved. Nothing in the text says so.
//   2. resolveEnding({ debt: 140 }).id === 'collected'
//   3. resolveEnding({ opinions: { a:-.9,b:-.9,c:-.9,d:-.9 } }).id === 'quietly_removed'
//   4. resolveEnding({ trust: 60, opinions: { sheila:.9, x:.3 } }).id === 'folded_in'
//   5. resolveEnding({}).id === 'still_here'
//   6. explain() === null, in every build, forever.
//   7. allEndingIds().every(id => endingById(id).lines.join(' ').match(/[0-9]/) === null)
