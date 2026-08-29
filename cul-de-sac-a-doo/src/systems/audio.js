// src/systems/audio.js — Agent D
//
// AudioManager. No asset files exist and none are required: every sound here is
// synthesised at call time from oscillators and noise buffers, so the game is
// audible today and stays audible if the sound designer never shows up.
//
// `load(manifest)` is kept for the frozen API. If a manifest ever names real
// files they are fetched and preferred; anything missing silently falls back to
// the synth. Nothing in this module throws — a blocked AudioContext, a decode
// failure, a browser with no WebAudio at all: all of it degrades to silence.

const DAY = 'day';
const NIGHT = 'night';

function now(ctx) { return ctx.currentTime; }

/** Short white-noise buffer, reused. Allocated once per manager. */
function makeNoise(ctx, seconds = 1) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02; // a little brown in it, less hissy
    d[i] = w * 0.6 + last * 2.2;
  }
  return buf;
}

export class AudioManager {
  constructor(opts = {}) {
    this.ready = false;
    this.blocked = false;
    this.ctx = null;
    this.master = null;
    this.busSfx = null;
    this.busMusic = null;
    this.noise = null;
    this.buffers = {};        // decoded real assets, if any ever arrive
    this.currentMusic = null; // { id, nodes:[], gain }
    this.muted = false;
    this.volumes = { master: 0.8, sfx: 0.85, music: 0.5, ...(opts.volumes || {}) };
    this._pendingMusic = null;
    this._gestureBound = false;
    this._init();
  }

  _init() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.blocked = true; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumes.master;
      this.master.connect(this.ctx.destination);
      this.busSfx = this.ctx.createGain();
      this.busSfx.gain.value = this.volumes.sfx;
      this.busSfx.connect(this.master);
      this.busMusic = this.ctx.createGain();
      this.busMusic.gain.value = this.volumes.music;
      this.busMusic.connect(this.master);
      this.noise = makeNoise(this.ctx, 1.4);
      this.ready = this.ctx.state === 'running';
      this._bindGesture();
    } catch (_) {
      this.blocked = true;
    }
  }

  /**
   * Autoplay policy: a context created before any user gesture starts
   * 'suspended'. We attach one-shot listeners on every plausible first gesture
   * and resume there. Until then every call is a no-op that never throws, and
   * a music request made too early is remembered and started on resume.
   */
  _bindGesture() {
    if (this._gestureBound || !this.ctx) return;
    this._gestureBound = true;
    const resume = () => {
      this.unlock();
    };
    ['pointerdown', 'touchstart', 'keydown', 'mousedown', 'click'].forEach((ev) => {
      window.addEventListener(ev, resume, { once: false, passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._safe(() => this.ctx.suspend());
    });
  }

  /** Idempotent, safe to call from anywhere including a gesture handler. */
  unlock() {
    if (!this.ctx) return Promise.resolve(false);
    if (this.ctx.state === 'running') { this.ready = true; return Promise.resolve(true); }
    try {
      return this.ctx.resume().then(() => {
        this.ready = true;
        if (this._pendingMusic) {
          const p = this._pendingMusic;
          this._pendingMusic = null;
          this.music(p.id, p.opts);
        }
        return true;
      }).catch(() => false);
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  _safe(fn) { try { return fn(); } catch (_) { return undefined; } }

  setVolume(bus, v) {
    const val = Math.max(0, Math.min(1, v));
    this.volumes[bus] = val;
    const node = bus === 'sfx' ? this.busSfx : bus === 'music' ? this.busMusic : this.master;
    if (node) this._safe(() => { node.gain.value = this.muted && bus === 'master' ? 0 : val; });
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this._safe(() => { this.master.gain.value = m ? 0 : this.volumes.master; });
  }

  /**
   * Frozen API. `manifest` is { id: url }. Anything that fails to fetch or
   * decode is dropped and the synth handles that id instead.
   * @returns {Promise<void>} always resolves.
   */
  load(manifest = {}) {
    const ids = Object.keys(manifest);
    if (!this.ctx || !ids.length) return Promise.resolve();
    return Promise.all(ids.map((id) => fetch(manifest[id])
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('miss'))))
      .then((ab) => new Promise((res, rej) => {
        try { this.ctx.decodeAudioData(ab, res, rej); } catch (e) { rej(e); }
      }))
      .then((buf) => { this.buffers[id] = buf; })
      .catch(() => { /* synth covers it */ }))).then(() => undefined);
  }

  // -- helpers -------------------------------------------------------------

  _env(gain, t, a, d, peak) {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _tone(type, f0, f1, a, d, peak, dest, detune = 0) {
    const ctx = this.ctx, t = now(ctx);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + d);
    this._env(g, t, a, d, peak);
    o.connect(g).connect(dest || this.busSfx);
    o.start(t);
    o.stop(t + a + d + 0.05);
    return o;
  }

  _noiseHit(a, d, peak, filterHz, q, dest) {
    const ctx = this.ctx, t = now(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filterHz;
    bp.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t, a, d, peak);
    src.connect(bp).connect(g).connect(dest || this.busSfx);
    src.start(t);
    src.stop(t + a + d + 0.05);
  }

  // -- sfx -----------------------------------------------------------------

  /**
   * Frozen API. Known ids: fire, hit, death, pickup, levelup, shop, transition,
   * ui, deny. Unknown ids get a neutral tick rather than an error.
   */
  sfx(id, opts = {}) {
    if (!this.ctx || this.blocked) return;
    if (this.ctx.state !== 'running') { this.unlock(); return; }
    this._safe(() => {
      if (this.buffers[id]) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffers[id];
        const g = this.ctx.createGain();
        g.gain.value = opts.gain == null ? 1 : opts.gain;
        src.connect(g).connect(this.busSfx);
        src.start();
        return;
      }
      const v = opts.gain == null ? 1 : opts.gain;
      switch (id) {
        case 'fire': // a hedge trimmer's cough. Domestic, not martial.
          this._tone('square', 320, 140, 0.004, 0.075, 0.16 * v);
          this._noiseHit(0.002, 0.05, 0.09 * v, 1800, 1.1);
          break;
        case 'hit': // wet, close, over quickly
          this._noiseHit(0.002, 0.055, 0.16 * v, 900, 2.2);
          this._tone('triangle', 210, 90, 0.003, 0.06, 0.09 * v);
          break;
        case 'death': // something sitting down heavily on a lawn
          this._tone('sine', 150, 44, 0.01, 0.42, 0.2 * v);
          this._noiseHit(0.01, 0.34, 0.13 * v, 380, 0.8);
          break;
        case 'pickup': // two notes, a major third — too pleased with itself
          this._tone('sine', 784, 784, 0.008, 0.12, 0.13 * v);
          setTimeout(() => this._safe(() => this._tone('sine', 988, 988, 0.008, 0.16, 0.11 * v)), 70);
          break;
        case 'levelup': // a bloom that is slightly out of tune with itself
          [523.25, 659.25, 783.99].forEach((f, i) => {
            setTimeout(() => this._safe(() => this._tone('triangle', f, f, 0.02, 0.5, 0.1 * v, null, i === 1 ? 22 : -8)), i * 90);
          });
          break;
        case 'shop': // a till that is not a till. Wood on wood.
          this._tone('square', 640, 620, 0.004, 0.05, 0.09 * v);
          this._noiseHit(0.002, 0.07, 0.07 * v, 2600, 3);
          break;
        case 'transition': // air leaving a room
          this._noiseHit(0.5, 1.1, 0.1 * v, 520, 0.5);
          this._tone('sine', 120, 60, 0.4, 1.2, 0.07 * v);
          break;
        case 'deny':
          this._tone('sine', 180, 150, 0.01, 0.16, 0.09 * v);
          break;
        default: // ui / unknown
          this._tone('sine', 520, 520, 0.004, 0.05, 0.05 * v);
      }
    });
  }

  // -- music ---------------------------------------------------------------

  /**
   * Two beds, both synthesised, both looping forever until stopped.
   *  'day'   — a nursery major triad arpeggio, one voice detuned just enough to
   *            be wrong, over a bed that never quite resolves.
   *  'night' — a low drone with a slow beating fifth and a filtered wind.
   * @param {'day'|'night'} id
   */
  music(id, opts = {}) {
    if (!this.ctx || this.blocked) return;
    if (this.ctx.state !== 'running') { this._pendingMusic = { id, opts }; this.unlock(); return; }
    if (this.currentMusic && this.currentMusic.id === id) return;
    const fade = opts.fade == null ? 1.5 : opts.fade;
    this.stopMusic({ fade: Math.min(fade, 1.2) });
    this._safe(() => {
      const ctx = this.ctx, t = now(ctx);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.9, t + Math.max(0.05, fade));
      gain.connect(this.busMusic);
      const nodes = [];
      const bed = { id, gain, nodes, timer: null };

      if (id === NIGHT) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 320;
        lp.connect(gain);
        // drone: a fifth that beats slowly against itself
        [55, 82.4, 82.9].forEach((f, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = i === 0 ? 'sine' : 'sawtooth';
          o.frequency.value = f;
          g.gain.value = i === 0 ? 0.5 : 0.14;
          o.connect(g).connect(lp);
          o.start(t);
          nodes.push(o);
        });
        // a slow swell, the room breathing
        const lfo = ctx.createOscillator();
        const lfoG = ctx.createGain();
        lfo.frequency.value = 0.07;
        lfoG.gain.value = 130;
        lfo.connect(lfoG).connect(lp.frequency);
        lfo.start(t);
        nodes.push(lfo);
        // wind
        const wind = ctx.createBufferSource();
        wind.buffer = this.noise;
        wind.loop = true;
        const wf = ctx.createBiquadFilter();
        wf.type = 'lowpass';
        wf.frequency.value = 240;
        const wg = ctx.createGain();
        wg.gain.value = 0.09;
        wind.connect(wf).connect(wg).connect(gain);
        wind.start(t);
        nodes.push(wind);
      } else {
        // DAY: too cheerful. C major, a bouncing arpeggio, one voice sharp.
        const seq = [523.25, 659.25, 783.99, 659.25, 523.25, 587.33, 659.25, 587.33];
        let step = 0;
        const pad = ctx.createOscillator();
        const padG = ctx.createGain();
        pad.type = 'triangle';
        pad.frequency.value = 130.81;
        pad.detune.value = -14; // flat. Nobody tuned this house.
        padG.gain.value = 0.11;
        pad.connect(padG).connect(gain);
        pad.start(t);
        nodes.push(pad);
        const tick = () => {
          this._safe(() => {
            const f = seq[step % seq.length];
            const tt = now(ctx);
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'triangle';
            o.frequency.value = f;
            o.detune.value = step % 4 === 3 ? 26 : 0; // the wrong one, every fourth
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.exponentialRampToValueAtTime(0.12, tt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.34);
            o.connect(g).connect(gain);
            o.start(tt);
            o.stop(tt + 0.4);
            step++;
          });
        };
        tick();
        bed.timer = setInterval(tick, 340);
      }
      this.currentMusic = bed;
    });
  }

  stopMusic(opts = {}) {
    const bed = this.currentMusic;
    if (!bed) return;
    this.currentMusic = null;
    const fade = opts.fade == null ? 1 : opts.fade;
    this._safe(() => {
      if (bed.timer) clearInterval(bed.timer);
      const t = now(this.ctx);
      bed.gain.gain.cancelScheduledValues(t);
      bed.gain.gain.setValueAtTime(Math.max(0.0002, bed.gain.gain.value), t);
      bed.gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, fade));
      setTimeout(() => {
        this._safe(() => {
          bed.nodes.forEach((n) => { try { n.stop(); } catch (_) {} });
          bed.gain.disconnect();
        });
      }, (fade + 0.2) * 1000);
    });
  }

  dispose() {
    this.stopMusic({ fade: 0.05 });
    this._safe(() => this.ctx && this.ctx.close());
  }
}

// SELF-TEST:
//   import { AudioManager } from './src/systems/audio.js';
//   const a = new AudioManager();
//   1. Before clicking anything: a.sfx('fire') is silent and does NOT throw,
//      and a.ctx.state is 'suspended'. Autoplay policy handled.
//   2. Click the page once. a.ready flips true. Now a.sfx('fire'), 'hit',
//      'death', 'pickup', 'levelup', 'shop', 'transition' each make a distinct,
//      audible, entirely synthesised noise. No network request is made.
//   3. a.music('day') -> a bouncing major arpeggio with every fourth note sharp
//      over a flat triangle pad. a.music('night') -> crossfades to a low beating
//      fifth and filtered wind. a.stopMusic({fade: 2}) fades it out and clears
//      the interval (check: no stray setInterval left running).
//   4. a.music('night') called twice in a row is a no-op the second time.
//   5. a.load({fire: '/nope.wav'}) resolves, logs nothing, and 'fire' still
//      plays the synth version.
//   6. In a browser with WebAudio disabled, `new AudioManager()` sets .blocked
//      and every method is an inert no-op.
