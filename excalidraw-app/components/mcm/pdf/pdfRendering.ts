// Thin, lazy wrapper around pdfjs-dist. The library ships ~3-5MB of
// JS + WASM so we keep it out of the main bundle by `import()`-ing
// the module only when the first PDF is encountered (upload, mount,
// thumbnail bake — whichever comes first). Subsequent callers reuse
// the cached module reference.
//
// pdfjs-dist requires a "worker" script for off-thread parsing.
// Bundling it via Vite's `?url` query gives us a stable URL that
// works in both dev (served from /node_modules) and production (the
// worker file is emitted alongside the main bundle).

// eslint-disable-next-line import/no-unresolved
import workerSrcUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfjsModule = typeof import("pdfjs-dist");

let cachedModule: PdfjsModule | null = null;
let workerConfigured = false;

const loadModule = async (): Promise<PdfjsModule> => {
  if (cachedModule) {
    return cachedModule;
  }
  cachedModule = await import("pdfjs-dist");
  // Configure the worker exactly once per page lifetime. Doing this
  // after `import()` resolves guarantees `GlobalWorkerOptions` exists
  // before we write to it (pdfjs constructs the object during module
  // initialisation).
  if (!workerConfigured) {
    cachedModule.GlobalWorkerOptions.workerSrc = workerSrcUrl as string;
    workerConfigured = true;
  }
  return cachedModule;
};

/** Probe a PDF dataURL and return its page count plus a thumbnail
 *  PNG dataURL of page 1, suitable for storing on the library entry's
 *  `pdfMeta`. Returns `null` if the file fails to parse — caller can
 *  decide whether to fall back to a generic placeholder. */
export const probePdf = async (
  dataURL: string,
  thumbnailWidth = 256,
): Promise<{ pageCount: number; thumbnail: string } | null> => {
  try {
    const pdfjs = await loadModule();
    const loadingTask = pdfjs.getDocument({ url: dataURL });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    let thumbnail = "";
    try {
      const page = await doc.getPage(1);
      // Pick a scale that yields roughly the requested width so the
      // baked PNG looks crisp in the library tile (which is ~120px
      // wide). Going larger trades tile rendering time for visual
      // quality on hi-dpi screens.
      const viewport1 = page.getViewport({ scale: 1 });
      const scale = thumbnailWidth / viewport1.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // pdfjs draws over a transparent canvas by default — paint
        // white first so PDFs with no page background still read as
        // a document instead of a faint outline.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        thumbnail = canvas.toDataURL("image/png");
      }
      // Free GPU/CPU memory eagerly — the worker holds onto page
      // resources until cleanup, and a library can grow large.
      page.cleanup();
    } catch (err) {
      console.warn("[pdfRendering] thumbnail render failed", err);
    }
    void doc.destroy();
    return { pageCount, thumbnail };
  } catch (err) {
    console.warn("[pdfRendering] probePdf failed", err);
    return null;
  }
};

export type PdfDocHandle = {
  pageCount: number;
  /** Render `pageNumber` (1-indexed) into the given canvas, sized to
   *  fit the canvas's current width while preserving the page's
   *  native aspect ratio. Resolves once the page is fully painted. */
  renderTo: (canvas: HTMLCanvasElement, pageNumber: number) => Promise<void>;
  /** Destroy the underlying pdfjs document — call on unmount to free
   *  worker memory. Safe to call more than once. */
  destroy: () => Promise<void>;
};

/** Open a PDF by dataURL and return a handle that can render any page
 *  on demand. The handle keeps the pdfjs document alive so subsequent
 *  page renders reuse parsed objects (much faster than re-opening).  */
export const openPdf = async (dataURL: string): Promise<PdfDocHandle> => {
  const pdfjs = await loadModule();
  const doc = await pdfjs.getDocument({ url: dataURL }).promise;
  let destroyed = false;
  return {
    pageCount: doc.numPages,
    renderTo: async (canvas, pageNumber) => {
      if (destroyed) {
        return;
      }
      const safePage = Math.max(1, Math.min(pageNumber, doc.numPages));
      const page = await doc.getPage(safePage);
      // Scale to fit the canvas's current pixel width. The caller is
      // responsible for setting canvas.width/height to the desired
      // display size (taking devicePixelRatio into account).
      const viewport1 = page.getViewport({ scale: 1 });
      const cssWidth = canvas.width;
      const scale = cssWidth / viewport1.width;
      const viewport = page.getViewport({ scale });
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
    },
    destroy: async () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      try {
        await doc.destroy();
      } catch {
        // pdfjs sometimes throws when destroying mid-render; safe to
        // ignore since the document is going away regardless.
      }
    },
  };
};
