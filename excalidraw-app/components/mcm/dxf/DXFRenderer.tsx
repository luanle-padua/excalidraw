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

/** Camera state — world centre + effective viewport width — that
 *  fully describes a dxf-viewer view in a serialisable form. The
 *  three fields plus the canvas aspect ratio (which we don't store)
 *  are enough to round-trip a `SetView` call. */
export type DXFViewState = { cx: number; cy: number; w: number };

export type DXFRendererControls = {
  fitToExtent: (padding?: number) => void;
  setLayerVisible: (name: string, visible: boolean) => void;
  getLayers: () => Array<{ name: string; displayName: string; color: number }>;
  /** Returns a PNG blob of the current view — useful for thumbnails. */
  exportPng: () => Promise<Blob | null>;
  /** Read the renderer's current camera state so the parent can
   *  persist it (e.g. to customData) and snapshot the matching PNG. */
  getView: () => DXFViewState | null;
  /** Apply a saved camera state. Used by the parent on remount so the
   *  user's last pan/zoom survives focus → exit → re-enter cycles. */
  setView: (view: DXFViewState) => void;
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
// Static list of TTF URLs we WANT to feed dxf-viewer for text +
// dimension rendering. Each candidate is HEAD-probed before the
// viewer load so that a missing / 404 file (Vite serves the SPA
// index.html for unmatched routes — `<!DOCTYPE…` bytes that crash
// opentype.js parsing with "Unsupported OpenType signature") drops
// gracefully out of the list instead of taking the whole DXF load
// down with it. Drop the actual `.ttf` files into
// `public/fonts/dxf/` to enable text rendering.
const DXF_FONT_CANDIDATES = [
  "/fonts/dxf/Roboto-Regular.ttf",
  "/fonts/dxf/NotoSansKR-Regular.ttf",
] as const;

const probeFontUrl = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) {
      return false;
    }
    const ct = res.headers.get("content-type") ?? "";
    // Vite's SPA fallback returns `text/html` for any route that
    // doesn't map to a real file. opentype.js can't parse HTML, so
    // we drop any URL whose content-type contains "html" or "text/"
    // (covers text/html, text/plain) — what we want is a binary
    // font mime such as font/ttf, font/otf, application/octet-stream,
    // application/font-sfnt, etc.
    if (ct.includes("html") || ct.startsWith("text/")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const resolveDxfFonts = async (): Promise<string[] | null> => {
  const results = await Promise.all(DXF_FONT_CANDIDATES.map(probeFontUrl));
  const available = DXF_FONT_CANDIDATES.filter((_, i) => results[i]);
  if (available.length === 0) {
    console.warn(
      "[DXFRenderer] no TTF fonts at /fonts/dxf/ — rendering DXF " +
        "without text / dimension labels. Drop Roboto-Regular.ttf + " +
        "NotoSansKR-Regular.ttf into public/fonts/dxf/ to enable.",
    );
    return null;
  }
  return [...available];
};

const loadDxfViewerModule = async (): Promise<typeof import("dxf-viewer")> => {
  if (cachedModule) {
    return cachedModule;
  }
  cachedModule = await import("dxf-viewer");
  return cachedModule;
};

// dxf-viewer's GetBounds returns the drawing's bounding box in MODEL
// space (raw CAD coordinates — can be in the millions for survey
// drawings), but the scene is rendered with GetOrigin() subtracted so
// the geometry sits around (0,0). dxf-viewer's own internal auto-fit
// after Load subtracts `scene.origin` from the bounds before calling
// FitView; calling FitView with raw model-space bounds aims the
// camera at the model centroid which is usually far outside the
// rendered scene → "fit" leaves the view blank or shifted to a corner.
// This helper does the same origin-subtraction that the library does
// internally so our Fit button + autoFit on load behave correctly.
const fitToBounds = (viewer: DxfViewer, padding: number) => {
  const b = viewer.GetBounds();
  if (!b) {
    return;
  }
  const o = viewer.GetOrigin();
  viewer.FitView(
    b.minX - o.x,
    b.maxX - o.x,
    b.minY - o.y,
    b.maxY - o.y,
    padding,
  );
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

        // Font URLs for text + dimension rendering. dxf-viewer uses
        // opentype.js under the hood, which accepts TTF/OTF/woff but
        // NOT woff2 — so we ship our own TTFs at /public/fonts/dxf/
        // rather than reusing the Google Fonts woff2 we load for
        // canvas text.
        //
        // CRITICAL: we probe each URL with a HEAD request BEFORE
        // handing the list to dxf-viewer. Without the probe, a 404
        // (Vite serves its SPA index.html for unmatched routes) lands
        // a `<!DOCTYPE…` HTML body in opentype.js, which throws
        // "Unsupported OpenType signature <!DO" and aborts the entire
        // DXF load. `resolveDxfFonts()` filters out missing files so
        // the DXF still renders (minus text) when the TTFs aren't
        // dropped in yet.
        const fonts = await resolveDxfFonts();
        await viewer.Load({ url: blobUrl, fonts });
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
          fitToBounds(viewer, 0.05);
        }
        viewer.Render();
        setStatus("ready");
        onReadyRef.current?.({
          fitToExtent: (padding = 0.05) => {
            if (viewer) {
              fitToBounds(viewer, padding);
            }
          },
          setLayerVisible: (name, visible) => {
            viewer?.ShowLayer(name, visible);
          },
          getLayers: () => Array.from(viewer?.GetLayers() ?? []),
          exportPng: async () => {
            if (!viewer) {
              return null;
            }
            const canvas = viewer.GetCanvas();
            if (!canvas) {
              return null;
            }
            // Force a fresh render into the back buffer immediately
            // before reading it. dxf-viewer constructs its
            // WebGLRenderer with the Three.js default
            // `preserveDrawingBuffer: false`, which means the GPU is
            // allowed to invalidate the drawing buffer after the
            // browser composites a frame. If we call toBlob() without
            // first re-rendering, what we read back can be a cleared
            // (transparent) frame — which manifests as the snapshot
            // <img> showing nothing after the user exits focus mode.
            viewer.Render();
            return new Promise((resolve) =>
              canvas.toBlob((b) => resolve(b), "image/png"),
            );
          },
          getView: () => {
            if (!viewer) {
              return null;
            }
            // Reverse of SetView: world centre is `cam.position +
            // frustum centroid`; effective width compensates for the
            // OrbitControls zoom multiplier so the value can be fed
            // straight back into SetView later. Same math as the
            // resize effect below — kept in lockstep with that.
            const cam = viewer.GetCamera();
            return {
              cx: cam.position.x + (cam.left + cam.right) / 2,
              cy: cam.position.y + (cam.top + cam.bottom) / 2,
              w: (cam.right - cam.left) / (cam.zoom || 1),
            };
          },
          setView: (view) => {
            if (!viewer) {
              return;
            }
            // dxf-viewer's SetView ignores the `z` field at runtime
            // but its TS signature insists on a Three Vector3 — same
            // cast as the resize effect.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            viewer.SetView({ x: view.cx, y: view.cy, z: 0 } as any, view.w);
            viewer.Render();
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
    // We depend on `file?.dataURL` rather than the `file` object so
    // that re-hydration of `meetingFilesAtom` (e.g. when the user
    // opens the library tab and MeetingLibrary calls hydrateMeetingFiles)
    // does not destroy + reload the viewer just because the array got
    // a fresh object identity. Reload still happens when content
    // changes (peer republish → new dataURL). Reading `file.dataURL`
    // inside the loader from the latest closure is safe because the
    // effect re-runs whenever dataURL identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.dataURL, autoFit, instanceId, fileId]);

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
