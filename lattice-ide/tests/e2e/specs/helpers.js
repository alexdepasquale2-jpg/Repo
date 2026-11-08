const { expect } = require('@playwright/test');

const WORKER_URL = `http://127.0.0.1:${process.env.E2E_WORKER_PORT}`;
const RUNS = process.env.E2E_RUNS;
const DEAD_URL = 'http://127.0.0.1:9'; // discard port: nothing listens

// Selectors: prefer U's data-testid attributes, fall back to wave-2 ids.
const S = {
  cancel: '[data-testid="job-cancel"], #jobCancel',
  exportBtn: '[data-testid="jobs-export"], #jobsExport',
  importBtn: '[data-testid="jobs-import"], #jobsImport',
  importInput: '#jobsImportIn',
  draftSend: '[data-testid="draft-send"], #jobResend',
  metrics: '[data-testid="job-metrics"]',
  mediaLibrary: '[data-testid="media-library"], input[data-in="lib"]',
  mediaVideo: '[data-testid="media-video"], input[data-in="vid"]',
};

/** Seed localStorage once per test (not on later reloads) and open the app. */
async function openApp(page, { workerUrl = WORKER_URL, licenses = true, hash = 'home', settings = {} } = {}) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.addInitScript(([wu, lic, extra]) => {
    if (sessionStorage.getItem('e2e.seeded')) return;
    sessionStorage.setItem('e2e.seeded', '1');
    localStorage.clear();
    localStorage.setItem('lattice.settings', JSON.stringify(Object.assign(
      { workerUrl: wu, workerToken: '', hfToken: 'hf_e2eSECRETtoken123', target: 'rtx', pollMs: 500 }, extra)));
    const now = new Date().toISOString();
    localStorage.setItem('lattice.license', JSON.stringify(lic
      ? { 'OpenMDW-1.1': now, 'Tencent-HY-World-2.0': now }
      : { 'OpenMDW-1.1': null, 'Tencent-HY-World-2.0': null }));
  }, [workerUrl, licenses, settings]);
  await page.goto('/index.html#' + hash);
}

function panel(page, engine) { return page.locator('#panel-' + engine); }

async function submit(page, engine) {
  const p = panel(page, engine);
  await p.locator(`[data-testid="${engine}-submit"], button[data-submit]`).first().click();
}

async function storedJobs(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('lattice.jobs') || '[]'));
}

/** Wait until the app has recorded a submitted (non-draft) job with this prompt and return its id.
 * Matching by prompt matters: on boot the app also syncs earlier tests' jobs from the shared worker. */
async function waitForQueuedJob(page, prompt) {
  let id;
  await expect.poll(async () => {
    const j = (await storedJobs(page)).find(x => !x.draft && x.inputs && x.inputs.prompt === prompt);
    id = j && j.id; return !!id;
  }).toBe(true);
  return id;
}

async function workerJob(request, id) {
  const r = await request.get(`${WORKER_URL}/jobs/${id}`);
  return r.json();
}

async function openJobFromHome(page, id) {
  await page.locator('#tab-home').click();
  await page.locator(`button.job[data-id="${id}"]`).click();
  await expect(page.locator('#sheet')).toBeVisible();
}

module.exports = { expect, WORKER_URL, RUNS, DEAD_URL, S, openApp, panel, submit, storedJobs, waitForQueuedJob, workerJob, openJobFromHome };
