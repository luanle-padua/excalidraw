var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../scripts/woff2/woff2-vite-plugins.js
var require_woff2_vite_plugins = __commonJS({
  "../scripts/woff2/woff2-vite-plugins.js"(exports, module) {
    "use strict";
    var OSS_FONTS_CDN = "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/";
    var OSS_FONTS_FALLBACK = "/";
    module.exports.woff2BrowserPlugin = () => {
      let isDev;
      return {
        name: "woff2BrowserPlugin",
        enforce: "pre",
        config(_, { command }) {
          isDev = command === "serve";
        },
        transform(code, id) {
          if (!isDev && id.endsWith("/excalidraw/fonts/fonts.css")) {
            return `/* WARN: The following content is generated during excalidraw-app build */

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Regular.woff2)
            format("woff2"),
          url(./Assistant-Regular.woff2) format("woff2");
        font-weight: 400;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Medium.woff2)
            format("woff2"),
          url(./Assistant-Medium.woff2) format("woff2");
        font-weight: 500;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-SemiBold.woff2)
            format("woff2"),
          url(./Assistant-SemiBold.woff2) format("woff2");
        font-weight: 600;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Bold.woff2)
            format("woff2"),
          url(./Assistant-Bold.woff2) format("woff2");
        font-weight: 700;
        style: normal;
        display: swap;
      }`;
          }
          if (!isDev && id.endsWith("excalidraw-app/index.html")) {
            return code.replace(
              "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
              `<script>
        // point into our CDN in prod, fallback to root (excalidraw.com) domain in case of issues
        window.EXCALIDRAW_ASSET_PATH = [
          "${OSS_FONTS_CDN}",
          "${OSS_FONTS_FALLBACK}",
        ];
      </script>

      <!-- Preload all default fonts to avoid swap on init -->
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <!-- For Nunito only preload the latin range, which should be good enough for now -->
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/Assistant/Assistant-SemiBold.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
    `
            );
          }
        }
      };
    };
  }
});

// vite.config.mts
var import_woff2_vite_plugins = __toESM(require_woff2_vite_plugins(), 1);
import path from "path";
import { defineConfig, loadEnv } from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite/dist/node/index.js";
import react from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/@vitejs/plugin-react/dist/index.mjs";
import svgrPlugin from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-svgr/dist/index.js";
import { ViteEjsPlugin } from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-ejs/index.js";
import { VitePWA } from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-pwa/dist/index.js";
import checker from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-checker/dist/esm/main.js";
import { createHtmlPlugin } from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-html/dist/index.mjs";
import Sitemap from "file:///D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw/node_modules/vite-plugin-sitemap/dist/index.js";
var __vite_injected_original_dirname = "D:\\LUAN\\0.WIP\\20.MEETING-CANVAS\\excalidraw\\excalidraw-app";
var vite_config_default = defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, `../`);
  return {
    server: {
      port: Number(envVars.VITE_APP_PORT || 3e3),
      host: true,
      // open the browser
      open: true,
      // accept any Host header — needed for both Cloudflare Tunnel and LAN
      // IP access (Vite blocks unknown hosts by default to prevent DNS
      // rebinding). Vite's default HMR will pick the right protocol from
      // the page origin (ws:// for plain http, wss:// when fronted by a
      // tunnel/proxy that terminates HTTPS).
      allowedHosts: true,
      // route the client's /socket.io requests to the local room server
      // so we only need one host (the Vite dev server) to reach the
      // collab socket — works for localhost, LAN IP, and tunnel access.
      proxy: {
        "/socket.io": {
          target: "http://localhost:3002",
          ws: true,
          changeOrigin: true
        }
      }
    },
    // We need to specify the envDir since now there are no
    //more located in parallel with the vite.config.ts file but in parent dir
    envDir: "../",
    resolve: {
      alias: [
        {
          find: /^@excalidraw\/common$/,
          replacement: path.resolve(
            __vite_injected_original_dirname,
            "../packages/common/src/index.ts"
          )
        },
        {
          find: /^@excalidraw\/common\/(.*?)/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/common/src/$1")
        },
        {
          find: /^@excalidraw\/element$/,
          replacement: path.resolve(
            __vite_injected_original_dirname,
            "../packages/element/src/index.ts"
          )
        },
        {
          find: /^@excalidraw\/element\/(.*?)/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/element/src/$1")
        },
        {
          find: /^@excalidraw\/excalidraw$/,
          replacement: path.resolve(
            __vite_injected_original_dirname,
            "../packages/excalidraw/index.tsx"
          )
        },
        {
          find: /^@excalidraw\/excalidraw\/(.*?)/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/excalidraw/$1")
        },
        {
          find: /^@excalidraw\/math$/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/math/src/index.ts")
        },
        {
          find: /^@excalidraw\/math\/(.*?)/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/math/src/$1")
        },
        {
          find: /^@excalidraw\/utils$/,
          replacement: path.resolve(
            __vite_injected_original_dirname,
            "../packages/utils/src/index.ts"
          )
        },
        {
          find: /^@excalidraw\/utils\/(.*?)/,
          replacement: path.resolve(__vite_injected_original_dirname, "../packages/utils/src/$1")
        },
        {
          find: /^@excalidraw\/fractional-indexing$/,
          replacement: path.resolve(
            __vite_injected_original_dirname,
            "../packages/fractional-indexing/src/index.ts"
          )
        }
      ]
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
            if (id.includes("packages/excalidraw/locales") && id.match(/en.json|percentages.json/) === null) {
              const index = id.indexOf("locales/");
              return `locales/${id.substring(index + 8)}`;
            }
            if (id.includes("@excalidraw/mermaid-to-excalidraw")) {
              return "mermaid-to-excalidraw";
            }
            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror.chunk";
            }
          }
        }
      },
      sourcemap: true,
      // don't auto-inline small assets (i.e. fonts hosted on CDN)
      assetsInlineLimit: 0
    },
    plugins: [
      Sitemap({
        hostname: "https://excalidraw.com",
        outDir: "build",
        changefreq: "monthly",
        // its static in public folder
        generateRobotsTxt: false
      }),
      (0, import_woff2_vite_plugins.woff2BrowserPlugin)(),
      react(),
      checker({
        typescript: true,
        eslint: envVars.VITE_APP_ENABLE_ESLINT === "false" ? void 0 : { lintCommand: 'eslint "./**/*.{js,ts,tsx}"' },
        overlay: {
          initialIsOpen: envVars.VITE_APP_COLLAPSE_OVERLAY === "false",
          badgeStyle: "margin-bottom: 4rem; margin-left: 1rem"
        }
      }),
      svgrPlugin(),
      ViteEjsPlugin(),
      VitePWA({
        registerType: "autoUpdate",
        devOptions: {
          /* set this flag to true to enable in Development mode */
          enabled: envVars.VITE_APP_ENABLE_PWA === "true"
        },
        workbox: {
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
            "**/CodeMirrorEditor-*.js"
          ],
          runtimeCaching: [
            {
              urlPattern: new RegExp(".+.woff2"),
              handler: "CacheFirst",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 1e3,
                  maxAgeSeconds: 60 * 60 * 24 * 90
                  // 90 days
                },
                cacheableResponse: {
                  // 0 to cache "opaque" responses from cross-origin requests (i.e. CDN)
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: new RegExp("fonts.css"),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 50
                }
              }
            },
            {
              urlPattern: new RegExp("locales/[^/]+.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "locales",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 30
                  // <== 30 days
                }
              }
            },
            {
              urlPattern: new RegExp("(.chunk-.+|CodeMirrorEditor-.+)\\.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "chunk",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 90
                  // <== 90 days
                }
              }
            }
          ],
          maximumFileSizeToCacheInBytes: 2.3 * 1024 ** 2
          // 2.3MB
        },
        manifest: {
          short_name: "Excalidraw",
          name: "Excalidraw",
          description: "Excalidraw is a whiteboard tool that lets you easily sketch diagrams that have a hand-drawn feel to them.",
          icons: [
            {
              src: "android-chrome-192x192.png",
              sizes: "192x192",
              type: "image/png"
            },
            {
              src: "apple-touch-icon.png",
              type: "image/png",
              sizes: "180x180"
            },
            {
              src: "favicon-32x32.png",
              sizes: "32x32",
              type: "image/png"
            },
            {
              src: "favicon-16x16.png",
              sizes: "16x16",
              type: "image/png"
            }
          ],
          start_url: "/",
          id: "excalidraw",
          display: "standalone",
          theme_color: "#121212",
          background_color: "#ffffff",
          file_handlers: [
            {
              action: "/",
              accept: {
                "application/vnd.excalidraw+json": [".excalidraw"]
              }
            }
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
                    ".excalidraw"
                  ]
                }
              ]
            }
          },
          screenshots: [
            {
              src: "/screenshots/virtual-whiteboard.png",
              type: "image/png",
              sizes: "462x945"
            },
            {
              src: "/screenshots/wireframe.png",
              type: "image/png",
              sizes: "462x945"
            },
            {
              src: "/screenshots/illustration.png",
              type: "image/png",
              sizes: "462x945"
            },
            {
              src: "/screenshots/shapes.png",
              type: "image/png",
              sizes: "462x945"
            },
            {
              src: "/screenshots/collaboration.png",
              type: "image/png",
              sizes: "462x945"
            },
            {
              src: "/screenshots/export.png",
              type: "image/png",
              sizes: "462x945"
            }
          ]
        }
      }),
      createHtmlPlugin({
        minify: true
      })
    ],
    publicDir: "../public"
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc2NyaXB0cy93b2ZmMi93b2ZmMi12aXRlLXBsdWdpbnMuanMiLCAidml0ZS5jb25maWcubXRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcTFVBTlxcXFwwLldJUFxcXFwyMC5NRUVUSU5HLUNBTlZBU1xcXFxleGNhbGlkcmF3XFxcXHNjcmlwdHNcXFxcd29mZjJcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXExVQU5cXFxcMC5XSVBcXFxcMjAuTUVFVElORy1DQU5WQVNcXFxcZXhjYWxpZHJhd1xcXFxzY3JpcHRzXFxcXHdvZmYyXFxcXHdvZmYyLXZpdGUtcGx1Z2lucy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovTFVBTi8wLldJUC8yMC5NRUVUSU5HLUNBTlZBUy9leGNhbGlkcmF3L3NjcmlwdHMvd29mZjIvd29mZjItdml0ZS1wbHVnaW5zLmpzXCI7Ly8gZGVmaW5lIGBFWENBTElEUkFXX0FTU0VUX1BBVEhgIGFzIGEgU1NPVFxuY29uc3QgT1NTX0ZPTlRTX0NETiA9IFwiaHR0cHM6Ly9leGNhbGlkcmF3Lm55YzMuY2RuLmRpZ2l0YWxvY2VhbnNwYWNlcy5jb20vb3NzL1wiO1xuY29uc3QgT1NTX0ZPTlRTX0ZBTExCQUNLID0gXCIvXCI7XG5cbi8qKlxuICogQ3VzdG9tIHZpdGUgcGx1Z2luIGZvciBhdXRvLXByZWZpeGluZyBgRVhDQUxJRFJBV19BU1NFVF9QQVRIYCB3b2ZmMiBmb250cyBpbiBgZXhjYWxpZHJhdy1hcHBgLlxuICpcbiAqIEByZXR1cm5zIHtpbXBvcnQoXCJ2aXRlXCIpLlBsdWdpbk9wdGlvbn1cbiAqL1xubW9kdWxlLmV4cG9ydHMud29mZjJCcm93c2VyUGx1Z2luID0gKCkgPT4ge1xuICBsZXQgaXNEZXY7XG5cbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcIndvZmYyQnJvd3NlclBsdWdpblwiLFxuICAgIGVuZm9yY2U6IFwicHJlXCIsXG4gICAgY29uZmlnKF8sIHsgY29tbWFuZCB9KSB7XG4gICAgICBpc0RldiA9IGNvbW1hbmQgPT09IFwic2VydmVcIjtcbiAgICB9LFxuICAgIHRyYW5zZm9ybShjb2RlLCBpZCkge1xuICAgICAgLy8gdXNpbmcgY29weSAvIHJlcGxhY2UgYXMgZm9udHMgZGVmaW5lZCBpbiB0aGUgYC5jc3NgIGRvbid0IGhhdmUgdG8gYmUgbWFudWFsbHkgY29waWVkIG92ZXIgKHZpdGUvcm9sbHVwIGRvZXMgdGhpcyBhdXRvbWF0aWNhbGx5KSxcbiAgICAgIC8vIGJ1dCBhdCB0aGUgc2FtZSB0aW1lIGNhbid0IGJlIGVhc2lseSBwcmVmaXhlZCB3aXRoIHRoZSBgRVhDQUxJRFJBV19BU1NFVF9QQVRIYCBvbmx5IGZvciB0aGUgYGV4Y2FsaWRyYXctYXBwYFxuICAgICAgaWYgKCFpc0RldiAmJiBpZC5lbmRzV2l0aChcIi9leGNhbGlkcmF3L2ZvbnRzL2ZvbnRzLmNzc1wiKSkge1xuICAgICAgICByZXR1cm4gYC8qIFdBUk46IFRoZSBmb2xsb3dpbmcgY29udGVudCBpcyBnZW5lcmF0ZWQgZHVyaW5nIGV4Y2FsaWRyYXctYXBwIGJ1aWxkICovXG5cbiAgICAgIEBmb250LWZhY2Uge1xuICAgICAgICBmb250LWZhbWlseTogXCJBc3Npc3RhbnRcIjtcbiAgICAgICAgc3JjOiB1cmwoJHtPU1NfRk9OVFNfQ0ROfWZvbnRzL0Fzc2lzdGFudC9Bc3Npc3RhbnQtUmVndWxhci53b2ZmMilcbiAgICAgICAgICAgIGZvcm1hdChcIndvZmYyXCIpLFxuICAgICAgICAgIHVybCguL0Fzc2lzdGFudC1SZWd1bGFyLndvZmYyKSBmb3JtYXQoXCJ3b2ZmMlwiKTtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDQwMDtcbiAgICAgICAgc3R5bGU6IG5vcm1hbDtcbiAgICAgICAgZGlzcGxheTogc3dhcDtcbiAgICAgIH1cblxuICAgICAgQGZvbnQtZmFjZSB7XG4gICAgICAgIGZvbnQtZmFtaWx5OiBcIkFzc2lzdGFudFwiO1xuICAgICAgICBzcmM6IHVybCgke09TU19GT05UU19DRE59Zm9udHMvQXNzaXN0YW50L0Fzc2lzdGFudC1NZWRpdW0ud29mZjIpXG4gICAgICAgICAgICBmb3JtYXQoXCJ3b2ZmMlwiKSxcbiAgICAgICAgICB1cmwoLi9Bc3Npc3RhbnQtTWVkaXVtLndvZmYyKSBmb3JtYXQoXCJ3b2ZmMlwiKTtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDUwMDtcbiAgICAgICAgc3R5bGU6IG5vcm1hbDtcbiAgICAgICAgZGlzcGxheTogc3dhcDtcbiAgICAgIH1cblxuICAgICAgQGZvbnQtZmFjZSB7XG4gICAgICAgIGZvbnQtZmFtaWx5OiBcIkFzc2lzdGFudFwiO1xuICAgICAgICBzcmM6IHVybCgke09TU19GT05UU19DRE59Zm9udHMvQXNzaXN0YW50L0Fzc2lzdGFudC1TZW1pQm9sZC53b2ZmMilcbiAgICAgICAgICAgIGZvcm1hdChcIndvZmYyXCIpLFxuICAgICAgICAgIHVybCguL0Fzc2lzdGFudC1TZW1pQm9sZC53b2ZmMikgZm9ybWF0KFwid29mZjJcIik7XG4gICAgICAgIGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICAgIHN0eWxlOiBub3JtYWw7XG4gICAgICAgIGRpc3BsYXk6IHN3YXA7XG4gICAgICB9XG5cbiAgICAgIEBmb250LWZhY2Uge1xuICAgICAgICBmb250LWZhbWlseTogXCJBc3Npc3RhbnRcIjtcbiAgICAgICAgc3JjOiB1cmwoJHtPU1NfRk9OVFNfQ0ROfWZvbnRzL0Fzc2lzdGFudC9Bc3Npc3RhbnQtQm9sZC53b2ZmMilcbiAgICAgICAgICAgIGZvcm1hdChcIndvZmYyXCIpLFxuICAgICAgICAgIHVybCguL0Fzc2lzdGFudC1Cb2xkLndvZmYyKSBmb3JtYXQoXCJ3b2ZmMlwiKTtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDcwMDtcbiAgICAgICAgc3R5bGU6IG5vcm1hbDtcbiAgICAgICAgZGlzcGxheTogc3dhcDtcbiAgICAgIH1gO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWlzRGV2ICYmIGlkLmVuZHNXaXRoKFwiZXhjYWxpZHJhdy1hcHAvaW5kZXguaHRtbFwiKSkge1xuICAgICAgICByZXR1cm4gY29kZS5yZXBsYWNlKFxuICAgICAgICAgIFwiPCEtLSBQTEFDRUhPTERFUjpFWENBTElEUkFXX0FQUF9GT05UUyAtLT5cIixcbiAgICAgICAgICBgPHNjcmlwdD5cbiAgICAgICAgLy8gcG9pbnQgaW50byBvdXIgQ0ROIGluIHByb2QsIGZhbGxiYWNrIHRvIHJvb3QgKGV4Y2FsaWRyYXcuY29tKSBkb21haW4gaW4gY2FzZSBvZiBpc3N1ZXNcbiAgICAgICAgd2luZG93LkVYQ0FMSURSQVdfQVNTRVRfUEFUSCA9IFtcbiAgICAgICAgICBcIiR7T1NTX0ZPTlRTX0NETn1cIixcbiAgICAgICAgICBcIiR7T1NTX0ZPTlRTX0ZBTExCQUNLfVwiLFxuICAgICAgICBdO1xuICAgICAgPC9zY3JpcHQ+XG5cbiAgICAgIDwhLS0gUHJlbG9hZCBhbGwgZGVmYXVsdCBmb250cyB0byBhdm9pZCBzd2FwIG9uIGluaXQgLS0+XG4gICAgICA8bGlua1xuICAgICAgICByZWw9XCJwcmVsb2FkXCJcbiAgICAgICAgaHJlZj1cIiR7T1NTX0ZPTlRTX0NETn1mb250cy9FeGNhbGlmb250L0V4Y2FsaWZvbnQtUmVndWxhci1hODhiNzJhMjRmYjU0YzlmOTRlM2I1ZmRhYTc0ODFjOS53b2ZmMlwiXG4gICAgICAgIGFzPVwiZm9udFwiXG4gICAgICAgIHR5cGU9XCJmb250L3dvZmYyXCJcbiAgICAgICAgY3Jvc3NvcmlnaW49XCJhbm9ueW1vdXNcIlxuICAgICAgLz5cbiAgICAgIDwhLS0gRm9yIE51bml0byBvbmx5IHByZWxvYWQgdGhlIGxhdGluIHJhbmdlLCB3aGljaCBzaG91bGQgYmUgZ29vZCBlbm91Z2ggZm9yIG5vdyAtLT5cbiAgICAgIDxsaW5rXG4gICAgICAgIHJlbD1cInByZWxvYWRcIlxuICAgICAgICBocmVmPVwiJHtPU1NfRk9OVFNfQ0ROfWZvbnRzL051bml0by9OdW5pdG8tUmVndWxhci1YUlhJM0k2TGkwMUJLb2ZpT2M1d3RsWjJkaThIRElraGRUUTNqNnpiWFdqZ2VnLndvZmYyXCJcbiAgICAgICAgYXM9XCJmb250XCJcbiAgICAgICAgdHlwZT1cImZvbnQvd29mZjJcIlxuICAgICAgICBjcm9zc29yaWdpbj1cImFub255bW91c1wiXG4gICAgICAvPlxuICAgICAgPGxpbmtcbiAgICAgICAgcmVsPVwicHJlbG9hZFwiXG4gICAgICAgIGhyZWY9XCIke09TU19GT05UU19DRE59Zm9udHMvQXNzaXN0YW50L0Fzc2lzdGFudC1TZW1pQm9sZC53b2ZmMlwiXG4gICAgICAgIGFzPVwiZm9udFwiXG4gICAgICAgIHR5cGU9XCJmb250L3dvZmYyXCJcbiAgICAgICAgY3Jvc3NvcmlnaW49XCJhbm9ueW1vdXNcIlxuICAgICAgLz5cbiAgICAgIDxsaW5rXG4gICAgICAgIHJlbD1cInByZWxvYWRcIlxuICAgICAgICBocmVmPVwiJHtPU1NfRk9OVFNfQ0ROfWZvbnRzL0NvbWljU2hhbm5zL0NvbWljU2hhbm5zLVJlZ3VsYXItMjc5YTdiMzE3ZDEyZWI4OGRlMDYxNjdiZDY3MmI0YjQud29mZjJcIlxuICAgICAgICBhcz1cImZvbnRcIlxuICAgICAgICB0eXBlPVwiZm9udC93b2ZmMlwiXG4gICAgICAgIGNyb3Nzb3JpZ2luPVwiYW5vbnltb3VzXCJcbiAgICAgIC8+XG4gICAgYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufTtcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcTFVBTlxcXFwwLldJUFxcXFwyMC5NRUVUSU5HLUNBTlZBU1xcXFxleGNhbGlkcmF3XFxcXGV4Y2FsaWRyYXctYXBwXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJEOlxcXFxMVUFOXFxcXDAuV0lQXFxcXDIwLk1FRVRJTkctQ0FOVkFTXFxcXGV4Y2FsaWRyYXdcXFxcZXhjYWxpZHJhdy1hcHBcXFxcdml0ZS5jb25maWcubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi9MVUFOLzAuV0lQLzIwLk1FRVRJTkctQ0FOVkFTL2V4Y2FsaWRyYXcvZXhjYWxpZHJhdy1hcHAvdml0ZS5jb25maWcubXRzXCI7aW1wb3J0IHBhdGggZnJvbSBcInBhdGhcIjtcbmltcG9ydCB7IGRlZmluZUNvbmZpZywgbG9hZEVudiB9IGZyb20gXCJ2aXRlXCI7XG5pbXBvcnQgcmVhY3QgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXJlYWN0XCI7XG5pbXBvcnQgc3ZnclBsdWdpbiBmcm9tIFwidml0ZS1wbHVnaW4tc3ZnclwiO1xuaW1wb3J0IHsgVml0ZUVqc1BsdWdpbiB9IGZyb20gXCJ2aXRlLXBsdWdpbi1lanNcIjtcbmltcG9ydCB7IFZpdGVQV0EgfSBmcm9tIFwidml0ZS1wbHVnaW4tcHdhXCI7XG5pbXBvcnQgY2hlY2tlciBmcm9tIFwidml0ZS1wbHVnaW4tY2hlY2tlclwiO1xuaW1wb3J0IHsgY3JlYXRlSHRtbFBsdWdpbiB9IGZyb20gXCJ2aXRlLXBsdWdpbi1odG1sXCI7XG5pbXBvcnQgU2l0ZW1hcCBmcm9tIFwidml0ZS1wbHVnaW4tc2l0ZW1hcFwiO1xuaW1wb3J0IHsgd29mZjJCcm93c2VyUGx1Z2luIH0gZnJvbSBcIi4uL3NjcmlwdHMvd29mZjIvd29mZjItdml0ZS1wbHVnaW5zXCI7XG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiB7XG4gIC8vIFRvIGxvYWQgLmVudiB2YXJpYWJsZXNcbiAgY29uc3QgZW52VmFycyA9IGxvYWRFbnYobW9kZSwgYC4uL2ApO1xuICAvLyBodHRwczovL3ZpdGVqcy5kZXYvY29uZmlnL1xuICByZXR1cm4ge1xuICAgIHNlcnZlcjoge1xuICAgICAgcG9ydDogTnVtYmVyKGVudlZhcnMuVklURV9BUFBfUE9SVCB8fCAzMDAwKSxcbiAgICAgIGhvc3Q6IHRydWUsXG4gICAgICAvLyBvcGVuIHRoZSBicm93c2VyXG4gICAgICBvcGVuOiB0cnVlLFxuICAgICAgLy8gYWNjZXB0IGFueSBIb3N0IGhlYWRlciBcdTIwMTQgbmVlZGVkIGZvciBib3RoIENsb3VkZmxhcmUgVHVubmVsIGFuZCBMQU5cbiAgICAgIC8vIElQIGFjY2VzcyAoVml0ZSBibG9ja3MgdW5rbm93biBob3N0cyBieSBkZWZhdWx0IHRvIHByZXZlbnQgRE5TXG4gICAgICAvLyByZWJpbmRpbmcpLiBWaXRlJ3MgZGVmYXVsdCBITVIgd2lsbCBwaWNrIHRoZSByaWdodCBwcm90b2NvbCBmcm9tXG4gICAgICAvLyB0aGUgcGFnZSBvcmlnaW4gKHdzOi8vIGZvciBwbGFpbiBodHRwLCB3c3M6Ly8gd2hlbiBmcm9udGVkIGJ5IGFcbiAgICAgIC8vIHR1bm5lbC9wcm94eSB0aGF0IHRlcm1pbmF0ZXMgSFRUUFMpLlxuICAgICAgYWxsb3dlZEhvc3RzOiB0cnVlLFxuICAgICAgLy8gcm91dGUgdGhlIGNsaWVudCdzIC9zb2NrZXQuaW8gcmVxdWVzdHMgdG8gdGhlIGxvY2FsIHJvb20gc2VydmVyXG4gICAgICAvLyBzbyB3ZSBvbmx5IG5lZWQgb25lIGhvc3QgKHRoZSBWaXRlIGRldiBzZXJ2ZXIpIHRvIHJlYWNoIHRoZVxuICAgICAgLy8gY29sbGFiIHNvY2tldCBcdTIwMTQgd29ya3MgZm9yIGxvY2FsaG9zdCwgTEFOIElQLCBhbmQgdHVubmVsIGFjY2Vzcy5cbiAgICAgIHByb3h5OiB7XG4gICAgICAgIFwiL3NvY2tldC5pb1wiOiB7XG4gICAgICAgICAgdGFyZ2V0OiBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMlwiLFxuICAgICAgICAgIHdzOiB0cnVlLFxuICAgICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICAvLyBXZSBuZWVkIHRvIHNwZWNpZnkgdGhlIGVudkRpciBzaW5jZSBub3cgdGhlcmUgYXJlIG5vXG4gICAgLy9tb3JlIGxvY2F0ZWQgaW4gcGFyYWxsZWwgd2l0aCB0aGUgdml0ZS5jb25maWcudHMgZmlsZSBidXQgaW4gcGFyZW50IGRpclxuICAgIGVudkRpcjogXCIuLi9cIixcbiAgICByZXNvbHZlOiB7XG4gICAgICBhbGlhczogW1xuICAgICAgICB7XG4gICAgICAgICAgZmluZDogL15AZXhjYWxpZHJhd1xcL2NvbW1vbiQvLFxuICAgICAgICAgIHJlcGxhY2VtZW50OiBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICBfX2Rpcm5hbWUsXG4gICAgICAgICAgICBcIi4uL3BhY2thZ2VzL2NvbW1vbi9zcmMvaW5kZXgudHNcIixcbiAgICAgICAgICApLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgZmluZDogL15AZXhjYWxpZHJhd1xcL2NvbW1vblxcLyguKj8pLyxcbiAgICAgICAgICByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLi9wYWNrYWdlcy9jb21tb24vc3JjLyQxXCIpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgZmluZDogL15AZXhjYWxpZHJhd1xcL2VsZW1lbnQkLyxcbiAgICAgICAgICByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKFxuICAgICAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICAgICAgXCIuLi9wYWNrYWdlcy9lbGVtZW50L3NyYy9pbmRleC50c1wiLFxuICAgICAgICAgICksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBmaW5kOiAvXkBleGNhbGlkcmF3XFwvZWxlbWVudFxcLyguKj8pLyxcbiAgICAgICAgICByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLi9wYWNrYWdlcy9lbGVtZW50L3NyYy8kMVwiKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGZpbmQ6IC9eQGV4Y2FsaWRyYXdcXC9leGNhbGlkcmF3JC8sXG4gICAgICAgICAgcmVwbGFjZW1lbnQ6IHBhdGgucmVzb2x2ZShcbiAgICAgICAgICAgIF9fZGlybmFtZSxcbiAgICAgICAgICAgIFwiLi4vcGFja2FnZXMvZXhjYWxpZHJhdy9pbmRleC50c3hcIixcbiAgICAgICAgICApLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgZmluZDogL15AZXhjYWxpZHJhd1xcL2V4Y2FsaWRyYXdcXC8oLio/KS8sXG4gICAgICAgICAgcmVwbGFjZW1lbnQ6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vcGFja2FnZXMvZXhjYWxpZHJhdy8kMVwiKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGZpbmQ6IC9eQGV4Y2FsaWRyYXdcXC9tYXRoJC8sXG4gICAgICAgICAgcmVwbGFjZW1lbnQ6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vcGFja2FnZXMvbWF0aC9zcmMvaW5kZXgudHNcIiksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBmaW5kOiAvXkBleGNhbGlkcmF3XFwvbWF0aFxcLyguKj8pLyxcbiAgICAgICAgICByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLi9wYWNrYWdlcy9tYXRoL3NyYy8kMVwiKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGZpbmQ6IC9eQGV4Y2FsaWRyYXdcXC91dGlscyQvLFxuICAgICAgICAgIHJlcGxhY2VtZW50OiBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICBfX2Rpcm5hbWUsXG4gICAgICAgICAgICBcIi4uL3BhY2thZ2VzL3V0aWxzL3NyYy9pbmRleC50c1wiLFxuICAgICAgICAgICksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBmaW5kOiAvXkBleGNhbGlkcmF3XFwvdXRpbHNcXC8oLio/KS8sXG4gICAgICAgICAgcmVwbGFjZW1lbnQ6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vcGFja2FnZXMvdXRpbHMvc3JjLyQxXCIpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgZmluZDogL15AZXhjYWxpZHJhd1xcL2ZyYWN0aW9uYWwtaW5kZXhpbmckLyxcbiAgICAgICAgICByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKFxuICAgICAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICAgICAgXCIuLi9wYWNrYWdlcy9mcmFjdGlvbmFsLWluZGV4aW5nL3NyYy9pbmRleC50c1wiLFxuICAgICAgICAgICksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0sXG4gICAgYnVpbGQ6IHtcbiAgICAgIG91dERpcjogXCJidWlsZFwiLFxuICAgICAgcm9sbHVwT3B0aW9uczoge1xuICAgICAgICBvdXRwdXQ6IHtcbiAgICAgICAgICBhc3NldEZpbGVOYW1lcyhjaHVua0luZm8pIHtcbiAgICAgICAgICAgIGlmIChjaHVua0luZm8/Lm5hbWU/LmVuZHNXaXRoKFwiLndvZmYyXCIpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGZhbWlseSA9IGNodW5rSW5mby5uYW1lLnNwbGl0KFwiLVwiKVswXTtcbiAgICAgICAgICAgICAgcmV0dXJuIGBmb250cy8ke2ZhbWlseX0vW25hbWVdW2V4dG5hbWVdYDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIFwiYXNzZXRzL1tuYW1lXS1baGFzaF1bZXh0bmFtZV1cIjtcbiAgICAgICAgICB9LFxuICAgICAgICAgIC8vIENyZWF0aW5nIHNlcGFyYXRlIGNodW5rIGZvciBsb2NhbGVzIGV4Y2VwdCBmb3IgZW4gYW5kIHBlcmNlbnRhZ2VzLmpzb24gc28gdGhleVxuICAgICAgICAgIC8vIGNhbiBiZSBjYWNoZWQgYXQgcnVudGltZSBhbmQgbm90IG1lcmdlZCB3aXRoXG4gICAgICAgICAgLy8gYXBwIHByZWNhY2hlLiBlbi5qc29uIGFuZCBwZXJjZW50YWdlcy5qc29uIGFyZSBuZWVkZWQgZm9yIGZpcnN0IGxvYWRcbiAgICAgICAgICAvLyBvciBmYWxsYmFjayBoZW5jZSBub3QgY2x1YmJpbmcgd2l0aCBsb2NhbGVzIHNvIGZpcnN0IGxvYWQgZm9sbG93ZWQgYnkgb2ZmbGluZSBtb2RlIHdvcmtzIGZpbmUuIFRoaXMgaXMgaG93IENSQSB1c2VkIHRvIHdvcmsgdG9vLlxuICAgICAgICAgIG1hbnVhbENodW5rcyhpZCkge1xuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBpZC5pbmNsdWRlcyhcInBhY2thZ2VzL2V4Y2FsaWRyYXcvbG9jYWxlc1wiKSAmJlxuICAgICAgICAgICAgICBpZC5tYXRjaCgvZW4uanNvbnxwZXJjZW50YWdlcy5qc29uLykgPT09IG51bGxcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IGlkLmluZGV4T2YoXCJsb2NhbGVzL1wiKTtcbiAgICAgICAgICAgICAgLy8gVGFraW5nIHRoZSBzdWJzdHJpbmcgYWZ0ZXIgXCJsb2NhbGVzL1wiXG4gICAgICAgICAgICAgIHJldHVybiBgbG9jYWxlcy8ke2lkLnN1YnN0cmluZyhpbmRleCArIDgpfWA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpZC5pbmNsdWRlcyhcIkBleGNhbGlkcmF3L21lcm1haWQtdG8tZXhjYWxpZHJhd1wiKSkge1xuICAgICAgICAgICAgICByZXR1cm4gXCJtZXJtYWlkLXRvLWV4Y2FsaWRyYXdcIjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGlkLmluY2x1ZGVzKFwiQGNvZGVtaXJyb3IvXCIpIHx8IGlkLmluY2x1ZGVzKFwiQGxlemVyL1wiKSkge1xuICAgICAgICAgICAgICByZXR1cm4gXCJjb2RlbWlycm9yLmNodW5rXCI7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBzb3VyY2VtYXA6IHRydWUsXG4gICAgICAvLyBkb24ndCBhdXRvLWlubGluZSBzbWFsbCBhc3NldHMgKGkuZS4gZm9udHMgaG9zdGVkIG9uIENETilcbiAgICAgIGFzc2V0c0lubGluZUxpbWl0OiAwLFxuICAgIH0sXG4gICAgcGx1Z2luczogW1xuICAgICAgU2l0ZW1hcCh7XG4gICAgICAgIGhvc3RuYW1lOiBcImh0dHBzOi8vZXhjYWxpZHJhdy5jb21cIixcbiAgICAgICAgb3V0RGlyOiBcImJ1aWxkXCIsXG4gICAgICAgIGNoYW5nZWZyZXE6IFwibW9udGhseVwiLFxuICAgICAgICAvLyBpdHMgc3RhdGljIGluIHB1YmxpYyBmb2xkZXJcbiAgICAgICAgZ2VuZXJhdGVSb2JvdHNUeHQ6IGZhbHNlLFxuICAgICAgfSksXG4gICAgICB3b2ZmMkJyb3dzZXJQbHVnaW4oKSxcbiAgICAgIHJlYWN0KCksXG4gICAgICBjaGVja2VyKHtcbiAgICAgICAgdHlwZXNjcmlwdDogdHJ1ZSxcbiAgICAgICAgZXNsaW50OlxuICAgICAgICAgIGVudlZhcnMuVklURV9BUFBfRU5BQkxFX0VTTElOVCA9PT0gXCJmYWxzZVwiXG4gICAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgICAgOiB7IGxpbnRDb21tYW5kOiAnZXNsaW50IFwiLi8qKi8qLntqcyx0cyx0c3h9XCInIH0sXG4gICAgICAgIG92ZXJsYXk6IHtcbiAgICAgICAgICBpbml0aWFsSXNPcGVuOiBlbnZWYXJzLlZJVEVfQVBQX0NPTExBUFNFX09WRVJMQVkgPT09IFwiZmFsc2VcIixcbiAgICAgICAgICBiYWRnZVN0eWxlOiBcIm1hcmdpbi1ib3R0b206IDRyZW07IG1hcmdpbi1sZWZ0OiAxcmVtXCIsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIHN2Z3JQbHVnaW4oKSxcbiAgICAgIFZpdGVFanNQbHVnaW4oKSxcbiAgICAgIFZpdGVQV0Eoe1xuICAgICAgICByZWdpc3RlclR5cGU6IFwiYXV0b1VwZGF0ZVwiLFxuICAgICAgICBkZXZPcHRpb25zOiB7XG4gICAgICAgICAgLyogc2V0IHRoaXMgZmxhZyB0byB0cnVlIHRvIGVuYWJsZSBpbiBEZXZlbG9wbWVudCBtb2RlICovXG4gICAgICAgICAgZW5hYmxlZDogZW52VmFycy5WSVRFX0FQUF9FTkFCTEVfUFdBID09PSBcInRydWVcIixcbiAgICAgICAgfSxcblxuICAgICAgICB3b3JrYm94OiB7XG4gICAgICAgICAgLy8gZG9uJ3QgcHJlY2FjaGUgZm9udHMsIGxvY2FsZXMgYW5kIHNlcGFyYXRlIGNodW5rc1xuICAgICAgICAgIGdsb2JJZ25vcmVzOiBbXG4gICAgICAgICAgICBcImZvbnRzLmNzc1wiLFxuICAgICAgICAgICAgXCIqKi9sb2NhbGVzLyoqXCIsXG4gICAgICAgICAgICBcInNlcnZpY2Utd29ya2VyLmpzXCIsXG4gICAgICAgICAgICBcIioqLyouY2h1bmstKi5qc1wiLFxuICAgICAgICAgICAgLy8gQ29kZU1pcnJvckVkaXRvciBjYW4ndCBiZSBhc3NpZ25lZCBhIGAuY2h1bmtgIG5hbWUgdmlhXG4gICAgICAgICAgICAvLyBtYW51YWxDaHVua3MgYmVjYXVzZSBSb2xsdXAgd291bGQgaG9pc3Qgc2hhcmVkIGRlcHMgKFJlYWN0KVxuICAgICAgICAgICAgLy8gdmlhIGEgc3RhdGljIGltcG9ydCBmcm9tIHRoZSBtYWluIGJ1bmRsZSwgZGVmZWF0aW5nIGxhenlcbiAgICAgICAgICAgIC8vIGxvYWRpbmcuIFNvIHdlIGV4Y2x1ZGUgaXQgYnkgbmFtZSBpbnN0ZWFkLlxuICAgICAgICAgICAgXCIqKi9Db2RlTWlycm9yRWRpdG9yLSouanNcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJ1bnRpbWVDYWNoaW5nOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHVybFBhdHRlcm46IG5ldyBSZWdFeHAoXCIuKy53b2ZmMlwiKSxcbiAgICAgICAgICAgICAgaGFuZGxlcjogXCJDYWNoZUZpcnN0XCIsXG4gICAgICAgICAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICBjYWNoZU5hbWU6IFwiZm9udHNcIixcbiAgICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7XG4gICAgICAgICAgICAgICAgICBtYXhFbnRyaWVzOiAxMDAwLFxuICAgICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0ICogOTAsIC8vIDkwIGRheXNcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGNhY2hlYWJsZVJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgICAvLyAwIHRvIGNhY2hlIFwib3BhcXVlXCIgcmVzcG9uc2VzIGZyb20gY3Jvc3Mtb3JpZ2luIHJlcXVlc3RzIChpLmUuIENETilcbiAgICAgICAgICAgICAgICAgIHN0YXR1c2VzOiBbMCwgMjAwXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXJsUGF0dGVybjogbmV3IFJlZ0V4cChcImZvbnRzLmNzc1wiKSxcbiAgICAgICAgICAgICAgaGFuZGxlcjogXCJTdGFsZVdoaWxlUmV2YWxpZGF0ZVwiLFxuICAgICAgICAgICAgICBvcHRpb25zOiB7XG4gICAgICAgICAgICAgICAgY2FjaGVOYW1lOiBcImZvbnRzXCIsXG4gICAgICAgICAgICAgICAgZXhwaXJhdGlvbjoge1xuICAgICAgICAgICAgICAgICAgbWF4RW50cmllczogNTAsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHVybFBhdHRlcm46IG5ldyBSZWdFeHAoXCJsb2NhbGVzL1teL10rLmpzXCIpLFxuICAgICAgICAgICAgICBoYW5kbGVyOiBcIkNhY2hlRmlyc3RcIixcbiAgICAgICAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgICAgICAgIGNhY2hlTmFtZTogXCJsb2NhbGVzXCIsXG4gICAgICAgICAgICAgICAgZXhwaXJhdGlvbjoge1xuICAgICAgICAgICAgICAgICAgbWF4RW50cmllczogNTAsXG4gICAgICAgICAgICAgICAgICBtYXhBZ2VTZWNvbmRzOiA2MCAqIDYwICogMjQgKiAzMCwgLy8gPD09IDMwIGRheXNcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXJsUGF0dGVybjogbmV3IFJlZ0V4cChcIiguY2h1bmstLit8Q29kZU1pcnJvckVkaXRvci0uKylcXFxcLmpzXCIpLFxuICAgICAgICAgICAgICBoYW5kbGVyOiBcIkNhY2hlRmlyc3RcIixcbiAgICAgICAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgICAgICAgIGNhY2hlTmFtZTogXCJjaHVua1wiLFxuICAgICAgICAgICAgICAgIGV4cGlyYXRpb246IHtcbiAgICAgICAgICAgICAgICAgIG1heEVudHJpZXM6IDUwLFxuICAgICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0ICogOTAsIC8vIDw9PSA5MCBkYXlzXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgICBtYXhpbXVtRmlsZVNpemVUb0NhY2hlSW5CeXRlczogMi4zICogMTAyNCAqKiAyLCAvLyAyLjNNQlxuICAgICAgICB9LFxuICAgICAgICBtYW5pZmVzdDoge1xuICAgICAgICAgIHNob3J0X25hbWU6IFwiRXhjYWxpZHJhd1wiLFxuICAgICAgICAgIG5hbWU6IFwiRXhjYWxpZHJhd1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICAgXCJFeGNhbGlkcmF3IGlzIGEgd2hpdGVib2FyZCB0b29sIHRoYXQgbGV0cyB5b3UgZWFzaWx5IHNrZXRjaCBkaWFncmFtcyB0aGF0IGhhdmUgYSBoYW5kLWRyYXduIGZlZWwgdG8gdGhlbS5cIixcbiAgICAgICAgICBpY29uczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzcmM6IFwiYW5kcm9pZC1jaHJvbWUtMTkyeDE5Mi5wbmdcIixcbiAgICAgICAgICAgICAgc2l6ZXM6IFwiMTkyeDE5MlwiLFxuICAgICAgICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3JjOiBcImFwcGxlLXRvdWNoLWljb24ucG5nXCIsXG4gICAgICAgICAgICAgIHR5cGU6IFwiaW1hZ2UvcG5nXCIsXG4gICAgICAgICAgICAgIHNpemVzOiBcIjE4MHgxODBcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHNyYzogXCJmYXZpY29uLTMyeDMyLnBuZ1wiLFxuICAgICAgICAgICAgICBzaXplczogXCIzMngzMlwiLFxuICAgICAgICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3JjOiBcImZhdmljb24tMTZ4MTYucG5nXCIsXG4gICAgICAgICAgICAgIHNpemVzOiBcIjE2eDE2XCIsXG4gICAgICAgICAgICAgIHR5cGU6IFwiaW1hZ2UvcG5nXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgICAgc3RhcnRfdXJsOiBcIi9cIixcbiAgICAgICAgICBpZDogXCJleGNhbGlkcmF3XCIsXG4gICAgICAgICAgZGlzcGxheTogXCJzdGFuZGFsb25lXCIsXG4gICAgICAgICAgdGhlbWVfY29sb3I6IFwiIzEyMTIxMlwiLFxuICAgICAgICAgIGJhY2tncm91bmRfY29sb3I6IFwiI2ZmZmZmZlwiLFxuICAgICAgICAgIGZpbGVfaGFuZGxlcnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIi9cIixcbiAgICAgICAgICAgICAgYWNjZXB0OiB7XG4gICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi92bmQuZXhjYWxpZHJhdytqc29uXCI6IFtcIi5leGNhbGlkcmF3XCJdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICAgIHNoYXJlX3RhcmdldDoge1xuICAgICAgICAgICAgYWN0aW9uOiBcIi93ZWItc2hhcmUtdGFyZ2V0XCIsXG4gICAgICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgICAgICAgZW5jdHlwZTogXCJtdWx0aXBhcnQvZm9ybS1kYXRhXCIsXG4gICAgICAgICAgICBwYXJhbXM6IHtcbiAgICAgICAgICAgICAgZmlsZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBuYW1lOiBcImZpbGVcIixcbiAgICAgICAgICAgICAgICAgIGFjY2VwdDogW1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL3ZuZC5leGNhbGlkcmF3K2pzb25cIixcbiAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiLmV4Y2FsaWRyYXdcIixcbiAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzY3JlZW5zaG90czogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzcmM6IFwiL3NjcmVlbnNob3RzL3ZpcnR1YWwtd2hpdGVib2FyZC5wbmdcIixcbiAgICAgICAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcbiAgICAgICAgICAgICAgc2l6ZXM6IFwiNDYyeDk0NVwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3JjOiBcIi9zY3JlZW5zaG90cy93aXJlZnJhbWUucG5nXCIsXG4gICAgICAgICAgICAgIHR5cGU6IFwiaW1hZ2UvcG5nXCIsXG4gICAgICAgICAgICAgIHNpemVzOiBcIjQ2Mng5NDVcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHNyYzogXCIvc2NyZWVuc2hvdHMvaWxsdXN0cmF0aW9uLnBuZ1wiLFxuICAgICAgICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICAgICAgICBzaXplczogXCI0NjJ4OTQ1XCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzcmM6IFwiL3NjcmVlbnNob3RzL3NoYXBlcy5wbmdcIixcbiAgICAgICAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcbiAgICAgICAgICAgICAgc2l6ZXM6IFwiNDYyeDk0NVwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3JjOiBcIi9zY3JlZW5zaG90cy9jb2xsYWJvcmF0aW9uLnBuZ1wiLFxuICAgICAgICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICAgICAgICBzaXplczogXCI0NjJ4OTQ1XCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzcmM6IFwiL3NjcmVlbnNob3RzL2V4cG9ydC5wbmdcIixcbiAgICAgICAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcbiAgICAgICAgICAgICAgc2l6ZXM6IFwiNDYyeDk0NVwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBjcmVhdGVIdG1sUGx1Z2luKHtcbiAgICAgICAgbWluaWZ5OiB0cnVlLFxuICAgICAgfSksXG4gICAgXSxcbiAgICBwdWJsaWNEaXI6IFwiLi4vcHVibGljXCIsXG4gIH07XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUNBLFFBQU0sZ0JBQWdCO0FBQ3RCLFFBQU0scUJBQXFCO0FBTzNCLFdBQU8sUUFBUSxxQkFBcUIs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
