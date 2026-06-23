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

import { Download, Film, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  listRecordings,
  recordingStreamUrl,
  type RecordingRow,
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
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [loading, setLoading] = useState(true);

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
            fmtWhen(r.readyAt ?? r.createdAt),
            fmtDuration(r.duration),
            fmtSize(r.bytes),
            r.startedBy,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={r.id} className="mcm-recordings__item">
              {ready ? (
                <video
                  className="mcm-recordings__video"
                  src={recordingStreamUrl(r.id)}
                  controls
                  preload="metadata"
                  playsInline
                />
              ) : (
                <div className="mcm-recordings__processing">
                  <span className="mcm-log-modal__spinner" />{" "}
                  {r.status === "failed"
                    ? t("recordings.failed")
                    : t("recordings.processing")}
                </div>
              )}
              <div className="mcm-recordings__row">
                <span className="mcm-recordings__meta">{meta}</span>
                {ready && (
                  <a
                    className="mcm-recordings__download"
                    href={recordingStreamUrl(r.id, true)}
                    download
                  >
                    <Download size={14} /> {t("recordings.download")}
                  </a>
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
