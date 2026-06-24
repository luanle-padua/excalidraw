// Phase 5 — review-mode RECORDINGS section. Shown inside the finished-meeting
// review (MeetingLogModal "Recordings" tab). Lists this meeting's recordings
// (listRecordings) and lets an authorised viewer play / download each one.
//
// PER-SPEAKER MODEL (owner 06-24, plan §8): recording is no longer one mixed
// WebM per clip. One Record→Stop SESSION now yields MANY rows that share a
// `session_id`: a per-speaker MIC track for everyone who spoke, an optional
// SCREEN-AUDIO track, and an optional SCREEN-VIDEO track (the only video). The
// list route returns each row with `kind` ('mic'|'screen-audio'|'screen-video'
// |'mixed'), `speaker_id`, `speaker_name`, `session_id`. Legacy rows are
// kind='mixed' with session_id=null — each renders as its own standalone item.
//
// We present each SESSION as a group ("Bản ghi N" by start time) and list its
// tracks inside; a track plays in the big player — VIDEO tracks (screen-video /
// legacy mixed) in the <video> element, AUDIO tracks (mic / screen-audio) in an
// <audio> element. There is NO mixed file going forward, so "the whole meeting"
// = pick a speaker, or play the screen-video. New styling lives in
// RecordingsSection.scss (mcm-recplay-* classes); the legacy `.mcm-recordings`
// rules in MeetingShell.scss are left untouched (owned by another team).
//
// ACCESS (anh Luân 06-23 §7.2): host / organizer / project leadership / admin
// ONLY — NOT every participant. The caller (MeetingLogModal) hides the whole
// tab when the viewer lacks authority; this component additionally relies on
// the worker auth-gating the list + stream routes (a non-authority caller gets
// [] / 403). The media is streamed from R2 behind the worker gate — there is no
// public link.
//
// MEDIA AUTH: the stream route is JWT-gated and a <video>/<audio src> can't
// attach the bearer, so we lazily fetch the SELECTED track through
// fetchRecordingObjectUrl (fetchWithAuth → blob → object URL) only when the
// viewer picks a track, and revoke object URLs on unmount / re-selection.
// Download goes through downloadRecording (same gated fetch → disk). See
// data/recordings.ts.

import { Download, Film, Mic, Play, RotateCw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  downloadRecording,
  fetchRecordingObjectUrl,
  listRecordings,
  type Recording,
} from "../../data/recordings";
import { useT } from "../../i18n/mcm";

import "./RecordingsSection.scss";

// The per-source fields the list route adds (plan §8). Kept as a local widening
// of Recording so this section is robust even before data/recordings.ts (owned
// elsewhere) carries them in its type — at runtime the API always sends them.
type RecKind = "mic" | "screen-audio" | "screen-video" | "mixed";
type Track = Recording & {
  kind?: RecKind | null;
  speaker_id?: string | null;
  speaker_name?: string | null;
  session_id?: string | null;
};

const kindOf = (r: Track): RecKind => (r.kind ?? "mixed") as RecKind;
const isVideoKind = (k: RecKind): boolean =>
  k === "screen-video" || k === "mixed";

const fmtDuration = (sec: number | null): string => {
  if (!sec || sec <= 0) {
    return "";
  }
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const fmtSize = (bytes: number | null): string => {
  if (!bytes || bytes <= 0) {
    return "";
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const fmtWhen = (ms: number | null): string => {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A recording session: the set of tracks sharing a session_id. Legacy mixed
 *  rows (session_id null) become single-track sessions of their own. */
type Session = {
  /** session_id, or the lone row's id for a legacy/standalone row. */
  key: string;
  /** Earliest created_at across the session's tracks — used for ordering +
   *  the "Bản ghi N" timestamp. */
  startedAt: number;
  /** True for a legacy standalone mixed row (renders without a group shell). */
  legacy: boolean;
  tracks: Track[];
};

// Track sort within a session: screen-video (visual anchor) first, then mics
// (per speaker, alphabetical), then screen-audio, then anything else.
const KIND_ORDER: Record<RecKind, number> = {
  "screen-video": 0,
  mic: 1,
  "screen-audio": 2,
  mixed: 3,
};

const speakerLabelOf = (r: Track): string =>
  (r.speaker_name || r.speaker_id || r.started_by || "").trim();

export const RecordingsSection = ({ roomId }: { roomId: string | null }) => {
  const t = useT();
  const [rows, setRows] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  // The track currently loaded in the big player.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Object URL for the active track, loaded on selection. Only ONE track is
  // buffered at a time (the previous one is revoked) so we never hold several
  // full media files in memory.
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loadingMedia, setLoadingMedia] = useState(false);
  const activeUrlRef = useRef<string | null>(null);
  activeUrlRef.current = activeUrl;

  const load = useCallback(async () => {
    if (!roomId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const list = (await listRecordings(roomId)) as Track[];
    setRows(list);
    setLoading(false);
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Recording uploads are ASYNC: a participant's per-speaker mic file finalizes
  // ~6-8s after the meeting ends, and the owner's screen tracks upload on stop.
  // The list is fetched once on mount, so opening Recordings right after End can
  // show an empty "No recordings" even though files are still landing (#26-B).
  // Auto-retry a BOUNDED number of times while the list is still empty so late
  // uploads appear without a manual Refresh; stop the instant a row arrives.
  const emptyRetriesRef = useRef(0);
  useEffect(() => {
    if (loading || rows.length > 0) {
      emptyRetriesRef.current = 0;
      return;
    }
    if (emptyRetriesRef.current >= 6) {
      return; // ~18s of polling — a genuinely empty meeting; give up.
    }
    const id = window.setTimeout(() => {
      emptyRetriesRef.current += 1;
      void load();
    }, 3000);
    return () => window.clearTimeout(id);
  }, [loading, rows.length, load]);

  // Free the buffered blob when the section unmounts.
  useEffect(
    () => () => {
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
      }
    },
    [],
  );

  // Select a track → fetch its gated media into an object URL and load the
  // player. Revokes any previously-buffered track first.
  const select = useCallback(async (id: string) => {
    setActiveId(id);
    setLoadingMedia(true);
    const url = await fetchRecordingObjectUrl(id);
    setLoadingMedia(false);
    // Revoke the previous track's blob now that a new one is ready.
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
    }
    setActiveUrl(url);
  }, []);

  // Group rows into sessions. Tracks sharing a non-null session_id form a group;
  // legacy mixed rows (session_id null) each become their own standalone group.
  // Sessions are ordered oldest-first so the numbering matches chronology.
  const sessions = useMemo<Session[]>(() => {
    const groups = new Map<string, Track[]>();
    const legacy: Session[] = [];
    for (const r of rows) {
      const sid = r.session_id;
      if (!sid) {
        legacy.push({
          key: r.id,
          startedAt: r.created_at,
          legacy: true,
          tracks: [r],
        });
        continue;
      }
      const bucket = groups.get(sid);
      if (bucket) {
        bucket.push(r);
      } else {
        groups.set(sid, [r]);
      }
    }
    const grouped: Session[] = Array.from(groups.entries()).map(
      ([key, tracks]) => {
        const sorted = [...tracks].sort((a, b) => {
          const ko = KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)];
          if (ko !== 0) {
            return ko;
          }
          // mics: by speaker name for a stable, readable order.
          return speakerLabelOf(a).localeCompare(speakerLabelOf(b));
        });
        const startedAt = sorted.reduce(
          (min, r) => Math.min(min, r.created_at),
          sorted[0]?.created_at ?? 0,
        );
        return { key, startedAt, legacy: false, tracks: sorted };
      },
    );
    return [...grouped, ...legacy].sort((a, b) => a.startedAt - b.startedAt);
  }, [rows]);

  const readyCount = rows.filter((r) => r.status === "ready").length;

  // Auto-select the lone ready track when there's exactly one across the whole
  // meeting, so a single-track meeting opens straight into the player.
  useEffect(() => {
    if (!activeId && readyCount === 1) {
      const sole = rows.find((r) => r.status === "ready");
      if (sole) {
        void select(sole.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyCount, activeId]);

  if (loading) {
    return (
      <div className="mcm-log-modal__empty">
        <span className="mcm-log-modal__spinner" /> {t("recordings.loading")}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mcm-log-modal__empty">
        <Film size={28} strokeWidth={1.5} aria-hidden="true" />
        <p>{t("recordings.empty")}</p>
        <button
          type="button"
          className="mcm-recplay__refresh"
          onClick={() => void load()}
        >
          <RotateCw size={14} /> {t("recordings.refresh")}
        </button>
      </div>
    );
  }

  // Sessions number oldest-first ("Bản ghi 1" = first recording of the meeting).
  const sessionNo = (idx: number) => idx + 1;

  const active = activeId
    ? rows.find((r) => r.id === activeId) ?? null
    : null;
  const activeKind = active ? kindOf(active) : "mixed";
  const activeIsVideo = isVideoKind(activeKind);

  // Human label for the active track in the player bar.
  const trackLabel = (r: Track): string => {
    const k = kindOf(r);
    if (k === "screen-video") {
      return t("recordings.trackScreenVideo");
    }
    if (k === "screen-audio") {
      return t("recordings.trackScreenAudio");
    }
    if (k === "mixed") {
      return t("recordings.trackMixed");
    }
    const who = speakerLabelOf(r);
    return who || t("recordings.trackMic");
  };

  const playerMeta = active
    ? [fmtWhen(active.ready_at ?? active.created_at), fmtSize(active.bytes)]
        .filter(Boolean)
        .join(" · ")
    : "";

  // Whole-meeting single track (one row, ready or not): surface its
  // processing/failed state in the player rather than a "pick a track" prompt.
  const soleRow = rows.length === 1 ? rows[0] : null;
  const solePending = soleRow ? soleRow.status !== "ready" : false;

  return (
    <div className="mcm-recplay">
      <div className="mcm-recplay__head">
        <span className="mcm-recplay__count">
          {t("recordings.sessionCount", { count: sessions.length })}
        </span>
        <button
          type="button"
          className="mcm-recplay__refresh"
          onClick={() => void load()}
          title={t("recordings.refresh")}
        >
          <RotateCw size={14} /> {t("recordings.refresh")}
        </button>
      </div>

      <div className="mcm-recplay__stage">
        {/* ---- prominent player ---- */}
        <div className="mcm-recplay__player">
          {loadingMedia ? (
            <div className="mcm-recplay__loading">
              <span className="mcm-log-modal__spinner" />{" "}
              {t("recordings.loadingMedia")}
            </div>
          ) : active && activeUrl ? (
            activeIsVideo ? (
              <video
                key={active.id}
                className="mcm-recplay__video"
                src={activeUrl}
                controls
                autoPlay
                preload="metadata"
                playsInline
              />
            ) : (
              <div className="mcm-recplay__audio">
                <span className="mcm-recplay__audio-icon" aria-hidden="true">
                  {activeKind === "screen-audio" ? (
                    <Volume2 size={30} strokeWidth={1.5} />
                  ) : (
                    <Mic size={30} strokeWidth={1.5} />
                  )}
                </span>
                <span className="mcm-recplay__audio-label">
                  {trackLabel(active)}
                </span>
                <audio
                  key={active.id}
                  className="mcm-recplay__audio-el"
                  src={activeUrl}
                  controls
                  autoPlay
                  preload="metadata"
                />
              </div>
            )
          ) : solePending ? (
            <div className="mcm-recplay__placeholder">
              {soleRow?.status !== "failed" && (
                <span className="mcm-log-modal__spinner" />
              )}
              <span>
                {soleRow?.status === "failed"
                  ? t("recordings.failed")
                  : t("recordings.processing")}
              </span>
            </div>
          ) : (
            <div className="mcm-recplay__placeholder">
              <Film size={30} strokeWidth={1.5} aria-hidden="true" />
              <span>{t("recordings.pickTrack")}</span>
            </div>
          )}

          {active && (
            <div className="mcm-recplay__player-bar">
              <div className="mcm-recplay__player-meta">
                <span className="mcm-recplay__player-title">
                  {trackLabel(active)}
                  {active.duration
                    ? ` · ${fmtDuration(active.duration)}`
                    : ""}
                </span>
                {playerMeta && (
                  <span className="mcm-recplay__player-sub">{playerMeta}</span>
                )}
              </div>
              <button
                type="button"
                className="mcm-recplay__download"
                onClick={() => void downloadRecording(active.id)}
              >
                <Download size={14} /> {t("recordings.download")}
              </button>
            </div>
          )}
        </div>

        {/* ---- session list (each session = a group of tracks) ---- */}
        <div className="mcm-recplay__sessions">
          {sessions.map((session, sIdx) => {
            // Legacy standalone mixed rows (session_id null) share the same
            // session shell — one track inside — so they keep their "Bản ghi N"
            // number + timestamp (back-compat with pre-per-speaker recordings).
            const allPending = session.tracks.every(
              (r) => r.status !== "ready",
            );
            return (
              <section className="mcm-recplay__session" key={session.key}>
                <header className="mcm-recplay__session-head">
                  <span className="mcm-recplay__session-title">
                    {t("recordings.sessionNo", { n: sessionNo(sIdx) })}
                  </span>
                  <span className="mcm-recplay__session-sub">
                    {[
                      fmtWhen(session.startedAt),
                      session.legacy
                        ? ""
                        : t("recordings.trackCount", {
                            count: session.tracks.length,
                          }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </header>
                {allPending ? (
                  <div className="mcm-recplay__session-pending">
                    {session.tracks.some((r) => r.status === "failed") ? null : (
                      <span className="mcm-log-modal__spinner" />
                    )}
                    {session.tracks.every((r) => r.status === "failed")
                      ? t("recordings.failed")
                      : t("recordings.processing")}
                  </div>
                ) : (
                  <ul className="mcm-recplay__tracks">
                    {session.tracks.map((r) => (
                      <li key={r.id}>
                        <TrackRow
                          track={r}
                          activeId={activeId}
                          onSelect={select}
                          label={trackLabel(r)}
                          t={t}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** One selectable track button (mic / screen-audio / screen-video / legacy
 *  mixed). Shows a kind-specific icon, the track label, duration + size, and
 *  the existing processing/failed status handling. */
const TrackRow = ({
  track,
  activeId,
  onSelect,
  label,
  t,
}: {
  track: Track;
  activeId: string | null;
  onSelect: (id: string) => void | Promise<void>;
  label: string;
  t: ReturnType<typeof useT>;
}) => {
  const k = kindOf(track);
  const isReady = track.status === "ready";
  const isActive = track.id === activeId;
  const meta = [fmtSize(track.bytes)].filter(Boolean).join(" · ");
  const Icon = k === "screen-video" ? Film : k === "screen-audio" ? Volume2 : Mic;

  return (
    <button
      type="button"
      className={`mcm-recplay__track${
        isActive ? " mcm-recplay__track--active" : ""
      }${!isReady ? " mcm-recplay__track--pending" : ""}`}
      onClick={() => isReady && void onSelect(track.id)}
      disabled={!isReady}
      aria-pressed={isActive ? "true" : "false"}
    >
      <span
        className={`mcm-recplay__track-icon mcm-recplay__track-icon--${
          k === "screen-video" ? "video" : "audio"
        }`}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={1.5} />
        {isReady && (
          <span className="mcm-recplay__track-badge">
            <Play size={14} />
          </span>
        )}
      </span>
      <span className="mcm-recplay__track-body">
        <span className="mcm-recplay__track-title">
          <span className="mcm-recplay__track-name">{label}</span>
          {isReady && track.duration ? (
            <span className="mcm-recplay__track-dur">
              {fmtDuration(track.duration)}
            </span>
          ) : null}
        </span>
        {isReady ? (
          meta ? (
            <span className="mcm-recplay__track-meta">{meta}</span>
          ) : null
        ) : (
          <span className="mcm-recplay__track-status">
            {track.status !== "failed" && (
              <span className="mcm-log-modal__spinner" />
            )}
            {track.status === "failed"
              ? t("recordings.failed")
              : t("recordings.processing")}
          </span>
        )}
      </span>
    </button>
  );
};

export default RecordingsSection;
