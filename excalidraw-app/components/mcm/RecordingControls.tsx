// Meeting recording UI — a SINGLE inline element rendered inside the
// bottom call-controls pill. There is no floating banner anywhere on
// the canvas; the previous design's top-center red banner was felt
// to be "lung tung" (cluttered), so all state lives in the call bar.
//
// `RecordingButton` renders four shapes depending on (isHost, isRecording):
//
//   • host + idle       → small red record-dot button
//   • host + recording  → inline pill "🔴 0:05 ■" — click stops
//   • peer + recording  → same pill MINUS the stop icon (read-only),
//                         tooltip names the host
//   • peer + idle       → disabled record-dot button, tooltip names
//                         the host so the feature is discoverable
//
// All four shapes occupy a single call-bar slot so the bar width is
// stable across state transitions.
//
// Logic is encapsulated in the `useRecording` hook so callers don't
// The hook also handles the MeetingRecorder lifecycle (provision on
// host start, mix in local + peer streams, tear down on stop, trigger
// download). We deliberately do NOT auto-upload the file to the
// meeting library — multi-MB opus blobs would blow up the websocket
// library broadcast + localStorage quotas. Host downloads, then drags
// into the library if they want to share.

import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  audioRoomInstanceAtom,
  audioStateAtom,
  recorderInstanceAtom,
  recordingStateAtom,
} from "../../audio/audioState";
import { MeetingRecorder } from "../../audio/MeetingRecorder";
import { activeRoomLinkAtom, collabAPIAtom } from "../../collab/Collab";
import {
  resetRoomRecording,
  roomRecordingAtom,
  setRoomRecording,
} from "../../data/roomRecording";
import {
  hostSocketIdAtom,
  mySocketIdAtom,
  peerProfilesAtom,
  userProfileAtom,
} from "../../data/userProfile";

import type { RecordingResult } from "../../audio/MeetingRecorder";

const RecordIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    fill="currentColor"
  >
    <circle cx="12" cy="12" r="6" />
  </svg>
);

const StopIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    fill="currentColor"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const DownloadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 4v12" />
    <path d="M6 14l6 6 6-6" />
    <path d="M4 22h16" />
  </svg>
);

/** Format milliseconds into `M:SS` (or `H:MM:SS` past an hour). */
const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0:00";
  }
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${m}:${pad(s)}`;
};

const buildFileName = (startedAt: number): string => {
  const d = new Date(startedAt);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `mcm-recording-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate(),
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.webm`;
};

const triggerDownload = (result: RecordingResult, startedAt: number): void => {
  const a = document.createElement("a");
  a.href = result.url;
  a.download = buildFileName(startedAt);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

/** Re-render every second while recording so the elapsed timer ticks
 *  off the same baseline on every peer. Returns Date.now() each tick. */
const useTick = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
};

type RecordingApi = {
  inActiveRoom: boolean;
  isHost: boolean;
  isRecording: boolean;
  finalizing: boolean;
  audioReady: boolean;
  hostName: string;
  elapsedMs: number;
  lastResult: RecordingResult | null;
  errorMessage: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  redownload: () => void;
};

/** Shared recording controller — encapsulates the MeetingRecorder
 *  lifecycle + broadcast wiring so `RecordingButton` can stay
 *  presentational. Today the only caller is `RecordingButton`; the
 *  hook stays separate so future surfaces (e.g. a settings panel
 *  control row) can plug in without duplicating lifecycle logic. */
const useRecording = (): RecordingApi => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const audioState = useAtomValue(audioStateAtom);
  const recorder = useAtomValue(recorderInstanceAtom);
  const recordingState = useAtomValue(recordingStateAtom);
  const roomRecording = useAtomValue(roomRecordingAtom);
  const mySocketId = useAtomValue(mySocketIdAtom);
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const myProfile = useAtomValue(userProfileAtom);
  const setRecorderInstance = useSetAtom(recorderInstanceAtom);
  const setRecordingState = useSetAtom(recordingStateAtom);

  const isHost = !!mySocketId && mySocketId === hostSocketId;
  const isRecording =
    recordingState.status === "recording" || roomRecording.recording;
  const finalizing = recordingState.status === "finalizing";
  const startedAt = roomRecording.startedAt;
  const now = useTick(isRecording);
  const elapsedMs =
    isRecording && startedAt != null ? Math.max(0, now - startedAt) : 0;

  // Resolve a friendly host name even when the host's USER_PROFILE
  // broadcast hasn't landed yet (chain: explicit name on the
  // RECORDING_STATE payload → cached peer profile → my own profile
  // if I'm the host → generic fallback).
  const hostName =
    roomRecording.hostName ??
    (roomRecording.hostSocketId
      ? peerProfiles.get(roomRecording.hostSocketId)?.username
      : null) ??
    (isHost ? myProfile?.username : null) ??
    (hostSocketId
      ? peerProfiles.get(hostSocketId)?.username ?? "Host"
      : "Host");

  const [lastResult, setLastResult] = useState<RecordingResult | null>(null);
  const [lastResultStartedAt, setLastResultStartedAt] = useState<number | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ensureRecorder = useCallback((): MeetingRecorder => {
    if (recorder) {
      return recorder;
    }
    const next = new MeetingRecorder();
    setRecorderInstance(next);
    return next;
  }, [recorder, setRecorderInstance]);

  const start = useCallback(async () => {
    if (!collabAPI || !audioRoom) {
      setErrorMessage("Audio call chưa sẵn sàng");
      return;
    }
    setErrorMessage(null);
    const rec = ensureRecorder();
    let inputCount = 0;
    const localStream = audioRoom.getLocalStream();
    if (localStream) {
      rec.addLocalStream(localStream);
      inputCount += 1;
    }
    for (const { socketId, stream } of audioRoom.getPeerStreams()) {
      rec.addStream(socketId, stream);
      inputCount += 1;
    }
    if (inputCount === 0) {
      // No mic, no peers — recording would produce a 0-byte file.
      // Bail before MediaRecorder runs so the user gets a clear error.
      setErrorMessage(
        "Không có nguồn âm thanh nào — vào audio call rồi thử lại",
      );
      return;
    }
    try {
      // `await` is important: MeetingRecorder.start() now resumes the
      // AudioContext first (it may be in `suspended` state after tab
      // focus changes / autoplay policy). Without the resume, the
      // destination stream produces no data and every `ondataavailable`
      // event from MediaRecorder fires with `size: 0`, leaving us with
      // an empty .webm on stop.
      await rec.start();
    } catch (err) {
      const msg = (err as Error)?.message ?? "Không thể bắt đầu ghi";
      setErrorMessage(msg);
      setRecordingState((prev) => ({ ...prev, errorMessage: msg }));
      return;
    }
    const ts = Date.now();
    setRecordingState({
      status: "recording",
      inputCount,
      lastResult: null,
      errorMessage: null,
    });
    // Set the host's OWN room-recording atom too. Without this, the
    // host's UI reads `roomRecording.startedAt` (null on the host
    // because their own broadcast doesn't echo back through the
    // socket), so the inline timer pill stays at 0:00 forever while
    // peers see the seconds tick. Setting both sides of the broadcast
    // locally keeps the host + peer views in sync.
    setRoomRecording({
      recording: true,
      hostSocketId: mySocketId ?? null,
      hostName: myProfile?.username ?? null,
      startedAt: ts,
    });
    collabAPI.publishRecordingState({ recording: true, startedAt: ts });
  }, [
    audioRoom,
    collabAPI,
    ensureRecorder,
    mySocketId,
    myProfile?.username,
    setRecordingState,
  ]);

  const stop = useCallback(async () => {
    if (!collabAPI || !recorder) {
      return;
    }
    // Snapshot startedAt BEFORE we clear the room atom — it drives the
    // download filename and the lastResultStartedAt slot used by
    // re-download. Reading after resetRoomRecording() would land us
    // on Date.now() instead of the actual recording start.
    const finalStartedAt = roomRecording.startedAt ?? Date.now();
    setRecordingState((prev) => ({ ...prev, status: "finalizing" }));
    try {
      const result = await recorder.stop();
      recorder.close();
      setRecorderInstance(null);
      setLastResult(result);
      setLastResultStartedAt(finalStartedAt);
      if (result.blob.size > 0) {
        triggerDownload(result, finalStartedAt);
      } else {
        // Sanity check — should be unreachable now that start() rejects
        // a no-input recording up front, but keeps users from getting
        // a useless 0-byte file with no explanation if some browser /
        // device combination still produces one.
        setErrorMessage("File ghi âm trống — kiểm tra mic và thử lại");
      }
      setRecordingState({
        status: "idle",
        inputCount: 0,
        lastResult: result,
        errorMessage: null,
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? "Lỗi khi dừng ghi";
      setErrorMessage(msg);
      setRecordingState((prev) => ({
        ...prev,
        status: "idle",
        errorMessage: msg,
      }));
    } finally {
      resetRoomRecording();
      collabAPI.publishRecordingState({ recording: false, startedAt: null });
    }
  }, [
    collabAPI,
    recorder,
    setRecorderInstance,
    setRecordingState,
    roomRecording.startedAt,
  ]);

  // Best-effort: emit a stop broadcast on tab close so peers don't
  // see an indefinitely-stuck "Đang ghi âm" banner. Bytes are lost
  // (we can't await async stop()), but the banner clears.
  const broadcastStopRef = useRef<(() => void) | null>(null);
  broadcastStopRef.current = () => {
    if (recordingState.status === "recording") {
      collabAPI?.publishRecordingState({ recording: false, startedAt: null });
    }
  };
  useEffect(() => {
    const onUnload = () => broadcastStopRef.current?.();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const redownload = useCallback(() => {
    if (!lastResult || lastResultStartedAt == null) {
      return;
    }
    triggerDownload(lastResult, lastResultStartedAt);
  }, [lastResult, lastResultStartedAt]);

  return {
    inActiveRoom: !!activeRoomLink,
    isHost,
    isRecording,
    finalizing,
    audioReady: audioState.status === "live",
    hostName,
    elapsedMs,
    lastResult,
    errorMessage,
    start,
    stop,
    redownload,
  };
};

/** Recording-in-progress indicator + control, ALWAYS rendered INSIDE
 *  the call-controls pill (no floating banner on the canvas). The
 *  previous design plastered a wide red banner across the top of the
 *  canvas while recording was active — the user called it "lung
 *  tung" (cluttered). Folding the state into the existing call bar
 *  removes that overlay entirely; the live state is now communicated
 *  via the same pulsing red dot every other conferencing app uses,
 *  in the same place every other call control lives.
 *
 *  Three shapes:
 *
 *    • host + idle       → a single red record-dot button.
 *    • host + recording  → an inline pill "🔴 0:05 ■" — clicking the
 *                          stop icon ends the recording.
 *    • peer + recording  → the same pill MINUS the stop icon, with
 *                          a tooltip naming the host. Read-only.
 *    • peer + idle       → a disabled record-dot button with a
 *                          tooltip naming the host. Discoverable but
 *                          not actionable.
 *
 *  The pill, recording badge, and idle button all share the same
 *  call-bar slot, so the bar width never changes between states. */
export const RecordingButton = () => {
  const rec = useRecording();
  if (!rec.inActiveRoom) {
    return null;
  }
  // Show the Re-download button only for the host AND only between
  // recordings — during a live recording, the Stop button is more
  // useful at that slot.
  const showRedownload =
    rec.isHost && !rec.isRecording && !rec.finalizing && !!rec.lastResult;

  // RECORDING IS ACTIVE — render the inline indicator pill (visible
  // to BOTH host and peers). The host's variant exposes a stop icon
  // on the right end of the pill; the peer's variant is a static
  // status pill with a host-name tooltip.
  if (rec.isRecording) {
    const tooltip = rec.isHost
      ? `Đang ghi âm · ${formatElapsed(rec.elapsedMs)} — bấm để dừng`
      : `${rec.hostName} đang ghi âm cuộc họp · ${formatElapsed(
          rec.elapsedMs,
        )}`;
    return (
      <div className="mcm-recording-btns" role="group">
        <button
          type="button"
          className={`mcm-recording-pill${
            rec.isHost
              ? " mcm-recording-pill--host"
              : " mcm-recording-pill--peer"
          }`}
          onClick={rec.isHost ? () => void rec.stop() : undefined}
          disabled={!rec.isHost || rec.finalizing}
          title={tooltip}
          aria-label={tooltip}
        >
          <span className="mcm-recording-pill__dot" aria-hidden="true" />
          <span className="mcm-recording-pill__timer">
            {formatElapsed(rec.elapsedMs)}
          </span>
          {rec.isHost && (
            <span className="mcm-recording-pill__stop" aria-hidden="true">
              {rec.finalizing ? (
                <span className="mcm-recording-btn__spinner" />
              ) : (
                <StopIcon />
              )}
            </span>
          )}
        </button>

        {rec.errorMessage && rec.isHost && (
          <span className="mcm-recording-btn__err" title={rec.errorMessage}>
            !
          </span>
        )}
      </div>
    );
  }

  // IDLE — single record-dot button. Active for host, disabled +
  // tooltip-explained for peers.
  return (
    <div className="mcm-recording-btns" role="group">
      {rec.isHost ? (
        <button
          type="button"
          className="mcm-call-controls__btn mcm-recording-btn mcm-recording-btn--start"
          onClick={() => void rec.start()}
          disabled={!rec.audioReady}
          title={
            rec.audioReady
              ? "Bắt đầu ghi âm cuộc họp (chỉ host)"
              : "Vào audio call trước để ghi âm"
          }
          aria-label="Bắt đầu ghi âm"
        >
          <RecordIcon />
        </button>
      ) : (
        <button
          type="button"
          className="mcm-call-controls__btn mcm-recording-btn mcm-recording-btn--start"
          disabled
          title={`Chỉ host (${rec.hostName}) mới ghi âm được`}
          aria-label={`Ghi âm — chỉ host ${rec.hostName} mới dùng được`}
        >
          <RecordIcon />
        </button>
      )}

      {showRedownload && (
        <button
          type="button"
          className="mcm-call-controls__btn mcm-recording-btn mcm-recording-btn--download"
          onClick={rec.redownload}
          title="Tải lại bản ghi vừa rồi"
          aria-label="Tải lại bản ghi"
        >
          <DownloadIcon />
        </button>
      )}

      {rec.errorMessage && rec.isHost && (
        <span className="mcm-recording-btn__err" title={rec.errorMessage}>
          !
        </span>
      )}
    </div>
  );
};

export default RecordingButton;
