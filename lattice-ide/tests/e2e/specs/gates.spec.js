const { test } = require('@playwright/test');
const h = require('./helpers');
const { expect } = h;

test('license gate blocks submit until accepted, then submits', async ({ page }) => {
  await h.openApp(page, { hash: 'hyworld', licenses: false });
  const form = h.panel(page, 'hyworld');
  await expect(form.getByText('License not accepted yet')).toBeVisible();
  await form.locator('#f-prompt-h').fill('e2e license gate');
  await h.submit(page, 'hyworld');
  await expect(page.locator('#sheetTitle')).toHaveText('License gate');
  expect((await h.storedJobs(page)).length).toBe(0);
  await expect(page.locator('#licDone')).toHaveCount(0);
  await page.locator('#sheet').getByRole('button', { name: /I have read License\.txt/ }).click();
  await page.locator('#sheet').getByRole('button', { name: 'Continue — submit job' }).click();
  await h.waitForQueuedJob(page, 'e2e license gate');
  const lic = await page.evaluate(() => JSON.parse(localStorage.getItem('lattice.license')));
  expect(lic['Tencent-HY-World-2.0']).toBeTruthy();
  expect(lic['OpenMDW-1.1']).toBeNull();
});

test('Super 64B is infeasible on Jetson', async ({ page }) => {
  await h.openApp(page, { hash: 'cosmos' });
  const form = h.panel(page, 'cosmos');
  await form.getByRole('radiogroup', { name: 'model' }).getByRole('radio', { name: /^Super 64B/ }).click();
  const targets = form.getByRole('radiogroup', { name: 'target' });
  const jetson = targets.getByRole('radio', { name: /^Jetson/ });
  await expect(jetson).toHaveAttribute('aria-disabled', 'true');
  await expect(jetson).toContainText('Super 64B needs datacenter');
  await jetson.click({ force: true }); // aria-disabled: Playwright would refuse a normal click
  await expect(page.locator('#toast')).toContainText('Super 64B needs datacenter');
  await expect(jetson).toHaveAttribute('aria-checked', 'false');
  await expect(targets.getByRole('radio', { name: /^Datacenter/ })).toHaveAttribute('aria-checked', 'true');
  await expect(form.locator('#cosmos-code')).toContainText('cosmos3-super-64b');
  await expect(form.locator('#cosmos-code')).toContainText('"target": "datacenter"');
});

test('mixed-content warning is not shown on http', async ({ page }) => {
  await h.openApp(page, { hash: 'home', workerUrl: h.DEAD_URL });
  expect(await page.evaluate(() => location.protocol)).toBe('http:');
  await expect(page.locator('#healthCard .pill')).toHaveText('offline');
  await expect(page.getByText('browsers block mixed content')).toHaveCount(0);
  await page.locator('#tab-more').click();
  await page.locator('#moreSettings summary').click();
  await page.locator('#s-url').fill('http://10.0.0.5:8787');
  await expect(page.locator('#s-mixed')).toBeHidden();
});

test('territory gate: EU country disables HY-World and Bridge submit; cleared country re-enables', async ({ page }) => {
  await h.openApp(page, { hash: 'more' });
  await page.locator('#moreSettings summary').click();
  await page.locator('#s-territory').fill('de');
  await page.locator('#settingsForm').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#s-territory')).toHaveValue('DE');
  for (const engine of ['hyworld', 'bridge']) {
    await page.locator('#tab-' + engine).click();
    const p = h.panel(page, engine);
    await expect(p.locator(`[data-testid="${engine}-submit"], button[data-submit]`).first()).toBeDisabled();
    await expect(p.locator('[data-testid="territory-reason"]')).toBeVisible();
  }
  await page.locator('#tab-cosmos').click();
  await expect(h.panel(page, 'cosmos').locator('[data-testid="cosmos-submit"], button[data-submit]').first()).toBeEnabled();

  await page.locator('#tab-more').click();
  await page.locator('#moreSettings summary').click();
  await page.locator('#s-territory').fill('US');
  await page.locator('#settingsForm').getByRole('button', { name: 'Save' }).click();
  await page.locator('#tab-hyworld').click();
  await expect(h.panel(page, 'hyworld').locator('[data-testid="hyworld-submit"], button[data-submit]').first()).toBeEnabled();
  await expect(h.panel(page, 'hyworld').locator('[data-testid="territory-reason"]')).toHaveCount(0);
});
