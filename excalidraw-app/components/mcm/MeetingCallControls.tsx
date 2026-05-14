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
import {
  audioRoomInstanceAtom,
  audioStateAtom,
  recorderInstanceAtom,
  recordingStateAtom,
} from "../../audio/audioState";
import { MeetingRecorder } from "../../audio/MeetingRecorder";
import { recordMic } from "../../audio/micRecorder";
import type { MicRecording } from "../../audio/micRecorder";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  raisedHandsAtom,
} from "../../collab/Collab";

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

const TEST_DURATION_MS = 5000;

const fmtDuration = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

export const MeetingCallControls = () => {
  const audioState = useAtomValue(audioStateAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const recorder = useAtomValue(recorderInstanceAtom);
  const setRecorder = useSetAtom(recorderInstanceAtom);
  const recordingState = useAtomValue(recordingStateAtom);
  const setRecordingState = useSetAtom(recordingStateAtom);
  const [recordingElapsed, setRecordingElapsed] = useState(0);

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

  // Mic-test recording state. Lives entirely on the controls component
  // — it's a diagnostic affordance, not part of the call lifecycle.
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [lastRecording, setLastRecording] = useState<MicRecording | null>(
    null,
  );

  // Free the previous blob URL when a new recording overwrites it or
  // the component unmounts — otherwise we leak memory across tests.
  useEffect(() => {
    return () => {
      if (lastRecording) {
        URL.revokeObjectURL(lastRecording.url);
      }
    };
  }, [lastRecording]);

  const testMic = useCallback(async () => {
    if (!audioRoom) {
      return;
    }
    const stream = audioRoom.getLocalStream();
    if (!stream) {
      setRecordError(
        "Không có local mic stream — máy này đang ở chế độ chỉ-nghe.",
      );
      return;
    }
    setRecordError(null);
    if (lastRecording) {
      URL.revokeObjectURL(lastRecording.url);
      setLastRecording(null);
    }
    setRecording(true);
    try {
      const result = await recordMic(stream, TEST_DURATION_MS);
      setLastRecording(result);
    } catch (err) {
      setRecordError((err as Error)?.message ?? "Recording failed");
    } finally {
      setRecording(false);
    }
  }, [audioRoom, lastRecording]);

  const dismissRecording = useCallback(() => {
    if (lastRecording) {
      URL.revokeObjectURL(lastRecording.url);
    }
    setLastRecording(null);
    setRecordError(null);
  }, [lastRecording]);

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

  // -----------------------------------------------------------------
  // Meeting recording — mix local mic + every peer's remote stream
  // into a single MediaStream, then save to a webm/opus blob.
  // -----------------------------------------------------------------

  const startRecording = useCallback(async () => {
    if (!audioRoom || recordingState.status !== "idle") {
      return;
    }
    // Revoke the previous result so we don't leak its blob URL.
    if (recordingState.lastResult) {
      URL.revokeObjectURL(recordingState.lastResult.url);
    }

    let rec: MeetingRecorder;
    try {
      rec = new MeetingRecorder();
    } catch (err) {
      setRecordingState({
        status: "idle",
        inputCount: 0,
        lastResult: null,
        errorMessage:
          (err as Error)?.message ??
          "Trình duyệt không hỗ trợ ghi âm",
      });
      return;
    }

    let inputCount = 0;
    const local = audioRoom.getLocalStream();
    if (local) {
      rec.addLocalStream(local);
      inputCount++;
    }
    for (const { socketId, stream } of audioRoom.getPeerStreams()) {
      rec.addStream(socketId, stream);
      inputCount++;
    }

    try {
      rec.start();
    } catch (err) {
      rec.close();
      setRecordingState({
        status: "idle",
        inputCount: 0,
        lastResult: null,
        errorMessage: (err as Error)?.message ?? "Không thể bắt đầu ghi",
      });
      return;
    }

    setRecorder(rec);
    setRecordingState({
      status: "recording",
      inputCount,
      lastResult: null,
      errorMessage: null,
    });
    setRecordingElapsed(0);
  }, [audioRoom, recordingState, setRecorder, setRecordingState]);

  const stopRecording = useCallback(async () => {
    if (!recorder || recordingState.status !== "recording") {
      return;
    }
    setRecordingState((prev) => ({ ...prev, status: "finalizing" }));
    try {
      const result = await recorder.stop();
      recorder.close();
      setRecorder(null);
      setRecordingState({
        status: "idle",
        inputCount: 0,
        lastResult: result,
        errorMessage: null,
      });
      setRecordingElapsed(0);
    } catch (err) {
      recorder.close();
      setRecorder(null);
      setRecordingState({
        status: "idle",
        inputCount: 0,
        lastResult: null,
        errorMessage:
          (err as Error)?.message ?? "Lưu file ghi âm thất bại",
      });
    }
  }, [recorder, recordingState, setRecorder, setRecordingState]);

  // Live duration counter — drives the "REC 0:23" pill while a
  // recording is in progress. Falls back to silence (0) outside that.
  useEffect(() => {
    if (recordingState.status !== "recording" || !recorder) {
      return;
    }
    const id = window.setInterval(() => {
      setRecordingElapsed(recorder.elapsedMs());
    }, 500);
    return () => window.clearInterval(id);
  }, [recordingState.status, recorder]);

  const dismissLastRecording = useCallback(() => {
    if (recordingState.lastResult) {
      URL.revokeObjectURL(recordingState.lastResult.url);
    }
    setRecordingState((prev) => ({
      ...prev,
      lastResult: null,
      errorMessage: null,
    }));
  }, [recordingState.lastResult, setRecordingState]);

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
      <>
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
              !canTransmit ? "Listen-only (no mic)" : muted ? "Unmute" : "Mute"
            }
            title={
              !canTransmit
                ? "Máy này không có mic — chỉ nghe được"
                : muted
                ? "Unmute"
                : "Mute"
            }
          >
            {muted || !canTransmit ? <MicOffIcon /> : <MicOnIcon />}
            <span>
              {!canTransmit
                ? "Chỉ nghe"
                : muted
                ? "Unmute"
                : "Mute"}
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
            title={myHandRaised ? "Hạ tay xuống" : "Giơ tay"}
          >
            <span className="mcm-call-controls__raise-emoji">✋</span>
            <span>{myHandRaised ? "Hạ tay" : "Giơ tay"}</span>
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
              title="Reactions"
            >
              <SmileyIcon />
              <span>Reactions</span>
            </button>
            {reactionsOpen && (
              <div
                className="mcm-call-controls__react-popover"
                role="toolbar"
                aria-label="Chọn emoji"
              >
                {MEETING_REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="mcm-call-controls__react-btn"
                    onClick={() => fireReaction(emoji)}
                    title={`Gửi ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Per-user "Test mic" + "Record meeting" buttons removed for
              the demo. Recording will move to host-only control in a
              follow-up — until then we don't want N people each cutting
              their own audio file from the same meeting. The recording
              state code is preserved so the playback strip below still
              works if a recording is already in progress; new starts
              are routed through nothing for now. */}

          {recordingState.status === "recording" ? (
            <button
              type="button"
              className="mcm-call-controls__btn mcm-call-controls__btn--rec-stop"
              onClick={stopRecording}
              title={`Đang ghi ${recordingState.inputCount} nguồn — bấm để dừng`}
            >
              <span className="mcm-call-controls__rec-dot" />
              REC {fmtDuration(recordingElapsed)}
            </button>
          ) : recordingState.status === "finalizing" ? (
            <button
              type="button"
              className="mcm-call-controls__btn"
              disabled
            >
              <span className="mcm-call-controls__spinner" />
              Đang lưu…
            </button>
          ) : null}

          <span className="mcm-call-controls__count">
            {peerCount === 0 ? "Đang gọi…" : `${peerCount + 1} người`}
          </span>
          <button
            type="button"
            className="mcm-call-controls__btn mcm-call-controls__btn--leave"
            onClick={leave}
            aria-label="Leave audio"
            title="Leave audio"
          >
            <PhoneOffIcon />
            <span>Rời call</span>
          </button>
        </div>

        {(lastRecording || recordError) && (
          <div className="mcm-call-playback">
            {recordError && (
              <span className="mcm-call-playback__err">{recordError}</span>
            )}
            {lastRecording && (
              <>
                <span className="mcm-call-playback__label">
                  Đoạn ghi {Math.round(lastRecording.durationMs / 100) / 10}s —
                  nghe lại:
                </span>
                <audio
                  src={lastRecording.url}
                  controls
                  autoPlay
                  className="mcm-call-playback__audio"
                />
                <a
                  href={lastRecording.url}
                  download={`mic-test-${Date.now()}.webm`}
                  className="mcm-call-playback__dl"
                >
                  Tải về
                </a>
              </>
            )}
            <button
              type="button"
              className="mcm-call-playback__close"
              onClick={dismissRecording}
              aria-label="Đóng"
            >
              ×
            </button>
          </div>
        )}

        {(recordingState.lastResult || recordingState.errorMessage) && (
          <div className="mcm-call-playback mcm-call-playback--meeting">
            {recordingState.errorMessage && (
              <span className="mcm-call-playback__err">
                {recordingState.errorMessage}
              </span>
            )}
            {recordingState.lastResult && (
              <>
                <span className="mcm-call-playback__label">
                  📼 File ghi (
                  {fmtDuration(recordingState.lastResult.durationMs)})
                </span>
                <audio
                  src={recordingState.lastResult.url}
                  controls
                  className="mcm-call-playback__audio"
                />
                <a
                  href={recordingState.lastResult.url}
                  download={`meeting-${Date.now()}.webm`}
                  className="mcm-call-playback__dl"
                >
                  Tải về
                </a>
              </>
            )}
            <button
              type="button"
              className="mcm-call-playback__close"
              onClick={dismissLastRecording}
              aria-label="Đóng"
            >
              ×
            </button>
          </div>
        )}
      </>
    );
  }

  if (status === "connecting") {
    return (
      <div className="mcm-call-controls">
        <button type="button" className="mcm-call-controls__btn" disabled>
          <span className="mcm-call-controls__spinner" />
          <span>Đang xin quyền mic…</span>
        </button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mcm-call-controls mcm-call-controls--error">
        <span className="mcm-call-controls__err">
          {errorMessage ?? "Không thể bật mic"}
        </span>
        <button
          type="button"
          className="mcm-call-controls__btn mcm-call-controls__btn--retry"
          onClick={join}
        >
          Thử lại
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
        aria-label="Join audio call"
      >
        <MicOnIcon />
        <span>Bật mic & vào call</span>
      </button>
    </div>
  );
};

export default MeetingCallControls;
