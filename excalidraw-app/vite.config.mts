import path from "path";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import svgrPlugin from "vite-plugin-svgr";
import { ViteEjsPlugin } from "vite-plugin-ejs";
import { VitePWA } from "vite-plugin-pwa";
import checker from "vite-plugin-checker";
import { createHtmlPlugin } from "vite-plugin-html";
import Sitemap from "vite-plugin-sitemap";

import { woff2BrowserPlugin } from "../scripts/woff2/woff2-vite-plugins";
export default defineConfig(({ mode }) => {
  // To load .env variables
  const envVars = loadEnv(mode, `../`);
  // https://vitejs.dev/config/
  return {
    server: {
      port: Number(envVars.VITE_APP_PORT || 3000),
      host: true,
      // open the browser
      open: true,
      // accept any Host header — needed for both Cloudflare Tunnel and LAN
      // IP access (Vite blocks unknown hosts by default to prevent DNS
      // rebinding). Vite's default HMR will pick the right protocol from
      // the page origin (ws:// for plain http, wss:// when fronted by a
      // tunnel/proxy that terminates HTTPS).
      allowedHosts: true,
      // Same-origin proxy so one host (the Vite dev server) reaches the
      // storage Worker for REST. Realtime is 100% Durable Objects on the
      // Worker (:8787) since 06-17 — the old socket.io room server (:3002)
      // is retired, so its /socket.io, /translate, /translate-batch,
      // /chatbot, /stt, /summarize proxies are gone (AI/STT now live under
      // the Worker's /v1). The DO realtime WebSocket connects straight to
      // the Worker (`/rooms/:id/ws`, via VITE_APP_STORAGE_URL), not through
      // this proxy, so /v1 stays plain HTTP (no `ws: true`).
      //
      // /v1: durable scene/file save+load reachable SAME-ORIGIN through the
      // tunnel. Without this, the browser fetches http://localhost:8787
      // directly, which is cross-origin from the tunnel (and on a remote
      // visitor's machine points at a worker that isn't running) →
      // CORS/503 and no shared storage between users. The worker serves
      // everything under /v1, so keep the prefix (no rewrite).
      proxy: {
        "/v1": {
          target: "http://localhost:8787",
          changeOrigin: true,
        },
      },
    },
    // We need to specify the envDir since now there are no
    //more located in parallel with the vite.config.ts file but in parent dir
    envDir: "../",
    optimizeDeps: {
      // Force Vite to pre-bundle dxf-viewer + three.js + pdfjs-dist at
      // dev server startup. Without this, the dynamic imports in
      // <DXFRenderer /> and pdfRendering.ts race Vite's on-demand
      // dep-scanner — Vite returns 404 for
      // /node_modules/.vite/deps/<dep>.js the first time the user
      // uploads or opens that file kind after a cold server start
      // (the symptom is "Failed to fetch dynamically imported
      // module" in the browser console).
      include: ["dxf-viewer", "three", "pdfjs-dist"],
    },
    resolve: {
      // Force a single copy of React across the app + deps (Schedule-X is
      // Preact-based and pulled a second React instance through vite's
      // optimizer → "Invalid hook call / more than one copy of React").
      dedupe: ["react", "react-dom"],
      alias: [
        {
          find: /^@excalidraw\/common$/,
          replacement: path.resolve(
            __dirname,
            "../packages/common/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/common\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/common/src/$1"),
        },
        {
          find: /^@excalidraw\/element$/,
          replacement: path.resolve(
            __dirname,
            "../packages/element/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/element\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/element/src/$1"),
        },
        {
          find: /^@excalidraw\/excalidraw$/,
          replacement: path.resolve(
            __dirname,
            "../packages/excalidraw/index.tsx",
          ),
        },
        {
          find: /^@excalidraw\/excalidraw\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/excalidraw/$1"),
        },
        {
          find: /^@excalidraw\/math$/,
          replacement: path.resolve(__dirname, "../packages/math/src/index.ts"),
        },
        {
          find: /^@excalidraw\/math\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/math/src/$1"),
        },
        {
          find: /^@excalidraw\/utils$/,
          replacement: path.resolve(
            __dirname,
            "../packages/utils/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/utils\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/utils/src/$1"),
        },
        {
          find: /^@excalidraw\/fractional-indexing$/,
          replacement: path.resolve(
            __dirname,
            "../packages/fractional-indexing/src/index.ts",
          ),
        },
        // dxf-viewer does `import opentype from "opentype.js"` (default
        // import). opentype.js v1.3+ ships an ESM build (.mjs) with only
        // NAMED exports — no default — which breaks dxf-viewer at build
        // time. Force resolution to the CJS bundle (.js), which carries
        // a UMD footer that exposes `default` for interop.
        {
          find: /^opentype\.js$/,
          replacement: path.resolve(
            __dirname,
            "../node_modules/opentype.js/dist/opentype.js",
          ),
        },
      ],
    },
    build: {
      outDir: "build",
      rollupOptions: {
        output: {
          assetFileNames(chunkInfo) {
            if (chunkInfo?.name?.endsWith(".woff2")) {
              const family = chunkInfo.name.split("-")[0];
              return `fonts/${family}/[name][extname]`;
            }

            return "assets/[name]-[hash][extname]";
          },
          // Creating separate chunk for locales except for en and percentages.json so they
          // can be cached at runtime and not merged with
          // app precache. en.json and percentages.json are needed for first load
          // or fallback hence not clubbing with locales so first load followed by offline mode works fine. This is how CRA used to work too.
          manualChunks(id) {
            if (
              id.includes("packages/excalidraw/locales") &&
              id.match(/en.json|percentages.json/) === null
            ) {
              const index = id.indexOf("locales/");
              // Taking the substring after "locales/"
              return `locales/${id.substring(index + 8)}`;
            }

            if (id.includes("@excalidraw/mermaid-to-excalidraw")) {
              return "mermaid-to-excalidraw";
            }

            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror.chunk";
            }
          },
        },
      },
      sourcemap: true,
      // don't auto-inline small assets (i.e. fonts hosted on CDN)
      assetsInlineLimit: 0,
    },
    plugins: [
      Sitemap({
        // Canvas M is an internal, login-required tool — this hostname only
        // appears in the generated sitemap.xml. robots.txt disallows all
        // crawling, so this is effectively unused; kept neutral so no
        // upstream (excalidraw.com) domain leaks into the build output.
        // TODO(canvas-m): set to the real Canvas M production origin if a
        // public canonical URL is ever assigned.
        hostname: "https://canvas-m.local",
        outDir: "build",
        changefreq: "monthly",
        // its static in public folder
        generateRobotsTxt: false,
      }),
      woff2BrowserPlugin(),
      react(),
      checker({
        typescript: true,
        eslint:
          envVars.VITE_APP_ENABLE_ESLINT === "false"
            ? undefined
            : { lintCommand: 'eslint "./**/*.{js,ts,tsx}"' },
        overlay: {
          initialIsOpen: envVars.VITE_APP_COLLAPSE_OVERLAY === "false",
          // Badge hidden — it floated over the MCM home (bottom-left) and
          // blocked the UI underneath. Type/lint errors still surface in the
          // terminal and in the full-screen overlay on build errors.
          badgeStyle: "display: none",
        },
      }),
      svgrPlugin(),
      ViteEjsPlugin(),
      VitePWA({
        // autoUpdate: a new SW skipWaiting + reloads so a deploy APPLIES on the
        // next visit automatically. Trade-off: a repeat visit after a deploy
        // paints the old precached shell then reloads once to the new one (the
        // "loads twice" the PM noticed). We accept that during active dev/test
        // because "prompt" mode made deploys NOT show up until all tabs closed —
        // worse for the test-deploy loop. TODO (pre-Aug): switch to "prompt" +
        // an onNeedRefresh "Update available" toast for a no-surprise update.
        registerType: "autoUpdate",
        devOptions: {
          /* set this flag to true to enable in Development mode */
          enabled: envVars.VITE_APP_ENABLE_PWA === "true",
        },

        workbox: {
          // Scope all workbox caches under a Canvas M id so the precache
          // bucket is named `workbox-precache-...-canvas-m-...` instead of a
          // generic/inherited name — old upstream caches won't be reused.
          cacheId: "canvas-m",
          // don't precache fonts, locales and separate chunks
          globIgnores: [
            "fonts.css",
            "**/locales/**",
            "service-worker.js",
            "**/*.chunk-*.js",
            // CodeMirrorEditor can't be assigned a `.chunk` name via
            // manualChunks because Rollup would hoist shared deps (React)
            // via a static import from the main bundle, defeating lazy
            // loading. So we exclude it by name instead.
            "**/CodeMirrorEditor-*.js",
          ],
          runtimeCaching: [
            {
              urlPattern: new RegExp(".+.woff2"),
              handler: "CacheFirst",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 1000,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
                },
                cacheableResponse: {
                  // 0 to cache "opaque" responses from cross-origin requests (i.e. CDN)
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: new RegExp("fonts.css"),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 50,
                },
              },
            },
            {
              urlPattern: new RegExp("locales/[^/]+.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "locales",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 30, // <== 30 days
                },
              },
            },
            {
              urlPattern: new RegExp("(.chunk-.+|CodeMirrorEditor-.+)\\.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "chunk",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // <== 90 days
                },
              },
            },
          ],
          // mcm: main chunk + IFC bake worker grew past the old 2.3MB cap,
          // which fails the whole build (workbox throws on oversized assets).
          // ts-ebml is now lazy-loaded (separate chunk) so the main bundle is
          // back under the limit; keep headroom at 5MB.
          maximumFileSizeToCacheInBytes: 5 * 1024 ** 2, // 5MB
        },
        manifest: {
          short_name: "Canvas M",
          name: "Canvas M",
          description:
            "Canvas M — a realtime meeting whiteboard for MAP-GROUP.",
          icons: [
            {
              src: "android-chrome-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            // mcm: 512px "any" icon — Android/Chrome install prompt picks the
            // largest available; without it the home-screen icon is upscaled
            // from 192 and looks blurry.
            {
              src: "android-chrome-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            // mcm: maskable variants so adaptive-icon platforms (Android) crop
            // into the safe zone instead of clipping our real icon's edges.
            {
              src: "maskable_icon_x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: "maskable_icon_x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: "apple-touch-icon.png",
              type: "image/png",
              sizes: "180x180",
            },
            {
              src: "favicon-32x32.png",
              sizes: "32x32",
              type: "image/png",
            },
            {
              src: "favicon-16x16.png",
              sizes: "16x16",
              type: "image/png",
            },
          ],
          start_url: "/",
          id: "canvas-m",
          display: "standalone",
          theme_color: "#121212",
          background_color: "#ffffff",
          file_handlers: [
            {
              action: "/",
              accept: {
                "application/vnd.excalidraw+json": [".excalidraw"],
              },
            },
          ],
          share_target: {
            action: "/web-share-target",
            method: "POST",
            enctype: "multipart/form-data",
            params: {
              files: [
                {
                  name: "file",
                  accept: [
                    "application/vnd.excalidraw+json",
                    "application/json",
                    ".excalidraw",
                  ],
                },
              ],
            },
          },
          // Screenshots removed: the upstream marketing images visibly showed
          // "excalidraw.com" in a phone mockup, leaking the original brand in
          // the PWA install dialog. Screenshots are optional metadata — the
          // install UI simply omits the preview gallery without them.
          // TODO(canvas-m): add real Canvas M install-preview screenshots
          //   under public/screenshots and restore this `screenshots` array.
        },
      }),
      createHtmlPlugin({
        minify: true,
      }),
    ],
    publicDir: "../public",
  };
});
