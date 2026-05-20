// HTML overlay that renders every PDF anchor on the canvas — sibling
// of DXFCanvasOverlay. Each anchor is a rectangle element with
// `customData.mcmType === "pdf-anchor"`, `pdfFileId`, and `pdfPage`.
// Excalidraw owns the rectangle's position, size, lock, and collab
// sync; we paint the matching PDF page on top via PDFRenderer (or a
// cached snapshot <img> when one is available).
//
// Why mirror DXFCanvasOverlay rather than share code: the two anchor
// kinds have different surfaces (DXF has layer panels + persisted
// pan/zoom, PDF has page navigation + page count), and the overlap
// is mostly mechanical (anchor list bookkeeping, capture-phase
// listeners). Sharing now would force the union of both interfaces
// onto callers — refactor once the shape settles, not before.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";

import { PDFRenderer } from "./PDFRenderer";
import {
  getPdfSnapshot,
  pdfSnapshotKey,
  pdfSnapshotVersionAtom,
  setPdfSnapshot,
} from "./pdfSnapshotCache";

import type { PDFRendererControls } from "./PDFRenderer";

/** Marker for elements that are PDF placeholders. Mirrors
 *  DXF_ANCHOR_KIND. */
export const PDF_ANCHOR_KIND = "pdf-anchor";

/** A PDF anchor is identified purely by its customData — the element
 *  type can be EITHER:
 *    • "rectangle"  — legacy anchors created before the image-anchor
 *      refactor; PDFCanvasOverlay paints the PDF on top via an HTML
 *      overlay.
 *    • "image"      — current anchors. The PDF page is baked into the
 *      Excalidraw file map and rendered natively on canvas, so other
 *      elements participate in z-order against it. We still mount the
 *      HTML overlay BUT only when focused (for page navigation). */
export const isPdfAnchorElement = (
  el: ExcalidrawElement,
): el is ExcalidrawElement & {
  customData: {
    mcmType: string;
    pdfFileId: string;
    /** 1-indexed page the user wants this specific anchor to show.
     *  Persists across reloads + peers so a "show me figure 3 of the
     *  spec" snapshot keeps showing figure 3. */
    pdfPage?: number;
    /** File id (in Excalidraw's binary-file map) of the snapshot PNG
     *  this anchor displays. Present on image-based anchors so we
     *  know which file to rewrite when the page changes. Absent on
     *  legacy rectangle anchors. */
    pdfSnapshotFileId?: string;
  };
} => {
  return (
    !el.isDeleted &&
    (el.type === "rectangle" || el.type === "image") &&
    !!el.customData &&
    (el.customData as Record<string, unknown>).mcmType === PDF_ANCHOR_KIND &&
    typeof (el.customData as Record<string, unknown>).pdfFileId === "string"
  );
};

type AnchorPosition = {
  elementId: string;
  fileId: string;
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** "image" for new anchors backed by an Excalidraw image element;
   *  "rectangle" for legacy ones still relying on the full HTML
   *  overlay for display. Drives whether the overlay paints the PDF
   *  content (rectangle) or only renders the focus-mode toolbar
   *  while the canvas image element handles normal display (image). */
  kind: "rectangle" | "image";
  /** Snapshot file id for image anchors (mirrors customData). Null
   *  for rectangle anchors. */
  snapshotFileId: string | null;
};

type ContextMenuState = {
  elementId: string;
  clientX: number;
  clientY: number;
};

/** Convert a Blob to a data URL — used for the snapshot cache. */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });

/** rAF + exportPng → cache. Mirrors DXFCanvasOverlay's helper. */
const capturePdfSnapshot = (
  controls: PDFRendererControls,
  cacheKey: string,
): void => {
  requestAnimationFrame(() => {
    void controls
      .exportPng()
      .then((blob) => (blob ? blobToDataUrl(blob) : null))
      .then((dataUrl) => {
        if (dataUrl) {
          setPdfSnapshot(cacheKey, dataUrl);
        }
      })
      .catch((err) => {
        console.warn("[PDFCanvasOverlay] snapshot capture failed", err);
      });
  });
};

/** Image-anchor variant of capturePdfSnapshot: writes BOTH to the
 *  shared snapshot cache AND to Excalidraw's binary-file map so the
 *  canvas image element re-renders with the freshly painted PDF page.
 *  `anchor.snapshotFileId` is the file id Excalidraw is using for
 *  this specific anchor's image content; replacing the file under
 *  that id swaps the picture without changing the element id, so
 *  any "Bring to Front" / "Send to Back" arrangement the user has
 *  applied stays put.
 *
 *  Why the delete-then-add dance: Excalidraw's `addFiles` calls
 *  `addMissingFiles` internally, which SKIPS any id already present
 *  in the file map (and consequently does NOT call
 *  `clearImageShapeCache` for it). So calling addFiles with the same
 *  id a second time is a no-op — the image element keeps rendering
 *  the original snapshot forever. Pulling the entry out of the
 *  live `this.files` reference returned by `getFiles()` (App.tsx
 *  line 767: `getFiles: () => this.files`) makes the next addFiles
 *  treat the id as fresh, which clears the image-shape cache and
 *  forces the canvas to repaint with the new dataURL. */
const capturePdfAndUpdateFile = (
  controls: PDFRendererControls,
  anchor: AnchorPosition,
  renderedPage: number,
  excalidrawAPI: ReturnType<typeof useExcalidrawAPI>,
): void => {
  if (!anchor.snapshotFileId) {
    return;
  }
  requestAnimationFrame(() => {
    void controls
      .exportPng()
      .then((blob) => (blob ? blobToDataUrl(blob) : null))
      .then((dataUrl) => {
        if (!dataUrl) {
          return;
        }
        setPdfSnapshot(pdfSnapshotKey(anchor.fileId, renderedPage), dataUrl);
        if (!excalidrawAPI || !anchor.snapshotFileId) {
          return;
        }
        // Evict any cached file under this id so the upcoming
        // addFiles sees it as new and bypasses Excalidraw's
        // addMissingFiles "skip if present" guard.
        const filesMap = excalidrawAPI.getFiles() as Record<
          string,
          BinaryFileData | undefined
        >;
        if (filesMap[anchor.snapshotFileId]) {
          delete filesMap[anchor.snapshotFileId];
        }
        excalidrawAPI.addFiles([
          {
            id: anchor.snapshotFileId as FileId,
            dataURL: dataUrl as unknown as BinaryFileData["dataURL"],
            mimeType: "image/png" as BinaryFileData["mimeType"],
            created: Date.now(),
          },
        ]);
      })
      .catch((err) => {
        console.warn("[PDFCanvasOverlay] snapshot+filemap update failed", err);
      });
  });
};

export const PDFCanvasOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  // Re-render on snapshot cache updates so passive anchors flip from
  // live renderer to <img> the moment a sibling populates the cache.
  useAtomValue(pdfSnapshotVersionAtom);
  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);
  const anchorsRef = useRef<AnchorPosition[]>([]);
  anchorsRef.current = anchors;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusedAnchorId, setFocusedAnchorId] = useState<string | null>(null);
  // Per-anchor controls (pageCount + exportPng) captured on each
  // PDFRenderer's onReady fire, so the focus toolbar can drive page
  // navigation + snapshotting.
  const controlsRef = useRef<Map<string, PDFRendererControls>>(new Map());

  const knownFileIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      s.add(f.id);
    }
    return s;
  }, [files]);

  // For image-based anchors, the Excalidraw image element needs a
  // file in its binary-file map BEFORE the snapshotter has had a
  // chance to render. Without an initial seed, peers receiving a new
  // anchor would see the missing-image placeholder for ~500ms while
  // pdfjs loads. Seed every image anchor's snapshotFileId with the
  // library-baked page-1 thumbnail (or a 1×1 transparent PNG when the
  // PDF didn't bake a thumbnail) so SOMETHING is on the canvas the
  // instant the element appears. The actual page snapshot follows
  // via capturePdfAndUpdateFile.
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const existingFiles = excalidrawAPI.getFiles();
    const additions: BinaryFileData[] = [];
    for (const a of anchors) {
      if (a.kind !== "image" || !a.snapshotFileId) {
        continue;
      }
      if (existingFiles[a.snapshotFileId]) {
        continue;
      }
      const libFile = files.find((f) => f.id === a.fileId);
      const seed =
        libFile?.pdfMeta?.thumbnail ??
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
      additions.push({
        id: a.snapshotFileId as FileId,
        dataURL: seed as unknown as BinaryFileData["dataURL"],
        mimeType: "image/png" as BinaryFileData["mimeType"],
        created: Date.now(),
      });
    }
    if (additions.length > 0) {
      excalidrawAPI.addFiles(additions);
    }
  }, [anchors, files, excalidrawAPI]);

  // When the user copies an anchor (Ctrl+D / clone-paste / paste from
  // another scene), Excalidraw deep-clones the source element but
  // shallow-clones customData, so the duplicate inherits the
  // ORIGINAL's pdfSnapshotFileId. Both anchors then point at the
  // same file map entry and `goToPage` on one rewrites the snapshot
  // for both — pages move in lockstep.
  //
  // We fix it deterministically: every image anchor's snapshotFileId
  // should equal `pdf-snap-{element.id}` (insertion enforces this).
  // Any anchor where the invariant is broken is, by definition, a
  // copy whose customData drifted away from its new element id, so
  // we re-key it. The rule is purely a function of the element id,
  // which means every peer running this effect produces the same
  // migration → no concurrent-write races, even if multiple users
  // copy at once.
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const migrations: Array<{
      elementId: string;
      newSnapshotFileId: string;
      oldSnapshotFileId: string;
    }> = [];
    for (const a of anchors) {
      if (a.kind !== "image" || !a.snapshotFileId) {
        continue;
      }
      const expected = `pdf-snap-${a.elementId}`;
      if (a.snapshotFileId === expected) {
        continue;
      }
      migrations.push({
        elementId: a.elementId,
        newSnapshotFileId: expected,
        oldSnapshotFileId: a.snapshotFileId,
      });
    }
    if (migrations.length === 0) {
      return;
    }
    // Seed the new fileIds in the file map from the originals so the
    // copy doesn't flash a missing-image placeholder during the
    // re-key. The fresh-page snapshot follows asynchronously through
    // the normal snapshotter path.
    const filesMap = excalidrawAPI.getFiles() as Record<
      string,
      BinaryFileData | undefined
    >;
    const additions: BinaryFileData[] = [];
    for (const m of migrations) {
      const oldFile = filesMap[m.oldSnapshotFileId];
      if (oldFile) {
        additions.push({
          ...oldFile,
          id: m.newSnapshotFileId as FileId,
          created: Date.now(),
        });
      }
    }
    if (additions.length > 0) {
      excalidrawAPI.addFiles(additions);
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      const m = migrations.find((mig) => mig.elementId === el.id);
      if (!m || !isPdfAnchorElement(el) || el.type !== "image") {
        return el;
      }
      return newElementWith(el, {
        // Image element's own fileId mirrors customData so Excalidraw
        // renders the right file.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileId: m.newSnapshotFileId as any,
        customData: {
          ...el.customData,
          pdfSnapshotFileId: m.newSnapshotFileId,
        },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  }, [anchors, excalidrawAPI]);

  /** Update an anchor's customData.pdfPage and flush to peers via
   *  updateScene. Both Prev and Next buttons funnel through this so
   *  the persist + broadcast logic lives in one place. */
  const persistPage = (elementId: string, nextPage: number) => {
    if (!excalidrawAPI) {
      return;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      if (el.id !== elementId || !isPdfAnchorElement(el)) {
        return el;
      }
      return newElementWith(el, {
        customData: { ...el.customData, pdfPage: nextPage },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  };

  const goToPage = (anchor: AnchorPosition, delta: number) => {
    const controls = controlsRef.current.get(anchor.elementId);
    const max = controls?.pageCount ?? anchor.page;
    const next = Math.max(1, Math.min(max, anchor.page + delta));
    if (next !== anchor.page) {
      persistPage(anchor.elementId, next);
    }
  };

  // ----- Recompute viewport positions on any scene change ----------
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const recompute = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      const next: AnchorPosition[] = [];
      const zoom = appState.zoom.value;
      for (const el of elements) {
        if (!isPdfAnchorElement(el)) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        next.push({
          elementId: el.id,
          fileId: el.customData.pdfFileId,
          page:
            typeof el.customData.pdfPage === "number" &&
            el.customData.pdfPage >= 1
              ? el.customData.pdfPage
              : 1,
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
          kind: el.type === "image" ? "image" : "rectangle",
          snapshotFileId:
            typeof el.customData.pdfSnapshotFileId === "string"
              ? el.customData.pdfSnapshotFileId
              : null,
        });
      }
      setAnchors((prev) => {
        if (prev.length === next.length) {
          const same = prev.every(
            (p, i) =>
              p.elementId === next[i].elementId &&
              p.fileId === next[i].fileId &&
              p.page === next[i].page &&
              p.left === next[i].left &&
              p.top === next[i].top &&
              p.width === next[i].width &&
              p.height === next[i].height &&
              p.kind === next[i].kind &&
              p.snapshotFileId === next[i].snapshotFileId,
          );
          if (same) {
            return prev;
          }
        }
        return next;
      });
    };

    recompute(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    const unsub = excalidrawAPI.onChange(recompute);
    return unsub;
  }, [excalidrawAPI]);

  // Swallow dbl-click on PDF anchors so Excalidraw doesn't try to
  // edit the rectangle's text label (a click anywhere inside the
  // anchor would otherwise drop into text-edit mode).
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const wrap = document.querySelector(
      ".mcm-shell__canvas-wrap",
    ) as HTMLElement | null;
    if (!wrap) {
      return undefined;
    }
    const onDblClick = (e: MouseEvent) => {
      if (anchorsRef.current.length === 0) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      for (const a of anchorsRef.current) {
        if (
          localX >= a.left &&
          localX <= a.left + a.width &&
          localY >= a.top &&
          localY <= a.top + a.height
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
      }
    };
    window.addEventListener("dblclick", onDblClick, true);
    return () => window.removeEventListener("dblclick", onDblClick, true);
  }, [excalidrawAPI]);

  // Right-click → "Chỉnh PDF" context menu → focus mode.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const wrap = document.querySelector(
      ".mcm-shell__canvas-wrap",
    ) as HTMLElement | null;
    if (!wrap) {
      return undefined;
    }
    const onContextMenu = (e: MouseEvent) => {
      if (anchorsRef.current.length === 0) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      for (const a of anchorsRef.current) {
        if (
          localX >= a.left &&
          localX <= a.left + a.width &&
          localY >= a.top &&
          localY <= a.top + a.height
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setContextMenu({
            elementId: a.elementId,
            clientX: e.clientX,
            clientY: e.clientY,
          });
          return;
        }
      }
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [excalidrawAPI]);

  // Outside-click / Esc closes the menu + exits focus.
  useEffect(() => {
    if (!contextMenu && !focusedAnchorId) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest(".mcm-pdf-context-menu")) {
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
      }
      if (focusedAnchorId) {
        setFocusedAnchorId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, focusedAnchorId]);

  if (anchors.length === 0) {
    return null;
  }

  return (
    <div className="mcm-pdf-layer">
      {anchors.map((a) => {
        const known = knownFileIds.has(a.fileId);
        const focused = focusedAnchorId === a.elementId;
        const cacheKey = pdfSnapshotKey(a.fileId, a.page);
        const cachedSnapshot = getPdfSnapshot(cacheKey);
        const controls = controlsRef.current.get(a.elementId);
        const pageCount = controls?.pageCount ?? 0;
        const isImageAnchor = a.kind === "image";
        // For IMAGE anchors the PDF page is already painted on the
        // canvas by Excalidraw (via the snapshot in its file map), so
        // the overlay only needs to:
        //   • be a positioned container for the focus toolbar.
        //   • mount a hidden PDFRenderer when we need a fresh snapshot
        //     for the current page (cache miss).
        //   • mount a visible PDFRenderer when the user is focused
        //     (interactive page navigation).
        // For LEGACY rectangle anchors the overlay still owns the
        // entire visual (live renderer or cached <img>), exactly as
        // before — the canvas underneath is just a transparent
        // rectangle stand-in.
        const showLegacyPanel = !isImageAnchor && known;
        const useSnapshotLegacy =
          showLegacyPanel && !focused && cachedSnapshot !== null;
        const needFreshSnapshot = known && !cachedSnapshot;
        // Hidden snapshotter for image anchors: when the cache is
        // missing for this (fileId, page), mount the renderer
        // off-screen just long enough to capture + push to the file
        // map. Width/height match the anchor so the snapshot scales
        // 1:1 with the canvas-rendered image.
        const mountHiddenSnapshotter =
          isImageAnchor && !focused && needFreshSnapshot;
        return (
          <div
            key={a.elementId}
            className={`mcm-pdf-layer__anchor${
              focused ? " mcm-pdf-layer__anchor--focused" : ""
            }${isImageAnchor ? " mcm-pdf-layer__anchor--image" : ""}`}
            // eslint-disable-next-line react/forbid-dom-props
            style={{
              left: a.left,
              top: a.top,
              width: a.width,
              height: a.height,
            }}
            data-anchor-id={a.elementId}
            data-file-id={a.fileId}
          >
            {/* Label only renders on the legacy panel + on focused
                image anchors. Image anchors at rest are "just an
                image on the canvas" — adding a label would defeat
                the whole point of moving to native rendering. */}
            {(showLegacyPanel || focused) && (
              <div className="mcm-pdf-layer__label">
                <span aria-hidden="true">📄</span>
                <span>
                  {files.find((f) => f.id === a.fileId)?.name ?? "PDF"}
                </span>
                {pageCount > 0 && (
                  <span className="mcm-pdf-layer__label-page">
                    · {a.page}/{pageCount}
                  </span>
                )}
              </div>
            )}
            {/* Frame is OPAQUE for the legacy path, transparent for
                image anchors (so the canvas image shows through).
                Focused image anchors paint the live PDFRenderer on
                top of the canvas image for interactive nav. */}
            <div
              className={`mcm-pdf-layer__frame${
                isImageAnchor ? " mcm-pdf-layer__frame--transparent" : ""
              }`}
            >
              {showLegacyPanel ? (
                useSnapshotLegacy ? (
                  <img
                    className="mcm-pdf-layer__snapshot"
                    src={cachedSnapshot ?? undefined}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <>
                    {files.find((f) => f.id === a.fileId)?.pdfMeta
                      ?.thumbnail && (
                      <img
                        className="mcm-pdf-layer__placeholder"
                        src={
                          files.find((f) => f.id === a.fileId)?.pdfMeta
                            ?.thumbnail ?? undefined
                        }
                        alt=""
                        draggable={false}
                      />
                    )}
                    <PDFRenderer
                      fileId={a.fileId}
                      page={a.page}
                      width={a.width}
                      height={a.height}
                      onReady={(c) => {
                        controlsRef.current.set(a.elementId, c);
                      }}
                      onPageRendered={(rendered) => {
                        const controls = controlsRef.current.get(a.elementId);
                        if (controls) {
                          capturePdfSnapshot(
                            controls,
                            pdfSnapshotKey(a.fileId, rendered),
                          );
                        }
                      }}
                    />
                  </>
                )
              ) : !known ? (
                <div className="mcm-pdf-layer__waiting">
                  Đang chờ file PDF từ peer…
                </div>
              ) : (
                // Image anchor — focused = live renderer on top of the
                // canvas image; idle = hidden snapshotter ONLY when
                // we're missing a cache entry; otherwise nothing
                // (the Excalidraw image element does the displaying).
                (focused || mountHiddenSnapshotter) && (
                  <PDFRenderer
                    fileId={a.fileId}
                    page={a.page}
                    width={a.width}
                    height={a.height}
                    onReady={(c) => {
                      controlsRef.current.set(a.elementId, c);
                    }}
                    onPageRendered={(rendered) => {
                      const captured = controlsRef.current.get(a.elementId);
                      if (!captured) {
                        return;
                      }
                      // Push into the existing snapshot cache (so
                      // sibling anchors can reuse it) AND directly
                      // into Excalidraw's file map keyed by the
                      // anchor's snapshot file id (so the canvas
                      // image element flips to the freshly-rendered
                      // page). Both writes are idempotent.
                      capturePdfAndUpdateFile(
                        captured,
                        a,
                        rendered,
                        excalidrawAPI,
                      );
                    }}
                  />
                )
              )}
            </div>

            {focused && (
              <div className="mcm-pdf-layer__focus-toolbar">
                <button
                  type="button"
                  className="mcm-pdf-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    goToPage(a, -1);
                  }}
                  disabled={a.page <= 1}
                  title="Trang trước"
                >
                  ←
                </button>
                <span className="mcm-pdf-layer__page-indicator">
                  {a.page}
                  {pageCount > 0 ? ` / ${pageCount}` : ""}
                </span>
                <button
                  type="button"
                  className="mcm-pdf-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    goToPage(a, 1);
                  }}
                  disabled={pageCount > 0 && a.page >= pageCount}
                  title="Trang sau"
                >
                  →
                </button>
                <button
                  type="button"
                  className="mcm-pdf-layer__exit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocusedAnchorId(null);
                  }}
                  title="Thoát chế độ chỉnh PDF (ESC)"
                >
                  × Thoát
                </button>
              </div>
            )}
          </div>
        );
      })}

      {contextMenu &&
        (() => {
          const target = anchors.find(
            (a) => a.elementId === contextMenu.elementId,
          );
          if (!target) {
            return null;
          }
          return (
            <div
              className="mcm-pdf-context-menu"
              // eslint-disable-next-line react/forbid-dom-props
              style={{ left: contextMenu.clientX, top: contextMenu.clientY }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="mcm-pdf-context-menu__item"
                onClick={() => {
                  setFocusedAnchorId(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">✏️</span>
                <span>Chỉnh PDF (đổi trang)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-pdf-context-menu__item"
                onClick={() => setContextMenu(null)}
              >
                <span aria-hidden="true">↩️</span>
                <span>Huỷ</span>
              </button>
            </div>
          );
        })()}
    </div>
  );
};

export default PDFCanvasOverlay;
