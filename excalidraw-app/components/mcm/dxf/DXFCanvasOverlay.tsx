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
import { newElementWith } from "@excalidraw/element";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";
import { useT } from "../../../i18n/mcm";

import { DXFRenderer } from "./DXFRenderer";
import {
  dxfSnapshotKey,
  dxfSnapshotVersionAtom,
  getDxfSnapshot,
  setDxfSnapshot,
} from "./dxfSnapshotCache";

import type { DXFRendererControls, DXFViewState } from "./DXFRenderer";

/** A stable string fingerprint for a persisted view — used as the
 *  third component of the snapshot cache key. We round to 2 decimals
 *  so subpixel drift in the camera math doesn't produce a different
 *  key for what is visually the same view. */
const viewKeyOf = (view: DXFViewState | null): string => {
  if (!view) {
    return "fit";
  }
  return `${view.cx.toFixed(2)}:${view.cy.toFixed(2)}:${view.w.toFixed(2)}`;
};

/** Parse the `dxfView` field on an anchor's customData into a typed
 *  view state, defensively rejecting partial payloads from older
 *  versions or malformed peer broadcasts. */
const viewFor = (el: ExcalidrawElement): DXFViewState | null => {
  const raw = (el.customData as Record<string, unknown> | undefined)
    ?.dxfView as { cx?: unknown; cy?: unknown; w?: unknown } | undefined;
  if (
    !raw ||
    typeof raw.cx !== "number" ||
    typeof raw.cy !== "number" ||
    typeof raw.w !== "number"
  ) {
    return null;
  }
  return { cx: raw.cx, cy: raw.cy, w: raw.w };
};

type LayerInfo = { name: string; displayName: string; color: number };

/** Marker for elements that are DXF placeholders rather than real
 *  shapes. Lives on `element.customData.mcmType`. */
export const DXF_ANCHOR_KIND = "dxf-anchor";

export const isDxfAnchorElement = (
  el: ExcalidrawElement,
): el is ExcalidrawElement & {
  customData: {
    mcmType: string;
    dxfFileId: string;
    /** Layer names the user has toggled OFF on this specific anchor.
     *  Persists with the element + syncs through collab so peers see
     *  the same layer filter. Absent / empty = all layers visible. */
    dxfHiddenLayers?: string[];
    /** User's last pan/zoom inside this anchor. Persists across focus
     *  exit, page reload, and peer sync — so the anchor displays the
     *  saved view (instead of resetting to fit-to-extent) once focus
     *  ends. Absent = use default fit. */
    dxfView?: { cx: number; cy: number; w: number };
  };
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
  /** Snapshot of customData.dxfHiddenLayers — used to drive both the
   *  layer-panel checkboxes and the diff-and-apply effect. Joined to a
   *  stable string in `hiddenLayersKey` so React useEffect can detect
   *  changes by value rather than array identity. */
  hiddenLayers: string[];
  hiddenLayersKey: string;
  /** Persisted pan/zoom from customData.dxfView (null = default fit).
   *  The viewKey is the snapshot-cache fingerprint derived from view —
   *  "fit" or "cx:cy:w" — so anchors with the same view share a PNG. */
  view: DXFViewState | null;
  viewKey: string;
};

type ContextMenuState = {
  /** anchor elementId the menu targets */
  elementId: string;
  /** viewport px where the menu pops up (= the right-click point) */
  clientX: number;
  clientY: number;
};

/** Convert a Blob to a data URL — used to persist DXF snapshots in
 *  the in-memory cache as strings (cheaper to dedupe than blobs). */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });

/** Snapshot the current viewport of a DXFRenderer's controls into the
 *  shared cache, keyed by (fileId, hiddenLayersKey). We rAF first so
 *  any pending dxf-viewer render (e.g. after a setLayerVisible call)
 *  has committed to the canvas before we read it back. Failures are
 *  swallowed — a missing snapshot just means anchors keep using the
 *  live renderer until next time we try. */
const captureDxfSnapshot = (
  controls: DXFRendererControls,
  cacheKey: string,
): void => {
  requestAnimationFrame(() => {
    void controls
      .exportPng()
      .then((blob) => (blob ? blobToDataUrl(blob) : null))
      .then((dataUrl) => {
        if (dataUrl) {
          setDxfSnapshot(cacheKey, dataUrl);
        }
      })
      .catch((err) => {
        console.warn("[DXFCanvasOverlay] snapshot capture failed", err);
      });
  });
};

export const DXFCanvasOverlay = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  // Subscribe to snapshot cache version so freshly-baked snapshots
  // trigger a re-render — anchors waiting on a cache miss flip from
  // live renderer to <img> the moment the cache is populated.
  useAtomValue(dxfSnapshotVersionAtom);
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusedAnchorId, setFocusedAnchorId] = useState<string | null>(null);

  // Per-anchor imperative controls (fitToExtent, layer toggles, etc.)
  // returned by the DXFRenderer's onReady callback. Keyed by elementId
  // so the context menu / focus toolbar can drive the right renderer.
  const controlsRef = useRef<Map<string, DXFRendererControls>>(new Map());

  // Layers exposed by the renderer (keyed by anchor elementId) plus
  // the open/closed state of the layer panel. Layers come from the
  // renderer once it has parsed the DXF; the panel can only render
  // checkboxes once they're available.
  const [layersByElement, setLayersByElement] = useState<
    Map<string, LayerInfo[]>
  >(new Map());
  const [layerPanelFor, setLayerPanelFor] = useState<string | null>(null);

  // Last applied hidden-layer key per anchor — drives diff-and-apply
  // so we only call setLayerVisible when the user (locally or via a
  // peer broadcast) actually changes the set, not on every recompute.
  const appliedLayersRef = useRef<Map<string, string>>(new Map());

  const refitAnchor = (elementId: string) => {
    controlsRef.current.get(elementId)?.fitToExtent(0.05);
  };

  /** Persist `nextHidden` (a Set of layer names) to the anchor element's
   *  customData via updateScene. Excalidraw's onChange listener then
   *  broadcasts the change to peers, so layer filters stay in sync. */
  const persistHiddenLayers = (elementId: string, nextHidden: Set<string>) => {
    if (!excalidrawAPI) {
      return;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const arr = Array.from(nextHidden).sort();
    const next = all.map((el) => {
      if (el.id !== elementId || !isDxfAnchorElement(el)) {
        return el;
      }
      return newElementWith(el, {
        customData: { ...el.customData, dxfHiddenLayers: arr },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  };

  const toggleLayer = (anchor: AnchorPosition, layerName: string) => {
    const nextHidden = new Set(anchor.hiddenLayers);
    if (nextHidden.has(layerName)) {
      nextHidden.delete(layerName);
    } else {
      nextHidden.add(layerName);
    }
    persistHiddenLayers(anchor.elementId, nextHidden);
  };

  const setAllAnchorLayersVisible = (
    anchor: AnchorPosition,
    visible: boolean,
  ) => {
    const layers = layersByElement.get(anchor.elementId) ?? [];
    const nextHidden = new Set<string>(
      visible ? [] : layers.map((l) => l.name),
    );
    persistHiddenLayers(anchor.elementId, nextHidden);
  };

  /** Write a view back onto the anchor's customData.dxfView. Used at
   *  focus-exit (and at peer-broadcast equivalents in the future) so
   *  the user's last pan/zoom survives the swap from live renderer
   *  back to cached <img>. */
  const persistAnchorView = (elementId: string, view: DXFViewState) => {
    if (!excalidrawAPI) {
      return;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      if (el.id !== elementId || !isDxfAnchorElement(el)) {
        return el;
      }
      return newElementWith(el, {
        customData: {
          ...el.customData,
          dxfView: { cx: view.cx, cy: view.cy, w: view.w },
        },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  };

  /** Snapshot the current live view + persist it to customData. Run
   *  on focus exit so the anchor's <img> fallback shows the user's
   *  last pan/zoom instead of resetting to fit-to-extent.
   *
   *  Snapshot capture happens BEFORE the persist call so the live
   *  renderer is guaranteed to still be mounted when exportPng runs
   *  (persisting customData triggers a re-render that may unmount
   *  the renderer the moment a cache hit becomes available). */
  const captureAndPersistView = async (anchor: AnchorPosition) => {
    const controls = controlsRef.current.get(anchor.elementId);
    if (!controls) {
      return;
    }
    const view = controls.getView();
    if (!view) {
      return;
    }
    // Skip writes when the view hasn't meaningfully moved — avoids
    // gratuitous customData churn (which would broadcast to peers).
    const newKey = viewKeyOf(view);
    if (newKey === anchor.viewKey) {
      return;
    }
    try {
      const blob = await controls.exportPng();
      if (blob) {
        const dataUrl = await blobToDataUrl(blob);
        setDxfSnapshot(
          dxfSnapshotKey(anchor.fileId, anchor.hiddenLayersKey, newKey),
          dataUrl,
        );
      }
    } catch (err) {
      console.warn("[DXFCanvasOverlay] view snapshot failed", err);
    }
    persistAnchorView(anchor.elementId, view);
  };

  // exitFocus must be reachable from handlers that close over a fresh
  // copy of the latest state (anchors, controlsRef, focusedAnchorId).
  // We mirror it onto a ref so the synchronous handlers can `void` it
  // without React having to re-bind every listener on every render.
  const exitFocusRef = useRef<((newId: string | null) => Promise<void>) | null>(
    null,
  );
  exitFocusRef.current = async (newId) => {
    const oldId = focusedAnchorId;
    if (oldId && oldId !== newId) {
      const anchor = anchors.find((a) => a.elementId === oldId);
      if (anchor) {
        // Await the capture so the renderer stays mounted long enough
        // for exportPng's canvas.toBlob to read the live framebuffer.
        // Setting focus before this resolves would trigger an unmount
        // (cache hit on the new viewKey) and the snapshot would come
        // back empty.
        await captureAndPersistView(anchor);
      }
    }
    setFocusedAnchorId(newId);
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
        // Stable, alphabetised join — different in-memory orderings of
        // the same layer set still produce identical keys, so the
        // diff-and-apply effect doesn't fire spuriously.
        const hiddenLayers = Array.isArray(el.customData.dxfHiddenLayers)
          ? [...el.customData.dxfHiddenLayers].sort()
          : [];
        next.push({
          elementId: el.id,
          fileId: el.customData.dxfFileId,
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
          hiddenLayers,
          hiddenLayersKey: hiddenLayers.join(""),
          view: viewFor(el),
          viewKey: viewKeyOf(viewFor(el)),
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
              p.height === next[i].height &&
              p.hiddenLayersKey === next[i].hiddenLayersKey &&
              p.viewKey === next[i].viewKey,
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
        // Route through exitFocusRef so the user's pan/zoom is
        // captured + persisted before the renderer unmounts.
        void exitFocusRef.current?.(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, focusedAnchorId]);

  // When an anchor's hiddenLayers set changes (locally toggled OR
  // received from a peer via updateScene), diff against the last
  // applied set for that anchor and call setLayerVisible on the
  // controls captured in onReady. We diff because dxf-viewer's
  // ShowLayer is an imperative call per name — easiest path to
  // converge from any prior state to the new desired one.
  useEffect(() => {
    for (const anchor of anchors) {
      const controls = controlsRef.current.get(anchor.elementId);
      if (!controls) {
        continue;
      }
      const prevKey = appliedLayersRef.current.get(anchor.elementId);
      if (prevKey === anchor.hiddenLayersKey) {
        continue;
      }
      const layers = layersByElement.get(anchor.elementId);
      if (!layers) {
        continue;
      }
      const nextHidden = new Set(anchor.hiddenLayers);
      for (const layer of layers) {
        controls.setLayerVisible(layer.name, !nextHidden.has(layer.name));
      }
      appliedLayersRef.current.set(anchor.elementId, anchor.hiddenLayersKey);
      // Layers just changed → invalidate any old snapshot for the
      // anchor's NEW key by writing a fresh one. We rAF inside
      // captureDxfSnapshot so dxf-viewer's ShowLayer render commits
      // before we read the canvas.
      captureDxfSnapshot(
        controls,
        dxfSnapshotKey(anchor.fileId, anchor.hiddenLayersKey, anchor.viewKey),
      );
    }
  }, [anchors, layersByElement]);

  // Close the layer panel when the user exits focus mode (clicking
  // away or hitting ESC). Without this, the panel would linger as a
  // floating popover detached from any focus affordance.
  useEffect(() => {
    if (!focusedAnchorId && layerPanelFor) {
      setLayerPanelFor(null);
    }
  }, [focusedAnchorId, layerPanelFor]);

  if (anchors.length === 0) {
    return null;
  }

  return (
    <div className="mcm-dxf-layer">
      {anchors.map((a) => {
        const known = knownFileIds.has(a.fileId);
        const focused = focusedAnchorId === a.elementId;
        // Snapshot fast-path: passive anchors (not focused) reuse a
        // cached PNG keyed by (fileId, hiddenLayersKey) so multiple
        // copies of the same DXF on the canvas only consume ONE
        // WebGL slot during their initial render — afterwards they
        // become plain <img> tags. Different layer filters resolve
        // to different cache keys, so per-anchor layer control still
        // works. Focused anchors always mount the live renderer so
        // pan/zoom + interactive layer toggle remain responsive.
        const cacheKey = dxfSnapshotKey(a.fileId, a.hiddenLayersKey, a.viewKey);
        const cachedSnapshot = getDxfSnapshot(cacheKey);
        const useSnapshot = !focused && cachedSnapshot !== null;
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
              <span className="mcm-dxf-layer__label-type">DXF</span>
              <span className="mcm-dxf-layer__label-name">
                {files.find((f) => f.id === a.fileId)?.name ?? "DXF"}
              </span>
            </div>
            {/* The renderer itself sits inside a clipping frame so
                  the DXF can never paint outside the anchor's bounds. */}
            <div className="mcm-dxf-layer__frame">
              {known ? (
                useSnapshot ? (
                  // Cache-hit fast path: just show the baked PNG. No
                  // WebGL context, no parse cost. `object-fit: contain`
                  // matches what dxf-viewer's FitView produces, so the
                  // snapshot scales identically across anchor sizes.
                  <img
                    className="mcm-dxf-layer__snapshot"
                    src={cachedSnapshot ?? undefined}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <DXFRenderer
                    fileId={a.fileId}
                    width={a.width}
                    height={a.height}
                    instanceId={`inline-${a.elementId}`}
                    interactive={focused}
                    onReady={(controls) => {
                      controlsRef.current.set(a.elementId, controls);
                      // Capture the parsed layer list for the panel UI.
                      try {
                        const layers = controls.getLayers();
                        setLayersByElement((prev) => {
                          const next = new Map(prev);
                          next.set(a.elementId, layers);
                          return next;
                        });
                        // Apply the persisted hidden-layer filter right
                        // away so the DXF appears with the user's last
                        // saved set (or what a peer toggled while we were
                        // away). Reset the applied-key so the diff effect
                        // recognises this as a fresh apply target.
                        if (a.hiddenLayers.length > 0) {
                          const hidden = new Set(a.hiddenLayers);
                          for (const layer of layers) {
                            controls.setLayerVisible(
                              layer.name,
                              !hidden.has(layer.name),
                            );
                          }
                        }
                        appliedLayersRef.current.set(
                          a.elementId,
                          a.hiddenLayersKey,
                        );
                      } catch (err) {
                        console.warn(
                          "[DXFCanvasOverlay] getLayers failed",
                          err,
                        );
                      }
                      // Restore the user's saved pan/zoom so the
                      // renderer mounts at the same view the user left
                      // it at — across focus → exit cycles and across
                      // reloads. Without this the renderer would sit
                      // at the default fit-to-extent view that dxf-
                      // viewer applies during Load.
                      if (a.view) {
                        try {
                          controls.setView(a.view);
                        } catch (err) {
                          console.warn(
                            "[DXFCanvasOverlay] setView failed",
                            err,
                          );
                        }
                      }
                      // Bake a PNG of the freshly-loaded DXF into the
                      // shared cache so any other anchor with the same
                      // (fileId, hiddenLayersKey, viewKey) can switch
                      // to <img> mode and free this WebGL slot.
                      captureDxfSnapshot(controls, cacheKey);
                    }}
                  />
                )
              ) : (
                <div className="mcm-dxf-layer__waiting">
                  {t("cad.status.waitingPeer")}
                </div>
              )}
            </div>
            {focused && (
              <div className="mcm-dxf-layer__focus-toolbar">
                <button
                  type="button"
                  className={`mcm-dxf-layer__tool${
                    layerPanelFor === a.elementId
                      ? " mcm-dxf-layer__tool--active"
                      : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLayerPanelFor((prev) =>
                      prev === a.elementId ? null : a.elementId,
                    );
                  }}
                  disabled={
                    (layersByElement.get(a.elementId)?.length ?? 0) === 0
                  }
                  title={
                    (layersByElement.get(a.elementId)?.length ?? 0) === 0
                      ? t("cad.layers.loadingTitle")
                      : t("cad.layers.countTitle", {
                          count: layersByElement.get(a.elementId)?.length ?? 0,
                        })
                  }
                >
                  📋 {t("cad.layers.button")}
                </button>
                <button
                  type="button"
                  className="mcm-dxf-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    refitAnchor(a.elementId);
                  }}
                  title={t("cad.toolbar.fitInlineTitle")}
                >
                  ↻ {t("cad.toolbar.fit")}
                </button>
                <button
                  type="button"
                  className="mcm-dxf-layer__exit"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exitFocusRef.current?.(null);
                  }}
                  title={t("cad.toolbar.exitTitle")}
                >
                  × {t("cad.toolbar.exit")}
                </button>
              </div>
            )}
            {focused &&
              layerPanelFor === a.elementId &&
              (layersByElement.get(a.elementId)?.length ?? 0) > 0 && (
                <div
                  className="mcm-dxf-layer__layer-panel"
                  role="dialog"
                  aria-label={t("cad.layers.panelAria")}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mcm-dxf-layer__layer-panel-header">
                    <span className="mcm-dxf-layer__layer-panel-title">
                      {t("cad.layers.title", {
                        count: layersByElement.get(a.elementId)?.length ?? 0,
                      })}
                    </span>
                    <div className="mcm-dxf-layer__layer-panel-actions">
                      <button
                        type="button"
                        className="mcm-dxf-layer__layer-panel-action"
                        onClick={() => setAllAnchorLayersVisible(a, true)}
                        title={t("cad.layers.allOnTitle")}
                      >
                        {t("cad.layers.allOn")}
                      </button>
                      <button
                        type="button"
                        className="mcm-dxf-layer__layer-panel-action"
                        onClick={() => setAllAnchorLayersVisible(a, false)}
                        title={t("cad.layers.allOffTitle")}
                      >
                        {t("cad.layers.allOff")}
                      </button>
                    </div>
                  </div>
                  <div className="mcm-dxf-layer__layer-list">
                    {(layersByElement.get(a.elementId) ?? []).map((layer) => {
                      const visible = !a.hiddenLayers.includes(layer.name);
                      // DXF colours come as 0xRRGGBB integers — convert
                      // to a CSS hex string for the swatch.
                      const colorHex = `#${layer.color
                        .toString(16)
                        .padStart(6, "0")}`;
                      return (
                        <label
                          key={layer.name}
                          className={`mcm-dxf-layer__layer-row${
                            visible ? "" : " mcm-dxf-layer__layer-row--hidden"
                          }`}
                          title={layer.name}
                        >
                          <input
                            type="checkbox"
                            checked={visible}
                            onChange={() => toggleLayer(a, layer.name)}
                          />
                          <span
                            className="mcm-dxf-layer__layer-swatch"
                            // swatch colour is data-driven from the DXF
                            // layer colour, so the inline style is the
                            // only practical option.
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{ background: colorHex }}
                            aria-hidden
                          />
                          <span className="mcm-dxf-layer__layer-name">
                            {layer.displayName || layer.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
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
                  // Route through exitFocusRef so any previously-
                  // focused anchor captures its view before we move
                  // focus to a different anchor.
                  void exitFocusRef.current?.(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">✏️</span>
                <span>{t("cad.menu.editDxf")}</span>
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
                <span>{t("cad.menu.resetFit")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-dxf-context-menu__item"
                onClick={() => setContextMenu(null)}
              >
                <span aria-hidden="true">↩️</span>
                <span>{t("cad.menu.cancel")}</span>
              </button>
            </div>
          );
        })()}
    </div>
  );
};

export default DXFCanvasOverlay;
