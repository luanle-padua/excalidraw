// Phase 5 — review-mode RECORDINGS section. Shown inside the finished-meeting
// review (MeetingLogModal "Recordings" tab). Lists this meeting's recordings
// (listRecordings) and lets an authorised viewer play / download each one.
//
// UX (owner 06-24): a meeting can have MULTIPLE recordings (each Record→Stop =
// one clip). We present them as a CLIP LIST + a prominent player: the list shows
// clip #, start time, duration, size and a placeholder thumbnail; clicking a clip
// loads it into the big player above. A single clip skips the list and just shows
// the player. New styling lives in RecordingsSection.scss (new mcm-recplay-*
// classes) — the legacy `.mcm-recordings` rules in MeetingShell.scss are left
// untouched (owned by another team).
//
// ACCESS (anh Luân 06-23 §7.2): host / organizer / project leadership / admin
// ONLY — NOT every participant. The caller (MeetingLogModal) hides the whole
// tab when the viewer lacks authority; this component additionally relies on
// the worker auth-gating the list + stream routes (a non-authority caller gets
// [] / 403). The media is streamed from R2 behind the worker gate — there is no
// public link.
//
// MEDIA AUTH: the stream route is JWT-gated and a <video src> can't attach the
// bearer, so we lazily fetch the SELECTED recording through fetchRecordingObjectUrl
// (fetchWithAuth → blob → object URL) only when the viewer picks a clip, and
// revoke object URLs on unmount / re-selection. Download goes through
// downloadRecording (same gated fetch → disk). See data/recordings.ts.

import { Download, Film, Play, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadRecording,
  fetchRecordingObjectUrl,
  listRecordings,
  type Recording,
} from "../../data/recordings";
import { useT } from "../../i18n/mcm";

import "./RecordingsSection.scss";

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

export const RecordingsSection = ({ roomId }: { roomId: string | null }) => {
  const t = useT();
  const [rows, setRows] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  // The recording currently loaded in the big player.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Object URL for the active recording, loaded on selection. Only ONE clip is
  // buffered at a time (the previous one is revoked) so we never hold several
  // full videos in memory.
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
    const list = await listRecordings(roomId);
    setRows(list);
    setLoading(false);
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Free the buffered blob when the section unmounts.
  useEffect(
    () => () => {
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
      }
    },
    [],
  );

  // Select a clip → fetch its gated media into an object URL and load the
  // player. Revokes any previously-buffered clip first.
  const select = useCallback(async (id: string) => {
    setActiveId(id);
    setLoadingMedia(true);
    const url = await fetchRecordingObjectUrl(id);
    setLoadingMedia(false);
    // Revoke the previous clip's blob now that a new one is ready.
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
    }
    setActiveUrl(url);
  }, []);

  const ready = rows.filter((r) => r.status === "ready");

  // Auto-select the (newest) ready clip when there's exactly one, so a
  // single-recording meeting opens straight into the player.
  useEffect(() => {
    if (!activeId && ready.length === 1) {
      void select(ready[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.length, activeId]);

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

  // rows arrive newest-first; number clips oldest-first ("Clip 1" = first
  // recording of the meeting) so the numbering matches chronology.
  const total = rows.length;
  const clipNo = (idx: number) => total - idx;

  const active = activeId ? rows.find((r) => r.id === activeId) ?? null : null;
  const activeNo = active ? clipNo(rows.indexOf(active)) : null;
  const playerMeta = active
    ? [
        fmtWhen(active.ready_at ?? active.created_at),
        fmtSize(active.bytes),
        active.started_by,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const singleClip = rows.length === 1;
  // The single clip when there's exactly one recording — used to surface its
  // processing/failed state in the player (the clip list is hidden in that case).
  const soleRow = singleClip ? rows[0] : null;
  const solePending = soleRow ? soleRow.status !== "ready" : false;

  return (
    <div className="mcm-recplay">
      <div className="mcm-recplay__head">
        <span className="mcm-recplay__count">
          {t("recordings.count", { count: rows.length })}
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
            <video
              key={active.id}
              className="mcm-recplay__video"
              src={activeUrl}
              controls
              autoPlay
              preload="metadata"
              playsInline
            />
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
              <span>{t("recordings.pickClip")}</span>
            </div>
          )}

          {active && (
            <div className="mcm-recplay__player-bar">
              <div className="mcm-recplay__player-meta">
                <span className="mcm-recplay__player-title">
                  {t("recordings.clipNo", { n: activeNo ?? 1 })}
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

        {/* ---- clip list (hidden when there's only one recording) ---- */}
        {!singleClip && (
          <ul className="mcm-recplay__list">
            {rows.map((r, idx) => {
              const isReady = r.status === "ready";
              const isActive = r.id === activeId;
              const meta = [
                fmtWhen(r.ready_at ?? r.created_at),
                fmtSize(r.bytes),
                r.started_by,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`mcm-recplay__clip${
                      isActive ? " mcm-recplay__clip--active" : ""
                    }${!isReady ? " mcm-recplay__clip--pending" : ""}`}
                    onClick={() => isReady && void select(r.id)}
                    disabled={!isReady}
                    aria-pressed={isActive}
                  >
                    <span className="mcm-recplay__thumb" aria-hidden="true">
                      <Film size={18} strokeWidth={1.5} />
                      {isReady && (
                        <span className="mcm-recplay__thumb-badge">
                          <Play size={16} />
                        </span>
                      )}
                    </span>
                    <span className="mcm-recplay__clip-body">
                      <span className="mcm-recplay__clip-title">
                        {t("recordings.clipNo", { n: clipNo(idx) })}
                        {isReady && r.duration ? (
                          <span className="mcm-recplay__clip-dur">
                            {fmtDuration(r.duration)}
                          </span>
                        ) : null}
                      </span>
                      {isReady ? (
                        <span className="mcm-recplay__clip-meta">{meta}</span>
                      ) : (
                        <span className="mcm-recplay__clip-status">
                          {r.status !== "failed" && (
                            <span className="mcm-log-modal__spinner" />
                          )}
                          {r.status === "failed"
                            ? t("recordings.failed")
                            : t("recordings.processing")}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default RecordingsSection;
