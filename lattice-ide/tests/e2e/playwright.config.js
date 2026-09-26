// Playwright config: serves the PWA with python's http.server and runs a dry-run worker,
// both on free ports chosen once in the main process (inherited by test workers via env).
const { defineConfig } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..', '..');
function freePort() {
  return Number(execFileSync('python3', ['-c',
    'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()']).toString().trim());
}
if (!process.env.E2E_APP_PORT) process.env.E2E_APP_PORT = String(freePort());
if (!process.env.E2E_WORKER_PORT) process.env.E2E_WORKER_PORT = String(freePort());
if (!process.env.E2E_RUNS) {
  process.env.E2E_RUNS = path.join(__dirname, '.runs', String(Date.now()));
  fs.mkdirSync(process.env.E2E_RUNS, { recursive: true });
}
const APP = Number(process.env.E2E_APP_PORT);
const WORKER = Number(process.env.E2E_WORKER_PORT);

const launchOptions = {};
if (process.env.PW_CHROMIUM_PATH) launchOptions.executablePath = process.env.PW_CHROMIUM_PATH;

module.exports = defineConfig({
  testDir: './specs',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one worker process: the Lattice worker runs one job at a time (FIFO)
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP}`,
    browserName: 'chromium',
    serviceWorkers: 'block',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    launchOptions,
  },
  webServer: [
    {
      command: `python3 -m http.server ${APP} --bind 127.0.0.1`,
      cwd: APP_DIR,
      url: `http://127.0.0.1:${APP}/index.html`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: process.env.CI ? 'pipe' : 'ignore',
    },
    {
      command: `python3 worker.py --host 127.0.0.1 --port ${WORKER} --runs "${process.env.E2E_RUNS}"`,
      cwd: APP_DIR,
      env: { LATTICE_DRY_RUN: '1', LATTICE_TOKEN: '', LATTICE_REGION: '' },
      url: `http://127.0.0.1:${WORKER}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: process.env.CI ? 'pipe' : 'ignore',
    },
  ],
});
