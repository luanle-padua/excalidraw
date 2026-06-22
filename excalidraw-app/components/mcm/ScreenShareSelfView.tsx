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

import { useEffect, useRef } from "react";

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
    <div className="mcm-ss-self" role="status">
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
      <div className="mcm-ss-self__bar">
        <span className="mcm-ss-self__label">
          {t("screenShare.youArePresenting")}
          {" · "}
          <strong>{sourceLabel}</strong>
        </span>
        <button
          type="button"
          className="mcm-ss-self__stop"
          onClick={() => instance?.stopSharing()}
          title={t("screenShare.stopShare")}
        >
          {t("screenShare.stopShare")}
        </button>
      </div>
    </div>
  );
};

export default ScreenShareSelfView;
