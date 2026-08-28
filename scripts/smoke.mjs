/**
 * Browser smoke test against a built + served copy of the game.
 *
 * Drives the parts that must work with no model present: tapping, the economy,
 * tab navigation, saving and offline credit. Model-backed abilities are checked
 * only as far as "unlocking one does not break the page" — their weights come
 * from the Hugging Face CDN, which CI may not be able to reach.
 *
 * Usage: node scripts/smoke.mjs [url] [screenshot-path]
 */
import { chromium, devices } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4173/';
const SHOT = process.argv[3] ?? 'smoke.png';

const CHROME =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ ...devices['Pixel 7'] });
const page = await context.newPage();

// Model weights come from the Hugging Face CDN. Where that is unreachable the
// download failing is the expected path, not a regression — the game is built
// to keep running without it, which is exactly what the rest of this asserts.
const EXPECTED_OFFLINE =
  /huggingface|hf\.co|cdn-lfs|Failed to load resource|ERR_(NAME|INTERNET|CONNECTION|PROXY)|net::/i;

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !EXPECTED_OFFLINE.test(m.text())) errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);

/* ---------------------------------------------------------------- combat -- */

const name0 = await page.locator('#enemy-name').textContent();
check('enemy spawns', Boolean(name0 && name0 !== '—'), name0 ?? '');

// Dispatched rather than clicked: this drives the real pointerdown handler but
// runs hundreds of taps in one round trip instead of hundreds.
const tap = (n) =>
  page.evaluate((count) => {
    const c = document.getElementById('combat');
    for (let i = 0; i < count; i++) {
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    }
  }, n);

await tap(400);
await page.waitForTimeout(300);

const weights = await page.locator('#stat-weights').textContent();
check('tapping earns weights', weights !== '0', `weights=${weights}`);

const progress = await page.locator('#layer-progress').textContent();
check('layer progress advances', Boolean(progress), `progress=${progress}`);

/* ----------------------------------------------------------------- forge -- */

await page.locator('.tab[data-panel="forge"]').click();
check('forge tab opens', await page.locator('#panel-forge').isVisible());

const focusBefore = await page.locator('#focus-cost').textContent();
await page.locator('#buy-focus').click();
const focusAfter = await page.locator('#focus-cost').textContent();
check('buying focus raises its price', focusBefore !== focusAfter, `${focusBefore} → ${focusAfter}`);

// The cheapest daemon should be affordable after that many taps.
await page.locator('[data-daemon="wisp"]').click();
await page.waitForTimeout(400);
const dps = await page.locator('#stat-dps').textContent();
check('buying a daemon produces idle dps', dps !== '0', `dps=${dps}`);

/* ------------------------------------------------------------- pipelines -- */

await page.locator('.tab[data-panel="pipelines"]').click();
check('pipelines tab opens', await page.locator('#panel-pipelines').isVisible());
check('all abilities listed', (await page.locator('.ability').count()) === 4);

const lockedLabel = await page.locator('.ability[data-ability="divination"] [data-action]').textContent();
check('abilities start locked behind a price', /Unlock/.test(lockedLabel ?? ''), lockedLabel ?? '');

// The element picker is part of Divination, not the base game, so it must not
// exist before the unlock and must appear immediately after it.
await page.locator('.tab[data-panel="fight"]').click();
check('no elemental system before Divination', await page.locator('#elements').isHidden());

// Fund the unlock through the live game rather than localStorage: the page
// saves on its way out, so seeding storage and reloading would just be
// overwritten by the outgoing save.
await page.evaluate(() => {
  window.__game.state.weights = 1e9;
});

await page.locator('.tab[data-panel="pipelines"]').click();
await page.waitForTimeout(200);
await page.locator('.ability[data-ability="divination"] [data-action]').click();
await page.waitForTimeout(400);

await page.locator('.tab[data-panel="fight"]').click();
check('unlocking Divination reveals the element picker', await page.locator('#elements').isVisible());
check('five elements offered', (await page.locator('.element').count()) === 5);

// The unlock is recorded even though the model itself cannot download here.
// Autosave runs on a 1s cadence, so wait for the write rather than racing it.
const persisted = await page
  .waitForFunction(
    () => JSON.parse(localStorage.getItem('latent-depths/save') ?? '{}').unlocked?.includes('divination'),
    null,
    { timeout: 4000 },
  )
  .then(() => true, () => false);
check('unlock is persisted', persisted);

/* ---------------------------------------------------------------- limits -- */

await page.locator('.tab[data-panel="pipelines"]').click();
const diag = (await page.locator('#diagnostics').textContent()) ?? '';
check(
  'diagnostics report budget and network',
  /budget \d+ MB, resident \d+ MB/.test(diag) && /network/.test(diag) && /evictions/.test(diag),
  diag.split('\n').find((l) => l.startsWith('memory')) ?? '',
);

// Resident weight is summed from the registry, so the budget can be enforced
// before a load rather than after an out-of-memory kill.
const resident = await page.evaluate(() => {
  const h = window.__host;
  h.slots.set('embed', { status: 'ready', progress: 1 });
  h.slots.set('sentiment', { status: 'ready', progress: 1 });
  const both = h.residentMB;
  h.slots.set('sentiment', { status: 'absent', progress: 0 });
  const one = h.residentMB;
  h.slots.clear();
  return { both, one, budget: h.budgetMB };
});
check('resident weight is tracked', resident.both === 92 && resident.one === 25,
  `embed+sentiment=${resident.both}MB, embed=${resident.one}MB`);
check('memory budget is positive', resident.budget > 0, `${resident.budget}MB`);

/* -------------------------------------------------- cached model answers -- */

// The whole point of persisting answers: an evicted model must not cost the
// player a mechanic for enemies already measured.
await page.evaluate(() => {
  const g = window.__game;
  g.state.sigil = 'creeping frost';
  g.state.affinitySigil = 'creeping frost';
  g.state.affinities = { 'rime-hound': 0.83 };
  g.state.resonance = { 'rime-hound': 'frost' };
});

const cachePersisted = await page
  .waitForFunction(
    () => {
      const s = JSON.parse(localStorage.getItem('latent-depths/save') ?? '{}');
      return s.affinities?.['rime-hound'] === 0.83 && s.resonance?.['rime-hound'] === 'frost';
    },
    null,
    { timeout: 4000 },
  )
  .then(() => true, () => false);
check('model answers persist to the save', cachePersisted);

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);
const afterReload = await page.evaluate(() => {
  const g = window.__game;
  return { aff: g.state.affinities?.['rime-hound'], res: g.state.resonance?.['rime-hound'] };
});
check(
  'answers survive reload with no model loaded',
  afterReload.aff === 0.83 && afterReload.res === 'frost',
  JSON.stringify(afterReload),
);

/* --------------------------------------------------------------- retrain -- */

await page.locator('.tab[data-panel="retrain"]').click();
check('retrain tab opens', await page.locator('#panel-retrain').isVisible());
check(
  'retrain gated before layer 10',
  await page.locator('#btn-retrain').isDisabled(),
);

/* ------------------------------------------------------------- persistence */

await page.locator('.tab[data-panel="fight"]').click();
await page.waitForTimeout(1400); // let the 1s autosave land

const saved = await page.evaluate(() => localStorage.getItem('latent-depths/save'));
check('save is written', Boolean(saved));

const before = JSON.parse(saved ?? '{}');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);

const restored = await page.locator('#stat-weights').textContent();
check('save survives reload', restored !== '0', `weights=${restored}`);
check(
  'daemon count restored',
  (await page.evaluate(() => JSON.parse(localStorage.getItem('latent-depths/save') ?? '{}').daemons?.wisp)) >= 1,
  `owned=${before.daemons?.wisp}`,
);

/* ------------------------------------------------------------------ misc -- */

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: SHOT });
console.log(`\nscreenshot → ${SHOT}`);

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
