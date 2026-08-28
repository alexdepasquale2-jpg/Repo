import './style.css';
import { PipelineHost } from './ai/PipelineHost';
import { PIPELINES } from './ai/registry';
import { LARGE_DOWNLOAD_MB, deviceMemoryGB, networkState } from './ai/limits';
import { Loop } from './engine/Loop';
import { Viewport } from './engine/Viewport';
import { Game } from './game/Game';
import { Oracle } from './game/Oracle';
import { CombatView } from './ui/CombatView';
import { fmt, fmtTime } from './game/numbers';
import { load, save, wipe } from './game/save';
import {
  ABILITIES,
  DAEMONS,
  ELEMENTS,
  ELEMENT_BY_ID,
  FOCUS,
  killsToClear,
  isBossLayer,
} from './game/content';
import { setupPWA } from './pwa';

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const host = new PipelineHost();
const oracle = new Oracle(host);
const game = new Game(load());

const el = {
  weights: need('stat-weights'),
  dps: need('stat-dps'),
  insight: need('stat-insight'),

  enemyName: need('enemy-name'),
  layerLabel: need('layer-label'),
  layerProgress: need('layer-progress'),
  bossTimer: need('boss-timer'),
  combat: need<HTMLCanvasElement>('combat'),
  elements: need('elements'),
  elementsLabel: need('elements-label'),
  elementRow: need('element-row'),
  fightHint: need('fight-hint'),

  buyFocus: need<HTMLButtonElement>('buy-focus'),
  focusSub: need('focus-sub'),
  focusCost: need('focus-cost'),
  daemonList: need('daemon-list'),

  abilityList: need('ability-list'),
  bindingSigil: need('binding-sigil'),
  sigil: need<HTMLInputElement>('sigil'),
  bindSigil: need<HTMLButtonElement>('bind-sigil'),
  sigilOut: need('sigil-out'),
  bindingCry: need('binding-cry'),
  cry: need<HTMLInputElement>('cry'),
  shoutCry: need<HTMLButtonElement>('shout-cry'),
  cryOut: need('cry-out'),
  bindingRelics: need('binding-relics'),
  relicList: need('relic-list'),

  retrainGain: need('retrain-gain'),
  retrainNote: need('retrain-note'),
  btnRetrain: need<HTMLButtonElement>('btn-retrain'),
  factDeepest: need('fact-deepest'),
  factLifetime: need('fact-lifetime'),
  factMult: need('fact-mult'),
  btnWipe: need<HTMLButtonElement>('btn-wipe'),

  diagnostics: need('diagnostics'),
  btnResetModels: need<HTMLButtonElement>('btn-reset-models'),

  tabs: need('tabs'),
  toast: need('toast'),
  toastText: need('toast-text'),
  swToast: need('sw-toast'),
  swReload: need('sw-reload'),
};

setupPWA(el.swToast, el.swReload);

/* ---------------------------------------------------------------- toast --- */

let toastTimer = 0;
function toast(text: string): void {
  el.toastText.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

/* ------------------------------------------------------------------ tabs -- */

el.tabs.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('.tab');
  if (!tab) return;
  const name = tab.dataset['panel']!;

  for (const b of el.tabs.querySelectorAll('.tab')) b.classList.toggle('is-active', b === tab);
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  // The canvas is measured on show; it reads as zero-sized while hidden.
  if (name === 'fight') viewport.resize();
  renderAll();
});

/* ---------------------------------------------------------------- combat -- */

const viewport = new Viewport(el.combat);
const view = new CombatView(viewport, game);

el.combat.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const report = game.tap();

  const color = report.resonant ? '#ff8c42' : report.crit ? '#ffd166' : '#e8ecf7';
  const label = `${fmt(report.amount)}${report.crit ? '!' : ''}${report.resonant ? ' ✦' : ''}`;
  view.pop(label, color, report.crit || report.resonant);

  if (report.crit || report.resonant) navigator.vibrate?.(12);
});

game.on((event) => {
  switch (event.type) {
    case 'kill':
      view.pop(`+${fmt(event.reward)}`, '#5fdc9a');
      break;
    case 'descend':
      toast(`Layer ${event.layer}`);
      void resolveResonance();
      void resolveAffinity();
      break;
    case 'bossFailed':
      toast(`The layer ${event.layer} boss held. Pushed back.`);
      navigator.vibrate?.([30, 60, 30]);
      break;
    case 'relic':
      toast(`Relic: ${event.relic.name}`);
      break;
  }
});

/* ------------------------------------------------------- AI-backed hooks -- */

/**
 * Brings a pipeline online in the background, but only when doing so is not a
 * decision worth asking about — small, and not over an expensive connection.
 *
 * This is what keeps the abilities feeling automatic without ever surprising
 * someone with a large download they did not ask for mid-fight. Anything
 * heavier stays manual, in the Pipelines tab.
 */
function warmIfCheap(abilityId: string): void {
  const spec = ABILITIES.find((a) => a.id === abilityId);
  if (!spec || !game.has(abilityId) || host.isReady(spec.pipeline)) return;
  if (host.state(spec.pipeline).status === 'loading') return;

  const net = networkState();
  if (net.offline || net.costly) return;
  if (PIPELINES[spec.pipeline].approxMB >= LARGE_DOWNLOAD_MB) return;

  void host.load(spec.pipeline, spec.pipeline).then(
    () => {
      void resolveResonance();
      void resolveAffinity();
    },
    () => {
      /* surfaced on the ability card */
    },
  );
}

/**
 * Divination. Answers are cached into the save, so a relaunch — or a budget
 * eviction — keeps what the model already worked out.
 */
async function resolveResonance(): Promise<void> {
  if (!game.has('divination')) return;
  const archetype = game.archetype;
  if (game.state.resonance[archetype.id]) return;

  if (!host.isReady('embed')) {
    warmIfCheap('divination');
    return;
  }

  try {
    game.state.resonance[archetype.id] = await oracle.resonantElement(archetype);
    renderAll();
  } catch (err) {
    console.warn('[divination] failed', err);
  }
}

/**
 * Resonance. Affinity is specific to the (sigil, archetype) pair, and cached
 * into the save once computed.
 *
 * The cache is what lets the memory budget evict the embedding model without
 * the mechanic degrading: an enemy already measured keeps its crit bonus, and
 * only a genuinely new archetype needs the model back.
 */
async function resolveAffinity(): Promise<void> {
  const sigil = game.state.sigil;
  if (!game.has('resonance') || !sigil) {
    game.sigilAffinity = 0;
    return;
  }

  // A new sigil invalidates every measurement taken against the old one.
  if (game.state.affinitySigil !== sigil) {
    game.state.affinities = {};
    game.state.affinitySigil = sigil;
  }

  const cached = game.state.affinities[game.archetype.id];
  if (cached !== undefined) {
    game.sigilAffinity = cached;
    return;
  }

  // Nothing cached and no model to ask: leave the bonus off rather than
  // dragging a download into the middle of a fight. A cheap warm may bring it
  // online shortly, and this runs again when it does.
  if (!host.isReady('embed')) {
    game.sigilAffinity = 0;
    warmIfCheap('resonance');
    return;
  }

  try {
    const value = await oracle.sigilAffinity(sigil, game.archetype);
    game.state.affinities[game.archetype.id] = value;
    game.sigilAffinity = value;
    renderAll();
  } catch (err) {
    console.warn('[resonance] failed', err);
    game.sigilAffinity = 0;
  }
}

/**
 * Loads an ability's pipeline, confirming first when the download is large and
 * the connection looks expensive.
 *
 * Spending 145 MB of someone's data plan is not a decision to make silently on
 * their behalf, and Save-Data is an explicit request not to.
 */
async function ensurePipeline(abilityId: string): Promise<boolean> {
  const spec = ABILITIES.find((a) => a.id === abilityId);
  if (!spec) return false;
  if (host.isReady(spec.pipeline)) return true;

  const sizeMB = PIPELINES[spec.pipeline].approxMB;
  const net = networkState();

  if (net.offline) {
    toast(`${spec.name} needs a connection the first time.`);
    return false;
  }

  if (sizeMB >= LARGE_DOWNLOAD_MB && net.costly) {
    const why = net.saveData ? 'Data Saver is on' : `you are on ${net.effectiveType}`;
    if (!confirm(`${spec.name} downloads about ${sizeMB} MB and ${why}. Download now?`)) {
      return false;
    }
  }

  try {
    await host.load(spec.pipeline, spec.pipeline);
    toast(`${spec.name} online.`);
    return true;
  } catch (err) {
    toast(`Could not load ${spec.name}.`);
    console.warn('[pipeline] load failed', err);
    return false;
  }
}

host.onChange = () => {
  renderAbilities();
  void renderDiagnostics();
};

/* -------------------------------------------------------------- bindings -- */

el.bindSigil.addEventListener('click', () => {
  game.state.sigil = el.sigil.value.trim();
  el.sigilOut.textContent = game.state.sigil ? 'Reading…' : 'Sigil cleared.';
  void (async () => {
    if (!(await ensurePipeline('resonance'))) return;
    await resolveAffinity();
    el.sigilOut.textContent = game.state.sigil
      ? `Affinity with ${game.archetype.name}: ${(game.sigilAffinity * 100).toFixed(0)}% — crit ${(game.critChance * 100).toFixed(0)}%`
      : 'Sigil cleared.';
  })();
});

el.shoutCry.addEventListener('click', () => {
  const text = el.cry.value.trim();
  if (!text) return;
  game.state.cry = text;
  el.cryOut.textContent = 'Listening…';

  void (async () => {
    if (!(await ensurePipeline('attunement'))) return;
    try {
      const reading = await oracle.readCry(text);
      if (reading.kind === 'fervour') {
        game.buff = { kind: 'fervour', remaining: 30, power: 1 + reading.power * 1.5 };
        el.cryOut.textContent = `Fervour — ${((game.buff.power - 1) * 100).toFixed(0)}% damage for 30s.`;
      } else {
        game.buff = { kind: 'dread', remaining: 30, power: reading.power * 0.05 };
        el.cryOut.textContent = `Dread — enemies burn for ${(game.buff.power * 100).toFixed(1)}% max HP per second.`;
      }
      toast(reading.kind === 'fervour' ? 'Fervour rises.' : 'Dread settles.');
      renderAll();
    } catch (err) {
      console.warn('[attunement] failed', err);
      el.cryOut.textContent = 'The depths did not hear that.';
    }
  })();
});

/* ------------------------------------------------------------- rendering -- */

function renderTop(): void {
  el.weights.textContent = fmt(game.state.weights);
  el.dps.textContent = fmt(game.dps);
  el.insight.textContent = fmt(game.state.insight);
}

function renderFight(): void {
  const s = game.state;
  el.enemyName.textContent = game.archetype.name;
  el.layerLabel.textContent = `Layer ${s.layer}${isBossLayer(s.layer) ? ' · Boss' : ''}`;
  el.layerProgress.textContent = `${s.killsThisLayer} / ${killsToClear(s.layer)}`;

  if (game.bossTimer !== null) {
    el.bossTimer.hidden = false;
    el.bossTimer.textContent = `⏳ ${game.bossTimer.toFixed(1)}s`;
  } else {
    el.bossTimer.hidden = true;
  }

  // The element picker only exists once Divination does — before that there is
  // no elemental system to interact with.
  const hasDivination = game.has('divination');
  el.elements.hidden = !hasDivination;

  if (hasDivination) {
    const known = game.resonantElement;
    el.elementsLabel.textContent = known
      ? `Resonates with ${ELEMENT_BY_ID.get(known)?.name ?? '—'}`
      : host.isReady('embed')
        ? 'Reading…'
        : 'Divination offline';

    if (el.elementRow.childElementCount !== ELEMENTS.length) {
      el.elementRow.replaceChildren(
        ...ELEMENTS.map((element) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'element';
          b.dataset['element'] = element.id;
          b.style.setProperty('--el', element.color);
          b.innerHTML = `<span class="element-glyph">${element.glyph}</span><span>${element.name}</span>`;
          b.addEventListener('click', () => {
            game.activeElement = game.activeElement === element.id ? null : element.id;
            renderFight();
          });
          return b;
        }),
      );
    }

    for (const b of el.elementRow.querySelectorAll<HTMLElement>('.element')) {
      const id = b.dataset['element']!;
      b.classList.toggle('is-active', game.activeElement === id);
      b.classList.toggle('is-resonant', known === id);
    }
  }

  const bits: string[] = [];
  if (game.critChance > 0) bits.push(`crit ${(game.critChance * 100).toFixed(0)}%`);
  if (game.buff) bits.push(`${game.buff.kind} ${game.buff.remaining.toFixed(0)}s`);
  el.fightHint.textContent = bits.length ? bits.join(' · ') : 'Tap the entity to attack.';
}

function renderForge(): void {
  el.focusSub.textContent = `Tap damage ${fmt(game.clickDamage)} → ${fmt(game.clickDamage + FOCUS.damagePerLevel * game.damageMultiplier)}`;
  el.focusCost.textContent = fmt(game.focusCost());
  el.buyFocus.classList.toggle('is-affordable', game.state.weights >= game.focusCost());

  if (el.daemonList.childElementCount !== DAEMONS.length) {
    el.daemonList.replaceChildren(
      ...DAEMONS.map((d) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'row buy';
        b.dataset['daemon'] = d.id;
        b.innerHTML = `
          <span class="row-main">
            <span class="row-name">${d.name} <span class="row-count" data-count></span></span>
            <span class="row-sub">${d.blurb}</span>
          </span>
          <span class="row-cost" data-cost></span>`;
        b.addEventListener('click', () => {
          if (game.buyDaemon(d.id)) renderAll();
          else toast('Not enough Weights.');
        });
        return b;
      }),
    );
  }

  for (const b of el.daemonList.querySelectorAll<HTMLElement>('[data-daemon]')) {
    const id = b.dataset['daemon']!;
    const owned = game.state.daemons[id] ?? 0;
    const cost = game.daemonCost(id);
    b.querySelector('[data-count]')!.textContent = owned > 0 ? `×${owned}` : '';
    b.querySelector('[data-cost]')!.textContent = fmt(cost);
    b.classList.toggle('is-affordable', game.state.weights >= cost);
  }
}

function renderAbilities(): void {
  if (el.abilityList.childElementCount !== ABILITIES.length) {
    el.abilityList.replaceChildren(
      ...ABILITIES.map((a) => {
        const card = document.createElement('div');
        card.className = 'ability';
        card.dataset['ability'] = a.id;
        card.innerHTML = `
          <div class="ability-head">
            <span class="ability-name">${a.name}</span>
            <span class="ability-size">${PIPELINES[a.pipeline].approxMB} MB</span>
          </div>
          <p class="ability-effect">${a.effect}</p>
          <p class="ability-flavor">${a.flavor}</p>
          <div class="ability-bar" data-bar hidden><span data-fill></span></div>
          <p class="ability-error" data-error hidden></p>
          <button class="btn btn-wide" type="button" data-action></button>`;

        card.querySelector('[data-action]')!.addEventListener('click', () => {
          if (!game.has(a.id)) {
            if (!game.unlock(a.id, a.cost)) {
              toast('Not enough Weights.');
              return;
            }
            toast(`${a.name} unlocked.`);
            renderAll();
          }
          void (async () => {
            if (await ensurePipeline(a.id)) {
              await resolveResonance();
              await resolveAffinity();
              renderAll();
            }
          })();
        });

        return card;
      }),
    );
  }

  for (const card of el.abilityList.querySelectorAll<HTMLElement>('[data-ability]')) {
    const a = ABILITIES.find((x) => x.id === card.dataset['ability'])!;
    const owned = game.has(a.id);
    const slot = host.state(a.pipeline);
    const button = card.querySelector<HTMLButtonElement>('[data-action]')!;
    const bar = card.querySelector<HTMLElement>('[data-bar]')!;
    const fill = card.querySelector<HTMLElement>('[data-fill]')!;
    const error = card.querySelector<HTMLElement>('[data-error]')!;

    card.classList.toggle('is-owned', owned);

    // The reason a load failed is the only thing that makes it fixable, and on
    // a phone there is no console to go read it in.
    if (slot.status === 'error' && slot.message) {
      error.hidden = false;
      error.textContent = slot.message;
    } else {
      error.hidden = true;
    }

    if (!owned) {
      button.textContent = `Unlock — ${fmt(a.cost)}`;
      button.disabled = game.state.weights < a.cost;
      button.className = 'btn btn-wide btn-primary';
      bar.hidden = true;
    } else if (slot.status === 'ready') {
      button.textContent = 'Online';
      button.disabled = true;
      button.className = 'btn btn-wide';
      bar.hidden = true;
    } else if (slot.status === 'loading') {
      button.textContent = `Downloading ${(slot.progress * 100).toFixed(0)}%`;
      button.disabled = true;
      button.className = 'btn btn-wide';
      bar.hidden = false;
      fill.style.width = `${slot.progress * 100}%`;
    } else {
      button.textContent = slot.status === 'error' ? 'Retry download' : 'Load model';
      button.disabled = false;
      button.className = 'btn btn-wide btn-primary';
      bar.hidden = true;
    }
  }

  el.bindingSigil.hidden = !game.has('resonance');
  el.bindingCry.hidden = !game.has('attunement');
  el.bindingRelics.hidden = game.state.relics.length === 0;

  el.relicList.replaceChildren(
    ...game.state.relics.map((r) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="row-main">
          <span class="row-name">${r.name}</span>
          <span class="row-sub">+${(r.value * 100).toFixed(0)}% ${r.mod}</span>
        </span>`;
      return row;
    }),
  );
}

function renderRetrain(): void {
  const gain = game.pendingInsight();
  el.retrainGain.textContent = fmt(gain);
  el.btnRetrain.disabled = gain <= 0;
  el.retrainNote.textContent =
    gain > 0
      ? `Resets Weights, Focus, Daemons and depth.`
      : `Reach layer 10 to retrain. Deepest so far: ${game.state.deepestLayer}.`;

  el.factDeepest.textContent = String(game.state.deepestLayer);
  el.factLifetime.textContent = fmt(game.state.lifetimeWeights);
  el.factMult.textContent = `${game.damageMultiplier.toFixed(2)}x`;
}

function renderAll(): void {
  renderTop();
  renderFight();
  renderForge();
  renderAbilities();
  renderRetrain();
}

/* ---------------------------------------------------------- diagnostics -- */

/**
 * Everything needed to explain a failed pipeline load, on the device itself.
 *
 * `crossOriginIsolated` is the one people get wrong: without COOP+COEP there is
 * no SharedArrayBuffer, so ORT drops to a single WASM thread. That is a speed
 * problem rather than a failure, and printing it stops it being blamed for one.
 */
/** Mirrors the worker's backend probe, for reporting only. */
async function probeAdapter(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'none';
  try {
    return (await gpu.requestAdapter()) ? 'yes' : 'null';
  } catch (err) {
    return `throws (${err instanceof Error ? err.message.slice(0, 60) : 'unknown'})`;
  }
}

async function renderDiagnostics(): Promise<void> {
  const caches_ = 'caches' in self ? await caches.keys().catch(() => []) : [];
  const net = networkState();
  const lines = [
    `base          ${import.meta.env.BASE_URL}`,
    `origin        ${location.origin}`,
    `memory        ${deviceMemoryGB() ?? '?'} GB — budget ${host.budgetMB} MB, resident ${host.residentMB} MB`,
    `network       ${net.effectiveType ?? '?'}${net.saveData ? ' save-data' : ''}${net.offline ? ' OFFLINE' : ''}`,
    `evictions     ${host.evictions}`,
    `isolated      ${self.crossOriginIsolated} (threads: ${typeof SharedArrayBuffer !== 'undefined'})`,
    // Both halves matter: navigator.gpu exists even when WebGPU is flag-gated,
    // and only a real adapter means it is actually usable.
    `webgpu        api=${'gpu' in navigator} adapter=${await probeAdapter()}`,
    `backend       ${host.backend ?? 'not chosen yet'}`,
    `serviceWorker ${navigator.serviceWorker?.controller ? 'active' : 'none'}`,
    `caches        ${caches_.join(', ') || 'none'}`,
    `online        ${navigator.onLine}`,
    ...[...host.slots].map(
      ([slot, s]) => `slot ${slot.padEnd(9)} ${s.status}${s.message ? ` — ${s.message}` : ''}`,
    ),
  ];
  el.diagnostics.textContent = lines.join('\n');
}

/**
 * Clears everything model-related: Transformers.js's own weight cache, the ORT
 * runtime cache, and the service worker. The recovery path for a poisoned cache
 * that would otherwise need the browser's site-data screen.
 */
el.btnResetModels.addEventListener('click', () => {
  if (!confirm('Clear cached models and service worker? Your save is kept.')) return;

  void (async () => {
    try {
      for (const key of await caches.keys()) await caches.delete(key);
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      toast('Caches cleared. Reloading…');
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      console.error('[diagnostics] clear failed', err);
      toast('Could not clear caches.');
    }
  })();
});

/* --------------------------------------------------------------- actions -- */

el.buyFocus.addEventListener('click', () => {
  if (game.buyFocus()) renderAll();
  else toast('Not enough Weights.');
});

el.btnRetrain.addEventListener('click', () => {
  if (!confirm('Collapse this run? You keep Insight, pipelines and relics.')) return;
  if (game.retrain()) {
    toast('Retrained.');
    renderAll();
  }
});

el.btnWipe.addEventListener('click', () => {
  if (!confirm('Erase your save permanently? This cannot be undone.')) return;
  wipe();
  location.reload();
});

/* ------------------------------------------------------------------ boot -- */

const offline = game.applyOffline((Date.now() - game.state.lastSeen) / 1000);
if (offline.weights > 0) {
  toast(`Away ${fmtTime(offline.seconds)} — daemons banked ${fmt(offline.weights)} Weights.`);
}

// Restore bound inputs so the pipelines tab reflects the save.
el.sigil.value = game.state.sigil;
el.cry.value = game.state.cry;

// Deliberately no eager preloading. Owned pipelines are warmed only when
// something actually needs a fresh answer (see warmIfCheap), because most
// sessions are served entirely from the cached answers in the save — and
// loading every owned model at launch is exactly what the budget exists to
// stop. The Pipelines tab remains the way to force one online.

let sinceSave = 0;
new Loop((dt, elapsed) => {
  game.tick(dt);
  view.draw(dt, elapsed);

  // The HUD only needs to keep up with the eye, not the frame.
  sinceSave += dt;
  if (sinceSave >= 1) {
    sinceSave = 0;
    save(game.state);
  }
  renderTop();
  renderFight();
}).start();

// Persist on the way out — visibilitychange is the reliable one on Android,
// where the tab is often killed without ever firing unload.
//
// Backgrounding also releases the models. An idle game sits in the background
// for hours, and a tab holding hundreds of megabytes is the one Android kills;
// the cached answers mean coming back costs a session rebuild at worst.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  save(game.state);
  host.sweepIdle(0);
});

/** Drop pipelines left untouched for a few minutes. */
const IDLE_UNLOAD_MS = 5 * 60_000;
setInterval(() => host.sweepIdle(IDLE_UNLOAD_MS), 60_000);

/**
 * Exposed deliberately, for the smoke test and for poking at a live run from
 * devtools. This is a single-player idle game with no server, no leaderboard
 * and a save the player already owns, so there is nothing here worth hiding.
 */
Object.assign(window, { __game: game, __host: host });

renderAll();
void renderDiagnostics();
void resolveResonance();
void resolveAffinity();
