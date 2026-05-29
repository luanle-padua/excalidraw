// HTML overlay that drives every IFC (3D BIM) anchor on the canvas.
// Mirrors DXFCanvasOverlay: each anchor is an invisible Excalidraw
// RECTANGLE element with `customData.mcmType === "ifc-anchor"` —
// Excalidraw owns its position / size / lock / collab-sync. We paint
// the 3D viewer (or a cached snapshot) on top with pointer-events: none
// so click/drag still selects the underlying rectangle.
//
// PASSIVE anchors show a cached snapshot PNG (keyed by fileId + viewKey
// in the shared ifcSnapshotCache) via an <img>, or a placeholder card
// when no snapshot has been baked yet. 3D is HEAVY (the renderer slot
// cap is 2), so passive anchors NEVER mount a live renderer — only the
// FOCUSED anchor mounts a live <IFCRenderer interactive/>. On focus
// exit it bakes the live view (exportPng → ifcSnapshotCache) and
// persists the camera view back to customData so the snapshot survives
// the swap from live renderer back to <img>.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom, isIfcModelFile } from "../../../data/meetingLibrary";
import { openFileInIfcView } from "../../../data/ifcViewState";

import { IFCRenderer } from "./IFCRenderer";
import { isIfcAnchorElement } from "./ifcAnchor";
import {
  ifcSnapshotKey,
  ifcSnapshotVersionAtom,
  getIfcSnapshot,
  setIfcSnapshot,
} from "./ifcSnapshotCache";

import "./ifc-overlay.scss";

import type { IFCRendererControls, IFCViewState } from "./IFCRenderer";
import type { IfcElementMeta, IfcStorey } from "./ifcTypes";

/** A stable string fingerprint for a persisted view — used as the
 *  second component of the snapshot cache key. We round each coordinate
 *  so subpixel drift in the camera math doesn't produce a different key
 *  for what is visually the same view. "fit" for the default view so
 *  multiple copies of the same model share one snapshot. */
const viewKeyOf = (view: IFCViewState | null): string => {
  if (!view) {
    return "fit";
  }
  const r = (n: number) => n.toFixed(2);
  return `${view.pos.map(r).join(",")}|${view.target.map(r).join(",")}`;
};

/** Parse the `ifcView` field on an anchor's customData into a typed view
 *  state, defensively rejecting partial payloads from older versions or
 *  malformed peer broadcasts. */
const viewFor = (el: ExcalidrawElement): IFCViewState | null => {
  const raw = (el.customData as Record<string, unknown> | undefined)
    ?.ifcView as { pos?: unknown; target?: unknown } | undefined;
  const isVec3 = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
  if (!raw || !isVec3(raw.pos) || !isVec3(raw.target)) {
    return null;
  }
  return { pos: raw.pos, target: raw.target };
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
  /** Persisted camera view from customData.ifcView (null = default fit).
   *  The viewKey is the snapshot-cache fingerprint derived from view —
   *  "fit" or a serialised camera string — so anchors with the same
   *  view share a cached PNG. */
  view: IFCViewState | null;
  viewKey: string;
};

type ContextMenuState = {
  /** anchor elementId the menu targets */
  elementId: string;
  /** viewport px where the menu pops up (= the right-click point) */
  clientX: number;
  clientY: number;
};

/** Convert a Blob to a data URL — used to persist IFC snapshots in the
 *  shared in-memory cache as strings. */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });

/** Section axis labels for the focus-toolbar button + popover. */
const SECTION_LABEL: Record<"x" | "y" | "z", string> = {
  x: "X",
  y: "Y",
  z: "Z",
};

/** Render styles offered by the engine, with their Vietnamese labels.
 *  Order = the segmented-control order in the view-style popover. */
type ViewStyle = "shaded" | "clay" | "wireframe";
const VIEW_STYLES: Array<{ id: ViewStyle; label: string; title: string }> = [
  {
    id: "shaded",
    label: "Tô bóng",
    title: "Tô bóng — hiển thị màu gốc của từng cấu kiện",
  },
  {
    id: "clay",
    label: "Đất sét",
    title: "Đất sét — phủ một màu xám đồng nhất",
  },
  {
    id: "wireframe",
    label: "Khung dây",
    title: "Khung dây — chỉ hiển thị đường nét cạnh",
  },
];

export const IFCCanvasOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  // Subscribe to the snapshot cache version so freshly-baked snapshots
  // trigger a re-render — passive anchors waiting on a cache miss flip
  // from the placeholder card to <img> the moment the cache populates.
  useAtomValue(ifcSnapshotVersionAtom);

  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);
  // anchorsRef mirrors state for synchronous access inside the global
  // dblclick / contextmenu listeners (avoid re-binding per render).
  const anchorsRef = useRef<AnchorPosition[]>([]);
  anchorsRef.current = anchors;

  // Right-click → small context menu → enters focus mode for that
  // anchor. While focused, the live IFCRenderer receives pointer events
  // (orbit / zoom / pick) and a focus toolbar overlays the corner.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusedAnchorId, setFocusedAnchorId] = useState<string | null>(null);

  // Per-anchor imperative controls returned by the renderer's onReady.
  // Only the focused anchor ever has one (we only mount one live
  // renderer at a time). Keyed by elementId.
  const controlsRef = useRef<Map<string, IFCRendererControls>>(new Map());

  // Ref-callback that wires the renderer's `mcm-ifc-measure` CustomEvent
  // (which bubbles up to the frame) to the distance readout. React's
  // synthetic event system doesn't see custom DOM events, so we attach a
  // native listener to the focused frame element and tear it down when
  // the node is detached / focus changes.
  const measureCleanupRef = useRef<(() => void) | null>(null);
  const measureFrameRef = (node: HTMLDivElement | null) => {
    measureCleanupRef.current?.();
    measureCleanupRef.current = null;
    if (!node) {
      return;
    }
    const onMeasure = (e: Event) => {
      const detail = (e as CustomEvent<{ distance: number }>).detail;
      if (detail && typeof detail.distance === "number") {
        setMeasureDist(detail.distance);
      }
    };
    node.addEventListener("mcm-ifc-measure", onMeasure as EventListener);
    measureCleanupRef.current = () =>
      node.removeEventListener("mcm-ifc-measure", onMeasure as EventListener);
  };

  // Focus-mode transient UI state (all scoped to the focused anchor):
  const [storeyPanelOpen, setStoreyPanelOpen] = useState(false);
  const [storeys, setStoreys] = useState<IfcStorey[]>([]);
  const [isolatedStoreyId, setIsolatedStoreyId] = useState<string | null>(null);
  const [sectionAxis, setSectionAxis] = useState<"x" | "y" | "z" | null>(null);
  const [sectionPanelOpen, setSectionPanelOpen] = useState(false);
  const [measureOn, setMeasureOn] = useState(false);
  const [measureDist, setMeasureDist] = useState<number | null>(null);
  const [ghostOn, setGhostOn] = useState(false);
  const [viewStyle, setViewStyle] = useState<ViewStyle>("shaded");
  const [viewStylePanelOpen, setViewStylePanelOpen] = useState(false);
  const [selected, setSelected] = useState<IfcElementMeta | null>(null);

  const fileById = useMemo(() => {
    const m = new Map<string, (typeof files)[number]>();
    for (const f of files) {
      m.set(f.id, f);
    }
    return m;
  }, [files]);

  // Quick lookup whether an anchor's file is an IFC model in the library
  // — peers might race the anchor element broadcast vs the file
  // broadcast; show a "waiting" state until the file arrives.
  const knownIfcFileIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (isIfcModelFile(f)) {
        s.add(f.id);
      }
    }
    return s;
  }, [files]);

  /** Write a camera view back onto the anchor's customData.ifcView via
   *  updateScene — Excalidraw's onChange listener then broadcasts it to
   *  peers and it round-trips across reload. Used on focus exit so the
   *  anchor's <img> fallback shows the user's last orbit instead of
   *  resetting to fit-to-model. */
  const persistAnchorView = (elementId: string, view: IFCViewState) => {
    if (!excalidrawAPI) {
      return;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      if (el.id !== elementId || !isIfcAnchorElement(el)) {
        return el;
      }
      return newElementWith(el, {
        customData: {
          ...el.customData,
          ifcView: { pos: view.pos, target: view.target },
        },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  };

  /** Bake the live 3D view into the shared snapshot cache + persist the
   *  camera view to customData. Run on focus exit so the passive anchor
   *  swaps from the live renderer back to a cached <img> showing the
   *  user's last orbit.
   *
   *  Ordering mirrors DXFCanvasOverlay: exportPng is captured BEFORE the
   *  persist call so the live renderer is guaranteed to still be mounted
   *  when exportPng's toBlob reads the framebuffer (persisting customData
   *  triggers a re-render that drops focus → the live renderer unmounts,
   *  and a later exportPng would read a blank framebuffer). We key the
   *  cache by the NEW view so the snapshot matches what the passive
   *  anchor will look up after the swap. */
  const captureAndPersistView = async (anchor: AnchorPosition) => {
    const controls = controlsRef.current.get(anchor.elementId);
    if (!controls) {
      return;
    }
    const view = controls.getView();
    const newKey = viewKeyOf(view);
    try {
      const blob = await controls.exportPng();
      if (blob) {
        const dataUrl = await blobToDataUrl(blob);
        setIfcSnapshot(ifcSnapshotKey(anchor.fileId, newKey), dataUrl);
      }
    } catch (err) {
      console.warn("[IFCCanvasOverlay] view snapshot failed", err);
    }
    if (view) {
      persistAnchorView(anchor.elementId, view);
    }
  };

  // exitFocus must be reachable from synchronous handlers that close
  // over fresh state. Mirror it onto a ref so handlers can `void` it
  // without React re-binding every listener each render.
  const exitFocusRef = useRef<((newId: string | null) => Promise<void>) | null>(
    null,
  );
  exitFocusRef.current = async (newId) => {
    const oldId = focusedAnchorId;
    if (oldId && oldId !== newId) {
      const anchor = anchors.find((a) => a.elementId === oldId);
      if (anchor) {
        // Await capture so the renderer stays mounted long enough for
        // exportPng's toBlob to read the live framebuffer — setting
        // focus first would unmount it and the snapshot would be blank.
        await captureAndPersistView(anchor);
      }
      controlsRef.current.delete(oldId);
    }
    setFocusedAnchorId(newId);
    // Reset transient focus UI for the (new or absent) focus target.
    setStoreyPanelOpen(false);
    setStoreys([]);
    setIsolatedStoreyId(null);
    setSectionAxis(null);
    setSectionPanelOpen(false);
    setMeasureOn(false);
    setMeasureDist(null);
    setGhostOn(false);
    setViewStyle("shaded");
    setViewStylePanelOpen(false);
    setSelected(null);
  };

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
        if (!isIfcAnchorElement(el)) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        const view = viewFor(el);
        next.push({
          elementId: el.id,
          fileId: el.customData.ifcFileId,
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
          view,
          viewKey: viewKeyOf(view),
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
  // rectangle anchor — typing a text label inside the 3D frame is never
  // what the user wants. Capture-phase listener runs BEFORE Excalidraw's
  // React handlers; if the dblclick lands over an anchor we swallow it.
  // Hit-testing is in canvas-wrap-local coords (anchor positions are
  // stored that way; e.clientX/Y are viewport → subtract the wrap rect).
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

  // Right-click on an IFC anchor → show our context menu. Capture phase
  // so Excalidraw's own right-click handler doesn't also fire.
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

  // Dismiss context menu on outside click / ESC; also exit focus on ESC.
  useEffect(() => {
    if (!contextMenu && !focusedAnchorId) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest(".mcm-ifc-context-menu")) {
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
      }
      // Outside-click (not on our overlay UI) exits focus mode too.
      if (focusedAnchorId && !(t && t.closest(".mcm-ifc-layer__anchor"))) {
        void exitFocusRef.current?.(null);
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
        // Route through exitFocusRef so the user's orbit is captured +
        // persisted before the renderer unmounts.
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

  if (anchors.length === 0) {
    return null;
  }

  return (
    <div className="mcm-ifc-layer">
      {anchors.map((a) => {
        const file = fileById.get(a.fileId);
        const known = knownIfcFileIds.has(a.fileId);
        const focused = focusedAnchorId === a.elementId;

        // PASSIVE anchors (not focused) NEVER mount a live renderer — 3D
        // is heavy and the renderer slot cap is 2. They show a cached
        // snapshot PNG (keyed by fileId + viewKey) via <img> when one has
        // been baked, else a lightweight placeholder card. Only the
        // FOCUSED anchor mounts the live interactive <IFCRenderer>.
        if (!focused) {
          const snapshot = getIfcSnapshot(ifcSnapshotKey(a.fileId, a.viewKey));
          return (
            <div
              key={a.elementId}
              className="mcm-ifc-layer__anchor"
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
              <div className="mcm-ifc-layer__label">
                <span aria-hidden="true">🧊</span>
                <span>{file?.name ?? "IFC"}</span>
              </div>
              <div className="mcm-ifc-layer__frame">
                {!known ? (
                  <div className="mcm-ifc-layer__waiting">
                    Đang chờ file IFC từ peer…
                  </div>
                ) : snapshot ? (
                  // Cache-hit fast path: just show the baked PNG. No
                  // WebGL context, no parse cost. `object-fit: contain`
                  // mirrors the letterboxed framing exportPng produces.
                  <img
                    className="mcm-ifc-layer__snapshot"
                    src={snapshot}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  // No baked snapshot yet — show a placeholder card with
                  // the file name, element count, and a hint to enter
                  // edit mode (which bakes a snapshot on exit).
                  <div className="mcm-ifc-layer__placeholder">
                    <span
                      className="mcm-ifc-layer__placeholder-glyph"
                      aria-hidden="true"
                    >
                      🧊
                    </span>
                    <span className="mcm-ifc-layer__placeholder-name">
                      {file?.name ?? "IFC"}
                    </span>
                    {file?.ifcMeta && (
                      <span className="mcm-ifc-layer__placeholder-count">
                        {file.ifcMeta.elementCount} cấu kiện
                      </span>
                    )}
                    <span className="mcm-ifc-layer__placeholder-hint">
                      Bấm chuột phải → Chỉnh 3D
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        }

        return (
          <div
            key={a.elementId}
            className="mcm-ifc-layer__anchor mcm-ifc-layer__anchor--focused"
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
            {/* Label sits OUTSIDE the renderer (above the frame) so it
                never obscures the 3D content. */}
            <div className="mcm-ifc-layer__label">
              <span aria-hidden="true">🧊</span>
              <span>{file?.name ?? "IFC"}</span>
            </div>
            {/* Clipping frame so 3D content can never paint outside the
                anchor's bounds. The focused frame attaches a listener
                for the renderer's `mcm-ifc-measure` CustomEvent (it
                bubbles, so React's synthetic system won't catch it). */}
            <div className="mcm-ifc-layer__frame" ref={measureFrameRef}>
              {!known ? (
                <div className="mcm-ifc-layer__waiting">
                  Đang chờ file IFC từ peer…
                </div>
              ) : file && file.ifcMeta ? (
                <IFCRenderer
                  glbUrl={file.dataURL}
                  metadata={file.ifcMeta.metadata}
                  fileId={a.fileId}
                  width={a.width}
                  height={a.height}
                  instanceId={`inline-${a.elementId}`}
                  interactive
                  onSelect={(el) => setSelected(el)}
                  onReady={(controls) => {
                    controlsRef.current.set(a.elementId, controls);
                    // Populate the storey list for the popover.
                    try {
                      setStoreys(controls.getStoreys());
                    } catch (err) {
                      console.warn(
                        "[IFCCanvasOverlay] getStoreys failed",
                        err,
                      );
                    }
                    // Restore the user's saved orbit so the renderer
                    // mounts at the view they left it at (across focus
                    // cycles + reloads). Without this it would sit at
                    // the default fit-to-model the renderer applies.
                    if (a.view) {
                      try {
                        controls.setView(a.view);
                      } catch (err) {
                        console.warn(
                          "[IFCCanvasOverlay] setView failed",
                          err,
                        );
                      }
                    }
                  }}
                  onError={(err) =>
                    console.warn("[IFCCanvasOverlay] renderer error", err)
                  }
                />
              ) : null}

              {/* Measure distance readout — only while focused + on. */}
              {focused && measureOn && measureDist !== null && (
                <div className="mcm-ifc-layer__measure-readout">
                  📏 {measureDist.toFixed(2)}
                </div>
              )}

              {/* Storey isolation popover — overlays the focused frame. */}
              {focused && storeyPanelOpen && (
                <div
                  className="mcm-ifc-layer__storey-panel"
                  role="dialog"
                  aria-label="Danh sách tầng"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mcm-ifc-layer__storey-panel-header">
                    <span className="mcm-ifc-layer__storey-panel-title">
                      Tầng ({storeys.length})
                    </span>
                  </div>
                  <div className="mcm-ifc-layer__storey-list">
                    <button
                      type="button"
                      className={`mcm-ifc-layer__storey-row${
                        isolatedStoreyId === null
                          ? " mcm-ifc-layer__storey-row--active"
                          : ""
                      }`}
                      onClick={() => {
                        controlsRef.current
                          .get(a.elementId)
                          ?.isolateStorey(null);
                        setIsolatedStoreyId(null);
                      }}
                    >
                      <span className="mcm-ifc-layer__storey-name">
                        Tất cả
                      </span>
                    </button>
                    {storeys.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`mcm-ifc-layer__storey-row${
                          isolatedStoreyId === s.id
                            ? " mcm-ifc-layer__storey-row--active"
                            : ""
                        }`}
                        onClick={() => {
                          controlsRef.current
                            .get(a.elementId)
                            ?.isolateStorey(s.id);
                          setIsolatedStoreyId(s.id);
                        }}
                        title={s.name}
                      >
                        <span className="mcm-ifc-layer__storey-name">
                          {s.name || s.id}
                        </span>
                        <span className="mcm-ifc-layer__storey-elev">
                          {s.elevation.toFixed(1)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Properties panel — shows the picked element's details. */}
              {focused && selected && (
                <div
                  className="mcm-ifc-layer__props"
                  role="dialog"
                  aria-label="Thuộc tính cấu kiện"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mcm-ifc-layer__props-header">
                    <span className="mcm-ifc-layer__props-name">
                      {selected.name || selected.globalId}
                    </span>
                    <span className="mcm-ifc-layer__props-type">
                      {selected.type}
                    </span>
                  </div>
                  <div className="mcm-ifc-layer__props-list">
                    {selected.category && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          Hạng mục
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.category}
                        </span>
                      </div>
                    )}
                    {selected.family && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          Họ cấu kiện
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.family}
                        </span>
                      </div>
                    )}
                    {selected.typeName && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          Loại
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.typeName}
                        </span>
                      </div>
                    )}
                    {Object.entries(selected.props).map(([k, v]) => (
                      <div key={k} className="mcm-ifc-layer__props-row">
                        <span
                          className="mcm-ifc-layer__props-label"
                          title={k}
                        >
                          {k}
                        </span>
                        <span className="mcm-ifc-layer__props-value">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {focused && (
              <div className="mcm-ifc-layer__focus-toolbar">
                <button
                  type="button"
                  className="mcm-ifc-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    controlsRef.current.get(a.elementId)?.fitToModel();
                  }}
                  title="Đặt lại góc nhìn — căn mô hình vừa khung"
                >
                  ↻ Vừa khung
                </button>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    storeyPanelOpen ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStoreyPanelOpen((p) => !p);
                  }}
                  disabled={storeys.length === 0}
                  title={
                    storeys.length === 0
                      ? "Không có tầng"
                      : `${storeys.length} tầng — chọn để cô lập`
                  }
                >
                  🏢 Tầng
                </button>
                <div className="mcm-ifc-layer__tool-wrap">
                  <button
                    type="button"
                    className={`mcm-ifc-layer__tool${
                      sectionAxis !== null || sectionPanelOpen
                        ? " mcm-ifc-layer__tool--active"
                        : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewStylePanelOpen(false);
                      setSectionPanelOpen((p) => !p);
                    }}
                    title="Mặt cắt — chọn trục cắt và kéo mặt phẳng để cắt mô hình"
                  >
                    ✂️ Mặt cắt
                    {sectionAxis ? ` ${SECTION_LABEL[sectionAxis]}` : ""}
                  </button>
                  {sectionPanelOpen && (
                    <div
                      className="mcm-ifc-layer__menu mcm-ifc-layer__menu--section"
                      role="dialog"
                      aria-label="Mặt cắt"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="mcm-ifc-layer__menu-row">
                        {(["x", "y", "z"] as const).map((axis) => (
                          <button
                            key={axis}
                            type="button"
                            className={`mcm-ifc-layer__seg${
                              sectionAxis === axis
                                ? " mcm-ifc-layer__seg--active"
                                : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              controlsRef.current
                                .get(a.elementId)
                                ?.setSection(axis);
                              setSectionAxis(axis);
                            }}
                            title={`Cắt theo trục ${SECTION_LABEL[axis]}`}
                          >
                            {SECTION_LABEL[axis]}
                          </button>
                        ))}
                      </div>
                      <div className="mcm-ifc-layer__menu-row">
                        <button
                          type="button"
                          className="mcm-ifc-layer__menu-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            controlsRef.current
                              .get(a.elementId)
                              ?.flipSection();
                          }}
                          disabled={sectionAxis === null}
                          title="Lật — đổi nửa không gian được giữ lại"
                        >
                          ⇄ Lật
                        </button>
                        <button
                          type="button"
                          className="mcm-ifc-layer__menu-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            controlsRef.current
                              .get(a.elementId)
                              ?.setSection(null);
                            setSectionAxis(null);
                          }}
                          disabled={sectionAxis === null}
                          title="Tắt mặt cắt"
                        >
                          Tắt
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    measureOn ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !measureOn;
                    controlsRef.current.get(a.elementId)?.toggleMeasure(next);
                    setMeasureOn(next);
                    if (!next) {
                      setMeasureDist(null);
                    }
                  }}
                  title="Đo khoảng cách — bấm 2 điểm trên mô hình"
                >
                  📏 Đo
                </button>
                <div className="mcm-ifc-layer__tool-wrap">
                  <button
                    type="button"
                    className={`mcm-ifc-layer__tool${
                      viewStylePanelOpen
                        ? " mcm-ifc-layer__tool--active"
                        : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSectionPanelOpen(false);
                      setViewStylePanelOpen((p) => !p);
                    }}
                    title="Kiểu hiển thị — Tô bóng / Đất sét / Khung dây"
                  >
                    🎨 Kiểu
                  </button>
                  {viewStylePanelOpen && (
                    <div
                      className="mcm-ifc-layer__menu mcm-ifc-layer__menu--style"
                      role="dialog"
                      aria-label="Kiểu hiển thị"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="mcm-ifc-layer__menu-row">
                        {VIEW_STYLES.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className={`mcm-ifc-layer__seg${
                              viewStyle === s.id
                                ? " mcm-ifc-layer__seg--active"
                                : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              controlsRef.current
                                .get(a.elementId)
                                ?.setViewStyle(s.id);
                              setViewStyle(s.id);
                            }}
                            title={s.title}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    ghostOn ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !ghostOn;
                    controlsRef.current.get(a.elementId)?.setGhost(next);
                    setGhostOn(next);
                  }}
                  title="Mờ nền — làm mờ mọi thứ trừ cấu kiện đang chọn"
                >
                  👻 Mờ nền
                </button>
                <button
                  type="button"
                  className="mcm-ifc-layer__exit"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exitFocusRef.current?.(null);
                  }}
                  title="Thoát chế độ chỉnh 3D (ESC)"
                >
                  × Thoát
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Context menu — pops up at the right-click position. */}
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
              className="mcm-ifc-context-menu"
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
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  // Route through exitFocusRef so any previously-focused
                  // anchor captures its view before focus moves here.
                  void exitFocusRef.current?.(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">🧊</span>
                <span>Chỉnh 3D (xoay / zoom)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  openFileInIfcView(target.fileId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">🗔</span>
                <span>Mở trong khung xem 3D</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  controlsRef.current
                    .get(contextMenu.elementId)
                    ?.fitToModel();
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">↻</span>
                <span>Đặt lại góc nhìn</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
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

export default IFCCanvasOverlay;
