import { History } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { getMyMeetings, type CalMeeting } from "../../data/calendar";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { listMyFiles } from "../../data/userFiles";
import { useT } from "../../i18n/mcm";

import "./ActivityLog.scss";

/**
 * Personal activity log — the History icon next to the notification bell
 * (quyết định anh Luân 06-11: bell = actionable notifications ONLY, history
 * lives in its own surface). A reverse-chronological log of what THIS user
 * did: meetings created, invitations received (+ answer), meetings joined,
 * shelf uploads.
 *
 * Deliberately DERIVED from data that already exists (meeting registry,
 * invitee rows, participant rows, user_file) — no event table to write at
 * action time, nothing new to operate. When more event kinds are needed
 * (edits, deletes, exports…) the honest upgrade is a real `user_activity`
 * table; until then this stays maintenance-free.
 */

const POLL_MS = 60 * 1000;
const LOG_LIMIT = 50;

type ActivityKind = "created" | "invited" | "joined" | "upload";

type ActivityEvent = {
  /** Stable key: kind + subject id. */
  key: string;
  kind: ActivityKind;
  /** Meeting title / file name. */
  subject: string;
  /** Project name when the subject is a meeting in a project. */
  context: string | null;
  /** Invite answer chip, only for kind === "invited". */
  inviteState?: "accepted" | "declined" | null;
  ts: number;
};

const tsToMs = (ts: number): number => (ts < 1e12 ? ts * 1000 : ts);

/** Compose the personal timeline from the surfaces we already fetch. */
const buildEvents = async (
  myEmail: string,
  fallbackTitle: string,
): Promise<ActivityEvent[]> => {
  const internal = isInternalEmail(myEmail);
  const [meetings, files] = await Promise.all([
    getMyMeetings(),
    internal ? listMyFiles() : Promise.resolve([]),
  ]);
  const events: ActivityEvent[] = [];
  for (const m of meetings as CalMeeting[]) {
    const title = m.title || fallbackTitle;
    if (m.organizer_email?.toLowerCase() === myEmail && m.created_at) {
      events.push({
        key: `created:${m.id}`,
        kind: "created",
        subject: title,
        context: m.project_name,
        ts: tsToMs(m.created_at),
      });
    }
    if (m.invited_direct && m.my_invited_at) {
      events.push({
        key: `invited:${m.id}`,
        kind: "invited",
        subject: title,
        context: m.project_name,
        inviteState:
          m.my_invite_status === "accepted" || m.my_invite_status === "declined"
            ? m.my_invite_status
            : null,
        ts: tsToMs(m.my_invited_at),
      });
    }
    if (m.my_joined_at) {
      events.push({
        key: `joined:${m.id}`,
        kind: "joined",
        subject: title,
        context: m.project_name,
        ts: tsToMs(m.my_joined_at),
      });
    }
  }
  for (const f of files) {
    events.push({
      key: `upload:${f.id}`,
      kind: "upload",
      subject: f.name,
      context: null,
      ts: tsToMs(f.created_at),
    });
  }
  return events.sort((a, b) => b.ts - a.ts).slice(0, LOG_LIMIT);
};

const fmtWhen = (ts: number): string =>
  new Date(ts).toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export const ActivityLog = () => {
  const t = useT();
  const session = useAtomValue(sessionAtom);

  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const myEmail = session?.email?.toLowerCase();
    if (!myEmail) {
      setEvents(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const list = await buildEvents(myEmail, t("folder.meetingFallbackTitle"));
      if (!cancelled) {
        setEvents(list);
      }
    };
    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session?.email, t]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!session) {
    return null;
  }

  const eventLabel = (ev: ActivityEvent): string => {
    switch (ev.kind) {
      case "created":
        return t("activity.evCreated");
      case "invited":
        return t("activity.evInvited");
      case "joined":
        return t("activity.evJoined");
      case "upload":
        return t("activity.evUpload");
      default:
        return "";
    }
  };

  return (
    <div className="mcm-activity" ref={rootRef}>
      <button
        type="button"
        className="mcm-activity__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("activity.title")}
        title={t("activity.title")}
        aria-expanded={open}
      >
        <History size={17} />
      </button>

      {open && (
        <div
          className="mcm-activity__panel"
          role="dialog"
          aria-label={t("activity.title")}
        >
          <div className="mcm-activity__head">{t("activity.title")}</div>
          {!events || events.length === 0 ? (
            <div className="mcm-activity__empty">{t("activity.empty")}</div>
          ) : (
            <ul className="mcm-activity__list">
              {events.map((ev) => (
                <li key={ev.key} className={`mcm-activity__item --${ev.kind}`}>
                  <div className="mcm-activity__info">
                    <span className="mcm-activity__label">
                      {eventLabel(ev)}
                      {ev.inviteState && (
                        <span
                          className={`mcm-activity__answer --${ev.inviteState}`}
                        >
                          {ev.inviteState === "accepted"
                            ? t("notif.stateAccepted")
                            : t("notif.stateDeclined")}
                        </span>
                      )}
                    </span>
                    <strong
                      className="mcm-activity__subject"
                      title={ev.subject}
                    >
                      {ev.subject}
                    </strong>
                    <span className="mcm-activity__meta">
                      {[ev.context, fmtWhen(ev.ts)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default ActivityLog;
