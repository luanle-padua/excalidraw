// Phase 5 — review-mode RECORDINGS section. Shown inside the finished-meeting
// review (MeetingLogModal "Recordings" tab). Lists this meeting's Daily cloud
// recordings (listRecordings) and lets an authorised viewer play each one in a
// <video> player or download it.
//
// ACCESS (anh Luân 06-23 §7.2): host / organizer / project leadership / admin
// ONLY — NOT every participant. The caller (MeetingLogModal) hides the whole
// tab when the viewer lacks authority; this component additionally relies on
// the worker auth-gating the list + stream routes (a non-authority caller gets
// [] / 403). The media is streamed from R2 behind the worker gate — there is no
// public link.
//
// MEDIA AUTH: the stream route is JWT-gated and a <video src> can't attach the
// bearer, so we lazily fetch each recording through fetchRecordingObjectUrl
// (fetchWithAuth → blob → object URL) only when the viewer clicks Play, and
// revoke the object URLs on unmount. Download goes through downloadRecording
// (same gated fetch → disk). See data/recordings.ts for the rationale.

import { Download, Film, Play, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadRecording,
  fetchRecordingObjectUrl,
  listRecordings,
  type Recording,
} from "../../data/recordings";
import { useT } from "../../i18n/mcm";

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
  // Object URL per recording id, loaded on Play (so we don't buffer every file
  // up front). Revoked on unmount.
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const mediaUrlsRef = useRef<Record<string, string>>({});
  mediaUrlsRef.current = mediaUrls;

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

  // Free every blob the player created when the section unmounts.
  useEffect(
    () => () => {
      Object.values(mediaUrlsRef.current).forEach((u) =>
        URL.revokeObjectURL(u),
      );
    },
    [],
  );

  const play = useCallback(async (id: string) => {
    setLoadingId(id);
    const url = await fetchRecordingObjectUrl(id);
    setLoadingId(null);
    if (url) {
      setMediaUrls((prev) => ({ ...prev, [id]: url }));
    }
  }, []);

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
          className="mcm-recordings__refresh"
          onClick={() => void load()}
        >
          <RotateCw size={14} /> {t("recordings.refresh")}
        </button>
      </div>
    );
  }

  return (
    <div className="mcm-recordings">
      <div className="mcm-recordings__head">
        <span className="mcm-recordings__count">
          {t("recordings.count", { count: rows.length })}
        </span>
        <button
          type="button"
          className="mcm-recordings__refresh"
          onClick={() => void load()}
          title={t("recordings.refresh")}
        >
          <RotateCw size={14} />
        </button>
      </div>
      <ul className="mcm-recordings__list">
        {rows.map((r) => {
          const ready = r.status === "ready";
          const meta = [
            fmtWhen(r.ready_at ?? r.created_at),
            fmtDuration(r.duration),
            fmtSize(r.bytes),
            r.started_by,
          ]
            .filter(Boolean)
            .join(" · ");
          const mediaUrl = mediaUrls[r.id];
          return (
            <li key={r.id} className="mcm-recordings__item">
              {!ready ? (
                <div className="mcm-recordings__processing">
                  <span className="mcm-log-modal__spinner" />{" "}
                  {r.status === "failed"
                    ? t("recordings.failed")
                    : t("recordings.processing")}
                </div>
              ) : mediaUrl ? (
                <video
                  className="mcm-recordings__video"
                  src={mediaUrl}
                  controls
                  autoPlay
                  preload="metadata"
                  playsInline
                />
              ) : (
                <button
                  type="button"
                  className="mcm-recordings__play"
                  onClick={() => void play(r.id)}
                  disabled={loadingId === r.id}
                >
                  {loadingId === r.id ? (
                    <span className="mcm-log-modal__spinner" />
                  ) : (
                    <Play size={18} />
                  )}{" "}
                  {t("recordings.play")}
                </button>
              )}
              <div className="mcm-recordings__row">
                <span className="mcm-recordings__meta">{meta}</span>
                {ready && (
                  <button
                    type="button"
                    className="mcm-recordings__download"
                    onClick={() => void downloadRecording(r.id)}
                  >
                    <Download size={14} /> {t("recordings.download")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default RecordingsSection;
