// Floating viewer for a remote presenter's screen. Appears only while we're
// watching someone (screenShareMediaAtom.remoteStream is set); the sharer
// themselves sees no pane (they're looking at their own screen). Supports a
// "Pop out" button that opens a Document-PiP window draggable to a second
// monitor.
//
// Pop-out renders a SEPARATE plain <video> into the PiP window (both feed off
// the same MediaStream) rather than moving this React-managed node — moving a
// React child into another document fights reconciliation. The in-app <video>
// stays mounted (just hidden) so the stream is never re-subscribed.

import { useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";
import { LiveCaptionDock } from "../components/mcm/LiveCaptionDock";
import { mountPopOutCaption } from "../components/mcm/captionPopOut";
import {
  captionPoppedOutAtom,
  captionSurfaceAtom,
} from "../data/captionState";
import { useT } from "../i18n/mcm";

import { isPopOutSupported, popOut } from "./popOut";
import { screenShareMediaAtom } from "./screenShareState";

import "./screenshare.scss";

export const ScreenSharePane = () => {
  const t = useT();
  const media = useAtomValue(screenShareMediaAtom);
  const stream = media.remoteStream;
  // Central caption router decides WHERE the dock mounts. We OWN one input to it:
  // captionPoppedOutAtom — flipped true while the share rides a Document-PiP window
  // so the selector returns "popout" and the in-pane dock steps aside (the pop-out
  // strip mounted via mountPopOutCaption becomes the sole caption surface).
  const captionSurface = useAtomValue(captionSurfaceAtom);
  const setCaptionPoppedOut = useSetAtom(captionPoppedOutAtom);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // Teardown for the plain-DOM caption strip we mount into the pop-out window
  // (see captionPopOut.ts). Kept separate from closeRef so we can unmount the
  // caption subscriptions independently of closing the PiP window.
  const popOutCaptionCleanupRef = useRef<(() => void) | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);

  // Bind the remote stream to the in-app <video> imperatively.
  useEffect(() => {
    const v = videoRef.current;
    if (v && stream && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
  }, [stream]);

  // Stream ended → make sure any pop-out window is closed.
  useEffect(() => {
    if (!stream && closeRef.current) {
      closeRef.current();
      closeRef.current = null;
      popOutCaptionCleanupRef.current?.();
      popOutCaptionCleanupRef.current = null;
      setPoppedOut(false);
      // Hand caption ownership back to the central router: no pop-out window
      // remains, so the selector should no longer return "popout".
      setCaptionPoppedOut(false);
    }
  }, [stream, setCaptionPoppedOut]);

  // Close the pop-out window if the pane unmounts.
  useEffect(() => {
    return () => {
      closeRef.current?.();
      closeRef.current = null;
      popOutCaptionCleanupRef.current?.();
      popOutCaptionCleanupRef.current = null;
      // Clear the shared pop-out flag on unmount — the atom outlives this
      // component, so a stale `true` would otherwise wedge the selector on
      // "popout" for the next share.
      setCaptionPoppedOut(false);
    };
  }, [setCaptionPoppedOut]);

  if (!stream) {
    return null;
  }

  const handlePopOut = async () => {
    const v = document.createElement("video");
    v.autoplay = true;
    v.muted = true;
    v.setAttribute("playsinline", "");
    v.style.width = "100%";
    v.style.height = "100%";
    v.style.objectFit = "contain";
    v.style.background = "#000";
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    const close = await popOut(v, {
      onReturn: () => {
        closeRef.current = null;
        // Tear down the caption strip's atom subscriptions when the user
        // closes the pop-out window (or it's closed for them).
        popOutCaptionCleanupRef.current?.();
        popOutCaptionCleanupRef.current = null;
        setPoppedOut(false);
        // Caption returns to the in-app pane: clear the shared flag so the
        // central selector routes back to "pane".
        setCaptionPoppedOut(false);
      },
    });
    if (close) {
      closeRef.current = close;
      // The video node now lives in the PiP document (popOut appended it AFTER
      // copyStyles ran), so its ownerDocument is the pop-out window — mount the
      // caption strip into the SAME document so captions follow the share onto
      // the second monitor. Plain DOM (not a React portal) to avoid moving a
      // reconciled node across documents (popOut.ts's warning).
      const pipDoc = v.ownerDocument;
      if (pipDoc && pipDoc !== document) {
        popOutCaptionCleanupRef.current = mountPopOutCaption(pipDoc);
      }
      setPoppedOut(true);
      // Tell the central router the share now rides a separate window → the
      // selector flips to "popout", suppressing the in-pane dock below.
      setCaptionPoppedOut(true);
    }
  };

  const presenter = media.remoteSharerName ?? "";

  return (
    <div
      className={`mcm-ss-pane${minimized ? " mcm-ss-pane--min" : ""}${
        poppedOut ? " mcm-ss-pane--popped" : ""
      }`}
    >
      <div className="mcm-ss-pane__header">
        <span className="mcm-ss-pane__title">
          <span className="mcm-ss-pane__dot" />
          {t("screenShare.presenting", { name: presenter })}
        </span>
        <div className="mcm-ss-pane__actions">
          {isPopOutSupported() && !minimized && !poppedOut && (
            <button
              type="button"
              className="mcm-ss-pane__btn"
              onClick={handlePopOut}
              title={t("screenShare.popOutTitle")}
              aria-label={t("screenShare.popOut")}
            >
              ⧉
            </button>
          )}
          <button
            type="button"
            className="mcm-ss-pane__btn"
            onClick={() => setMinimized((m) => !m)}
            title={
              minimized ? t("screenShare.expand") : t("screenShare.minimize")
            }
            aria-label={
              minimized ? t("screenShare.expand") : t("screenShare.minimize")
            }
          >
            {minimized ? "▢" : "—"}
          </button>
        </div>
      </div>
      {!minimized && (
        <div className="mcm-ss-pane__body">
          {poppedOut && (
            <div className="mcm-ss-pane__popped">
              {t("screenShare.poppedOut")}
            </div>
          )}
          <video
            ref={videoRef}
            className="mcm-ss-pane__video"
            autoPlay
            playsInline
            muted
          />
          {/* Live captions pinned to the bottom of the viewer pane — mounted
              ONLY when the central router (captionSurfaceAtom) hands ownership to
              "pane". While popped out the selector returns "popout" instead, so
              this is suppressed and the PiP-window strip (mountPopOutCaption) is
              the sole caption surface — no two docks competing. */}
          {captionSurface === "pane" && <LiveCaptionDock variant="embedded" />}
        </div>
      )}
    </div>
  );
};

export default ScreenSharePane;
