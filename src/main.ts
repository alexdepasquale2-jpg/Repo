import './style.css';
import { PipelineHost } from './ai/PipelineHost';
import { PIPELINES } from './ai/registry';
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
 * Divination. Answers are cached into the save, so a relaunch keeps what the
 * model already worked out even before the pipeline is warm again.
 */
async function resolveResonance(): Promise<void> {
  if (!game.has('divination') || !host.isReady('embed')) return;
  const archetype = game.archetype;
  if (game.state.resonance[archetype.id]) return;

  try {
    game.state.resonance[archetype.id] = await oracle.resonantElement(archetype);
    renderAll();
  } catch (err) {
    console.warn('[divination] failed', err);
  }
}

/** Resonance. Recomputed per archetype since affinity is pair-specific. */
async function resolveAffinity(): Promise<void> {
  if (!game.has('resonance') || !host.isReady('embed') || !game.state.sigil) {
    game.sigilAffinity = 0;
    return;
  }
  try {
    game.sigilAffinity = await oracle.sigilAffinity(game.state.sigil, game.archetype);
    renderAll();
  } catch (err) {
    console.warn('[resonance] failed', err);
    game.sigilAffinity = 0;
  }
}

/** Loads an ability's pipeline, reporting progress through the ability list. */
async function ensurePipeline(abilityId: string): Promise<boolean> {
  const spec = ABILITIES.find((a) => a.id === abilityId);
  if (!spec) return false;
  if (host.isReady(spec.pipeline)) return true;

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

host.onChange = () => renderAbilities();

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

    card.classList.toggle('is-owned', owned);

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

// Re-warm any pipeline the player already paid for. Weights come from the
// Transformers.js cache on a repeat launch, so this is usually near-instant
// and needs no network.
for (const a of ABILITIES) {
  if (game.has(a.id) && !host.isReady(a.pipeline)) {
    void host.load(a.pipeline, a.pipeline).then(
      () => {
        void resolveResonance();
        void resolveAffinity();
      },
      () => {
        /* surfaced in the pipelines tab */
      },
    );
  }
}

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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save(game.state);
});

/**
 * Exposed deliberately, for the smoke test and for poking at a live run from
 * devtools. This is a single-player idle game with no server, no leaderboard
 * and a save the player already owns, so there is nothing here worth hiding.
 */
(window as unknown as { __game: Game }).__game = game;

renderAll();
void resolveResonance();
void resolveAffinity();
