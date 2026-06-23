// Recording controls (host-only) + content picker — CLIENT-SIDE (06-23 pivot).
//
// Pivoted OFF Daily cloud recording: the host presses Record → a MediaRecorder
// IN THE HOST'S BROWSER (audio/clientRecording.ts) captures mixed audio (mic +
// every peer) PLUS the live screen-share video track when a share is active →
// on Stop, the WebM blob is uploaded to R2 (PUT /v1/recordings/:roomId/upload)
// and indexed in the `recording` table → the host/leadership review it in
// finished-meeting review (RecordingsSection), exactly as before — same table,
// same R2, same gated stream route, just a .webm.
//
// What this component owns:
//   • a host-only Record / Stop button in the call-controls cluster,
//   • a small CONTENT PICKER (audio / screen) the host ticks before recording.
//     The canvas is NOT recorded (owner: it reopens any time); the screen is
//     captured live only when someone is actually sharing.
//   • driving the local ClientMeetingRecorder lifecycle,
//   • driving the SHARED roomRecordingAtom + broadcasting RECORDING_STATE over
//     the DO realtime channel so EVERYONE sees the REC indicator (legally
//     required — anh Luân 06-23 §7.5). The indicator itself is rendered by
//     RecordingIndicator (header) + the frame glow, both reading the same atom.
//
// Default OFF: nothing records until the host clicks Record (§7.3).

import { Disc, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { audioRoomInstanceAtom, audioStateAtom } from "../../audio/audioState";
import { ClientMeetingRecorder } from "../../audio/clientRecording";
import { activeRoomLinkAtom, collabAPIAtom } from "../../collab/Collab";
import { uploadRecording } from "../../data/recordings";
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
import { screenShareMediaAtom } from "../../screenshare/screenShareState";
import { useT } from "../../i18n/mcm";

/** What the recording captures — the host's pre-record picker. `audio` is the
 *  mixed mic+peers track; `screen` opts in to capturing the live screen-share
 *  video when a share is active (audio-only file otherwise). The canvas is never
 *  recorded — it reopens any time. */
type RecordContent = { audio: boolean; screen: boolean };

const DEFAULT_CONTENT: RecordContent = {
  audio: true,
  screen: true,
};

/** Pick the active screen-share stream to record: prefer OUR OWN share, else the
 *  remote presenter we're viewing. Null when no one is sharing. */
const activeScreenStream = (
  media: { localStream: MediaStream | null; remoteStream: MediaStream | null },
): MediaStream | null => media.localStream ?? media.remoteStream ?? null;

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
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const screenMedia = useAtomValue(screenShareMediaAtom);
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

  // The live client recorder + whether the host opted to capture screen. Held in
  // refs so the start-time choice survives re-renders and the unload handler can
  // flush without a stale closure.
  const recorderRef = useRef<ClientMeetingRecorder | null>(null);
  const captureScreenRef = useRef(false);

  // Live-attach / detach the screen-share video track while recording, so a
  // share that starts (or stops) AFTER Record was pressed is captured without
  // restarting the recorder. No-op when the host opted out of screen capture or
  // when nothing is recording.
  const screenStream = activeScreenStream(screenMedia);
  useEffect(() => {
    const rec = recorderRef.current;
    if (!rec || !isRecording || !captureScreenRef.current) {
      return;
    }
    rec.setScreenStream(screenStream);
  }, [screenStream, isRecording]);

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
    // Audio is the mandatory track — a recording is the mixed call audio plus,
    // optionally, the screen. (The canvas is never recorded.)
    if (!content.audio) {
      setErrorMessage(t("cloudRecording.pickContent"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);

    // Build the recorder: mix local mic + every peer's audio (the proven
    // MeetingRecorder recipe), then attach the live screen-share track if the
    // host opted in and someone is sharing right now.
    const rec = new ClientMeetingRecorder();
    let audioInputs = 0;
    const localStream = audioRoom?.getLocalStream();
    if (localStream) {
      rec.addLocalStream(localStream);
      audioInputs += 1;
    }
    for (const { socketId, stream } of audioRoom?.getPeerStreams() ?? []) {
      rec.addStream(socketId, stream);
      audioInputs += 1;
    }
    if (audioInputs === 0) {
      // No mic and no peers → an empty audio mix. Bail before MediaRecorder runs
      // so the host gets a clear error instead of a 0-byte file.
      rec.close();
      setBusy(false);
      setErrorMessage(t("cloudRecording.startFailed"));
      return;
    }
    captureScreenRef.current = content.screen;
    if (content.screen) {
      // Attach whatever is being shared at start; the useEffect above keeps it
      // in sync if the share starts/stops mid-record.
      rec.setScreenStream(activeScreenStream(screenMedia));
    }

    try {
      await rec.start();
    } catch (err) {
      rec.close();
      setBusy(false);
      const detail = (err as Error)?.message;
      setErrorMessage(
        detail
          ? `${t("cloudRecording.startFailed")} (${detail})`
          : t("cloudRecording.startFailed"),
      );
      return;
    }
    recorderRef.current = rec;
    setBusy(false);
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
    audioRoom,
    collabAPI,
    content,
    mySocketId,
    myProfile?.username,
    screenMedia,
    t,
  ]);

  const stop = useCallback(async () => {
    const roomId = extractRoomId(activeRoomLink);
    const rec = recorderRef.current;
    if (!roomId || !collabAPI || !rec) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    // The recorder is LOCAL — stopping always succeeds quickly. Clear the
    // indicator for everyone as soon as recording ends; the upload happens after
    // and only its failure is surfaced (the bytes are not lost on a failed
    // upload — they're in the returned blob, but we have no retry UI yet).
    let durationSec: number | undefined;
    let blob: Blob | null = null;
    try {
      const result = await rec.stop();
      durationSec = Math.round(result.durationMs / 1000);
      blob = result.blob.size > 0 ? result.blob : null;
    } catch {
      // Recorder failed to flush — nothing to upload.
    } finally {
      rec.close();
      recorderRef.current = null;
      captureScreenRef.current = false;
      resetRoomRecording();
      collabAPI.publishRecordingState({ recording: false, startedAt: null });
    }
    if (blob) {
      const ok = await uploadRecording(roomId, blob, durationSec);
      if (!ok) {
        setErrorMessage(t("cloudRecording.uploadFailed"));
      }
    }
    setBusy(false);
  }, [activeRoomLink, collabAPI, t]);

  // Best-effort: clear the room indicator for peers if the host's tab closes
  // mid-recording. The in-flight bytes are lost (we cannot await an async
  // stop()/upload in beforeunload), but the banner shouldn't dangle. Mirrors
  // RecordingControls' beforeunload.
  const broadcastStopRef = useRef<(() => void) | null>(null);
  broadcastStopRef.current = () => {
    if (isRecording && isHost) {
      // Synchronously stop the local MediaRecorder so the mic/screen capture
      // releases; bytes can't be uploaded from an unloading tab.
      try {
        recorderRef.current?.close();
      } catch {
        // ignore
      }
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
    content.screen && t("cloudRecording.contentScreen"),
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
              checked={content.screen}
              onChange={(e) =>
                setContent((c) => ({ ...c, screen: e.target.checked }))
              }
            />
            <span>{t("cloudRecording.contentScreen")}</span>
          </label>
          <p className="mcm-cloudrec__hint">{t("cloudRecording.screenHint")}</p>
          <button
            type="button"
            className="mcm-cloudrec__go"
            onClick={() => void start()}
            disabled={busy || !content.audio}
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
