// Presenter self-awareness overlay — fixes the "sharer is blind" gap.
//
// While WE are presenting (screenShareMediaAtom.localActive), the only cues
// today are a tinted Present button + a tiny avatar badge; the sharer can't see
// WHAT they're sharing and can easily forget. This floating panel gives them:
//   (a) a small muted self-preview <video> of their own screen (the exact thing
//       viewers see) with an accent border + a "LIVE • everyone can see this"
//       label, and
//   (b) a banner naming the source TYPE (Entire screen / Window / Browser tab,
//       from displaySurface) plus a clear "Stop sharing" button.
//
// The self-preview feeds off localStream (wrapped from the same local track that
// flips localActive in DailyScreenShare) — never the remote stream. The Stop
// button calls the existing manager.stopSharing() via the instance atom, the
// same handler the Present button uses.

import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { useT } from "../../i18n/mcm";
import {
  screenShareInstanceAtom,
  screenShareMediaAtom,
  screenShareSurfaceLabelKey,
} from "../../screenshare/screenShareState";

export const ScreenShareSelfView = () => {
  const t = useT();
  const media = useAtomValue(screenShareMediaAtom);
  const instance = useAtomValue(screenShareInstanceAtom);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Root element ref so the drag clamp can measure the panel's LIVE size
  // (height is content-driven by CSS, so we read it via getBoundingClientRect
  // rather than hard-coding it).
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Floating position (top-left, viewport px). null = not yet dragged → leave
  // the CSS default corner (left:24 / bottom:96) untouched so the first paint
  // looks exactly like today. The first drag seeds + owns the position.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Always-fresh mirror so the dep-free pointer-move callback clamps against the
  // LIVE pos without re-binding the handler every render.
  const posRef = useRef(pos);
  posRef.current = pos;
  // Offset from the pointer to the panel's top-left at drag start, so the box
  // tracks the cursor without jumping.
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // Seed from the element's CURRENT on-screen rect (covers the still-CSS-pinned
    // first drag as well as any later drag) so there's no jump on grab.
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 240;
    const h = rect?.height ?? 0;
    // Clamp so the panel stays FULLY on-screen (8px margin), against its LIVE
    // measured width/height.
    const x = Math.min(
      Math.max(8, e.clientX - d.dx),
      Math.max(8, window.innerWidth - w - 8),
    );
    const y = Math.min(
      Math.max(8, e.clientY - d.dy),
      Math.max(8, window.innerHeight - h - 8),
    );
    setPos({ x, y });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const stream = media.localStream;

  // Bind our own screen stream to the self-preview <video> imperatively (same
  // pattern as ScreenSharePane). Cleared on unmount / when the stream drops.
  useEffect(() => {
    const v = videoRef.current;
    if (v && stream && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
    return () => {
      if (v) {
        v.srcObject = null;
      }
    };
  }, [stream]);

  // Only the presenter sees this. (localActive can briefly be true before the
  // stream resolves, so render the banner regardless but guard the <video>.)
  if (!media.localActive) {
    return null;
  }

  const sourceLabel = t(
    `screenShare.${screenShareSurfaceLabelKey(media.localSurface)}`,
  );

  return (
    <div
      ref={rootRef}
      className="mcm-ss-self"
      role="status"
      // Only override the CSS corner once dragged (pos !== null). Until then we
      // emit no left/top so the default left:24 / bottom:96 corner applies.
      style={
        pos
          ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
          : undefined
      }
    >
      <div className="mcm-ss-self__preview">
        {stream ? (
          <video
            ref={videoRef}
            className="mcm-ss-self__video"
            autoPlay
            playsInline
            muted
          />
        ) : (
          <div className="mcm-ss-self__placeholder" />
        )}
        <span className="mcm-ss-self__live">
          <span className="mcm-ss-self__dot" />
          {t("screenShare.everyoneSees")}
        </span>
      </div>
      {/* The bar is the DRAG HANDLE: pointer-captured drag moves the whole
          panel. The Stop button below stops propagation so clicking it never
          starts a drag. */}
      <div
        className="mcm-ss-self__bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
      >
        <span className="mcm-ss-self__label">
          {t("screenShare.youArePresenting")}
          {" · "}
          <strong>{sourceLabel}</strong>
        </span>
        <button
          type="button"
          className="mcm-ss-self__stop"
          onClick={() => instance?.stopSharing()}
          // Keep clicks on Stop from initiating a drag on the bar handle.
          onPointerDown={(e) => e.stopPropagation()}
          title={t("screenShare.stopShare")}
          style={{ cursor: "pointer" }}
        >
          {t("screenShare.stopShare")}
        </button>
      </div>
    </div>
  );
};

export default ScreenShareSelfView;
