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
  activeRoomLinkAtom,
  collabAPIAtom,
  raisedHandsAtom,
} from "../../collab/Collab";
import { useT } from "../../i18n/mcm";

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

const PhoneOffIcon = () => (
  <Icon d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91 M23 1L1 23" />
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
      errorMessage: null,
    });
  }, [audioRoom, setAudioState]);

  // Don't render at all if the user hasn't joined a collab room yet —
  // there's nobody to call.
  if (!activeRoomLink) {
    return null;
  }

  const { status, muted, canTransmit, peers, errorMessage } = audioState;
  const peerCount = peers.size;

  if (status === "live") {
    return (
      <div className="mcm-call-controls mcm-call-controls--live">
        {/* Mute is the PRIMARY action — always rendered as a clear
              button (disabled in listen-only so the user still sees
              "where the control is" instead of just a "👂 listening"
              label). */}
        <button
          type="button"
          className={`mcm-call-controls__btn mcm-call-controls__btn--mic${
            muted ? " mcm-call-controls__btn--muted" : ""
          }${!canTransmit ? " mcm-call-controls__btn--mic-listen" : ""}`}
          onClick={canTransmit ? toggleMute : undefined}
          disabled={!canTransmit}
          aria-label={
            !canTransmit
              ? t("callControls.listenOnlyTitle")
              : muted
              ? t("callControls.unmute")
              : t("callControls.mute")
          }
          title={
            !canTransmit
              ? t("callControls.listenOnlyTitle")
              : muted
              ? t("callControls.unmute")
              : t("callControls.mute")
          }
        >
          {muted || !canTransmit ? <MicOffIcon /> : <MicOnIcon />}
          <span>
            {!canTransmit
              ? t("callControls.listenOnly")
              : muted
              ? t("callControls.unmute")
              : t("callControls.mute")}
          </span>
        </button>

        {/* Raise hand — sticky toggle. Visible badge state lets the
              user see whether their hand is up at a glance. */}
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
        >
          <span className="mcm-call-controls__raise-emoji">✋</span>
          <span>
            {myHandRaised
              ? t("callControls.lowerHand")
              : t("callControls.raiseHand")}
          </span>
        </button>

        {/* Reactions — opens a small popover with 6 quick emojis.
              Each one fires a one-shot broadcast that animates over
              the sender's avatar in the participants strip. */}
        <div className="mcm-call-controls__reactions" ref={reactionsPopoverRef}>
          <button
            type="button"
            className={`mcm-call-controls__btn mcm-call-controls__btn--react${
              reactionsOpen ? " mcm-call-controls__btn--react-open" : ""
            }`}
            onClick={() => setReactionsOpen((v) => !v)}
            title={t("callControls.reactions")}
          >
            <SmileyIcon />
            <span>{t("callControls.reactions")}</span>
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

        <span className="mcm-call-controls__count">
          {peerCount === 0
            ? t("callControls.callingNoPeers")
            : t("participants.countInRoom", { count: peerCount + 1 })}
        </span>
        <button
          type="button"
          className="mcm-call-controls__btn mcm-call-controls__btn--leave"
          onClick={leave}
          aria-label={t("callControls.leaveCall")}
          title={t("callControls.leaveCall")}
        >
          <PhoneOffIcon />
          <span>{t("callControls.leaveCall")}</span>
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
    return (
      <div className="mcm-call-controls mcm-call-controls--error">
        <span className="mcm-call-controls__err">
          {errorMessage ?? t("callControls.cannotStartMic")}
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
