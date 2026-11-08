const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { expect, S } = h;

test('cancel a running job', async ({ page, request }) => {
  await h.openApp(page, { hash: 'cosmos' });
  await h.panel(page, 'cosmos').locator('#f-prompt-c').fill('e2e cancel me');
  await h.submit(page, 'cosmos');
  const id = await h.waitForQueuedJob(page, 'e2e cancel me');
  await expect.poll(async () => (await h.workerJob(request, id)).status).toBe('running');
  await h.openJobFromHome(page, id);
  const cancel = page.locator(S.cancel);
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.locator('#sheet .pill.cancelled').first()).toBeVisible();
  await expect(cancel).toBeDisabled();
  expect((await h.workerJob(request, id)).status).toBe('cancelled');
});

test('offline draft, fix worker URL, send draft -> done', async ({ page }) => {
  await h.openApp(page, { hash: 'cosmos', workerUrl: h.DEAD_URL });
  await h.panel(page, 'cosmos').locator('#f-prompt-c').fill('e2e offline draft');
  await h.submit(page, 'cosmos');
  await expect(page.locator('#sheetTitle')).toHaveText('Worker offline');
  await page.getByRole('button', { name: 'Save as queued draft' }).click();
  let id;
  await expect.poll(async () => {
    const d = (await h.storedJobs(page)).find(j => j.draft && j.inputs && j.inputs.prompt === 'e2e offline draft'); id = d && d.id; return !!id;
  }).toBe(true);

  // Fix the worker URL in More -> Settings.
  await page.locator('#tab-more').click();
  await page.locator('#moreSettings summary').click();
  await page.locator('#s-url').fill(h.WORKER_URL);
  await page.locator('#settingsForm').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#hdrHealth .hdr-label')).toHaveText(/dry-run|online/);

  await page.locator(`#moreJobs button.job[data-id="${id}"]`).click();
  await page.locator(S.draftSend).click();
  await expect(page.locator('#sheet .pill.done').first()).toBeVisible({ timeout: 30_000 });
  const rec = (await h.storedJobs(page)).find(j => j.id === id);
  expect(rec.draft).toBe(false);
  expect(rec.status).toBe('done');
});

test('export lattice-jobs.json (no tokens, no media data) and import it back', async ({ page }, info) => {
  await h.openApp(page, { hash: 'cosmos' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await h.panel(page, 'cosmos').locator('#f-prompt-c').fill('e2e export');
  await h.panel(page, 'cosmos').locator(S.mediaLibrary).setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await h.submit(page, 'cosmos');
  const id = await h.waitForQueuedJob(page, 'e2e export');

  await page.locator('#tab-more').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(S.exportBtn).click()]);
  expect(dl.suggestedFilename()).toBe('lattice-jobs.json');
  const file = info.outputPath('lattice-jobs.json');
  await dl.saveAs(file);
  const text = fs.readFileSync(file, 'utf8');
  expect(text).not.toContain('hf_e2eSECRETtoken123');
  expect(text).not.toMatch(/hfToken|workerToken|X-HF-Token":\s*"hf_/);
  expect(text).not.toContain('data:image');
  expect(text).not.toContain(';base64,');
  const d = JSON.parse(text);
  expect(d.schema).toBe('lattice.jobs-export/1');
  const job = d.jobs.find(j => j.id === id);
  expect(job).toBeTruthy();
  expect(job.inputs.media[0].name).toBe('dot.png');

  // Clear history, then import the file back.
  page.once('dialog', dlg => dlg.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(async () => (await h.storedJobs(page)).length).toBe(0);
  await page.locator(S.importInput).setInputFiles(file);
  await expect(page.locator(`#moreJobs button.job[data-id="${id}"]`)).toBeVisible();
  expect((await h.storedJobs(page)).map(j => j.id)).toContain(id);
  // The import control is a visible button wired to the hidden file input.
  await expect(page.locator(S.importBtn)).toBeVisible();
});

test('media pick (image + video) -> thumbnails -> submitted -> worker has inputs/<file>', async ({ page, request }) => {
  await h.openApp(page, { hash: 'cosmos' });
  const form = h.panel(page, 'cosmos');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  // Minimal ISO-BMFF header ("ftyp" box) standing in for a tiny mp4; the app only needs a video/* file.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2')]);
  await form.locator(S.mediaLibrary).setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await form.locator(S.mediaVideo).setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(form.locator('#cosmos-thumbs .thumb')).toHaveCount(2);
  await expect(form.locator('#cosmos-thumbs img[alt="pixel.png"]')).toBeVisible();
  await expect(form.locator('#cosmos-thumbs video')).toHaveCount(1);
  await form.locator('#f-prompt-c').fill('e2e media');
  await h.submit(page, 'cosmos');
  const id = await h.waitForQueuedJob(page, 'e2e media');
  const st = await h.workerJob(request, id);
  expect(st.id).toBe(id);
  const inputs = path.join(h.RUNS, id, 'inputs');
  await expect.poll(() => fs.existsSync(path.join(inputs, 'pixel.png')) && fs.existsSync(path.join(inputs, 'clip.mp4'))).toBe(true);
  expect(fs.readFileSync(path.join(inputs, 'pixel.png')).equals(png)).toBe(true);
  expect(fs.readFileSync(path.join(inputs, 'clip.mp4')).equals(mp4)).toBe(true);
  // job.json on disk has media data stripped and never contains the HF token.
  const jobJson = fs.readFileSync(path.join(h.RUNS, id, 'job.json'), 'utf8');
  expect(jobJson).not.toContain('base64,');
  expect(jobJson).not.toContain('hf_e2eSECRETtoken123');
});
