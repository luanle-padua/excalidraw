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

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAtom, useAtomValue, useSetAtom } from "../../app-jotai";
import {
  chatMessagesAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
} from "../../collab/Collab";
import { withAiActivity } from "../../data/aiActivity";
import { aiBackendUrl } from "../../data/aiBackend";
import { collectCanvasText } from "../../data/canvasText";
import { fetchWithAuth } from "../../data/fetchWithAuth";
import {
  clearTranscriptLog,
  meetingSummaryAtom,
  saveMeetingSummary,
  transcriptionLogAtom,
} from "../../data/transcription";
import { preferredLanguageAtom } from "../../data/translation";
import { sessionAtom } from "../../data/session";
import {
  meetingViewerAuthorityAtom,
  peerProfilesAtom,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { CanvasReplaySection } from "./CanvasReplaySection";
import { RecordingsSection } from "./RecordingsSection";
import { personColor } from "./meetingColors";
import { shortDisplayName } from "./animalEmoji";

import type {
  MeetingSummary,
  TranscriptSegment,
} from "../../data/transcription";

// --- helpers ---------------------------------------------------------

// Deterministic person tint, resolved through the SAME `personColor` MCMAvatar
// uses so a speaker's name tint == their avatar hue. Speaker rows key on EMAIL
// (stable login identity, falling back to socketId for anon link-joins); the AI
// summary participant chips key on the participant name string they carry.
const colorFor = (key: string): string => personColor(key);

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

type Tab = "transcript" | "summary" | "replay" | "recordings";

export const MeetingLogModal = ({ onClose }: { onClose: () => void }) => {
  const t = useT();
  const [log] = useAtom(transcriptionLogAtom);
  const setLog = useSetAtom(transcriptionLogAtom);
  const [summary, setSummary] = useAtom(meetingSummaryAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const chatMessages = useAtomValue(chatMessagesAtom);
  const excalidrawAPI = useExcalidrawAPI();
  const preferredLang = useAtomValue(preferredLanguageAtom);
  // Profile lookup powers the avatar img + name override on each
  // speaker run. Self reads its own atom directly so renames pop
  // immediately even before the broadcast lands.
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const selfSocketId = collabAPI?.portal.socket?.id;
  const [tab, setTab] = useState<Tab>("transcript");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Rate-limit (429) cooldown: the worker caps /summarize at 1/user/min to
  // hold down Gemini cost. Rather than surface the raw "Too many requests"
  // error, we show a friendly localized note AND disable the Generate button
  // for the cooldown so the user isn't tempted to hammer it. Seconds remaining;
  // 0 = no cooldown. The interval is cleared on unmount.
  const [cooldownSec, setCooldownSec] = useState(0);
  const cooldownTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (cooldownTimerRef.current !== null) {
        window.clearInterval(cooldownTimerRef.current);
      }
    },
    [],
  );
  const startCooldown = (seconds: number) => {
    setCooldownSec(seconds);
    if (cooldownTimerRef.current !== null) {
      window.clearInterval(cooldownTimerRef.current);
    }
    cooldownTimerRef.current = window.setInterval(() => {
      setCooldownSec((prev) => {
        if (prev <= 1) {
          if (cooldownTimerRef.current !== null) {
            window.clearInterval(cooldownTimerRef.current);
            cooldownTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };
  // Review = read the record, don't rewrite it: no clearing the cached log,
  // no regenerating the stored AI summary. Download/export stays — that's
  // the "extract-only" half of the review contract.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);

  // Phase 5 — the Recordings tab is gated to host / leadership / admin (anh Luân
  // 06-23 §7.2), NOT every participant. viewerAuthority is the server-computed
  // project-authority flag (leader / leading-division head); session.isAdmin /
  // isOwner cover the admin tier. The worker re-enforces on the list + stream
  // routes, so this is the UX half — a non-authority viewer never sees the tab.
  const session = useAtomValue(sessionAtom);
  const viewerAuthority = useAtomValue(meetingViewerAuthorityAtom);
  const canSeeRecordings =
    viewerAuthority || !!session?.isAdmin || !!session?.isOwner;

  const roomId = collabAPI?.portal.roomId ?? null;
  // Room key (from the URL hash, never sent to the server) — the replay player
  // decrypts the E2E canvas-history blob client-side with it.
  const roomKey = collabAPI?.portal.roomKey ?? null;
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
    // WHOLE-meeting recap (anh Luân 06-23): synthesize the entire meeting log
    // — transcript + chat + canvas notes — not just speech. So allow the
    // summary to run when ANY of those carry content (a canvas-only working
    // session is still worth recapping).
    const canvasText = collectCanvasText(excalidrawAPI);
    if (
      log.length === 0 &&
      chatMessages.length === 0 &&
      canvasText.length === 0
    ) {
      return;
    }
    if (cooldownSec > 0) {
      return; // still cooling down from a recent 429 — button is disabled too
    }
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await withAiActivity(() =>
        fetchWithAuth(`${aiBackendUrl()}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // meetingId gates the AI route (worker aiRoomGate): proves this
            // caller is a member of the room before summarization runs.
            meetingId: roomId ?? undefined,
            segments: log.map((s) => ({
              speaker: s.username,
              text: s.text,
              lang: s.lang,
              ts: s.ts,
            })),
            // Send chat + canvas too (was transcript-only) so the on-demand
            // recap matches the auto-recap and covers the whole meeting.
            chat: chatMessages.map((m) => ({
              username: m.username,
              text: m.text,
            })),
            canvasText,
            language: preferredLang,
          }),
        }),
      );
      if (res.status === 429) {
        // Friendly, localized rate-limit message + a cooldown so the user
        // understands they just generated a summary and should wait — instead
        // of the raw "Too many requests" error. Honour Retry-After if the
        // worker sends it, else default to the 60s window.
        const retryAfter = Number(res.headers.get("Retry-After"));
        const cooldown =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
        startCooldown(cooldown);
        setSummaryError(t("log.summaryRateLimited"));
        return;
      }
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
    // Empty the in-memory atom too so the UI clears immediately. The R2
    // transcript blob still exists — a rejoin re-hydrates it (separate debt).
    setLog([]);
    setSummary(null);
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
            {/* Canvas Replay — scrub/play back how the whiteboard evolved.
                Available to anyone in review (E2E: they hold the room key). */}
            <button
              type="button"
              role="tab"
              className={`mcm-log-modal__tab${
                tab === "replay" ? " mcm-log-modal__tab--active" : ""
              }`}
              onClick={() => setTab("replay")}
            >
              {t("log.tabReplay")}
            </button>
            {/* Phase 5 — Recordings tab, host/leadership/admin only. */}
            {canSeeRecordings && (
              <button
                type="button"
                role="tab"
                className={`mcm-log-modal__tab${
                  tab === "recordings" ? " mcm-log-modal__tab--active" : ""
                }`}
                onClick={() => setTab("recordings")}
              >
                {t("log.tabRecordings")}
              </button>
            )}
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
                  // Same profile-aware resolution as STT + chat: the
                  // log shows the user's chosen avatar + display name,
                  // falling back to a deterministic library image
                  // keyed off the speaker's EMAIL when logged in
                  // (socketId only for anonymous peers), so a
                  // transcript before profile setup still shows a
                  // real face, not a placeholder.
                  const speakerProfile =
                    run.socketId === selfSocketId
                      ? myProfile ?? undefined
                      : peerProfiles.get(run.socketId);
                  const speakerName = speakerProfile?.username || run.username;
                  return (
                    <div
                      key={`${run.socketId}-${run.startTs}-${idx}`}
                      className="mcm-log-modal__run"
                    >
                      <div className="mcm-log-modal__run-head">
                        <MCMAvatar
                          className="mcm-log-modal__run-avatar"
                          avatar={speakerProfile?.avatar}
                          name={speakerName}
                          email={speakerProfile?.email}
                          identityKey={speakerProfile?.email ?? run.socketId}
                        />
                        <span
                          className="mcm-log-modal__run-spk"
                          // per-speaker color keyed on EMAIL → matches the
                          // avatar hue + STT panel, stable across reconnects
                          // eslint-disable-next-line react/forbid-dom-props
                          style={{
                            color: colorFor(
                              speakerProfile?.email ?? run.socketId,
                            ),
                          }}
                        >
                          {shortDisplayName(speakerName)}
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
          {tab === "replay" && (
            <CanvasReplaySection roomId={roomId} roomKey={roomKey} />
          )}
          {tab === "recordings" && canSeeRecordings && (
            <RecordingsSection roomId={roomId} />
          )}
        </div>

        <div className="mcm-log-modal__footer">
          {!viewOnly && (
            <button
              type="button"
              className="mcm-log-modal__btn mcm-log-modal__btn--ghost"
              onClick={handleClear}
              disabled={log.length === 0 && !summary}
            >
              {t("log.buttonClear")}
            </button>
          )}
          <div className="mcm-log-modal__footer-spacer" />
          {tab === "summary" && !viewOnly && (
            <button
              type="button"
              className="mcm-log-modal__btn mcm-log-modal__btn--accent"
              onClick={handleGenerateSummary}
              disabled={
                summaryLoading ||
                cooldownSec > 0 ||
                // Allow generating from a meeting with NO transcript as long as
                // there was chat (canvas notes are also valid, but they're not
                // a reactive atom — the handler re-checks the canvas anyway).
                (log.length === 0 && chatMessages.length === 0)
              }
              title={
                cooldownSec > 0
                  ? t("log.summaryCooldown", { sec: cooldownSec })
                  : undefined
              }
            >
              {cooldownSec > 0
                ? t("log.summaryCooldown", { sec: cooldownSec })
                : summary
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
