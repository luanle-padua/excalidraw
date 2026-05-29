// Right-docked vertical CAD viewer pane. Each tab corresponds to a
// DXF library file and renders an interactive DxfViewer (full pan/
// zoom, layer-toggle control). Multiple tabs are mounted only one at
// a time (active tab) — switching reloads the DXF (~1s) but keeps the
// WebGL slot budget tight + avoids ResizeObserver firing on hidden
// 0×0 inactive panels.
//
// Polish features:
//   • Body is sized via ResizeObserver so the DXF fills the pane
//     exactly, no matter how the user resizes the gutter.
//   • Toolbar below the tabs: ↻ Fit + 📋 Layers dropdown driven by
//     the renderer's imperative controls (getLayers / setLayerVisible).
//   • Layer dropdown is an overlay (top-left of the body) — keeps the
//     CAD area maximised when the panel is closed.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "../../../app-jotai";
import {
  cadViewStateAtom,
  closeCadFileTab,
  closeCadViewPane,
  getMaxCadViewWidth,
  getMinCadViewWidth,
  setActiveCadTab,
  setCadViewWidth,
} from "../../../data/cadViewState";
import { meetingFilesAtom } from "../../../data/meetingLibrary";
import { useT } from "../../../i18n/mcm";

import { DXFRenderer } from "../dxf/DXFRenderer";

import type { DXFRendererControls } from "../dxf/DXFRenderer";

type LayerInfo = { name: string; displayName: string; color: number };

export const CADViewPane = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const state = useAtomValue(cadViewStateAtom);
  const files = useAtomValue(meetingFilesAtom);

  // The persisted openFileIds list is keyed by user, not by meeting —
  // joining a different room can resurrect tabs whose file id only
  // existed in the previous room's library, giving the user a phantom
  // "DXF" tab whose body shows the "không tìm thấy" placeholder.
  // We only ever render tabs whose file id resolves to a real entry
  // in the current meeting's library; the matching effect below
  // prunes those stale ids from the persisted state once.
  const knownFileIds = useMemo(() => new Set(files.map((f) => f.id)), [files]);
  const visibleFileIds = useMemo(
    () => state.openFileIds.filter((id) => knownFileIds.has(id)),
    [state.openFileIds, knownFileIds],
  );

  useEffect(() => {
    // Wait until at least one library file has loaded before pruning —
    // otherwise the very first render (pre-hydration) would wipe every
    // valid tab as "unknown". Once files are non-empty we know the
    // library is populated for THIS meeting; anything left in
    // openFileIds that isn't here is leftover state from a different
    // meeting and safe to close.
    if (files.length === 0) {
      return;
    }
    for (const id of state.openFileIds) {
      if (!knownFileIds.has(id)) {
        closeCadFileTab(id);
      }
    }
  }, [files.length, state.openFileIds, knownFileIds]);

  const fileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of files) {
      if (visibleFileIds.includes(f.id)) {
        map.set(f.id, f.name || "DXF");
      }
    }
    return map;
  }, [files, visibleFileIds]);

  // ----- Resize (left edge — drag LEFT to grow) --------------------
  const resizeRef = useRef<{
    startX: number;
    baseW: number;
  } | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // Separate boolean so the resize handle gets a dragging className
  // without re-rendering on every pointer-move (we throttle width
  // updates via rAF but the class flip should be one-shot).
  const [isResizing, setIsResizing] = useState(false);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, baseW: state.width };
    setLiveWidth(state.width);
    setIsResizing(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    const dx = e.clientX - resizeRef.current.startX;
    // Clamp to BOTH min and max during drag — without the max clamp
    // overshooting the cap would snap the pane back on release,
    // which feels like the resize "broke" mid-motion.
    const proposed = resizeRef.current.baseW - dx;
    const clamped = Math.max(
      getMinCadViewWidth(),
      Math.min(getMaxCadViewWidth(), proposed),
    );
    setLiveWidth(clamped);
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (liveWidth !== null) {
      setCadViewWidth(liveWidth);
    }
    resizeRef.current = null;
    setLiveWidth(null);
    setIsResizing(false);
  };

  // ----- Body size (callback ref + ResizeObserver) -----------------
  // Drive DXFRenderer's width/height from the REAL body dimensions.
  // We start with `null` (not a default like 400×400) and gate the
  // renderer mount on having measured first — otherwise the DXF
  // would fit-to-extent at the default canvas size and the resize
  // hook would then lock that small-fit view across the subsequent
  // grow-to-real-size, leaving the DXF stuck small in a tall pane.
  //
  // useState ref + useEffect were unusable here because the pane
  // returns null while closed: the regular useEffect / useLayoutEffect
  // fired once at MeetingShell mount (when body was unrendered) and
  // never re-fired on open. A callback ref runs every time the body
  // DOM node attaches/detaches, so it works across open/close cycles.
  const roRef = useRef<ResizeObserver | null>(null);
  const [bodySize, setBodySize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const handleBodyRef = useCallback((el: HTMLDivElement | null) => {
    // Tear down any prior observer when the body remounts.
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setBodySize(null);
      return;
    }
    // Measure synchronously so the renderer mounts on the same paint.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setBodySize({
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      });
    }
    // Then observe for subsequent user-driven resizes.
    roRef.current = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) {
        return;
      }
      const w = Math.floor(e.contentRect.width);
      const h = Math.floor(e.contentRect.height);
      if (w > 0 && h > 0) {
        setBodySize({ width: w, height: h });
      }
    });
    roRef.current.observe(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Renderer controls + layer panel ---------------------------
  // controls per active tab — captured via DXFRenderer.onReady. Layer
  // visibility map is local (per-session) so toggles snap back on
  // reload — that's acceptable for MVP and avoids leaky persistence.
  const controlsRef = useRef<DXFRendererControls | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  // Lock view = freeze pan/zoom inside the DXF. Implemented by
  // flipping the renderer's `interactive` prop, which toggles
  // pointer-events on the inner canvas. Useful for presentations
  // and to avoid accidental panning during discussion.
  const [viewLocked, setViewLocked] = useState(false);

  const handleRendererReady = (controls: DXFRendererControls) => {
    controlsRef.current = controls;
    try {
      const l = controls.getLayers();
      setLayers(l);
      // Re-apply any hidden state to the freshly-loaded viewer (e.g.
      // when the user re-mounts the tab via switch-and-back).
      for (const name of hiddenLayers) {
        controls.setLayerVisible(name, false);
      }
    } catch (err) {
      console.warn("[CADView] getLayers failed", err);
    }
  };

  const toggleLayer = (name: string) => {
    const wasHidden = hiddenLayers.has(name);
    const nextVisible = wasHidden; // toggle: hidden → visible
    controlsRef.current?.setLayerVisible(name, nextVisible);
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (nextVisible) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const setAllLayersVisible = (visible: boolean) => {
    if (!controlsRef.current) {
      return;
    }
    for (const layer of layers) {
      controlsRef.current.setLayerVisible(layer.name, visible);
    }
    setHiddenLayers(visible ? new Set() : new Set(layers.map((l) => l.name)));
  };

  const handleFit = () => {
    controlsRef.current?.fitToExtent(0.05);
  };

  // Reset captured controls + layers when tab switches (renderer
  // re-mounts via key prop). Wait for the new mount's onReady.
  useEffect(() => {
    controlsRef.current = null;
    setLayers([]);
    setHiddenLayers(new Set());
    setLayerPanelOpen(false);
  }, [state.activeFileId]);

  // Outside-click + Esc close the layer panel.
  useEffect(() => {
    if (!layerPanelOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".mcm-cad-view__layer-panel")) {
        return;
      }
      if (t?.closest(".mcm-cad-view__tool--layers")) {
        return;
      }
      setLayerPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLayerPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [layerPanelOpen]);

  if (!excalidrawAPI || !state.open || visibleFileIds.length === 0) {
    return null;
  }

  // Prefer the persisted active id if it survived the visibility
  // filter, otherwise fall back to the first visible tab — never to a
  // ghost id that would just render the not-found state.
  const activeFileId = visibleFileIds.includes(state.activeFileId ?? "")
    ? state.activeFileId
    : visibleFileIds[0];
  const effectiveWidth = liveWidth ?? state.width;

  return (
    <aside
      className={`mcm-cad-view${isResizing ? " mcm-cad-view--resizing" : ""}`}
      aria-label={t("cad.pane.viewAria")}
      // width is data-driven (user-resizable).
      // eslint-disable-next-line react/forbid-dom-props
      style={{ width: effectiveWidth }}
    >
      <div
        className={`mcm-cad-view__resize-handle${
          isResizing ? " mcm-cad-view__resize-handle--dragging" : ""
        }`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("cad.pane.resizeAria")}
      />
      <div className="mcm-cad-view__header">
        <div className="mcm-cad-view__tabs">
          {visibleFileIds.map((fid) => {
            const isActive = fid === activeFileId;
            const name = fileNames.get(fid) ?? "DXF";
            return (
              <div
                key={fid}
                className={`mcm-cad-view__tab${
                  isActive ? " mcm-cad-view__tab--active" : ""
                }`}
              >
                <button
                  type="button"
                  className="mcm-cad-view__tab-label"
                  onClick={() => setActiveCadTab(fid)}
                  title={name}
                >
                  📐 {name}
                </button>
                <button
                  type="button"
                  className="mcm-cad-view__tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeCadFileTab(fid);
                  }}
                  aria-label={t("cad.tab.closeAria", { name })}
                  title={t("cad.tab.closeTitle")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="mcm-cad-view__close"
          onClick={() => closeCadViewPane()}
          aria-label={t("cad.pane.closeAria")}
          title={t("cad.pane.closeTitle")}
        >
          ×
        </button>
      </div>

      {/* Toolbar row — actions that operate on the active tab. */}
      <div className="mcm-cad-view__toolbar">
        <button
          type="button"
          className={`mcm-cad-view__tool mcm-cad-view__tool--layers${
            layerPanelOpen ? " mcm-cad-view__tool--active" : ""
          }`}
          onClick={() => setLayerPanelOpen((v) => !v)}
          disabled={layers.length === 0}
          title={
            layers.length === 0
              ? t("cad.layers.loadingTitle")
              : t("cad.layers.countTitle", { count: layers.length })
          }
        >
          <span aria-hidden>📋</span>
          <span>{t("cad.layers.button")}</span>
          {layers.length > 0 && (
            <span className="mcm-cad-view__tool-badge">{layers.length}</span>
          )}
        </button>
        <button
          type="button"
          className="mcm-cad-view__tool"
          onClick={handleFit}
          disabled={!controlsRef.current}
          title={t("cad.toolbar.fitPaneTitle")}
        >
          <span aria-hidden>↻</span>
          <span>{t("cad.toolbar.fit")}</span>
        </button>
        <button
          type="button"
          className={`mcm-cad-view__tool${
            viewLocked ? " mcm-cad-view__tool--active" : ""
          }`}
          onClick={() => setViewLocked((v) => !v)}
          title={
            viewLocked
              ? t("cad.lock.lockedTitle")
              : t("cad.lock.unlockedTitle")
          }
        >
          <span aria-hidden>{viewLocked ? "🔒" : "🔓"}</span>
          <span>{viewLocked ? t("cad.lock.locked") : t("cad.lock.lock")}</span>
        </button>
      </div>

      <div ref={handleBodyRef} className="mcm-cad-view__body">
        {/* keyed by activeFileId so a tab-switch fully re-mounts the
            renderer — cleanest way to swap WebGL contexts safely. */}
        {/* Wait for the real body measurement before mounting the
            renderer — see the bodySize comment above. */}
        {activeFileId && bodySize && (
          <DXFRenderer
            key={activeFileId}
            fileId={activeFileId}
            width={bodySize.width}
            height={bodySize.height}
            instanceId={`cad-view-${activeFileId}`}
            interactive={!viewLocked}
            onReady={handleRendererReady}
          />
        )}

        {layerPanelOpen && layers.length > 0 && (
          <div
            className="mcm-cad-view__layer-panel"
            role="dialog"
            aria-label={t("cad.layers.panelAria")}
          >
            <div className="mcm-cad-view__layer-panel-header">
              <span className="mcm-cad-view__layer-panel-title">
                {t("cad.layers.title", { count: layers.length })}
              </span>
              <div className="mcm-cad-view__layer-panel-actions">
                <button
                  type="button"
                  className="mcm-cad-view__layer-panel-action"
                  onClick={() => setAllLayersVisible(true)}
                  title={t("cad.layers.allOnTitle")}
                >
                  {t("cad.layers.allOn")}
                </button>
                <button
                  type="button"
                  className="mcm-cad-view__layer-panel-action"
                  onClick={() => setAllLayersVisible(false)}
                  title={t("cad.layers.allOffTitle")}
                >
                  {t("cad.layers.allOff")}
                </button>
              </div>
            </div>
            <div className="mcm-cad-view__layer-list">
              {layers.map((layer) => {
                const visible = !hiddenLayers.has(layer.name);
                // DXF colors are 0xRRGGBB integers. Convert to CSS.
                const colorHex = `#${layer.color
                  .toString(16)
                  .padStart(6, "0")}`;
                return (
                  <label
                    key={layer.name}
                    className={`mcm-cad-view__layer-row${
                      visible ? "" : " mcm-cad-view__layer-row--hidden"
                    }`}
                    title={layer.name}
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={() => toggleLayer(layer.name)}
                    />
                    <span
                      className="mcm-cad-view__layer-swatch"
                      // colour swatch is data-driven from DXF layer
                      // colour, so the inline style is unavoidable.
                      // eslint-disable-next-line react/forbid-dom-props
                      style={{ background: colorHex }}
                      aria-hidden
                    />
                    <span className="mcm-cad-view__layer-name">
                      {layer.displayName || layer.name}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

export default CADViewPane;
