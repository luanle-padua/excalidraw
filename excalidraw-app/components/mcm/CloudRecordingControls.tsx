// Recording controls + content picker — OWNER-side (06-24 per-speaker pivot, #23/#24).
//
// The recording model changed from "host records ONE mixed file" to: ONE
// recording SESSION per room, owned by a SINGLE participant and enforced by a
// server lock in the room Durable Object. During a session EVERY participant
// records their OWN local mic to a separate file (ParticipantMicRecorder —
// mounted for everyone in MeetingShell, incl. the owner). The session OWNER
// ADDITIONALLY records the optional screen-video and screen-audio here. All
// files from one Record→Stop press share one `sessionId` so they re-align later.
//
// What THIS component owns (owner / would-be-owner control only):
//   • a Record / Stop button in the call-controls cluster,
//   • the small CONTENT PICKER (screen video / screen audio) the owner ticks,
//   • acquiring + releasing the DO recording LOCK,
//   • driving ScreenVideoRecorder (opt-in) + ScreenAudioRecorder (when the share
//     carries audio). It does NOT record the owner's mic — that's the owner's
//     own ParticipantMicRecorder, so there's never a double mic file.
//
// Non-owner / non-host while a session is active → a PASSIVE "đang được ghi"
// indicator, never an actionable Stop for someone else's session. The shared
// roomRecordingAtom (DO-driven) is the single source of truth for who owns it.
//
// Default OFF: nothing records until someone clicks Record (§7.3).

import { Disc, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  ScreenAudioRecorder,
  ScreenVideoRecorder,
} from "../../audio/clientRecording";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
} from "../../collab/Collab";
import { uploadRecording } from "../../data/recordings";
import { roomRecordingAtom } from "../../data/roomRecording";
import { sessionAtom } from "../../data/session";
import {
  hostSocketIdAtom,
  mySocketIdAtom,
  userProfileAtom,
} from "../../data/userProfile";
import { screenShareMediaAtom } from "../../screenshare/screenShareState";
import { useT } from "../../i18n/mcm";

/** What the OWNER captures beyond everyone's per-speaker mic. `screen` opts in
 *  to the screen-share VIDEO (canvas compositor); the shared window's AUDIO is
 *  captured automatically as its own file whenever a share carries audio. The
 *  canvas is never recorded — it reopens any time. */
type RecordContent = { screen: boolean };

const DEFAULT_CONTENT: RecordContent = {
  screen: true,
};

/** Pick the active screen-share stream to record: prefer OUR OWN share, else the
 *  remote presenter we're viewing. Null when no one is sharing. */
const activeScreenStream = (media: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}): MediaStream | null => media.localStream ?? media.remoteStream ?? null;

const extractRoomId = (link: string | null | undefined): string | null =>
  link?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;

/** Generate a session id (one per Record press, shared by every per-source
 *  file). crypto.randomUUID where available, else a sufficiently-unique fallback. */
const newSessionId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
 * Owner-side recording control. The host (or anyone who would own the session)
 * sees a Record button (idle) or a Stop pill (recording-and-I-own-it). A
 * non-owner while someone ELSE records sees a passive disabled "đang được ghi"
 * chip. The REC indicator for everyone lives separately in RecordingIndicator.
 */
export const CloudRecordingControls = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const screenMedia = useAtomValue(screenShareMediaAtom);
  const roomRecording = useAtomValue(roomRecordingAtom);
  const mySocketId = useAtomValue(mySocketIdAtom);
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  const myProfile = useAtomValue(userProfileAtom);
  const session = useAtomValue(sessionAtom);
  // When the meeting is ended-for-all this flips true and the client drops into
  // read-only review while STAYING connected. The owner's socket never closes,
  // so the DO's disconnect-based lock auto-release never fires — we must stop the
  // session HERE (see the on-review auto-stop effect below).
  const meetingViewOnly = useAtomValue(meetingViewOnlyAtom);

  const isHost = !!mySocketId && mySocketId === hostSocketId;
  const isRecording = roomRecording.recording;
  const startedAt = roomRecording.startedAt;

  // My authenticated email — the DO key for ownership. "owner.email === my
  // email" ⇒ I hold the lock (a re-acquire returns ok:false with myself).
  const myEmail = (myProfile?.email ?? session?.email)?.toLowerCase() ?? null;
  const iOwnSession =
    isRecording &&
    !!roomRecording.ownerEmail &&
    !!myEmail &&
    roomRecording.ownerEmail === myEmail;
  const someoneElseRecording =
    isRecording && (!myEmail || roomRecording.ownerEmail !== myEmail);

  const now = useTick(iOwnSession);
  const elapsedMs =
    iOwnSession && startedAt != null ? Math.max(0, now - startedAt) : 0;

  const [content, setContent] = useState<RecordContent>(DEFAULT_CONTENT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // The live OWNER-side recorders + the session they belong to. Held in refs so
  // the choice survives re-renders and the unload handler can flush without a
  // stale closure. The owner's MIC is NOT here — it's their ParticipantMicRecorder.
  const screenVideoRef = useRef<ScreenVideoRecorder | null>(null);
  const screenAudioRef = useRef<ScreenAudioRecorder | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Live-attach / detach the screen-share VIDEO track while recording, so a
  // share that starts (or stops) AFTER Record was pressed is captured without
  // restarting the recorder. No-op when no screen-video recorder is running.
  const screenStream = activeScreenStream(screenMedia);
  useEffect(() => {
    screenVideoRef.current?.setScreenStream(screenStream);
  }, [screenStream]);

  // Live-attach / detach the shared window's AUDIO into the screen-VIDEO file
  // (so the video has sound). The standalone ScreenAudioRecorder is started at
  // Record time from the audio that exists then; this keeps the video's muxed
  // audio in sync if the share's audio starts/stops mid-record.
  const screenAudioStream = screenMedia.screenAudioStream;
  useEffect(() => {
    screenVideoRef.current?.setScreenAudioStream(screenAudioStream);
  }, [screenAudioStream]);

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
    setBusy(true);
    setErrorMessage(null);

    // 1) ACQUIRE THE SERVER LOCK FIRST — never start any recorder before the DO
    //    confirms WE own the session. A re-acquire by the current owner replies
    //    ok:false with OURSELVES as owner; treat that as success. Anyone else
    //    owning it ⇒ busy.
    const sessionId = newSessionId();
    const ts = Date.now();
    const { ok, owner } = await collabAPI.acquireRecordingLock(sessionId, ts);
    const ownerIsMe =
      !!owner?.email && !!myEmail && owner.email.toLowerCase() === myEmail;
    if (!ok && !ownerIsMe) {
      // Someone else holds the lock (or the acquire timed out). Do NOT start.
      // The roomRecordingAtom (DO-driven) already paints the passive indicator
      // for an active session; surface a short error otherwise.
      collabAPI.releaseRecordingLock?.();
      setBusy(false);
      if (owner) {
        setErrorMessage(t("cloudRecording.busyByOther"));
      } else {
        setErrorMessage(t("cloudRecording.startFailed"));
      }
      return;
    }

    // We OWN the session. Remember it so the unload/stop handlers can flush.
    sessionIdRef.current = sessionId;
    startedAtRef.current = ts;

    // 2) Start the OWNER-side recorders. The owner's mic is NOT recorded here —
    //    ParticipantMicRecorder handles it like every other participant.
    try {
      // 2a) SCREEN VIDEO (opt-in). The compositor runs from start() so a share
      //     that begins LATER is still captured; seed it with the current share
      //     + its audio so the video has sound from the first frame.
      if (content.screen) {
        const sv = new ScreenVideoRecorder();
        await sv.start({
          initialScreenStream: activeScreenStream(screenMedia),
          screenAudioStream: screenMedia.screenAudioStream,
        });
        screenVideoRef.current = sv;
      }
      // 2b) SCREEN AUDIO as its OWN file — only when a share is actually
      //     carrying audio right now (a no-audio share records no empty file).
      const saStream = screenMedia.screenAudioStream;
      if (saStream && saStream.getAudioTracks().length > 0) {
        const sa = new ScreenAudioRecorder();
        sa.start(saStream);
        screenAudioRef.current = sa;
      }
    } catch (err) {
      // A recorder failed to start — tear down whatever DID start, drop the lock.
      try {
        screenVideoRef.current?.close();
      } catch {
        // ignore
      }
      try {
        screenAudioRef.current?.close();
      } catch {
        // ignore
      }
      screenVideoRef.current = null;
      screenAudioRef.current = null;
      sessionIdRef.current = null;
      startedAtRef.current = null;
      collabAPI.releaseRecordingLock();
      setBusy(false);
      const detail = (err as Error)?.message;
      setErrorMessage(
        detail
          ? `${t("cloudRecording.startFailed")} (${detail})`
          : t("cloudRecording.startFailed"),
      );
      return;
    }

    // The DO broadcasts recording-state → roomRecordingAtom flips true for
    // everyone (incl. us + every ParticipantMicRecorder). No local atom write
    // needed; the lock is the source of truth.
    setBusy(false);
    setPickerOpen(false);
  }, [activeRoomLink, collabAPI, content, myEmail, screenMedia, t]);

  const stop = useCallback(async () => {
    const roomId = extractRoomId(activeRoomLink);
    if (!roomId || !collabAPI) {
      return;
    }
    const sessionId = sessionIdRef.current;
    const sv = screenVideoRef.current;
    const sa = screenAudioRef.current;
    setBusy(true);
    setErrorMessage(null);

    // 1) RELEASE THE LOCK FIRST so the DO clears the indicator for EVERYONE (and
    //    every ParticipantMicRecorder stops + uploads its own mic file) the
    //    instant recording ends — the owner-side uploads below can be slow.
    collabAPI.releaseRecordingLock();

    // 2) Stop the owner-side recorders, collect non-null blobs. Each recorder's
    //    startedAtMs (the absolute instant ITS capture began) is read BEFORE
    //    close() — which resets it — and threaded to started_at_ms so the replay
    //    can align this track on the shared timeline (#28).
    const uploads: Array<{
      blob: Blob;
      kind: "screen-video" | "screen-audio";
      durationSec: number;
      startedAtMs: number | null;
    }> = [];
    const baseStart = startedAtRef.current;
    const durationSec =
      baseStart != null
        ? Math.round(Math.max(0, Date.now() - baseStart) / 1000)
        : undefined;
    if (sv) {
      try {
        const startedAtMs = sv.startedAtMs();
        const blob = await sv.stop();
        if (blob) {
          uploads.push({
            blob,
            kind: "screen-video",
            durationSec: durationSec ?? 0,
            startedAtMs,
          });
        }
      } catch {
        // recorder failed to flush — nothing to upload for this source
      } finally {
        sv.close();
      }
    }
    if (sa) {
      try {
        const startedAtMs = sa.startedAtMs();
        const blob = await sa.stop();
        if (blob) {
          uploads.push({
            blob,
            kind: "screen-audio",
            durationSec: durationSec ?? 0,
            startedAtMs,
          });
        }
      } catch {
        // ignore
      } finally {
        sa.close();
      }
    }
    screenVideoRef.current = null;
    screenAudioRef.current = null;
    sessionIdRef.current = null;
    startedAtRef.current = null;

    // Re-enable the control NOW — recording is over and the indicator is already
    // cleared. The R2 uploads can be slow (big blob / weak network); they must
    // NOT keep the button disabled (read as "frozen"). Only their failure shows.
    setBusy(false);
    let anyFailed = false;
    for (const u of uploads) {
      const ok = await uploadRecording(roomId, u.blob, {
        kind: u.kind,
        durationSec: u.durationSec,
        ...(sessionId ? { sessionId } : {}),
        ...(u.startedAtMs != null ? { startedAtMs: u.startedAtMs } : {}),
      });
      if (!ok) {
        anyFailed = true;
      }
    }
    if (anyFailed) {
      setErrorMessage(t("cloudRecording.uploadFailed"));
    }
  }, [activeRoomLink, collabAPI, t]);

  // MEETING ENDED-FOR-ALL → auto-stop the OWNER's session exactly once.
  //
  // End-for-all flips meetingViewOnlyAtom → true while this client STAYS
  // connected in review. The header's handleEndMeeting only flips to review; it
  // never stops recording. So without this, the owner's screen recorders never
  // flush+upload and releaseRecordingLock() is never sent → the DO recording lock
  // STRANDS (it otherwise only clears on the owner's socket disconnect, which
  // doesn't happen). Calling the existing stop() here flushes+uploads the owner's
  // screen files AND releases the lock → the DO broadcasts recording-state:false,
  // so every ParticipantMicRecorder stops+uploads promptly and the lock clears.
  //
  // This MUST run only for the session OWNER while a session is actually live
  // (iOwnSession) — a non-owner / non-recording client has nothing to stop and
  // must never release someone else's lock. A ref flag makes it fire EXACTLY
  // ONCE per session: stop() is not fully idempotent (a second call would re-send
  // releaseRecordingLock + re-toggle busy), and it does not touch the manual Stop
  // button — that path simply leaves iOwnSession false on the next render.
  const autoStoppedRef = useRef(false);
  useEffect(() => {
    if (!iOwnSession) {
      // Session over (manual stop or never started) → arm for the next session.
      autoStoppedRef.current = false;
      return;
    }
    if (meetingViewOnly && !autoStoppedRef.current) {
      autoStoppedRef.current = true;
      void stop();
    }
  }, [meetingViewOnly, iOwnSession, stop]);

  // Best-effort: synchronously stop the owner recorders + release the lock if
  // the owner's tab closes mid-recording. In-flight bytes are lost (we can't
  // await an async stop()/upload in beforeunload), but the lock must not dangle
  // — the DO ALSO auto-releases on socket close, so this is belt-and-braces.
  const unloadRef = useRef<(() => void) | null>(null);
  unloadRef.current = () => {
    if (!iOwnSession) {
      return;
    }
    try {
      screenVideoRef.current?.close();
    } catch {
      // ignore
    }
    try {
      screenAudioRef.current?.close();
    } catch {
      // ignore
    }
    collabAPI?.releaseRecordingLock();
  };
  useEffect(() => {
    const onUnload = () => unloadRef.current?.();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // Not in a room → nothing here.
  if (!activeRoomLink) {
    return null;
  }

  // SOMEONE ELSE owns the session → passive, disabled "đang được ghi" chip for
  // anyone who isn't the owner (host or not). Never an actionable Stop — a
  // non-owner must not stop another person's recording.
  if (someoneElseRecording) {
    const who = roomRecording.hostName;
    const label = who
      ? t("cloudRecording.busyByName", { name: who })
      : t("cloudRecording.busyByOther");
    return (
      <div className="mcm-cloudrec" role="group">
        <span
          className="mcm-cloudrec__pill mcm-cloudrec__pill--busy"
          role="status"
          title={label}
          aria-label={label}
        >
          <span className="mcm-cloudrec__dot" aria-hidden="true" />
          <span className="mcm-cloudrec__busy">{t("cloudRecording.busy")}</span>
        </span>
      </div>
    );
  }

  // I OWN the session → Stop pill with the live timer.
  if (iOwnSession) {
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

  // IDLE, and nobody is recording. Only the host gets the Record affordance (the
  // session OWNER is whoever presses it; a non-host participant doesn't start
  // sessions, but their per-speaker mic still records once the host does).
  if (!isHost) {
    return null;
  }

  const summary = [
    t("cloudRecording.contentMic"),
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
          {/* Per-speaker mic is ALWAYS recorded (every participant's own mic) —
              shown as a fixed, non-toggleable line so the owner knows. */}
          <p className="mcm-cloudrec__hint">{t("cloudRecording.micAlways")}</p>
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
            disabled={busy}
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
