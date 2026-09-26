// Multi-user workspace: this spec starts its own dry-run worker with a temp LATTICE_USERS file
// (admin + viewer, created with `worker.py users add`) so the shared open worker stays untouched.
const { test } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { expect } = h;

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
let dir, worker, url;
const tok = {};

function freePort() {
  return Number(execFileSync('python3', ['-c',
    'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()']).toString().trim());
}
function addUser(name, role) {
  const out = execFileSync('python3', ['worker.py', 'users', 'add', name, '--role', role,
    '--file', path.join(dir, 'users.json'), '--runs', path.join(dir, 'runs')], { cwd: APP_DIR }).toString();
  const t = out.split('\n').map(s => s.trim()).find(s => s.startsWith('lt_'));
  if (!t) throw new Error('no token printed');
  return t;
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-users-e2e-'));
  fs.mkdirSync(path.join(dir, 'runs'));
  tok.admin = addUser('ada', 'admin');
  tok.viewer = addUser('vera', 'viewer');
  const port = freePort();
  url = `http://127.0.0.1:${port}`;
  worker = spawn('python3', ['worker.py', '--host', '127.0.0.1', '--port', String(port), '--runs', path.join(dir, 'runs')], {
    cwd: APP_DIR, stdio: 'ignore',
    env: Object.assign({}, process.env, { LATTICE_DRY_RUN: '1', LATTICE_USERS: path.join(dir, 'users.json'), LATTICE_TOKEN: '', LATTICE_REGION: '' }),
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/health'); if (r.ok) return; } catch (e) { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('users worker did not start');
});

test.afterAll(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise(r => { worker.once('exit', r); setTimeout(r, 3000); });
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('viewer: whoami shows name and role, submit buttons disabled with reason, no audit section', async ({ page }) => {
  await h.openApp(page, { hash: 'home', workerUrl: url, settings: { workerToken: tok.viewer } });
  await expect(page.locator('[data-testid="whoami"]')).toHaveText('Signed in as vera (viewer)');
  for (const engine of ['cosmos', 'hyworld', 'bridge']) {
    await page.locator('#tab-' + engine).click();
    const p = h.panel(page, engine);
    await expect(p.locator(`[data-testid="${engine}-submit"]`)).toBeDisabled();
    await expect(p.locator('[data-testid="role-reason"]')).toContainText('viewer (read-only)');
  }
  await page.locator('#tab-more').click();
  await expect(page.locator('#moreSettings')).toBeVisible();
  await expect(page.getByText('Audit & costs')).toHaveCount(0);
  // The worker enforces it too: a viewer POST is 403.
  const r = await page.request.post(url + '/jobs', { data: {}, headers: { Authorization: 'Bearer ' + tok.viewer } });
  expect(r.status()).toBe(403);
});

test('admin: whoami, submit a job, audit table + report table + CSV download without tokens', async ({ page }, info) => {
  await h.openApp(page, { hash: 'cosmos', workerUrl: url, settings: { workerToken: tok.admin } });
  await page.locator('#tab-home').click();
  await expect(page.locator('[data-testid="whoami"]')).toHaveText('Signed in as ada (admin)');
  await page.locator('#tab-cosmos').click();
  const form = h.panel(page, 'cosmos');
  await expect(form.locator('[data-testid="cosmos-submit"]')).toBeEnabled();
  await expect(form.locator('[data-testid="role-reason"]')).toHaveCount(0);
  await form.locator('#f-prompt-c').fill('e2e users admin job');
  await h.submit(page, 'cosmos');
  const id = await h.waitForQueuedJob(page, 'e2e users admin job');

  await page.locator('#tab-more').click();
  await page.locator('#moreAudit summary').click();
  const audit = page.locator('[data-testid="audit-table"]');
  await expect(audit).toBeVisible();
  await expect(audit).toContainText('job.submit');
  await expect(audit).toContainText('license.accept');
  await expect(audit).toContainText(id);
  await expect(audit).toContainText('ada');
  const report = page.locator('[data-testid="report-table"]');
  await expect(report).toBeVisible();
  await expect(report.locator('tbody tr', { hasText: 'ada' })).toHaveCount(1);
  await expect(report.locator('tbody tr', { hasText: 'cosmos' })).toHaveCount(1);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid="audit-csv"]').click()]);
  expect(dl.suggestedFilename()).toBe('lattice-audit.csv');
  const file = info.outputPath('lattice-audit.csv');
  await dl.saveAs(file);
  const csv = fs.readFileSync(file, 'utf8');
  expect(csv.split(/\r?\n/)[0]).toBe('ts,user,action,job_id,license_id,accepted_at,territory,subject,change,role,ip');
  expect(csv).toContain('job.submit');
  expect(csv).toContain('users.change');
  for (const t of Object.values(tok)) expect(csv).not.toContain(t);
  expect(csv).not.toContain('hf_e2eSECRETtoken123');
  const raw = fs.readFileSync(path.join(dir, 'runs', '_audit', 'audit.jsonl'), 'utf8');
  for (const t of Object.values(tok)) expect(raw).not.toContain(t);
  expect(raw).not.toContain('hf_e2eSECRETtoken123');
});
