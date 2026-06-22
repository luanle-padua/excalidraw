// PreJoinModal — the pre-join "green room" / hair-check gate (Item 6,
// docs/plans/meeting-bugs-and-ux-fixes.md §3, Option A).
//
// Shown AFTER the user is in the meeting room (canvas mounted, activeRoomLink
// set) but BEFORE they join the audio/video CALL — the moment to preview their
// camera and decide mic/camera on/off. It gates CALL entry only; the
// WaitingForStart / WaitingRoom gates own ROOM entry (sequential, never both at
// once — see MeetingShell mount order).
//
// Respects the lazy architecture: the preview camera is a STANDALONE
// getUserMedia (DailyAudio.previewCamera — no Daily room, no publish); Join runs
// the shared useJoinCall() which start()s listener-only, then ensureMic() /
// setCamera(true) per the chosen intent. The retained idle "Join" button in the
// header is the fallback for re-joining after Cancel.

import { DoorOpen, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtom, useAtomValue, useSetAtom } from "../../app-jotai";
import {
  audioRoomInstanceAtom,
  preJoinCamIntentAtom,
  preJoinMicIntentAtom,
  preJoinPendingAtom,
} from "../../audio/audioState";
import { cameraStateAtom } from "../../audio/videoState";
import { useJoinCall } from "../../audio/useJoinCall";
import { sessionAtom } from "../../data/session";
import { userProfileAtom } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { PortalBackdrop } from "./PortalBackdrop";

type Props = {
  /** Leave the whole meeting (not just the call). Wired to MeetingShell's
   *  handleLeave so Cancel exits the room cleanly. */
  onLeave: () => void;
};

export const PreJoinModal = ({ onLeave }: Props) => {
  const t = useT();
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const session = useAtomValue(sessionAtom);
  const userProfile = useAtomValue(userProfileAtom);
  const joinCall = useJoinCall();

  const [micOn, setMicOn] = useAtom(preJoinMicIntentAtom);
  const [camOn, setCamOn] = useAtom(preJoinCamIntentAtom);
  const setPending = useSetAtom(preJoinPendingAtom);
  const setCameraState = useSetAtom(cameraStateAtom);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Tracks whether THIS device even has a camera — drives the disabled-with-
  // reason state on the camera toggle (mirrors MeetingCallControls' probe).
  const [hasCamera, setHasCamera] = useState(true);
  // True once the preview getUserMedia resolved with a real stream — lets us
  // show the avatar fallback when the camera is on but no device/permission.
  const [previewLive, setPreviewLive] = useState(false);
  const [joining, setJoining] = useState(false);

  const displayName =
    session?.name || userProfile?.username || t("participants.guest");
  const email = session?.email ?? userProfile?.email ?? null;
  const avatar = session?.avatar ?? userProfile?.avatar ?? null;

  // Probe for a camera device on mount so the toggle disables (with a reason)
  // when there is nothing to turn on.
  useEffect(() => {
    let alive = true;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (alive) {
          setHasCamera(devices.some((d) => d.kind === "videoinput"));
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Camera PREVIEW lifecycle — bound to the camera toggle. Acquire a standalone
  // preview stream when the user turns the camera ON (no call, no publish);
  // release it when they turn it OFF / Join / Cancel / unmount. Teardown is in
  // the cleanup AND mirrored in DailyAudio.stop() as a safety net.
  useEffect(() => {
    if (!audioRoom || !camOn) {
      setPreviewLive(false);
      return undefined;
    }
    // Capture the node now (the ref may point elsewhere by cleanup time).
    const videoEl = videoRef.current;
    let cancelled = false;
    void audioRoom.previewCamera().then((stream) => {
      if (cancelled) {
        return;
      }
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
        setPreviewLive(true);
      } else {
        // No device / permission denied at preview — show the avatar; the real
        // permission decision still happens at Join (setCamera).
        setPreviewLive(false);
      }
    });
    return () => {
      cancelled = true;
      if (videoEl) {
        videoEl.srcObject = null;
      }
      audioRoom.stopPreview();
    };
  }, [audioRoom, camOn]);

  const handleJoin = async () => {
    if (joining) {
      return;
    }
    setJoining(true);
    // Stop the preview BEFORE starting the real call so the camera device is
    // free for setCamera() to re-acquire (some webcams are single-consumer).
    audioRoom?.stopPreview();
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    // If the user never opted into the camera, make sure cameraStateAtom is a
    // clean "off" (a prior session could have left it elsewhere).
    if (!camOn) {
      setCameraState({ status: "off", errorKind: null, errorMessage: null });
    }
    try {
      await joinCall({ mic: micOn, camera: camOn });
    } finally {
      // Dismiss the gate regardless — join errors surface via the header's
      // error button (audioStateAtom), and we never want to trap the user in
      // the modal. The "seen" flag is the pending atom going null.
      setPending(null);
    }
  };

  const handleCancel = () => {
    audioRoom?.stopPreview();
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setPending(null);
    onLeave();
  };

  return (
    <div
      className="mcm-gate mcm-gate--client mcm-prejoin"
      role="dialog"
      aria-modal="true"
      aria-label={t("preJoin.title")}
    >
      <PortalBackdrop />
      <div className="mcm-gate__card mcm-prejoin__card">
        <h2 className="mcm-gate__title">{t("preJoin.title")}</h2>
        <p className="mcm-gate__desc">
          {t("preJoin.joiningAs", { name: displayName })}
        </p>

        {/* Camera preview — mirrored, muted self-view. The <video> is ALWAYS
            mounted while the camera intent is on (so videoRef exists for the
            preview effect to attach srcObject the moment the stream resolves —
            gating it on previewLive would never mount it). The avatar overlays
            it until a real stream is playing, or shows alone when camera is off
            / no device. */}
        <div className="mcm-prejoin__preview">
          {camOn && (
            <video
              ref={videoRef}
              className="mcm-prejoin__video"
              style={previewLive ? undefined : { display: "none" }}
              muted
              autoPlay
              playsInline
            />
          )}
          {!(camOn && previewLive) && (
            <div className="mcm-prejoin__avatar-wrap">
              <MCMAvatar
                avatar={avatar}
                name={displayName}
                email={email}
                className="mcm-prejoin__avatar"
              />
              <span className="mcm-prejoin__cam-hint">
                {camOn ? t("preJoin.noPreview") : t("preJoin.cameraOffHint")}
              </span>
            </div>
          )}
        </div>

        {/* Mic / camera intent toggles. Camera default OFF (lazy). */}
        <div className="mcm-prejoin__toggles">
          <button
            type="button"
            className={`mcm-btn mcm-btn--secondary mcm-prejoin__toggle${
              micOn ? " mcm-prejoin__toggle--on" : ""
            }`}
            onClick={() => setMicOn((v) => !v)}
            aria-pressed={micOn}
          >
            {micOn ? <Mic size={16} /> : <MicOff size={16} />}
            {micOn ? t("preJoin.micOn") : t("preJoin.micOff")}
          </button>
          <button
            type="button"
            className={`mcm-btn mcm-btn--secondary mcm-prejoin__toggle${
              camOn ? " mcm-prejoin__toggle--on" : ""
            }`}
            onClick={() => hasCamera && setCamOn((v) => !v)}
            disabled={!hasCamera}
            aria-pressed={camOn}
            title={!hasCamera ? t("callControls.noCameraTitle") : undefined}
          >
            {camOn ? <Video size={16} /> : <VideoOff size={16} />}
            {camOn ? t("preJoin.cameraOn") : t("preJoin.cameraOff")}
          </button>
        </div>

        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--block mcm-prejoin__join"
          onClick={() => void handleJoin()}
          disabled={joining}
        >
          <DoorOpen size={16} />
          {joining ? t("preJoin.joining") : t("preJoin.joinNow")}
        </button>
        <button type="button" className="mcm-gate__back" onClick={handleCancel}>
          {t("preJoin.cancel")}
        </button>
      </div>
    </div>
  );
};

export default PreJoinModal;
