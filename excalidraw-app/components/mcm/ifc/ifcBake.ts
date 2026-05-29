// Main-thread helper that runs the IFC -> GLB + metadata bake in a
// module web worker (see ifcBakeWorker.ts). One worker is spawned per
// call and terminated when done — bakes happen once on upload, so the
// startup cost is irrelevant and a fresh worker avoids leaking the
// web-ifc WASM heap between (potentially large) models.

import type { IfcBakeRequest, IfcBakeResponse, IfcMetadataPayload } from "./ifcTypes";

let bakeCounter = 0;

export const bakeIfc = (
  ifc: ArrayBuffer,
): Promise<{
  glb: ArrayBuffer;
  metadata: IfcMetadataPayload;
  elementCount: number;
}> => {
  const id = `ifc-bake-${Date.now()}-${bakeCounter++}`;

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./ifcBakeWorker.ts", import.meta.url),
      { type: "module" },
    );

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<IfcBakeResponse>) => {
      const response = event.data;
      // Ignore stray messages that aren't for this request.
      if (response.id !== id) {
        return;
      }
      cleanup();
      if (response.ok) {
        resolve({
          glb: response.glb,
          metadata: response.metadata,
          elementCount: response.elementCount,
        });
      } else {
        reject(new Error(response.error));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "IFC bake worker failed"));
    };

    const request: IfcBakeRequest = { id, ifc };
    // Transfer the IFC bytes so we don't copy the (large) buffer.
    worker.postMessage(request, [ifc]);
  });
};
