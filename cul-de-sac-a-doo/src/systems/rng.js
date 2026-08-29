// Deterministic RNG — mulberry32. Owner: Agent A.
// All gameplay-affecting randomness MUST go through this, never Math.random().

/**
 * Create a seeded PRNG.
 * @param {number|string} seed
 * @returns {function} rng() -> float in [0,1). Also carries helper methods.
 */
export function rng(seed = 1) {
  let a = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
  if (a === 0) a = 0x9e3779b9;

  const next = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** float in [min,max) */
  next.range = (min, max) => min + next() * (max - min);
  /** integer in [min,max] inclusive */
  next.int = (min, max) => Math.floor(min + next() * (max - min + 1));
  /** random element of an array */
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  /** true with probability p */
  next.chance = (p) => next() < p;
  /** angle in radians */
  next.angle = () => next() * Math.PI * 2;
  /** in-place Fisher-Yates using this stream */
  next.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  /** fork an independent, still-deterministic stream */
  next.fork = () => rng(Math.floor(next() * 0xffffffff));
  /** current raw state, for save/restore */
  next.state = () => a;
  next.setState = (s) => { a = s | 0; };

  return next;
}

/** FNV-1a-ish string hash so seeds can be human words. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Default shared stream, replaced per-run by GameState.
export const defaultRng = rng(20260829);

// SELF-TEST: In devtools console:
//   import('./src/systems/rng.js').then(m => {
//     const a = m.rng('cul-de-sac'), b = m.rng('cul-de-sac');
//     console.log([a(),a(),a()], [b(),b(),b()]);   // the two arrays must be identical
//     const c = m.rng(1); const hist = new Array(10).fill(0);
//     for (let i=0;i<100000;i++) hist[c.int(0,9)]++;
//     console.log(hist);                            // each bucket ~10000 (+/- ~400)
//   });
