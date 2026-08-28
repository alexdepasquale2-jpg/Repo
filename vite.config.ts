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
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
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
        navigateFallback: 'index.html',

        runtimeCaching: [
          {
            // onnxruntime-web WASM runtime, served from our own origin.
            urlPattern: ({ url }) => url.pathname.startsWith('/ort/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ort-runtime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Model weights. Transformers.js also keeps its own Cache Storage
            // entry ('transformers-cache'); this is a second line of defence so
            // a cold reload offline still resolves.
            urlPattern: /^https:\/\/(huggingface\.co|cdn-lfs[^/]*\.hf\.co)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'hf-models',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },

      manifest: {
        name: 'Signal Hunt',
        short_name: 'Signal Hunt',
        description:
          'Track down a hidden word using an AI model that runs entirely on your phone.',
        lang: 'en',
        start_url: '/',
        scope: '/',
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
