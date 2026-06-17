// Self-hosting: serve ALL fonts from OUR OWN origin instead of the upstream
// (Excalidraw) DigitalOcean CDN. The editor fonts (Excalifont, Nunito,
// ComicShanns, Assistant, …) are already bundled into the app build under
// `/fonts/...` by Vite/Rollup, so pointing the asset path at our root ("/")
// removes any runtime dependency on excalidraw.nyc3.cdn.digitaloceanspaces.com
// (which on slow networks triggered Chrome's fallback-font intervention).
const OSS_FONTS_FALLBACK = "/";

/**
 * Custom vite plugin for auto-prefixing `EXCALIDRAW_ASSET_PATH` woff2 fonts in `excalidraw-app`.
 *
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = () => {
  let isDev;

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    transform(code, id) {
      // using copy / replace as fonts defined in the `.css` don't have to be manually copied over (vite/rollup does this automatically),
      // but at the same time can't be easily prefixed with the `EXCALIDRAW_ASSET_PATH` only for the `excalidraw-app`
      if (!isDev && id.endsWith("/excalidraw/fonts/fonts.css")) {
        // Self-hosted: the Assistant UI woff2 files live in `public/` and are
        // served from our origin root. Reference them by absolute path so the
        // URL is stable regardless of where the merged/hashed CSS chunk lands
        // in the build output — no external CDN.
        return `/* WARN: The following content is generated during excalidraw-app build */

      @font-face {
        font-family: "Assistant";
        src: url(/Assistant-Regular.woff2) format("woff2");
        font-weight: 400;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(/Assistant-Medium.woff2) format("woff2");
        font-weight: 500;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(/Assistant-SemiBold.woff2) format("woff2");
        font-weight: 600;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(/Assistant-Bold.woff2) format("woff2");
        font-weight: 700;
        style: normal;
        display: swap;
      }`;
      }

      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        // Self-hosted: load all editor fonts from OUR own origin (root). The
        // fonts are bundled into the build under /fonts/... — no external CDN.
        window.EXCALIDRAW_ASSET_PATH = "${OSS_FONTS_FALLBACK}";
      </script>

      <!-- Preload all default fonts (served from our origin) to avoid swap on init -->
      <link
        rel="preload"
        href="/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <!-- For Nunito only preload the latin range, which should be good enough for now -->
      <link
        rel="preload"
        href="/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="/Assistant-SemiBold.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="/fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
    `,
        );
      }
    },
  };
};
