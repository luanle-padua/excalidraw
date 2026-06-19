// IN-HEADER call controls for the WebRTC audio/video call. These used to live
// in a floating pill anchored bottom-center of the canvas (it overlapped the
// lower CAD / DXF anchors and felt "vướng"); the whole cluster has moved up
// into the meeting header so the canvas stays clear. The component is now a
// set of header icon buttons (class `mcm-header__icon-btn` + `mcm-tip` for the
// styled hover tooltip), NOT a self-positioned pill — the header owns layout
// and grouping. ALL wiring (mic/cam toggle, raise-hand, reactions, recording,
// join/leave + the audioState lifecycle) is unchanged; only the render target
// moved.
//
// Call lifecycle still drives what shows:
//   • idle       → "Join" icon button (NO mic prompt — joins listener-only)
//   • connecting → spinner icon (disabled)
//   • live       → mic / camera / raise-hand / reactions / recording / leave
//   • error      → a single error icon button (tooltip carries the message);
//                  click = retry
//
// Joining is mic-free: start() enters listening-only and the mic is acquired
// lazily on the first unmute (or when STT turns on), so the browser permission
// prompt fires on that later click — itself a user gesture.

import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { audioRoomInstanceAtom, audioStateAtom } from "../../audio/audioState";
import { cameraStateAtom } from "../../audio/videoState";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
  raisedHandsAtom,
} from "../../collab/Collab";
import { useT } from "../../i18n/mcm";

import { RecordingButton } from "./RecordingControls";

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
  >
    <path d={d} />
  </svg>
);

const MicOnIcon = () => (
  <Icon d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8" />
);

const MicOffIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
  >
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12 M15 9.34V4a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2 m14 0v2a7 7 0 0 1-.11 1.23" />
    <path d="M12 19v4 M8 23h8" />
  </svg>
);

const CameraOnIcon = () => (
  <Icon d="M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
);

const CameraOffIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
  >
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const PhoneOffIcon = () => (
  <Icon d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91 M23 1L1 23" />
);

// Neutral "enter the room" icon for the idle Join button. The old MicOnIcon
// implied a mic prompt up front; we now join listener-only and acquire the mic
// later (on unmute / STT), so a door-with-arrow reads "go in" without promising
// the mic turns on.
const EnterIcon = () => (
  <Icon d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M10 17l5-5-5-5 M15 12H3" />
);

const SmileyIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </svg>
);

// Quick-react emoji set — ordered for thumbing through during a call.
const MEETING_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👏", "😮"];

export const MeetingCallControls = () => {
  const t = useT();
  const audioState = useAtomValue(audioStateAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const cameraState = useAtomValue(cameraStateAtom);
  const setCameraState = useSetAtom(cameraStateAtom);
  // Whether this device has any camera at all — drives the disabled-with-reason
  // state on the toggle. Probed once when the call goes live (enumerateDevices
  // only labels devices after a getUserMedia grant, but the *kind* is always
  // present, so counting `videoinput` is enough to know a camera exists).
  const [hasCamera, setHasCamera] = useState(true);
  // Finished meeting opened for review = read-only, extract-only. There is
  // no live call to join, so the entire mic/join/leave control bar is hidden.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);

  // Raise-hand + reactions plumbing. Raised state is sourced from the
  // shared atom so it stays in sync with what peers also see (and is
  // cleared automatically when the user leaves the room).
  const collabAPI = useAtomValue(collabAPIAtom);
  const raisedHands = useAtomValue(raisedHandsAtom);
  const myHandRaised =
    !!collabAPI?.portal.socket?.id &&
    raisedHands.has(collabAPI.portal.socket.id);

  const [reactionsOpen, setReactionsOpen] = useState(false);
  const reactionsPopoverRef = useRef<HTMLDivElement | null>(null);

  // Close the reactions popover on outside click / Escape — same
  // pattern as the chat reaction popover.
  useEffect(() => {
    if (!reactionsOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (
        reactionsPopoverRef.current &&
        e.target instanceof Node &&
        !reactionsPopoverRef.current.contains(e.target)
      ) {
        setReactionsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReactionsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [reactionsOpen]);

  const toggleRaiseHand = useCallback(() => {
    collabAPI?.toggleRaiseHand();
    setReactionsOpen(false);
  }, [collabAPI]);

  const fireReaction = useCallback(
    (emoji: string) => {
      collabAPI?.sendMeetingReaction(emoji);
      setReactionsOpen(false);
    },
    [collabAPI],
  );

  const join = useCallback(async () => {
    if (!audioRoom) {
      return;
    }
    setAudioState((prev) => ({
      ...prev,
      status: "connecting",
      errorKind: null,
      errorMessage: null,
    }));
    try {
      await audioRoom.start();
      setAudioState((prev) => ({ ...prev, status: "live" }));
    } catch {
      // error already surfaced via onError → audioStateAtom.errorMessage
    }
  }, [audioRoom, setAudioState]);

  const toggleMute = useCallback(() => {
    audioRoom?.toggleMute();
  }, [audioRoom]);

  // Probe for a camera device once the call is live so we can disable the
  // toggle (with a reason) when there's nothing to turn on.
  useEffect(() => {
    if (audioState.status !== "live") {
      return;
    }
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
  }, [audioState.status]);

  // Camera toggle — opt-in on the EXISTING call object, default OFF. On
  // permission denial / no device we stay off and surface the reason via the
  // cameraStateAtom (the tile keeps showing the avatar).
  const toggleCamera = useCallback(async () => {
    if (!audioRoom) {
      return;
    }
    const turningOn = !audioRoom.isCameraOn();
    if (turningOn) {
      setCameraState({ status: "starting", errorMessage: null });
    }
    try {
      const on = await audioRoom.setCamera(turningOn);
      setCameraState({ status: on ? "on" : "off", errorMessage: null });
    } catch (err) {
      setCameraState({
        status: "error",
        errorMessage: err instanceof Error ? err.message : null,
      });
    }
  }, [audioRoom, setCameraState]);

  // Recording (test-mic + meeting recording) used to live in this
  // component. It's been removed pending a host-only control flow —
  // we don't want N participants each cutting their own audio file
  // from the same meeting. The recording infrastructure (atoms +
  // MeetingRecorder + micRecorder) is still in place in
  // ../../audio/* for the future host UI to consume.

  const leave = useCallback(() => {
    if (!audioRoom) {
      return;
    }
    audioRoom.stop();
    setAudioState({
      status: "idle",
      muted: false,
      canTransmit: true,
      peers: new Map(),
      errorKind: null,
      errorMessage: null,
    });
  }, [audioRoom, setAudioState]);

  // Don't render at all if the user hasn't joined a collab room yet —
  // there's nobody to call — or when reviewing a finished meeting (read-only).
  if (!activeRoomLink || viewOnly) {
    return null;
  }

  const { status, muted, canTransmit, errorKind, errorMessage } = audioState;

  // LIVE — the full media + interaction cluster, icon-only with styled
  // tooltips. Rendered as a React fragment so the HEADER controls the
  // grouping/spacing (no self-positioned wrapper anymore).
  if (status === "live") {
    const micTitle = !canTransmit
      ? t("callControls.listenOnlyTitle")
      : muted
      ? t("callControls.unmute")
      : t("callControls.mute");
    const camOn = cameraState.status === "on";
    const camStarting = cameraState.status === "starting";
    const camTitle = !hasCamera
      ? t("callControls.noCameraTitle")
      : cameraState.status === "error"
      ? t("callControls.cameraError")
      : camOn
      ? t("callControls.cameraOff")
      : t("callControls.cameraOn");

    return (
      <>
        {/* MEDIA: mic + camera. The `--cta` modifier paints the live "you can
            speak/show" state in accent; `--danger` paints the muted state red,
            mirroring every other conferencing app. */}
        <button
          type="button"
          className={`mcm-header__icon-btn mcm-tip${
            muted || !canTransmit ? " mcm-header__icon-btn--danger" : ""
          }`}
          onClick={canTransmit ? toggleMute : undefined}
          disabled={!canTransmit}
          aria-label={micTitle}
          data-mcm-tip={micTitle}
        >
          {muted || !canTransmit ? <MicOffIcon /> : <MicOnIcon />}
        </button>

        <button
          type="button"
          className={`mcm-header__icon-btn mcm-tip${
            camOn ? " mcm-header__icon-btn--active" : ""
          }`}
          onClick={hasCamera && !camStarting ? toggleCamera : undefined}
          disabled={!hasCamera || camStarting}
          aria-pressed={camOn}
          aria-label={camTitle}
          data-mcm-tip={camTitle}
        >
          {camStarting ? (
            <span className="mcm-call-controls__spinner" />
          ) : camOn ? (
            <CameraOnIcon />
          ) : (
            <CameraOffIcon />
          )}
        </button>

        {/* Virtual-background control moved to User Settings → Preferences
            (keeps the cluster compact). The persisted choice still auto-applies
            when the camera turns on — see audio/videoBg.ts. */}

        {/* INTERACTION: raise-hand + reactions. */}
        <button
          type="button"
          className={`mcm-header__icon-btn mcm-tip${
            myHandRaised ? " mcm-header__icon-btn--warn" : ""
          }`}
          onClick={toggleRaiseHand}
          data-mcm-tip={
            myHandRaised
              ? t("callControls.lowerHand")
              : t("callControls.raiseHand")
          }
          aria-label={
            myHandRaised
              ? t("callControls.lowerHand")
              : t("callControls.raiseHand")
          }
        >
          <span className="mcm-call-controls__raise-emoji">✋</span>
        </button>

        <div className="mcm-call-controls__reactions" ref={reactionsPopoverRef}>
          <button
            type="button"
            className={`mcm-header__icon-btn mcm-tip${
              reactionsOpen ? " mcm-header__icon-btn--active" : ""
            }`}
            onClick={() => setReactionsOpen((v) => !v)}
            data-mcm-tip={t("callControls.reactions")}
            aria-label={t("callControls.reactions")}
            aria-haspopup="menu"
            aria-expanded={reactionsOpen}
          >
            <SmileyIcon />
          </button>
          {reactionsOpen && (
            <div
              className="mcm-call-controls__react-popover"
              role="toolbar"
              aria-label={t("callControls.pickEmoji")}
            >
              {MEETING_REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="mcm-call-controls__react-btn"
                  onClick={() => fireReaction(emoji)}
                  title={t("callControls.sendReaction", { emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Recording — host gets an active record/stop control; non-host sees
            it disabled with a tooltip naming the host. */}
        <RecordingButton />

        {/* LEAVE CALL — leaves only the audio/video call (stays in the
            meeting / on the canvas). Distinct from header "Leave meeting". */}
        <button
          type="button"
          className="mcm-header__icon-btn mcm-tip mcm-header__icon-btn--danger"
          onClick={leave}
          aria-label={t("callControls.leaveCall")}
          data-mcm-tip={t("callControls.leaveCall")}
        >
          <PhoneOffIcon />
        </button>
      </>
    );
  }

  // CONNECTING — a single disabled spinner button (tooltip explains).
  if (status === "connecting") {
    return (
      <button
        type="button"
        className="mcm-header__icon-btn mcm-tip"
        disabled
        aria-label={t("callControls.requestingMic")}
        data-mcm-tip={t("callControls.requestingMic")}
      >
        <span className="mcm-call-controls__spinner" />
      </button>
    );
  }

  // ERROR — one icon button; the localized headline rides the tooltip, the raw
  // (dev-facing) detail rides the native title. Click = retry.
  if (status === "error") {
    const headline =
      errorKind === "mic-denied"
        ? t("callControls.micDenied")
        : errorKind === "mic-busy"
        ? t("callControls.micBusy")
        : errorKind === "call"
        ? t("callControls.callFailed")
        : t("callControls.cannotStartMic");
    return (
      <button
        type="button"
        className="mcm-header__icon-btn mcm-tip mcm-header__icon-btn--danger"
        onClick={join}
        aria-label={`${headline} — ${t("callControls.retry")}`}
        data-mcm-tip={`${headline} · ${t("callControls.retry")}`}
        title={errorMessage ?? undefined}
      >
        <MicOffIcon />
      </button>
    );
  }

  // IDLE — the "Join call" entry point. Neutral door icon, not a mic: joining
  // no longer prompts for the mic (listener-only; mic acquired on first unmute).
  return (
    <button
      type="button"
      className="mcm-header__icon-btn mcm-tip mcm-header__icon-btn--join"
      onClick={join}
      aria-label={t("callControls.joinCall")}
      data-mcm-tip={t("callControls.joinCall")}
    >
      <EnterIcon />
    </button>
  );
};

export default MeetingCallControls;
