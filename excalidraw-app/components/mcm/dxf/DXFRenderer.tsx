// Reusable wrapper around dxf-viewer (Three.js-based DXF renderer).
// One <DXFRenderer /> instance owns one WebGL context — both the
// inline canvas overlay and the split-pane viewer mount this leaf
// component to display a DXF file.
//
// Responsibilities:
//   • lazy-load the dxf-viewer chunk so users who never touch a DXF
//     don't pay the ~3MB bundle cost
//   • register with dxfInstanceRegistry (enforces 4-instance cap)
//   • handle WebGL context lifecycle (dispose on unmount)
//   • track container size changes via ResizeObserver
//   • expose imperative controls (fit, layer toggle, screenshot)
//     via the optional `onReady` callback
//
// What it intentionally does NOT do:
//   • pan/zoom canvas-coord tracking — that's the overlay's job
//   • layer tree UI — the split-pane owns that
//   • drag-to-place — the picker owns that

import { useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";

import {
  claimDxfSlot,
  releaseDxfSlot,
  subscribeDxfEvict,
} from "./dxfInstanceRegistry";

import type { DxfViewer } from "dxf-viewer";

export type DXFRendererControls = {
  fitToExtent: (padding?: number) => void;
  setLayerVisible: (name: string, visible: boolean) => void;
  getLayers: () => Array<{ name: string; displayName: string; color: number }>;
  /** Returns a PNG blob of the current view — useful for thumbnails. */
  exportPng: () => Promise<Blob | null>;
};

type Props = {
  /** Library file id — must resolve to a MeetingFile with dxfMeta
   *  populated (or a raw .dxf data URL we can fetch).  */
  fileId: string;
  /** Container size in CSS px. Caller is responsible for sizing
   *  (overlay vs split-pane have different sizing strategies). */
  width: number;
  height: number;
  /** Stable per-mount UUID so the instance registry can track this
   *  specific renderer (the same fileId may appear in inline overlay
   *  AND a split-pane tab simultaneously). */
  instanceId: string;
  /** Initial fit on load — defaults to true. */
  autoFit?: boolean;
  /** When true, the renderer captures pointer events itself so the
   *  user can pan/zoom INSIDE the DXF (dxf-viewer's built-in
   *  OrbitControls). Default false — clicks pass through to the
   *  underlying Excalidraw canvas (Option A passive). */
  interactive?: boolean;
  /** Called once the DXF is loaded + rendered. Pass back imperative
   *  controls so parents can drive layer toggles, exports, etc. */
  onReady?: (controls: DXFRendererControls) => void;
  /** Called when load fails. */
  onError?: (err: Error) => void;
};

type Status = "loading" | "ready" | "error" | "capacity-exceeded";

// Cached dxf-viewer module reference. Loaded lazily on first mount;
// subsequent mounts reuse the cached module.
let cachedModule: typeof import("dxf-viewer") | null = null;
const loadDxfViewerModule = async (): Promise<typeof import("dxf-viewer")> => {
  if (cachedModule) {
    return cachedModule;
  }
  cachedModule = await import("dxf-viewer");
  return cachedModule;
};

export const DXFRenderer = ({
  fileId,
  width,
  height,
  instanceId,
  autoFit = true,
  interactive = false,
  onReady,
  onError,
}: Props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DxfViewer | null>(null);
  // Hold the most recent onReady/onError so the loader effect doesn't
  // re-run just because the parent passed a fresh closure.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  // Latest container size — read inside the async loader after Load
  // resolves, so the initial fit uses the REAL props (not whatever
  // the canvas was at construction time, which is usually wrong
  // because dxf-viewer creates its WebGL canvas with default 100×100).
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const files = useAtomValue(meetingFilesAtom);
  const file = useMemo(
    () => files.find((f) => f.id === fileId) ?? null,
    [files, fileId],
  );

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // External eviction (parent registry asks us to unmount) — we just
  // report the request upward via DOM event; the actual unmount is
  // owned by the parent so it can remove us from its list.
  useEffect(() => {
    return subscribeDxfEvict((evictedId) => {
      if (evictedId === instanceId && containerRef.current) {
        containerRef.current.dispatchEvent(
          new CustomEvent("mcm-dxf-evict", { bubbles: true }),
        );
      }
    });
  }, [instanceId]);

  // Combined slot-claim + load + lifecycle effect. Previously claim
  // lived in its own effect and `status` was in this effect's deps,
  // which caused a feedback loop: the loader called setStatus("ready")
  // → status changed → cleanup destroyed the just-built viewer → the
  // effect re-ran and rebuilt + reloaded everything. Symptom: DXF
  // appeared blank on first drop and only painted after a stray canvas
  // resize (which forced the second-mount viewer to render).
  // Atomic claim + load avoids the loop entirely.
  useEffect(() => {
    if (!file || !containerRef.current) {
      return undefined;
    }
    const ok = claimDxfSlot(instanceId, fileId);
    if (!ok) {
      setStatus("capacity-exceeded");
      return undefined;
    }

    let cancelled = false;
    let blobUrl: string | null = null;
    let viewer: DxfViewer | null = null;

    const run = async () => {
      try {
        const mod = await loadDxfViewerModule();
        if (cancelled || !containerRef.current) {
          return;
        }
        viewer = new mod.DxfViewer(containerRef.current, {
          // Transparent background so the renderer composes nicely
          // with the canvas / split-pane chrome.
          clearAlpha: 0,
          canvasAlpha: true,
          autoResize: false, // we drive resize via ResizeObserver below
          antialias: true,
          // Pass the latest container size at construction so the
          // internal WebGL canvas + camera are already correct when
          // Load runs (vs the dxf-viewer default ~100×100, which made
          // FitView frame the DXF for a tiny canvas — the DXF then
          // appeared squished in one corner of the actual container).
          canvasWidth: Math.max(1, sizeRef.current.width),
          canvasHeight: Math.max(1, sizeRef.current.height),
          sceneOptions: {
            // Skip paper-space layouts so GetBounds returns ONLY the
            // model-space drawing extents. Without this, an A1/A2
            // sheet template baked into the DXF pulls FitView out so
            // far that the actual floor plan ends up tiny + clipped
            // to one corner of the anchor (the bug the user reported).
            suppressPaperSpace: true,
          },
        });
        viewerRef.current = viewer;

        // dxf-viewer.Load() takes a URL — wrap the stored dataURL
        // as a blob URL so it can fetch().
        const res = await fetch(file.dataURL);
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);

        await viewer.Load({ url: blobUrl, fonts: null });
        if (cancelled) {
          return;
        }
        // Re-apply size after Load in case the parent resized while
        // we were fetching/parsing. THEN fit, so the camera frames
        // the DXF bounds inside the CURRENT canvas size.
        viewer.SetSize(
          Math.max(1, sizeRef.current.width),
          Math.max(1, sizeRef.current.height),
        );
        if (autoFit) {
          const b = viewer.GetBounds();
          if (b) {
            viewer.FitView(b.minX, b.maxX, b.minY, b.maxY, 0.05);
          }
        }
        viewer.Render();
        setStatus("ready");
        onReadyRef.current?.({
          fitToExtent: (padding = 0.05) => {
            const b = viewer?.GetBounds();
            if (b && viewer) {
              viewer.FitView(b.minX, b.maxX, b.minY, b.maxY, padding);
            }
          },
          setLayerVisible: (name, visible) => {
            viewer?.ShowLayer(name, visible);
          },
          getLayers: () => Array.from(viewer?.GetLayers() ?? []),
          exportPng: async () => {
            const canvas = viewer?.GetCanvas();
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
      releaseDxfSlot(instanceId);
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
      try {
        viewer?.Destroy();
      } catch {
        // Some dxf-viewer versions throw if Destroy is called before
        // Load resolves — ignore.
      }
      viewerRef.current = null;
    };
    // status is INTENTIONALLY not in deps — setStatus is called
    // inside the loader and we don't want to tear the viewer down
    // just because we transitioned from loading→ready.
    // file.dataURL identity changes when peers re-publish — re-load
    // intentionally. Otherwise we'd serve a stale render.
  }, [file, autoFit, instanceId, fileId]);

  // Preserve the user's view region (sticker behavior) across
  // container resize: as the anchor / pane grows or shrinks, the
  // SAME DXF region stays in view, so the content visually scales
  // with the canvas (just like a printed photo glued onto a sheet).
  //
  // Two subtleties make this trickier than it looks:
  //
  //  1. Three's OrthographicCamera frustum (left/right/top/bottom)
  //     is in camera-LOCAL coords, so the world centre of the view
  //     is `cam.position + (left+right)/2`. Earlier versions used
  //     the camera-local centre directly and dxf-viewer dutifully
  //     teleported the camera to world (0, 0) → "DXF jumps to
  //     origin" bug.
  //
  //  2. OrbitControls' scroll-zoom modifies `cam.zoom` (a projection
  //     multiplier) rather than the frustum itself. The effective
  //     visible width is `(right - left) / zoom`. dxf-viewer's
  //     SetView resets `cam.zoom = 1` and writes left/right = ±w/2,
  //     so to keep the SAME visible region we have to pass the
  //     EFFECTIVE width, not the raw frustum width. Without this
  //     correction the user's pan/zoom-inside view jumped back to
  //     the base frustum every time the canvas resized.
  useEffect(() => {
    if (status !== "ready" || !viewerRef.current) {
      return;
    }
    const viewer = viewerRef.current;
    const cam = viewer.GetCamera();
    const worldCx = cam.position.x + (cam.left + cam.right) / 2;
    const worldCy = cam.position.y + (cam.top + cam.bottom) / 2;
    const effectiveWidth = (cam.right - cam.left) / (cam.zoom || 1);
    viewer.SetSize(Math.max(1, width), Math.max(1, height));
    // dxf-viewer's SetView takes a Vector3-like {x, y[, z]} — plain
    // object literal works at runtime (the lib only reads .x and .y)
    // but the TS signature insists on a Three Vector3. We don't pull
    // in @types/three just for one call site.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewer.SetView({ x: worldCx, y: worldCy, z: 0 } as any, effectiveWidth);
    viewer.Render();
  }, [width, height, status]);

  if (!file) {
    return (
      <div className="mcm-dxf-renderer mcm-dxf-renderer--missing">
        File DXF không tìm thấy
      </div>
    );
  }

  if (status === "capacity-exceeded") {
    return (
      <div className="mcm-dxf-renderer mcm-dxf-renderer--capacity">
        <div className="mcm-dxf-renderer__capacity-icon" aria-hidden="true">
          ⚠️
        </div>
        <div className="mcm-dxf-renderer__capacity-text">
          Đã mở tối đa DXF cùng lúc. Đóng bớt 1 file khác để xem file này.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`mcm-dxf-renderer mcm-dxf-renderer--${status}${
        interactive ? " mcm-dxf-renderer--interactive" : ""
      }`}
      // eslint-disable-next-line react/forbid-dom-props
      style={{ width, height }}
      data-dxf-instance-id={instanceId}
      data-dxf-file-id={fileId}
    >
      {status === "loading" && (
        <div className="mcm-dxf-renderer__loading">
          <span className="mcm-dxf-renderer__spinner" />
          <span>Đang tải DXF…</span>
        </div>
      )}
      {status === "error" && (
        <div className="mcm-dxf-renderer__error">
          Không đọc được DXF: {errorMsg}
        </div>
      )}
    </div>
  );
};

export default DXFRenderer;
