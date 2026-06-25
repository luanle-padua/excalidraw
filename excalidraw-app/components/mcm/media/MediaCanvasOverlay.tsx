// HTML overlay that renders every MEDIA (video / audio) anchor on the
// canvas — sibling of PDFCanvasOverlay / IFCCanvasOverlay. Each anchor
// is an Excalidraw IMAGE element with `customData.mcmType ===
// "media-anchor"`, a `mediaFileId`, and a `mediaType` of
// "video" | "audio". Excalidraw owns the image's position / size / lock
// / collab-sync AND paints the poster natively on the canvas; we mount a
// positioned <video controls>/<audio controls> player on top so the user
// can actually play the uploaded file inline.
//
// Positioning + anchor-detection mirror PDFCanvasOverlay EXACTLY (the
// same viewport-rect math from element bounds + appState zoom/scroll,
// the same onChange-driven recompute + shallow-equality short-circuit),
// so media anchors follow pan/zoom identically to the other anchor
// kinds. This is intentionally NOT a new positioning system — it's the
// established anchor+overlay pattern applied to a player surface.
//
// v1 LIMITATION (acceptable): playback is NOT synced between peers —
// each participant controls their own player (play / pause / seek are
// local). The anchor element itself (position, which file) IS synced
// via Excalidraw collab like every other anchor; only the transport
// position is per-viewer. A future version could broadcast play/pause.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom } from "../../../data/meetingLibrary";
import { useT } from "../../../i18n/mcm";

import { isMediaAnchorElement, type MediaKind } from "./mediaAnchor";

import "./media-overlay.scss";

type AnchorPosition = {
  elementId: string;
  /** Library file id whose bytes the player streams. */
  fileId: string;
  mediaType: MediaKind;
  /** viewport px from the canvas-wrap top-left */
  left: number;
  top: number;
  width: number;
  height: number;
};

export const MediaCanvasOverlay = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);

  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);

  const fileById = useMemo(() => {
    const m = new Map<string, typeof files[number]>();
    for (const f of files) {
      m.set(f.id, f);
    }
    return m;
  }, [files]);

  // ----- Recompute viewport positions on any scene change ----------
  // Mirrors PDFCanvasOverlay.recompute: walk the scene for our anchors,
  // turn each element's scene-space bounds into a viewport rect using
  // appState zoom + scroll, and only replace the state array when
  // something actually moved (shallow per-field equality) so pan/zoom
  // doesn't thrash React.
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
        if (!isMediaAnchorElement(el)) {
          continue;
        }
        // SAME math as PDFCanvasOverlay (and IFCCanvasOverlay):
        //   viewportX = (el.x + appState.scrollX) * zoom;
        //   viewportY = (el.y + appState.scrollY) * zoom;
        //   width     = el.width  * zoom;
        //   height    = el.height * zoom;
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        next.push({
          elementId: el.id,
          fileId: el.customData.mediaFileId,
          mediaType: el.customData.mediaType,
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
              p.mediaType === next[i].mediaType &&
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

  // Swallow dbl-click on media anchors so Excalidraw doesn't drop into
  // text-edit mode on the underlying image element. Capture-phase, exact
  // hit-testing in canvas-wrap-local coords — mirrors PDFCanvasOverlay.
  // (Single-clicks still pass through to the player controls because the
  // player is pointer-events:auto and sits above this layer.)
  const anchorsRef = useRef<AnchorPosition[]>([]);
  anchorsRef.current = anchors;
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

  if (anchors.length === 0) {
    return null;
  }

  return (
    <div className="mcm-media-layer">
      {anchors.map((a) => {
        const file = fileById.get(a.fileId);
        // Bytes: prefer the library entry's dataURL; large files are
        // R2-offloaded with the dataURL stripped from the library record
        // but hydrated into the canvas file map — fall back to
        // excalidrawAPI.getFiles()[mediaFileId]?.dataURL exactly like the
        // promote feature / PDF seed path does.
        const src =
          file?.dataURL ||
          (excalidrawAPI?.getFiles()[a.fileId]?.dataURL as
            | string
            | undefined) ||
          "";
        const known = !!src;
        return (
          <div
            key={a.elementId}
            className="mcm-media-layer__anchor"
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
            <div className="mcm-media-layer__label">
              <span className="mcm-media-layer__label-type">
                {a.mediaType === "video" ? "VIDEO" : "AUDIO"}
              </span>
              <span className="mcm-media-layer__label-name">
                {file?.name ?? (a.mediaType === "video" ? "Video" : "Audio")}
              </span>
            </div>
            <div className="mcm-media-layer__frame">
              {!known ? (
                <div className="mcm-media-layer__waiting">
                  {t("mediaOverlay.waitingPeer")}
                </div>
              ) : a.mediaType === "video" ? (
                <video
                  className="mcm-media-layer__video"
                  src={src}
                  controls
                  playsInline
                  preload="metadata"
                />
              ) : (
                <div className="mcm-media-layer__audio-wrap">
                  <audio
                    className="mcm-media-layer__audio"
                    src={src}
                    controls
                    preload="metadata"
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default MediaCanvasOverlay;
