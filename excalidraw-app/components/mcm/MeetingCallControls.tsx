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
//   • idle       → "Call" icon button (NO mic prompt — joins listener-only)
//   • connecting → spinner icon (disabled)
//   • live       → an ACTIVE "Leave call" toggle (PhoneOff glyph; click = leave
//                  the call, stay on the canvas) + mic / camera / raise-hand /
//                  reactions / recording
//   • error      → a single error icon button (tooltip carries the message);
//                  click = retry
//
// Joining is mic-free: start() enters listening-only and the mic is acquired
// lazily on the first unmute (or when STT turns on), so the browser permission
// prompt fires on that later click — itself a user gesture.

import {
  Hand,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Smile,
  Video,
  VideoOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { audioRoomInstanceAtom, audioStateAtom } from "../../audio/audioState";
import { useJoinCall } from "../../audio/useJoinCall";
import {
  cameraErrorKindForDomException,
  cameraStateAtom,
} from "../../audio/videoState";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
  raisedHandsAtom,
} from "../../collab/Collab";
import { useT } from "../../i18n/mcm";

import { CloudRecordingControls } from "./CloudRecordingControls";

// Icon system: ALL call-control glyphs are lucide-react at size 18, matching the
// rest of the meeting header (MeetingHeader.tsx, LayoutSwitcher, LangTheme). This
// replaces the old hand-rolled inline <svg> paths (mic/cam/leave/enter) + the ✋
// and ☺ glyphs, which sat at a different stroke weight than their lucide
// neighbours and made the action row read as two mismatched icon families.
const ICON_SIZE = 18;

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

  // The idle "Join" button and the error-retry button both join listener-only
  // (no mic/camera intent) — the pre-join modal is the path that carries an
  // intent. Both share useJoinCall() so the join logic is identical everywhere.
  const joinCall = useJoinCall();
  const join = useCallback(() => {
    void joinCall();
  }, [joinCall]);

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
      setCameraState({
        status: "starting",
        errorKind: null,
        errorMessage: null,
      });
    }
    try {
      const on = await audioRoom.setCamera(turningOn);
      setCameraState({
        status: on ? "on" : "off",
        errorKind: null,
        errorMessage: null,
      });
    } catch (err) {
      // The toggle acquires the camera via getUserMedia itself, so it surfaces a
      // raw DOMException (not Daily's structured camera-error). Classify the
      // exception NAME into the same CameraErrorKind vocabulary so the UI shows
      // the right guidance (a "permissions" code → "allow camera" prompt).
      setCameraState({
        status: "error",
        errorKind: cameraErrorKindForDomException(
          err instanceof Error ? err.name : undefined,
        ),
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
      ? t("callControls.enableMic")
      : muted
      ? t("callControls.unmute")
      : t("callControls.mute");
    const camOn = cameraState.status === "on";
    const camStarting = cameraState.status === "starting";
    const camTitle = !hasCamera
      ? t("callControls.noCameraTitle")
      : cameraState.status === "error"
      ? // Type-specific guidance from the language-neutral CameraErrorKind:
        // "permissions" gets the actionable "allow camera/mic" prompt; every
        // other kind falls back to the generic camera-error message.
        cameraState.errorKind === "permissions"
        ? t("callControls.cameraPermission")
        : t("callControls.cameraError")
      : camOn
      ? t("callControls.cameraOff")
      : t("callControls.cameraOn");

    return (
      <>
        {/* CALL toggle (active) — the leftmost media control in BOTH idle and
            live states, so its position never shifts. Active highlight signals
            "you're in the call"; clicking it leaves ONLY the audio/video call
            (drops Daily) and stays on the canvas / in the meeting. The glyph is
            PhoneOff (hung-up handset) — distinct from the idle Phone (join) so
            the two call-lifecycle states never read as the same button — and
            distinct from the header's "Leave meeting" (LogOut) and "End for all"
            (Power). */}
        <button
          type="button"
          className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip mcm-header__icon-btn--active"
          onClick={leave}
          aria-label={t("callControls.leaveCall")}
          aria-pressed={true}
          data-mcm-tip={t("callControls.leaveCall")}
        >
          <PhoneOff size={ICON_SIZE} />
          <span className="mcm-header__icon-label">
            {t("callControls.leaveCall")}
          </span>
        </button>

        {/* MEDIA: mic + camera. The `--cta` modifier paints the live "you can
            speak/show" state in accent; `--danger` paints the muted state red,
            mirroring every other conferencing app. */}
        <button
          type="button"
          className={`mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip${
            muted || !canTransmit ? " mcm-header__icon-btn--danger" : ""
          }`}
          // #25 FIX: the mic button MUST be clickable even when listener-only
          // (!canTransmit = no mic yet). Tapping it is exactly what acquires the
          // first mic — toggleMute → ensureMic fires the permission prompt ON
          // THIS USER GESTURE, which iOS Safari REQUIRES (an auto getUserMedia
          // off-gesture hangs/blocks). Gating disabled={!canTransmit} was a
          // deadlock: you couldn't tap to get a mic, so listener-only users (esp.
          // iPhone, where STT didn't pre-acquire it) could never unmute.
          onClick={toggleMute}
          aria-label={micTitle}
          data-mcm-tip={micTitle}
        >
          {muted || !canTransmit ? (
            <MicOff size={ICON_SIZE} />
          ) : (
            <Mic size={ICON_SIZE} />
          )}
          {/* State-neutral inline label (the icon + tooltip carry mute state);
              hidden under 1100px back to icon-only. */}
          <span className="mcm-header__icon-label">
            {t("callControls.micLabel")}
          </span>
        </button>

        <button
          type="button"
          className={`mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip${
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
            <Video size={ICON_SIZE} />
          ) : (
            <VideoOff size={ICON_SIZE} />
          )}
          <span className="mcm-header__icon-label">
            {t("callControls.cameraLabel")}
          </span>
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
          <Hand size={ICON_SIZE} />
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
            <Smile size={ICON_SIZE} />
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

        {/* Phase 5 — CLOUD recording: host-only Record/Stop + content picker.
            Drives a server-side Daily cloud recording of the merged call room
            (voice + camera + screen → one MP4) and broadcasts RECORDING_STATE
            so everyone sees the REC indicator (rendered in the header). Non-host
            renders nothing here. (The legacy host-local audio recorder
            RecordingControls.tsx stays in the tree but is no longer wired in.) */}
        <CloudRecordingControls />
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
        : errorKind === "meeting-full"
        ? t("callControls.meetingFull")
        : errorKind === "token-expired"
        ? t("callControls.tokenExpired")
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
        <MicOff size={ICON_SIZE} />
      </button>
    );
  }

  // IDLE — the "Call" entry point (Phone glyph, sans the active highlight). The
  // live toggle uses PhoneOff so join vs leave-call never read as the same
  // button. Joining no longer prompts for the mic (listener-only; the mic is
  // acquired on the first unmute), so the phone reads "join the call" without
  // promising the mic turns on. Same leftmost slot as the live toggle so it
  // never jumps when the call state flips.
  return (
    <button
      type="button"
      className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip mcm-header__icon-btn--call-cta"
      onClick={join}
      aria-label={t("callControls.call")}
      data-mcm-tip={t("callControls.call")}
    >
      <Phone size={ICON_SIZE} />
      <span className="mcm-header__icon-label">{t("callControls.call")}</span>
    </button>
  );
};

export default MeetingCallControls;
