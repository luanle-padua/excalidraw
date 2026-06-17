// Base URL for the AI / STT routes (DO migration I-1).
//
// These routes moved off the Fly room server onto the Cloudflare Worker
// (mcm-storage): /translate, /translate-batch, /chatbot, /summarize (HTTP) and
// /stt (WebSocket). The client therefore points them at the SAME backend as the
// rest of the storage API — VITE_APP_STORAGE_URL — instead of the old room URL
// (VITE_APP_WS_SERVER_URL). See docs/plans/durable-objects-migration.md §6.
//
// Tunnel mode (VITE_DEV_TUNNEL=true): the Worker sits behind the same
// Cloudflare quick-tunnel hostname as the page, so a same-origin "" base
// (relative fetch) Just Works — mirrors data/admin.ts etc.

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** HTTP base for the AI routes (e.g. `${aiBackendUrl()}/translate`). Empty
 *  string in tunnel/same-origin mode → a plain relative fetch. */
export const aiBackendUrl = (): string => STORAGE_URL;

/** WebSocket base for the /stt proxy. Converts the http(s) storage URL to its
 *  ws(s) form; returns same-origin ws(s):// in tunnel mode. */
export const sttBackendWsUrl = (): string => {
  if (!STORAGE_URL) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return STORAGE_URL.replace(/^http(s?):/, (_m: string, s: string) =>
    s ? "wss:" : "ws:",
  );
};
