// Bundles the ES-module source into one self-contained HTML file.
//
// The repo version (index.html) loads src/ as modules, which is the right shape
// to work in. Artifact hosting serves a single page with no relative fetches, so
// this produces dist/play.html: identical game, everything inlined.
//
//   node build.mjs        (needs esbuild on the path or in node_modules)
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap';

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
});
const js = result.outputFiles[0].text;

// No <!doctype>, <html>, <head> or <body>: the artifact host supplies the
// skeleton and wraps this fragment.
const page = `<title>The Chair Is Not Locked</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
  /* One committed visual world — a dark ruin lit by lamplight. No light theme:
     the game paints its own ground, and a canvas that inverts is a different game.
     Every colour is stated here so the page never borrows the host's. */
  :root {
    --ground: #0b0a07;
    --ink: #e8e2d0;
    --ink-dim: rgba(232, 226, 208, 0.42);
    --gold: #c9a24a;
    --spore: #8fbf5a;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --display: "IBM Plex Sans Condensed", "IBM Plex Mono", ui-monospace, sans-serif;
    color-scheme: dark;
  }

  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--mono);
    /* A game is not a document: no rubber-band scroll, no text selection from a
       dragged thumb, no grey flash on every tap. */
    overscroll-behavior: none;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
  }

  #game {
    display: block;
    width: 100vw;
    height: 100vh;
    /* dvh follows the mobile browser's collapsing toolbars; vh does not. */
    height: 100dvh;
    touch-action: none;
    cursor: crosshair;
    background: var(--ground);
  }
  #game:focus, #game:focus-visible { outline: none; }

  /* The canvas draws its own title screen, so this stays out of its way: a plate
     at the foot of the screen that exists only to explain why the keyboard is
     not doing anything yet. */
  /* Touch needs no focus plate — a tap is already the gesture. It is hidden by
     the coarse-pointer query and by the script, so neither path leaves it up. */
  #focus-plate {
    position: fixed;
    left: 50%;
    bottom: 8vh;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 14px 26px;
    background: rgba(11, 10, 7, 0.92);
    border: 1px solid rgba(201, 162, 74, 0.45);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 18px 40px rgba(0, 0, 0, 0.55);
    text-align: center;
    pointer-events: none;
    transition: opacity 220ms ease;
  }
  #focus-plate[hidden] { display: none !important; }

  #focus-plate .call {
    font-family: var(--display);
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--gold);
  }
  #focus-plate .why {
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink-dim);
    max-width: 42ch;
  }

  #legend {
    position: fixed;
    top: 10px;
    left: 20px;
    font-size: 10px;
    letter-spacing: 0.08em;
    color: rgba(232, 226, 208, 0.26);
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
  }
  #legend b { color: rgba(232, 226, 208, 0.5); font-weight: 500; }

  @media (prefers-reduced-motion: reduce) {
    #focus-plate { transition: none; }
  }

  /* On a touch device the on-screen controls are the legend, and the keyboard
     hints name keys that are not there. */
  @media (pointer: coarse) {
    #focus-plate, #legend { display: none !important; }
  }
</style>

<canvas id="game" tabindex="0"></canvas>

<div id="focus-plate">
  <div class="call">Click to take the controls</div>
  <div class="why">The page has to hold the keyboard before WASD and Tab reach the game.</div>
</div>

<div id="legend">
  <b>WASD</b> move &middot; <b>Tab</b> target &middot; <b>Space</b> step &middot;
  <b>E</b> loot / hold to sit &middot; <b>1-4</b> abilities &middot;
  <b>\`</b> debug &middot; <b>P</b> pause
</div>

<script>
(function () {
  var canvas = document.getElementById('game');
  var plate = document.getElementById('focus-plate');
  var call = plate.querySelector('.call');
  var why = plate.querySelector('.why');

  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  function take() {
    canvas.focus({ preventScroll: true });
    plate.hidden = true;
  }
  // Focus without a gesture is not a promise the keyboard follows, so the plate
  // stays up until someone actually clicks or types. On touch there is no
  // keyboard to wait for, so it never appears at all.
  if (coarse) plate.hidden = true;
  canvas.focus({ preventScroll: true });
  // Any click, tap or keypress on the page is a request to play.
  document.addEventListener('pointerdown', take);
  document.addEventListener('keydown', function (e) {
    if (document.activeElement !== canvas) take();
  }, true);

  // Losing focus mid-run is the one case worth interrupting for: the keys stop
  // working and nothing on screen would otherwise say why.
  window.addEventListener('blur', function () {
    if (coarse) return;
    call.textContent = 'Click to resume';
    why.textContent = 'The keyboard went somewhere else.';
    plate.hidden = false;
  });

  // Double-tap-to-zoom would otherwise fight the target button.
  document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  window.addEventListener('focus', function () {
    canvas.focus({ preventScroll: true });
  });
})();
</script>

<script>
${js}
</script>
`;

await mkdir('dist', { recursive: true });
await writeFile('dist/play.html', page);

// play.html is a fragment: the artifact host wraps it in a document and supplies
// the charset/viewport meta and a small reset. Locally there is no host, and a
// page with no viewport meta lays out at 980px on a phone — which is exactly the
// bug this preview exists to stop me shipping. Same fragment, host-shaped wrapper.
const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px system-ui, sans-serif; background: #fafaf9; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${page}
</body>
</html>
`;
await writeFile('dist/preview.html', preview);

console.log(`dist/play.html — ${(page.length / 1024).toFixed(1)} KB (artifact fragment)`);
console.log('dist/preview.html — same page, wrapped for local testing');
