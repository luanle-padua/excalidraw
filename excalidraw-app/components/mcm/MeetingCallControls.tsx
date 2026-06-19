// Floating control bar for the WebRTC audio call. Shows different
// states based on the AudioRoom lifecycle:
//
//   • idle      → "Join audio" pill (mic prompt happens here)
//   • connecting → spinner
//   • live      → mute toggle + leave call button
//   • error     → message + retry
//
// Mic permission requires a user gesture, so we always defer
// AudioRoom.start() to the explicit click — never auto-call it.

import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { audioRoomInstanceAtom, audioStateAtom } from "../../audio/audioState";
import {
  BLUR_STRENGTHS,
  VIDEO_BG_IMAGE_PRESETS,
  isVideoBgSupported,
  setVideoBgPref,
  videoBgAtom,
  type BlurLevel,
  type VideoBg,
} from "../../audio/videoBg";
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

// Image/landscape glyph for the "change background" control — reads as
// "scene behind me" without leaning on the camera icon (already taken).
const BackgroundIcon = () => (
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
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
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

  // Virtual-background (blur / image) state. Persisted choice drives the
  // picker's active highlight and is applied to the live call object on change.
  const videoBg = useAtomValue(videoBgAtom);
  const [bgOpen, setBgOpen] = useState(false);
  const bgPopoverRef = useRef<HTMLDivElement | null>(null);
  // Daily's background processors are DESKTOP-BROWSER only. Probe once on mount
  // (it can't change for the life of the page) so the control can disable +
  // explain itself on mobile rather than silently no-op.
  const [bgSupported] = useState(isVideoBgSupported);

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

  // Close the background picker on outside click / Escape — same pattern as
  // the reactions popover above.
  useEffect(() => {
    if (!bgOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (
        bgPopoverRef.current &&
        e.target instanceof Node &&
        !bgPopoverRef.current.contains(e.target)
      ) {
        setBgOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBgOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [bgOpen]);

  // Pick a virtual background: persist it (so it re-applies on the next camera
  // start + survives reload) AND push it to the live call object so the change
  // shows immediately if the camera is already on. updateInputSettings is a
  // no-op-safe persist when the camera is off — Daily attaches the processor
  // when a video track next appears (06-19).
  const applyVideoBg = useCallback(
    (bg: VideoBg) => {
      setVideoBgPref(bg);
      // Fire-and-forget: a processor failure must not break the picker. The raw
      // camera keeps publishing; the error is logged inside DailyAudio.
      void audioRoom?.setVideoBackground(bg).catch(() => undefined);
      setBgOpen(false);
    },
    [audioRoom],
  );

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

  if (status === "live") {
    // Compact layout — icons only, tooltips carry the labels. The
    // previous bar with full text labels (Mute / Raise hand /
    // Reactions / 2 in room / Leave call) was the widest UI element
    // on the canvas and overlapped the lower CAD / DXF anchors.
    // Switching to icons reclaims that screen space; the
    // participants strip already shows the people count, so we drop
    // the redundant "X in room" counter here.
    const micTitle = !canTransmit
      ? t("callControls.listenOnlyTitle")
      : muted
      ? t("callControls.unmute")
      : t("callControls.mute");
    return (
      <div className="mcm-call-controls mcm-call-controls--live mcm-call-controls--compact">
        <button
          type="button"
          className={`mcm-call-controls__btn mcm-call-controls__btn--mic${
            muted ? " mcm-call-controls__btn--muted" : ""
          }${!canTransmit ? " mcm-call-controls__btn--mic-listen" : ""}`}
          onClick={canTransmit ? toggleMute : undefined}
          disabled={!canTransmit}
          aria-label={micTitle}
          title={micTitle}
        >
          {muted || !canTransmit ? <MicOffIcon /> : <MicOnIcon />}
        </button>

        {(() => {
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
            <button
              type="button"
              className={`mcm-call-controls__btn mcm-call-controls__btn--cam${
                camOn ? " mcm-call-controls__btn--cam-on" : ""
              }`}
              onClick={hasCamera && !camStarting ? toggleCamera : undefined}
              disabled={!hasCamera || camStarting}
              aria-pressed={camOn}
              aria-label={camTitle}
              title={camTitle}
            >
              {camStarting ? (
                <span className="mcm-call-controls__spinner" />
              ) : camOn ? (
                <CameraOnIcon />
              ) : (
                <CameraOffIcon />
              )}
            </button>
          );
        })()}

        {/* Virtual background — blur or a company scene applied to the local
            camera via Daily's video processor. Desktop-only (the processor is
            unsupported on mobile web); disabled there with an explaining
            tooltip. Lives next to the camera toggle since it only affects the
            outgoing camera feed. */}
        <div className="mcm-call-controls__bg" ref={bgPopoverRef}>
          <button
            type="button"
            className={`mcm-call-controls__btn mcm-call-controls__btn--bg${
              videoBg.kind !== "none"
                ? " mcm-call-controls__btn--bg-active"
                : ""
            }${bgOpen ? " mcm-call-controls__btn--bg-open" : ""}`}
            onClick={bgSupported ? () => setBgOpen((v) => !v) : undefined}
            disabled={!bgSupported}
            aria-haspopup="menu"
            aria-expanded={bgOpen}
            title={
              bgSupported
                ? t("videoBg.title")
                : t("videoBg.desktopOnlyTitle")
            }
            aria-label={
              bgSupported
                ? t("videoBg.title")
                : t("videoBg.desktopOnlyTitle")
            }
          >
            <BackgroundIcon />
          </button>
          {bgOpen && bgSupported && (
            <div
              className="mcm-call-controls__bg-popover"
              role="menu"
              aria-label={t("videoBg.title")}
            >
              <div className="mcm-call-controls__bg-section">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={videoBg.kind === "none"}
                  className={`mcm-call-controls__bg-item${
                    videoBg.kind === "none"
                      ? " mcm-call-controls__bg-item--active"
                      : ""
                  }`}
                  onClick={() => applyVideoBg({ kind: "none" })}
                >
                  {t("videoBg.none")}
                </button>
              </div>

              <div className="mcm-call-controls__bg-label">
                {t("videoBg.blur")}
              </div>
              <div className="mcm-call-controls__bg-section mcm-call-controls__bg-section--row">
                {(Object.keys(BLUR_STRENGTHS) as BlurLevel[]).map((level) => {
                  const active =
                    videoBg.kind === "blur" && videoBg.level === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`mcm-call-controls__bg-chip${
                        active ? " mcm-call-controls__bg-chip--active" : ""
                      }`}
                      onClick={() => applyVideoBg({ kind: "blur", level })}
                    >
                      {t(`videoBg.blur_${level}`)}
                    </button>
                  );
                })}
              </div>

              <div className="mcm-call-controls__bg-label">
                {t("videoBg.images")}
              </div>
              <div className="mcm-call-controls__bg-section mcm-call-controls__bg-grid">
                {VIDEO_BG_IMAGE_PRESETS.map((preset) => {
                  const active =
                    videoBg.kind === "image" && videoBg.src === preset.src;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`mcm-call-controls__bg-thumb${
                        active ? " mcm-call-controls__bg-thumb--active" : ""
                      }`}
                      style={{ backgroundImage: `url("${preset.src}")` }}
                      onClick={() =>
                        applyVideoBg({ kind: "image", src: preset.src })
                      }
                      title={t(preset.labelKey)}
                      aria-label={t(preset.labelKey)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`mcm-call-controls__btn mcm-call-controls__btn--raise${
            myHandRaised ? " mcm-call-controls__btn--raised" : ""
          }`}
          onClick={toggleRaiseHand}
          title={
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
            className={`mcm-call-controls__btn mcm-call-controls__btn--react${
              reactionsOpen ? " mcm-call-controls__btn--react-open" : ""
            }`}
            onClick={() => setReactionsOpen((v) => !v)}
            title={t("callControls.reactions")}
            aria-label={t("callControls.reactions")}
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

        {/* Recording — host gets an active record/stop icon; non-host
              sees the same icon disabled with a tooltip naming the
              host. Lives in the call bar so the feature is exactly
              where users look for call-related controls. */}
        <RecordingButton />

        <button
          type="button"
          className="mcm-call-controls__btn mcm-call-controls__btn--leave"
          onClick={leave}
          aria-label={t("callControls.leaveCall")}
          title={t("callControls.leaveCall")}
        >
          <PhoneOffIcon />
        </button>
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="mcm-call-controls">
        <button type="button" className="mcm-call-controls__btn" disabled>
          <span className="mcm-call-controls__spinner" />
          <span>{t("callControls.requestingMic")}</span>
        </button>
      </div>
    );
  }

  if (status === "error") {
    // errorKind → localized message; the raw error detail (dev-facing,
    // often an English browser/Daily string) only rides the tooltip.
    return (
      <div className="mcm-call-controls mcm-call-controls--error">
        <span
          className="mcm-call-controls__err"
          title={errorMessage ?? undefined}
        >
          {errorKind === "mic-denied"
            ? t("callControls.micDenied")
            : errorKind === "mic-busy"
            ? t("callControls.micBusy")
            : errorKind === "call"
            ? t("callControls.callFailed")
            : t("callControls.cannotStartMic")}
        </span>
        <button
          type="button"
          className="mcm-call-controls__btn mcm-call-controls__btn--retry"
          onClick={join}
        >
          {t("callControls.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="mcm-call-controls">
      <button
        type="button"
        className="mcm-call-controls__btn mcm-call-controls__btn--join"
        onClick={join}
        aria-label={t("callControls.joinCall")}
      >
        <MicOnIcon />
        <span>{t("callControls.joinCall")}</span>
      </button>
    </div>
  );
};

export default MeetingCallControls;
