// Floating bottom-right canvas-navigation widget. Three jobs:
//   1. Zoom in / out / reset buttons that work even when the user is
//      on a tablet without scroll-wheel or pinch shortcuts.
//   2. Live zoom-% readout (clickable to reset to 100%).
//   3. Toggleable mini-map that paints every scene element as a faint
//      rectangle and overlays the current viewport — click or drag
//      anywhere on the map to recentre the viewport there.
//
// All state is local-only (no collab); the minimap-open preference
// persists to localStorage so each user gets the layout they last
// chose. We deliberately do NOT expose this widget through the meeting
// header — its discoverability is "it's just always there in the
// corner of the canvas," which matches how zoom controls work in
// every other CAD/whiteboard app.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "@excalidraw/common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

const LS_KEY = "mcm:canvasNav:v1";

type NavPrefs = { minimapOpen: boolean };

const readPrefs = (): NavPrefs => {
  if (typeof window === "undefined") {
    return { minimapOpen: false };
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) {
      return { minimapOpen: false };
    }
    const parsed = JSON.parse(raw) as Partial<NavPrefs>;
    return { minimapOpen: !!parsed.minimapOpen };
  } catch {
    return { minimapOpen: false };
  }
};

const writePrefs = (prefs: NavPrefs): void => {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    // best-effort
  }
};

/** Normalise a proposed zoom into Excalidraw's allowed range. We
 *  multiply by 1000 + round to avoid float drift across many clicks
 *  (e.g. 0.1 + 0.1 + 0.1 !== 0.3). */
const clampZoom = (z: number): number => {
  const rounded = Math.round(z * 1000) / 1000;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rounded));
};

/** Scene bounding box across all (non-deleted) elements. Returns null
 *  when the scene is empty — the minimap then renders the viewport
 *  alone, centred on a neutral grid. */
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const computeBounds = (
  elements: readonly ExcalidrawElement[],
): Bounds | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const el of elements) {
    if (el.isDeleted) {
      continue;
    }
    any = true;
    if (el.x < minX) {
      minX = el.x;
    }
    if (el.y < minY) {
      minY = el.y;
    }
    if (el.x + el.width > maxX) {
      maxX = el.x + el.width;
    }
    if (el.y + el.height > maxY) {
      maxY = el.y + el.height;
    }
  }
  if (!any) {
    return null;
  }
  return { minX, minY, maxX, maxY };
};

const MAP_W = 220;
const MAP_H = 150;
const MAP_PAD = 32; // world-units around the content box

/** Project a world point into minimap pixel space. Centred + padded so
 *  the content always sits inside the viewport with some breathing
 *  room. Falls back to a fixed scene-window around origin when the
 *  scene is empty. */
const buildProjection = (
  bounds: Bounds | null,
  viewportWorldRect: { x: number; y: number; w: number; h: number },
) => {
  // Union of the content bounds and the current viewport. This is the
  // crucial bit: without it, panning the camera off the content shows
  // a static minimap with a viewport rect that flies off the map edge.
  const ux = bounds
    ? Math.min(bounds.minX, viewportWorldRect.x)
    : viewportWorldRect.x;
  const uy = bounds
    ? Math.min(bounds.minY, viewportWorldRect.y)
    : viewportWorldRect.y;
  const uX = bounds
    ? Math.max(bounds.maxX, viewportWorldRect.x + viewportWorldRect.w)
    : viewportWorldRect.x + viewportWorldRect.w;
  const uY = bounds
    ? Math.max(bounds.maxY, viewportWorldRect.y + viewportWorldRect.h)
    : viewportWorldRect.y + viewportWorldRect.h;
  const worldW = Math.max(1, uX - ux + MAP_PAD * 2);
  const worldH = Math.max(1, uY - uy + MAP_PAD * 2);
  const scale = Math.min(MAP_W / worldW, MAP_H / worldH);
  // Centre the projected union inside the minimap canvas.
  const offsetX = (MAP_W - worldW * scale) / 2;
  const offsetY = (MAP_H - worldH * scale) / 2;
  const originX = ux - MAP_PAD;
  const originY = uy - MAP_PAD;
  return {
    worldToMap: (wx: number, wy: number) => ({
      x: (wx - originX) * scale + offsetX,
      y: (wy - originY) * scale + offsetY,
    }),
    mapToWorld: (mx: number, my: number) => ({
      x: (mx - offsetX) / scale + originX,
      y: (my - offsetY) / scale + originY,
    }),
    scale,
  };
};

/** Subscribe to Excalidraw scene changes. Reads back elements +
 *  appState on every onChange so the widget paints the live viewport
 *  rect and current zoom % without polling. We pull from the API
 *  directly (no derived store) because Excalidraw's onChange already
 *  batches at the render frame. */
const useExcalidrawSnapshot = () => {
  const api = useExcalidrawAPI();
  const [snap, setSnap] = useState<{
    elements: readonly ExcalidrawElement[];
    appState: AppState;
  } | null>(null);

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    const refresh = () => {
      setSnap({
        elements: api.getSceneElements(),
        appState: api.getAppState(),
      });
    };
    refresh();
    return api.onChange(refresh);
  }, [api]);

  return { api, snap };
};

export const CanvasNavWidget = () => {
  const { api, snap } = useExcalidrawSnapshot();
  const [prefs, setPrefs] = useState<NavPrefs>(() => readPrefs());
  const minimapRef = useRef<HTMLDivElement | null>(null);
  // True while the user is actively dragging on the minimap so we
  // skip the click-to-centre handler (it'd double-apply on release).
  const draggingRef = useRef(false);

  // Persist prefs whenever they change.
  useEffect(() => {
    writePrefs(prefs);
  }, [prefs]);

  const zoom = snap?.appState.zoom.value ?? 1;
  const zoomPct = Math.round(zoom * 100);

  // Coalesce zoom clicks into a single rAF-flushed updateScene. Each
  // call accumulates its delta on top of `pendingZoomRef` (seeded from
  // the live API zoom on the first click of a burst), then schedules
  // a single flush. Without this, rapid taps were lost: Excalidraw's
  // updateScene goes through React's batched setState, so
  // api.getAppState() still returns the pre-tap zoom for every click
  // in the same tick — 30 rapid clicks all computed
  // "currentZoom + ZOOM_STEP" off the SAME baseline and only the last
  // dispatch survived. Accumulating in a ref makes the burst behave
  // like one motion of (current + 30 × step).
  const pendingZoomRef = useRef<number | null>(null);
  const flushScheduledRef = useRef(false);

  const adjustZoom = useCallback(
    (compute: (currentZoom: number) => number) => {
      if (!api) {
        return;
      }
      const live = api.getAppState();
      const base = pendingZoomRef.current ?? live.zoom.value;
      pendingZoomRef.current = clampZoom(compute(base));
      if (flushScheduledRef.current) {
        return;
      }
      flushScheduledRef.current = true;
      requestAnimationFrame(() => {
        flushScheduledRef.current = false;
        const target = pendingZoomRef.current;
        pendingZoomRef.current = null;
        if (target == null) {
          return;
        }
        const liveNow = api.getAppState();
        const oldZoom = liveNow.zoom.value;
        if (target === oldZoom) {
          return;
        }
        // Pivot around the viewport centre so the user's focus stays
        // put. Mirrors Excalidraw's own +/- buttons.
        const { width, height, scrollX, scrollY } = liveNow;
        const cx = -scrollX + width / 2 / oldZoom;
        const cy = -scrollY + height / 2 / oldZoom;
        const nextScrollX = -(cx - width / 2 / target);
        const nextScrollY = -(cy - height / 2 / target);
        api.updateScene({
          appState: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            zoom: { value: target as any },
            scrollX: nextScrollX,
            scrollY: nextScrollY,
          },
        });
      });
    },
    [api],
  );

  const handleZoomIn = () => adjustZoom((z) => z + ZOOM_STEP);
  const handleZoomOut = () => adjustZoom((z) => z - ZOOM_STEP);
  const handleZoomReset = () => adjustZoom(() => 1);
  const handleToggleMinimap = () => {
    setPrefs((p) => ({ ...p, minimapOpen: !p.minimapOpen }));
  };

  // --- Minimap -----------------------------------------------------
  const bounds = useMemo(
    () => (snap ? computeBounds(snap.elements) : null),
    [snap],
  );

  const viewportWorldRect = useMemo(() => {
    if (!snap) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    const { scrollX, scrollY, zoom: z, width, height } = snap.appState;
    return {
      x: -scrollX,
      y: -scrollY,
      w: width / z.value,
      h: height / z.value,
    };
  }, [snap]);

  const projection = useMemo(
    () => buildProjection(bounds, viewportWorldRect),
    [bounds, viewportWorldRect],
  );

  // Pre-projected element rectangles. Capped to the first ~600
  // elements so a giant board with thousands of strokes doesn't
  // turn the minimap render into a per-frame bottleneck — the
  // viewport rect is still accurate regardless of cap.
  const projectedElements = useMemo(() => {
    if (!snap) {
      return [];
    }
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const max = 600;
    for (const el of snap.elements) {
      if (el.isDeleted) {
        continue;
      }
      if (out.length >= max) {
        break;
      }
      const a = projection.worldToMap(el.x, el.y);
      const b = projection.worldToMap(el.x + el.width, el.y + el.height);
      out.push({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.max(1, Math.abs(b.x - a.x)),
        h: Math.max(1, Math.abs(b.y - a.y)),
      });
    }
    return out;
  }, [snap, projection]);

  const projectedViewport = useMemo(() => {
    const a = projection.worldToMap(viewportWorldRect.x, viewportWorldRect.y);
    const b = projection.worldToMap(
      viewportWorldRect.x + viewportWorldRect.w,
      viewportWorldRect.y + viewportWorldRect.h,
    );
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.max(2, Math.abs(b.x - a.x)),
      h: Math.max(2, Math.abs(b.y - a.y)),
    };
  }, [projection, viewportWorldRect]);

  /** Centre the viewport on the world point under the minimap pointer.
   *  Used by both click and drag — same math, different trigger. Reads
   *  live appState off the API for the same staleness reason as
   *  adjustZoom above (a drag fires pointermove faster than React
   *  re-renders, so any closure over `snap` would lock the camera
   *  to the pre-drag zoom). */
  const recenterViewportAt = useCallback(
    (mapX: number, mapY: number) => {
      if (!api) {
        return;
      }
      const { x: worldX, y: worldY } = projection.mapToWorld(mapX, mapY);
      const live = api.getAppState();
      const { width, height, zoom: z } = live;
      const nextScrollX = -(worldX - width / 2 / z.value);
      const nextScrollY = -(worldY - height / 2 / z.value);
      api.updateScene({
        appState: { scrollX: nextScrollX, scrollY: nextScrollY },
      });
    },
    [api, projection],
  );

  const handleMapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    recenterViewportAt(mx, my);
  };

  const handleMapPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    recenterViewportAt(mx, my);
  };

  const handleMapPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  if (!api) {
    return null;
  }

  return (
    <div className="mcm-canvas-nav" aria-label="Canvas navigation">
      {prefs.minimapOpen && (
        <div
          ref={minimapRef}
          className="mcm-canvas-nav__minimap"
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={handleMapPointerUp}
          onPointerCancel={handleMapPointerUp}
          role="application"
          aria-label="Bản đồ canvas"
          title="Click hoặc kéo để di chuyển camera"
        >
          <svg
            width={MAP_W}
            height={MAP_H}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            aria-hidden="true"
          >
            {projectedElements.map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                className="mcm-canvas-nav__el"
              />
            ))}
            <rect
              x={projectedViewport.x}
              y={projectedViewport.y}
              width={projectedViewport.w}
              height={projectedViewport.h}
              className="mcm-canvas-nav__viewport"
            />
          </svg>
        </div>
      )}
      <div className="mcm-canvas-nav__bar" role="toolbar">
        <button
          type="button"
          className="mcm-canvas-nav__btn"
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <span aria-hidden>+</span>
        </button>
        <button
          type="button"
          className="mcm-canvas-nav__pct"
          onClick={handleZoomReset}
          title="Reset zoom (100%)"
          aria-label={`Zoom ${zoomPct}% — bấm để reset`}
        >
          {zoomPct}%
        </button>
        <button
          type="button"
          className="mcm-canvas-nav__btn"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <span aria-hidden>−</span>
        </button>
        <div className="mcm-canvas-nav__divider" />
        <button
          type="button"
          className={`mcm-canvas-nav__btn mcm-canvas-nav__btn--map${
            prefs.minimapOpen ? " mcm-canvas-nav__btn--active" : ""
          }`}
          onClick={handleToggleMinimap}
          title={
            prefs.minimapOpen ? "Ẩn navigation map" : "Hiện navigation map"
          }
          aria-label="Toggle navigation map"
          aria-pressed={prefs.minimapOpen}
        >
          <svg
            viewBox="0 0 20 20"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2.5 5l5-2 5 2 5-2v12l-5 2-5-2-5 2z" />
            <path d="M7.5 3v12" />
            <path d="M12.5 5v12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default CanvasNavWidget;
