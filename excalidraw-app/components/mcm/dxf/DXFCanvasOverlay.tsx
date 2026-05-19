// HTML overlay that renders every DXF anchor on the canvas. The
// anchors themselves are invisible rectangle elements with
// `customData.mcmType === "dxf-anchor"` — Excalidraw owns their
// position, size, lock state, and collab sync. We just paint a
// <DXFRenderer /> on top, tracking the rectangle's viewport coords.
//
// Why a rectangle + overlay instead of a custom element type:
//   • Custom element types require forking Excalidraw core.
//   • Rectangle gives us all the collab + edit affordances for free
//     (drag, resize, lock, snap, copy/paste).
//   • DXF content is rendered in our overlay above the canvas with
//     pointer-events: none so click/drag still selects the underlying
//     rectangle (interaction model Option A — passive DXF).

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";

import { DXFRenderer } from "./DXFRenderer";

import type { DXFRendererControls } from "./DXFRenderer";

/** Marker for elements that are DXF placeholders rather than real
 *  shapes. Lives on `element.customData.mcmType`. */
export const DXF_ANCHOR_KIND = "dxf-anchor";

export const isDxfAnchorElement = (
  el: ExcalidrawElement,
): el is ExcalidrawElement & {
  customData: { mcmType: string; dxfFileId: string };
} => {
  return (
    !el.isDeleted &&
    el.type === "rectangle" &&
    !!el.customData &&
    (el.customData as Record<string, unknown>).mcmType === DXF_ANCHOR_KIND &&
    typeof (el.customData as Record<string, unknown>).dxfFileId === "string"
  );
};

type AnchorPosition = {
  /** Excalidraw element id — stable React key + cross-frame identity */
  elementId: string;
  fileId: string;
  /** viewport px from the canvas-wrap top-left */
  left: number;
  top: number;
  width: number;
  height: number;
};

type ContextMenuState = {
  /** anchor elementId the menu targets */
  elementId: string;
  /** viewport px where the menu pops up (= the right-click point) */
  clientX: number;
  clientY: number;
};

export const DXFCanvasOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);
  // anchorsRef mirrors state for synchronous access inside the global
  // dblclick / contextmenu listeners (avoid re-binding on every
  // anchor render).
  const anchorsRef = useRef<AnchorPosition[]>([]);
  anchorsRef.current = anchors;

  // Right-click → small "Edit DXF" menu → enters focus mode for that
  // anchor. While focused, the DXF renderer receives pointer events
  // (pan/zoom inside the drawing) and an exit affordance overlays
  // the top-right corner.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
    null,
  );
  const [focusedAnchorId, setFocusedAnchorId] = useState<string | null>(null);

  // Per-anchor imperative controls (fitToExtent, layer toggles, etc.)
  // returned by the DXFRenderer's onReady callback. Keyed by elementId
  // so the context menu / focus toolbar can drive the right renderer.
  const controlsRef = useRef<Map<string, DXFRendererControls>>(new Map());

  const refitAnchor = (elementId: string) => {
    controlsRef.current.get(elementId)?.fitToExtent(0.05);
  };

  // Quickly look up whether an anchor's file is actually in the library
  // — peers might race the anchor element broadcast vs the file
  // broadcast; show a "loading" state until the file arrives.
  const knownFileIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      s.add(f.id);
    }
    return s;
  }, [files]);

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
        if (!isDxfAnchorElement(el)) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        next.push({
          elementId: el.id,
          fileId: el.customData.dxfFileId,
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
        });
      }
      setAnchors((prev) => {
        if (prev.length === next.length) {
          const same = prev.every(
            (p, i) =>
              p.elementId === next[i].elementId &&
              p.fileId === next[i].fileId &&
              p.left === next[i].left &&
              p.top === next[i].top &&
              p.width === next[i].width &&
              p.height === next[i].height,
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

  // Block Excalidraw's default double-click-to-edit-text on the
  // rectangle anchor — typing a text label inside the DXF frame is
  // never what the user wants. Capture-phase listener runs BEFORE
  // Excalidraw's React handlers; if the dblclick lands over an
  // anchor (anywhere inside our overlay frame), we swallow it.
  //
  // We compute hit-testing in canvas-wrap-local coordinates because
  // anchor positions are already stored that way. e.clientX/Y are
  // viewport coords → subtract canvas-wrap's bounding rect.
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

  // Right-click on a DXF anchor → show "Edit DXF" context menu.
  // Capture phase so Excalidraw's own right-click handler doesn't
  // also fire (Excalidraw shows its own element context menu, which
  // would compete with ours).
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

  // Dismiss context menu on outside click / ESC; also exit focus
  // mode on ESC.
  useEffect(() => {
    if (!contextMenu && !focusedAnchorId) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest(".mcm-dxf-context-menu")) {
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
    <div className="mcm-dxf-layer">
      {anchors.map((a) => {
        const known = knownFileIds.has(a.fileId);
        const focused = focusedAnchorId === a.elementId;
        return (
          <div
            key={a.elementId}
            className={`mcm-dxf-layer__anchor${
              focused ? " mcm-dxf-layer__anchor--focused" : ""
            }`}
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
            {/* Label sits OUTSIDE the renderer (top-left, above the
                  frame) so it never obscures the DXF content. */}
            <div className="mcm-dxf-layer__label">
              <span aria-hidden="true">📐</span>
              <span>
                {files.find((f) => f.id === a.fileId)?.name ?? "DXF"}
              </span>
            </div>
            {/* The renderer itself sits inside a clipping frame so
                  the DXF can never paint outside the anchor's bounds. */}
            <div className="mcm-dxf-layer__frame">
              {known ? (
                <DXFRenderer
                  fileId={a.fileId}
                  width={a.width}
                  height={a.height}
                  instanceId={`inline-${a.elementId}`}
                  interactive={focused}
                  onReady={(controls) => {
                    controlsRef.current.set(a.elementId, controls);
                  }}
                />
              ) : (
                <div className="mcm-dxf-layer__waiting">
                  Đang chờ file DXF từ peer…
                </div>
              )}
            </div>
            {focused && (
              <div className="mcm-dxf-layer__focus-toolbar">
                <button
                  type="button"
                  className="mcm-dxf-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    refitAnchor(a.elementId);
                  }}
                  title="Reset view — fit DXF lại vào khung"
                >
                  ↻ Fit
                </button>
                <button
                  type="button"
                  className="mcm-dxf-layer__exit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocusedAnchorId(null);
                  }}
                  title="Thoát chế độ chỉnh DXF (ESC)"
                >
                  × Thoát
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Context menu — pops up at the right-click position with
            an Edit action that flips this anchor into focus mode. */}
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
              className="mcm-dxf-context-menu"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: contextMenu.clientX,
                top: contextMenu.clientY,
              }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="mcm-dxf-context-menu__item"
                onClick={() => {
                  setFocusedAnchorId(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">✏️</span>
                <span>Chỉnh DXF (pan / zoom)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-dxf-context-menu__item"
                onClick={() => {
                  refitAnchor(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">↻</span>
                <span>Reset fit (về full view)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-dxf-context-menu__item"
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

export default DXFCanvasOverlay;
