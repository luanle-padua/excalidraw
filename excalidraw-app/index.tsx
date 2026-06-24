import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);

// Keep EVERY open client on the latest deploy WITHOUT a manual hard-refresh —
// essential on phones/tablets where there is no easy "clear cache" (the cause of
// "iPhone can't open review / I still see the old version"). registerType is
// "autoUpdate", so a newly-found SW skipWaiting's + reloads on its own; we
// proactively POLL for a new SW on an interval and whenever the tab/PWA regains
// focus or reconnects, so a deploy reaches an already-open client within ~a
// minute instead of only on the next cold start.
const SW_UPDATE_INTERVAL_MS = 60_000;
registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    if (!registration) {
      return;
    }
    const checkForUpdate = async () => {
      if (registration.installing) {
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      try {
        // Bypass the HTTP cache for the SW script itself so an edge/browser
        // -cached sw.js can never mask a fresh deploy; registration.update()
        // then swaps in the new SW (autoUpdate reloads the page).
        const resp = await fetch(swUrl, {
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
        });
        if (resp?.status === 200) {
          await registration.update();
        }
      } catch {
        // offline / transient network — retry on the next tick or focus.
      }
    };
    window.setInterval(checkForUpdate, SW_UPDATE_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void checkForUpdate();
      }
    });
    window.addEventListener("online", () => void checkForUpdate());
  },
});
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
