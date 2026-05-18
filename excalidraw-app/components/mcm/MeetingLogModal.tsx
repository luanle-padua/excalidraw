// Meeting log + summary modal.
//
// Tabs:
//   - "Biên bản" (default): full chronological transcript with speaker
//     attribution + per-segment language tag. Grouped visually by
//     consecutive same-speaker runs.
//   - "Tóm tắt": Gemini-generated summary with sections — narrative,
//     decisions, action items, key topics, participants. Generated
//     on-demand (button) and persisted to localStorage per room.
//
// Footer: download the transcript or summary as a Markdown file,
// clear-with-confirm to wipe history for this room.

import { useEffect, useMemo, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import {
  clearTranscriptLog,
  meetingSummaryAtom,
  saveMeetingSummary,
  transcriptionLogAtom,
} from "../../data/transcription";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

import { emojiForUsername, shortDisplayName } from "./animalEmoji";

import type {
  MeetingSummary,
  TranscriptSegment,
} from "../../data/transcription";

// --- helpers ---------------------------------------------------------

const PALETTE: [string, string][] = [
  ["#34d399", "#0ea5e9"],
  ["#f472b6", "#ef4444"],
  ["#fbbf24", "#f97316"],
  ["#60a5fa", "#6366f1"],
  ["#a78bfa", "#ec4899"],
  ["#22d3ee", "#3b82f6"],
  ["#fb7185", "#f59e0b"],
  ["#84cc16", "#10b981"],
];
const colorFor = (key: string): string => {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length][0];
};

const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
};

const fmtDate = (ts: number): string =>
  new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

// Group consecutive same-speaker segments together (visual run, no
// time window — meeting transcripts rarely have rapid speaker switch).
type SpeakerRun = {
  socketId: string;
  username: string;
  startTs: number;
  segments: TranscriptSegment[];
};

const groupBySpeaker = (segments: TranscriptSegment[]): SpeakerRun[] => {
  const runs: SpeakerRun[] = [];
  for (const seg of segments) {
    const last = runs[runs.length - 1];
    if (last && last.socketId === seg.socketId) {
      last.segments.push(seg);
    } else {
      runs.push({
        socketId: seg.socketId,
        username: seg.username,
        startTs: seg.ts,
        segments: [seg],
      });
    }
  }
  return runs;
};

const segmentsToMarkdown = (
  segments: TranscriptSegment[],
  title: string,
): string => {
  if (segments.length === 0) {
    return `# ${title}\n\n_(no transcript)_\n`;
  }
  const head = `# ${title}\n\n_${fmtDate(segments[0].ts)} — ${fmtTime(
    segments[0].ts,
  )} → ${fmtTime(segments[segments.length - 1].ts)}_\n\n`;
  const runs = groupBySpeaker(segments);
  const body = runs
    .map((run) => {
      const headerLine = `**${run.username}** _(${fmtTime(run.startTs)})_`;
      const lines = run.segments
        .map((s) => `  - ${s.text}${s.lang ? ` _[${s.lang}]_` : ""}`)
        .join("\n");
      return `${headerLine}\n${lines}`;
    })
    .join("\n\n");
  return `${head}${body}\n`;
};

const summaryToMarkdown = (summary: MeetingSummary, title: string): string => {
  const sections: string[] = [`# ${title} — Tóm tắt`, ""];
  sections.push(
    `_Tạo lúc ${fmtDate(summary.generatedAt)} ${fmtTime(summary.generatedAt)}_`,
  );
  sections.push("");
  sections.push("## Tổng quan");
  sections.push(summary.summary);
  if (summary.participants.length) {
    sections.push("");
    sections.push("## Người tham dự");
    sections.push(summary.participants.map((p) => `- ${p}`).join("\n"));
  }
  if (summary.keyTopics?.length) {
    sections.push("");
    sections.push("## Chủ đề chính");
    sections.push(summary.keyTopics.map((t) => `- ${t}`).join("\n"));
  }
  if (summary.decisions.length) {
    sections.push("");
    sections.push("## Quyết định");
    sections.push(summary.decisions.map((d) => `- ${d}`).join("\n"));
  }
  if (summary.actionItems.length) {
    sections.push("");
    sections.push("## Action items");
    sections.push(
      summary.actionItems
        .map(
          (a) =>
            `- **${a.owner}** — ${a.task}${
              a.due ? ` _(deadline: ${a.due})_` : ""
            }`,
        )
        .join("\n"),
    );
  }
  return `${sections.join("\n")}\n`;
};

const downloadMarkdown = (filename: string, content: string): void => {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to honour the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// --- modal -----------------------------------------------------------

type Tab = "transcript" | "summary";

export const MeetingLogModal = ({ onClose }: { onClose: () => void }) => {
  const t = useT();
  const [log] = useAtom(transcriptionLogAtom);
  const [summary, setSummary] = useAtom(meetingSummaryAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const preferredLang = useAtomValue(preferredLanguageAtom);
  const [tab, setTab] = useState<Tab>("transcript");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const roomId = collabAPI?.portal.roomId ?? null;
  const meetingTitle = useMemo(() => {
    if (roomId) {
      return t("log.titleWithId", { id: roomId.slice(0, 6) });
    }
    return t("log.title");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, t]);

  const runs = useMemo(() => groupBySpeaker(log), [log]);

  // Close on Escape — modal etiquette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleGenerateSummary = async () => {
    if (log.length === 0) {
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await fetch("/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: log.map((s) => ({
            speaker: s.username,
            text: s.text,
            lang: s.lang,
            ts: s.ts,
          })),
          language: preferredLang,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `${t("log.summaryFailedPrefix")} (${res.status}) ${errBody.slice(
            0,
            200,
          )}`,
        );
      }
      const body = (await res.json()) as Omit<MeetingSummary, "generatedAt">;
      const next: MeetingSummary = {
        summary: body.summary ?? "",
        decisions: Array.isArray(body.decisions) ? body.decisions : [],
        actionItems: Array.isArray(body.actionItems) ? body.actionItems : [],
        participants: Array.isArray(body.participants) ? body.participants : [],
        keyTopics:
          (body as any).keyTopics && Array.isArray((body as any).keyTopics)
            ? (body as any).keyTopics
            : [],
        generatedAt: Date.now(),
      };
      setSummary(next);
      if (roomId) {
        saveMeetingSummary(roomId, next);
      }
      setTab("summary");
    } catch (err) {
      setSummaryError((err as Error)?.message ?? t("log.summaryError"));
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleDownload = () => {
    if (tab === "transcript") {
      downloadMarkdown(
        `${meetingTitle.replace(/\s+/g, "-").toLowerCase()}-transcript.md`,
        segmentsToMarkdown(log, meetingTitle),
      );
      return;
    }
    if (summary) {
      downloadMarkdown(
        `${meetingTitle.replace(/\s+/g, "-").toLowerCase()}-summary.md`,
        summaryToMarkdown(summary, meetingTitle),
      );
    }
  };

  const handleClear = () => {
    if (!roomId) {
      return;
    }
    const ok = window.confirm(
      t("log.confirmClear", { roomId: roomId.slice(0, 6) }),
    );
    if (!ok) {
      return;
    }
    clearTranscriptLog(roomId);
    setSummary(null);
    // Local atom is cleared by TranscriptionController when room
    // leaves; for now we leave it untouched — refresh applies fully.
  };

  return (
    <div
      className="mcm-log-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("log.title")}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="mcm-log-modal">
        <div className="mcm-log-modal__header">
          <div className="mcm-log-modal__head-text">
            <h2 className="mcm-log-modal__title">{meetingTitle}</h2>
            <span className="mcm-log-modal__meta">
              {log.length === 1
                ? t("log.metaSegments", { count: log.length })
                : t("log.metaSegmentsPlural", { count: log.length })}
              {log.length > 0 && (
                <>
                  {" · "}
                  {fmtDate(log[0].ts)} {fmtTime(log[0].ts)} →{" "}
                  {fmtTime(log[log.length - 1].ts)}
                </>
              )}
            </span>
          </div>
          <div className="mcm-log-modal__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`mcm-log-modal__tab${
                tab === "transcript" ? " mcm-log-modal__tab--active" : ""
              }`}
              onClick={() => setTab("transcript")}
            >
              {t("log.tabTranscript")}
            </button>
            <button
              type="button"
              role="tab"
              className={`mcm-log-modal__tab${
                tab === "summary" ? " mcm-log-modal__tab--active" : ""
              }`}
              onClick={() => setTab("summary")}
            >
              {t("log.tabSummary")}
              {summary && (
                <span className="mcm-log-modal__tab-dot" aria-hidden="true" />
              )}
            </button>
          </div>
          <button
            type="button"
            className="mcm-log-modal__close"
            onClick={onClose}
            aria-label={t("log.closeAria")}
          >
            ×
          </button>
        </div>

        <div className="mcm-log-modal__body">
          {tab === "transcript" && (
            <>
              {runs.length === 0 ? (
                <div className="mcm-log-modal__empty">
                  {t("log.emptyTranscript")}
                </div>
              ) : (
                runs.map((run, idx) => {
                  const emoji = emojiForUsername(run.username);
                  return (
                    <div
                      key={`${run.socketId}-${run.startTs}-${idx}`}
                      className="mcm-log-modal__run"
                    >
                      <div className="mcm-log-modal__run-head">
                        {emoji && (
                          <span
                            className="mcm-log-modal__run-emoji"
                            aria-hidden="true"
                          >
                            {emoji}
                          </span>
                        )}
                        <span
                          className="mcm-log-modal__run-spk"
                          // per-speaker color matches the avatar + STT panel
                          // eslint-disable-next-line react/forbid-dom-props
                          style={{ color: colorFor(run.socketId) }}
                        >
                          {shortDisplayName(run.username)}
                        </span>
                        <span className="mcm-log-modal__run-at">
                          {fmtTime(run.startTs)}
                        </span>
                      </div>
                      {run.segments.map((seg) => (
                        <div key={seg.id} className="mcm-log-modal__seg">
                          {seg.text}
                          {seg.lang && (
                            <span className="mcm-log-modal__seg-lang">
                              {seg.lang}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </>
          )}

          {tab === "summary" && (
            <>
              {summaryError && (
                <div className="mcm-log-modal__error">{summaryError}</div>
              )}
              {!summary && !summaryLoading && (
                <div className="mcm-log-modal__empty">
                  {t("log.emptySummary")}
                </div>
              )}
              {summaryLoading && (
                <div className="mcm-log-modal__empty">
                  <span className="mcm-log-modal__spinner" />{" "}
                  {t("log.summaryLoading")}
                </div>
              )}
              {summary && !summaryLoading && (
                <>
                  <section className="mcm-log-modal__section">
                    <h3>{t("log.sectionOverview")}</h3>
                    <p>{summary.summary}</p>
                  </section>
                  {summary.participants.length > 0 && (
                    <section className="mcm-log-modal__section">
                      <h3>{t("log.sectionParticipants")}</h3>
                      <ul className="mcm-log-modal__chips">
                        {summary.participants.map((p) => (
                          <li
                            key={p}
                            className="mcm-log-modal__chip"
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{
                              borderColor: colorFor(p),
                              color: colorFor(p),
                            }}
                          >
                            {p}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {summary.keyTopics?.length > 0 && (
                    <section className="mcm-log-modal__section">
                      <h3>{t("log.sectionKeyTopics")}</h3>
                      <ul className="mcm-log-modal__chips">
                        {summary.keyTopics.map((topic) => (
                          <li
                            key={topic}
                            className="mcm-log-modal__chip mcm-log-modal__chip--neutral"
                          >
                            {topic}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {summary.decisions.length > 0 && (
                    <section className="mcm-log-modal__section">
                      <h3>{t("log.sectionDecisions")}</h3>
                      <ul className="mcm-log-modal__bullets">
                        {summary.decisions.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {summary.actionItems.length > 0 && (
                    <section className="mcm-log-modal__section">
                      <h3>{t("log.sectionActionItems")}</h3>
                      <ul className="mcm-log-modal__actions">
                        {summary.actionItems.map((a, i) => (
                          <li key={i}>
                            <strong>{a.owner}</strong> — {a.task}
                            {a.due && (
                              <span className="mcm-log-modal__due">
                                {" "}
                                · {t("log.deadlineLabel")} {a.due}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="mcm-log-modal__footer">
          <button
            type="button"
            className="mcm-log-modal__btn mcm-log-modal__btn--ghost"
            onClick={handleClear}
            disabled={log.length === 0 && !summary}
          >
            {t("log.buttonClear")}
          </button>
          <div className="mcm-log-modal__footer-spacer" />
          {tab === "summary" && (
            <button
              type="button"
              className="mcm-log-modal__btn mcm-log-modal__btn--accent"
              onClick={handleGenerateSummary}
              disabled={summaryLoading || log.length === 0}
            >
              {summary
                ? t("log.buttonRegenerateSummary")
                : t("log.buttonGenerateSummary")}
            </button>
          )}
          <button
            type="button"
            className="mcm-log-modal__btn mcm-log-modal__btn--primary"
            onClick={handleDownload}
            disabled={tab === "summary" ? !summary : log.length === 0}
          >
            {t("log.buttonDownload")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MeetingLogModal;
