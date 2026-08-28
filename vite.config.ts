import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Cross-origin isolation.
 *
 * onnxruntime-web only gets multi-threaded WASM when `SharedArrayBuffer` is
 * available, which requires COOP+COEP. `credentialless` is used instead of
 * `require-corp` so that cross-origin model weights (the Hugging Face CDN)
 * still load without needing CORP headers on their side.
 *
 * These headers must be replicated by whatever serves the production build,
 * otherwise ORT silently drops to a single WASM thread. See README.
 */
// NO_COI=1 drops these, to reproduce a host that cannot set them (GitHub Pages
// among them) and confirm ORT still initialises single-threaded.
const crossOriginIsolation = process.env['NO_COI']
  ? {}
  : {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    };

/**
 * Deploy target sub-path. GitHub Pages serves a project site under /<repo>/,
 * so the build needs BASE_PATH=/Repo/ there; local dev and any root-hosted
 * deploy leave it alone. Everything downstream reads `import.meta.env.BASE_URL`
 * rather than assuming '/'.
 */
const base = process.env['BASE_PATH'] ?? '/';

export default defineConfig({
  base,
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },

  worker: { format: 'es' },

  // Transformers.js ships prebuilt ESM + wasm; letting Vite pre-bundle it
  // rewrites the paths it uses to locate its own runtime assets.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },

  build: {
    target: 'es2022',
    sourcemap: true,
  },

  plugins: [
    /**
     * Transformers.js references its WASM runtime via `new URL(..., import.meta.url)`,
     * so Vite emits a second, content-hashed copy of the same 21 MB binary into
     * assets/. The worker sets `wasmPaths` to '/ort/' before creating any ORT
     * session, so that copy is never fetched — it just doubles the build size.
     */
    {
      name: 'drop-duplicate-ort-wasm',
      apply: 'build',
      generateBundle(_options, bundle) {
        for (const file of Object.keys(bundle)) {
          const entry = bundle[file];
          if (entry?.type === 'asset' && /ort-wasm.*\.wasm$/.test(file)) {
            delete bundle[file];
          }
        }
      },
    },

    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['icons/*.png', 'favicon.svg'],

      workbox: {
        // The ORT WASM runtime is ~21 MB. Precaching it would block the first
        // launch on mobile data, so it is runtime-cached on first use instead.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['ort/**'],
        navigateFallback: `${base}index.html`,

        runtimeCaching: [
          {
            // onnxruntime-web WASM runtime, served from our own origin. Matched
            // anywhere in the path so it holds under a sub-path deploy too.
            urlPattern: ({ url }) => url.pathname.includes('/ort/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ort-runtime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
              // 200 only. Allowing 0 lets an opaque or failed response be
              // cached permanently under CacheFirst, which bricks the runtime
              // until the user clears site data.
              cacheableResponse: { statuses: [200] },
            },
          },
          // Model weights are deliberately NOT runtime-cached here.
          //
          // Transformers.js already persists them itself in Cache Storage
          // ('transformers-cache'), so a rule here buys nothing — and putting a
          // CacheFirst handler in front of multi-hundred-megabyte downloads is
          // actively harmful: the Cache API cannot store 206 Partial Content,
          // so any ranged or resumed fetch either fails outright or gets served
          // a mismatched full response on the next load.
        ],
      },

      manifest: {
        name: 'Latent Depths',
        short_name: 'Latent Depths',
        description:
          'An idle ARPG whose abilities are real AI models running on your phone.',
        lang: 'en',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1020',
        theme_color: '#0b1020',
        categories: ['games', 'education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      devOptions: { enabled: false },
    }),
  ],
});
