// Phase 5 — CLOUD recording controls (host-only) + content picker.
//
// This is the Phase-5 server-side Daily cloud recording control, distinct from
// the legacy host-local audio MediaRecorder (RecordingControls.tsx, still in
// the tree but no longer wired into the call bar). Here the host presses Record
// → the WORKER starts a Daily cloud recording of the merged call room (voice +
// camera + screen, one composited MP4) → on stop, the worker copies the file to
// R2 and indexes it; the host/leadership later review it in finished-meeting
// review (RecordingsSection).
//
// What this component owns:
//   • a host-only Record / Stop button in the call-controls cluster,
//   • a small CONTENT PICKER (audio / video[camera+screen] / canvas) the host
//     ticks before recording (anh Luân 06-23 §7.4),
//   • calling startRecording / stopRecording (data/recordings.ts contract),
//   • driving the SHARED roomRecordingAtom + broadcasting RECORDING_STATE over
//     the DO realtime channel so EVERYONE sees the REC indicator (legally
//     required — anh Luân 06-23 §7.5). The elegant indicator itself is rendered
//     by RecordingIndicator (header) + the frame glow, both reading the same
//     atom.
//
// Default OFF: nothing records until the host clicks Record (§7.3).

import { Disc, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import { activeRoomLinkAtom, collabAPIAtom } from "../../collab/Collab";
import {
  startRecording as startCloudRecording,
  stopRecording as stopCloudRecording,
} from "../../data/recordings";
import {
  resetRoomRecording,
  roomRecordingAtom,
  setRoomRecording,
} from "../../data/roomRecording";
import {
  hostSocketIdAtom,
  mySocketIdAtom,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

/** What the recording captures — the host's pre-record picker. `audio` + `video`
 *  are real Daily tracks; `canvas` is metadata-only for the MVP (the canvas is
 *  replayed from the event-log in review, not a Daily track). */
type RecordContent = { audio: boolean; video: boolean; canvas: boolean };

const DEFAULT_CONTENT: RecordContent = {
  audio: true,
  video: true,
  canvas: false,
};

const extractRoomId = (link: string | null | undefined): string | null =>
  link?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;

/** Format ms → `M:SS` / `H:MM:SS` for the live Stop pill. */
const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0:00";
  }
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/** Re-render each second while recording so the Stop pill timer ticks. */
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

/**
 * Host-only cloud-recording control. Renders nothing for non-hosts (the REC
 * indicator for everyone lives in RecordingIndicator, not here). The host sees
 * a Record button (idle) or a Stop pill (recording) plus the content-picker
 * popover.
 */
export const CloudRecordingControls = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const audioState = useAtomValue(audioStateAtom);
  const roomRecording = useAtomValue(roomRecordingAtom);
  const mySocketId = useAtomValue(mySocketIdAtom);
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  const myProfile = useAtomValue(userProfileAtom);

  const isHost = !!mySocketId && mySocketId === hostSocketId;
  const isRecording = roomRecording.recording;
  const startedAt = roomRecording.startedAt;
  const now = useTick(isRecording);
  const elapsedMs =
    isRecording && startedAt != null ? Math.max(0, now - startedAt) : 0;

  const [content, setContent] = useState<RecordContent>(DEFAULT_CONTENT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Close the content picker on outside click / Escape (same pattern as the
  // reactions popover in MeetingCallControls).
  useEffect(() => {
    if (!pickerOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (
        pickerRef.current &&
        e.target instanceof Node &&
        !pickerRef.current.contains(e.target)
      ) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const start = useCallback(async () => {
    const roomId = extractRoomId(activeRoomLink);
    if (!roomId || !collabAPI) {
      return;
    }
    // At least one Daily-track content type must be selected (canvas alone is
    // captured via the event-log, not Daily — recording just audio+video would
    // be empty). Allow audio-only or video-only; block "canvas only".
    if (!content.audio && !content.video) {
      setErrorMessage(t("cloudRecording.pickContent"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    const res = await startCloudRecording(roomId, content);
    setBusy(false);
    if (!res.ok) {
      setErrorMessage(
        res.status === 403
          ? t("cloudRecording.notAllowed")
          : t("cloudRecording.startFailed"),
      );
      return;
    }
    setPickerOpen(false);
    const ts = Date.now();
    // Drive the SHARED atom locally (the host's own broadcast doesn't echo back
    // through the socket) AND broadcast to everyone so the REC indicator lights
    // up for the whole room.
    setRoomRecording({
      recording: true,
      hostSocketId: mySocketId ?? null,
      hostName: myProfile?.username ?? null,
      startedAt: ts,
    });
    collabAPI.publishRecordingState({ recording: true, startedAt: ts });
  }, [
    activeRoomLink,
    collabAPI,
    content,
    mySocketId,
    myProfile?.username,
    t,
  ]);

  const stop = useCallback(async () => {
    const roomId = extractRoomId(activeRoomLink);
    if (!roomId || !collabAPI) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    const res = await stopCloudRecording(roomId);
    setBusy(false);
    if (!res.ok) {
      // Stop failed server-side — keep the indicator up (Daily may still be
      // recording) and let the host retry rather than silently clearing it.
      setErrorMessage(t("cloudRecording.stopFailed"));
      return;
    }
    resetRoomRecording();
    collabAPI.publishRecordingState({ recording: false, startedAt: null });
  }, [activeRoomLink, collabAPI, t]);

  // Best-effort: clear the room indicator for peers if the host's tab closes
  // mid-recording (Daily keeps recording server-side until `exp`, but the
  // banner shouldn't dangle). Mirrors RecordingControls' beforeunload.
  const broadcastStopRef = useRef<(() => void) | null>(null);
  broadcastStopRef.current = () => {
    if (isRecording && isHost) {
      collabAPI?.publishRecordingState({ recording: false, startedAt: null });
    }
  };
  useEffect(() => {
    const onUnload = () => broadcastStopRef.current?.();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // Non-host, or not in a room → render nothing here. (Peers still see the REC
  // indicator via RecordingIndicator.) Only the host gets the control.
  if (!activeRoomLink || !isHost) {
    return null;
  }

  // RECORDING — a Stop pill with the live timer.
  if (isRecording) {
    const tooltip = t("cloudRecording.stopTooltip", {
      time: formatElapsed(elapsedMs),
    });
    return (
      <div className="mcm-cloudrec" role="group">
        <button
          type="button"
          className="mcm-cloudrec__pill mcm-cloudrec__pill--rec"
          onClick={() => void stop()}
          disabled={busy}
          title={tooltip}
          aria-label={tooltip}
        >
          <span className="mcm-cloudrec__dot" aria-hidden="true" />
          <span className="mcm-cloudrec__timer">
            {formatElapsed(elapsedMs)}
          </span>
          <span className="mcm-cloudrec__stop" aria-hidden="true">
            {busy ? (
              <span className="mcm-call-controls__spinner" />
            ) : (
              <Square size={13} />
            )}
          </span>
        </button>
        {errorMessage && (
          <span className="mcm-cloudrec__err" title={errorMessage}>
            !
          </span>
        )}
      </div>
    );
  }

  // IDLE — Record button + content-picker popover.
  const audioReady = audioState.status === "live";
  const summary = [
    content.audio && t("cloudRecording.contentAudio"),
    content.video && t("cloudRecording.contentVideo"),
    content.canvas && t("cloudRecording.contentCanvas"),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mcm-cloudrec" role="group" ref={pickerRef}>
      <button
        type="button"
        className="mcm-header__icon-btn mcm-cloudrec__btn mcm-tip"
        onClick={() => setPickerOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        data-mcm-tip={t("cloudRecording.startTitle")}
        aria-label={t("cloudRecording.startAria")}
      >
        <Disc size={18} />
      </button>

      {pickerOpen && (
        <div
          className="mcm-cloudrec__popover"
          role="menu"
          aria-label={t("cloudRecording.pickerTitle")}
        >
          <div className="mcm-cloudrec__popover-title">
            {t("cloudRecording.pickerTitle")}
          </div>
          <label className="mcm-cloudrec__opt">
            <input
              type="checkbox"
              checked={content.audio}
              onChange={(e) =>
                setContent((c) => ({ ...c, audio: e.target.checked }))
              }
            />
            <span>{t("cloudRecording.contentAudio")}</span>
          </label>
          <label className="mcm-cloudrec__opt">
            <input
              type="checkbox"
              checked={content.video}
              onChange={(e) =>
                setContent((c) => ({ ...c, video: e.target.checked }))
              }
            />
            <span>{t("cloudRecording.contentVideo")}</span>
          </label>
          <label className="mcm-cloudrec__opt">
            <input
              type="checkbox"
              checked={content.canvas}
              onChange={(e) =>
                setContent((c) => ({ ...c, canvas: e.target.checked }))
              }
            />
            <span>{t("cloudRecording.contentCanvas")}</span>
          </label>
          <p className="mcm-cloudrec__hint">{t("cloudRecording.canvasHint")}</p>
          <button
            type="button"
            className="mcm-cloudrec__go"
            onClick={() => void start()}
            disabled={busy || (!content.audio && !content.video)}
          >
            {busy ? (
              <span className="mcm-call-controls__spinner" />
            ) : (
              <>
                <Disc size={14} />
                <span>{t("cloudRecording.startNow")}</span>
              </>
            )}
          </button>
          {!audioReady && (
            <p className="mcm-cloudrec__hint">{t("cloudRecording.joinHint")}</p>
          )}
          {summary && (
            <p className="mcm-cloudrec__summary">
              {t("cloudRecording.willRecord", { what: summary })}
            </p>
          )}
        </div>
      )}
      {errorMessage && (
        <span className="mcm-cloudrec__err" title={errorMessage}>
          !
        </span>
      )}
    </div>
  );
};

export default CloudRecordingControls;
