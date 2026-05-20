// React wrapper around a pdfjs document handle — renders a specific
// page of a library PDF into a <canvas> sized to the parent. Each
// instance holds ONE pdfjs document; switching `page` re-renders the
// same document, which is cheap. Switching `fileId` tears down and
// reopens.
//
// Separation of concerns:
//   • This component owns the pdfjs document lifecycle + page render.
//   • The parent (PDFCanvasOverlay / library preview) decides which
//     page to show, when to mount/unmount, and what to do with the
//     `onReady` callback (e.g. snapshot for the cache).

import { useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";

import { acquireDoc, releaseDoc } from "./pdfDocPool";

import type { PdfDocHandle } from "./pdfRendering";

export type PDFRendererControls = {
  /** Total pages in the document — useful for the parent's page-nav
   *  toolbar so it can clamp Prev/Next at the document edges. */
  pageCount: number;
  /** Returns a PNG blob of the currently-rendered canvas. */
  exportPng: () => Promise<Blob | null>;
};

type Props = {
  /** Library file id — resolved against `meetingFilesAtom` to find
   *  the dataURL for pdfjs. */
  fileId: string;
  /** 1-indexed page to render. Defaults to 1. */
  page?: number;
  width: number;
  height: number;
  /** Fires once the pdfjs document is loaded (NOT when the first page
   *  has been painted) — exposes pageCount + exportPng to the parent.
   *  Don't call exportPng from here; the canvas may still be blank. */
  onReady?: (controls: PDFRendererControls) => void;
  /** Fires every time a page has finished painting onto the canvas.
   *  This is the moment the canvas actually holds the requested
   *  page's pixels — the right time to call exportPng for the
   *  snapshot cache. Without using this callback the parent would
   *  capture a blank canvas (status flips to "ready" before the page
   *  is drawn), and every peer/passive anchor would see a white
   *  placeholder after a page change. */
  onPageRendered?: (page: number) => void;
  onError?: (err: Error) => void;
};

type Status = "loading" | "ready" | "error";

export const PDFRenderer = ({
  fileId,
  page = 1,
  width,
  height,
  onReady,
  onPageRendered,
  onError,
}: Props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<PdfDocHandle | null>(null);
  const onReadyRef = useRef(onReady);
  const onPageRenderedRef = useRef(onPageRendered);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onPageRenderedRef.current = onPageRendered;
  onErrorRef.current = onError;

  const files = useAtomValue(meetingFilesAtom);
  const file = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId],
  );

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [renderedPage, setRenderedPage] = useState<number>(0);

  // Acquire a SHARED document handle via the pool keyed by fileId.
  // Many anchors of the same PDF (passive copies, peers, snapshot
  // generators) all coalesce onto a single pdfjs parse — the previous
  // implementation called openPdf directly and paid the ~500ms parse
  // cost per anchor, which is what made peers see a long white frame
  // after every page change. `file?.dataURL` is still the content
  // key so re-hydration of meetingFilesAtom doesn't re-acquire.
  useEffect(() => {
    if (!file) {
      return undefined;
    }
    let cancelled = false;
    let acquiredFileId: string | null = null;

    const run = async () => {
      try {
        const handle = await acquireDoc(file.id, file.dataURL);
        acquiredFileId = file.id;
        if (cancelled) {
          // Effect was torn down mid-acquire — release back to the
          // pool so the refcount stays balanced.
          void releaseDoc(file.id);
          acquiredFileId = null;
          return;
        }
        handleRef.current = handle;
        setStatus("ready");
        onReadyRef.current?.({
          pageCount: handle.pageCount,
          exportPng: async () => {
            const canvas = canvasRef.current;
            if (!canvas) {
              return null;
            }
            return new Promise((resolve) =>
              canvas.toBlob((b) => resolve(b), "image/png"),
            );
          },
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        setStatus("error");
        setErrorMsg(e.message);
        onErrorRef.current?.(e);
      }
    };

    void run();

    return () => {
      cancelled = true;
      handleRef.current = null;
      // Release matches the (eventual) acquire. The pool destroys
      // the underlying document only when the last user releases.
      if (acquiredFileId) {
        void releaseDoc(acquiredFileId);
        acquiredFileId = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.dataURL]);

  // Render the requested page whenever it changes, the document
  // becomes ready, or the container resizes. Each render writes to
  // canvas.width = pixel width, height is derived from the page's
  // aspect ratio (pdfRendering.renderTo sets canvas.height itself).
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    const handle = handleRef.current;
    const canvas = canvasRef.current;
    if (!handle || !canvas) {
      return;
    }
    const pixelWidth = Math.max(1, Math.floor(width * window.devicePixelRatio));
    canvas.width = pixelWidth;
    let cancelled = false;
    void handle.renderTo(canvas, page).then(() => {
      if (cancelled) {
        return;
      }
      setRenderedPage(page);
      // Notify the parent ONLY after the canvas actually holds this
      // page's pixels — that's when exportPng can produce a real PNG
      // for the snapshot cache. Previously the parent called
      // exportPng from onReady (which fires the moment the document
      // is parsed, well before any paint), so the cached snapshot
      // was a blank white frame.
      onPageRenderedRef.current?.(page);
    });
    return () => {
      cancelled = true;
    };
  }, [status, page, width, height]);

  if (!file) {
    return (
      <div className="mcm-pdf-renderer mcm-pdf-renderer--missing">
        File PDF không tìm thấy
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`mcm-pdf-renderer mcm-pdf-renderer--${status}`}
      // eslint-disable-next-line react/forbid-dom-props
      style={{ width, height }}
      data-pdf-file-id={fileId}
      data-pdf-page={renderedPage}
    >
      <canvas ref={canvasRef} className="mcm-pdf-renderer__canvas" />
      {status === "loading" && (
        <div className="mcm-pdf-renderer__loading">
          <span className="mcm-pdf-renderer__spinner" />
          <span>Đang tải PDF…</span>
        </div>
      )}
      {status === "error" && (
        <div className="mcm-pdf-renderer__error">
          Không đọc được PDF: {errorMsg}
        </div>
      )}
    </div>
  );
};

export default PDFRenderer;
