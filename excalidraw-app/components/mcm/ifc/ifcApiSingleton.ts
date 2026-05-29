// Shared web-ifc WASM instance. Ported from the Digital Twins viewer
// (D:\LUAN\0.WIP\15.DIGITAL TWINS apps/client/src/lib/IfcApiSingleton.ts).
//
// web-ifc's WASM is loaded once and reused across every IFC bake /
// load. The .wasm file must be served from the origin root — we drop
// `web-ifc.wasm` into excalidraw's `public/` folder (served at
// `/web-ifc.wasm`) and point SetWasmPath at "/".
//
// `Init(undefined, true)` forces the single-threaded WASM variant so we
// don't need cross-origin-isolation (COOP/COEP) headers, which the
// Cloudflare-tunnel dev setup doesn't send. The multi-threaded variant
// is a future optimisation once those headers are configured.

import { IfcAPI } from "web-ifc";

let instance: IfcAPI | null = null;
let initPromise: Promise<IfcAPI> | null = null;

export const getIfcApi = async (): Promise<IfcAPI> => {
  if (instance) {
    return instance;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const api = new IfcAPI();
    api.SetWasmPath("/");
    await api.Init(undefined, true);
    instance = api;
    return api;
  })();

  return initPromise;
};
