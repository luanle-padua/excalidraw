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

import { useAtomValue } from "../app-jotai";
import { useT } from "../i18n/mcm";

import { isPopOutSupported, popOut } from "./popOut";
import { screenShareMediaAtom } from "./screenShareState";

import "./screenshare.scss";

export const ScreenSharePane = () => {
  const t = useT();
  const media = useAtomValue(screenShareMediaAtom);
  const stream = media.remoteStream;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
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
      setPoppedOut(false);
    }
  }, [stream]);

  // Close the pop-out window if the pane unmounts.
  useEffect(() => {
    return () => {
      closeRef.current?.();
      closeRef.current = null;
    };
  }, []);

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
        setPoppedOut(false);
      },
    });
    if (close) {
      closeRef.current = close;
      setPoppedOut(true);
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
            title={minimized ? t("screenShare.expand") : t("screenShare.minimize")}
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
        </div>
      )}
    </div>
  );
};

export default ScreenSharePane;
