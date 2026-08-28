/**
 * Proves onnxruntime-web actually initialises and runs, using a 76-byte
 * hand-built ONNX model instead of a real one.
 *
 * This covers the setup that has broken in practice — wasmPaths resolution, the
 * WebGPU-vs-WASM decision, and whether the threaded build survives without
 * SharedArrayBuffer — none of which needs the Hugging Face CDN. What it does
 * not cover is downloading real weights.
 *
 * Usage: node scripts/verify-ort.mjs [url]
 *   With a dev server on :5173, or NO_COI=1 vite on :5174 to reproduce a host
 *   that cannot send COOP/COEP.
 */
import { chromium, devices } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5173/verify/ort.html';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ ...devices['Pixel 7'] });

await page.goto(URL, { waitUntil: 'load' });
await page
  .waitForFunction(() => document.getElementById('out').textContent.includes('RESULT'), null, {
    timeout: 90_000,
  })
  .catch(() => {});

const report = (await page.locator('#out').textContent()) ?? '';
console.log(report);
await browser.close();

if (!/RESULT: PASS/.test(report)) {
  console.error('\nORT runtime check FAILED');
  process.exit(1);
}
console.log('\nORT runtime check passed');
