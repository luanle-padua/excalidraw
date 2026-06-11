import { CalendarClock, LogIn, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { getMyMeetings, type CalMeeting } from "../../data/calendar";
import { getMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { normalizeMeetingStatus } from "./meetingStatus";

/**
 * "Meeting tới giờ" — a bottom-right toast that surfaces when a SCHEDULED
 * meeting the user can see reaches its start time, suggesting they join.
 *
 * Mounted by MeetingShell but only VISIBLE outside a meeting (the in-meeting
 * canvas stays clean — and a user already in the room doesn't need a nudge).
 * Polls the calendar every minute; a meeting whose `scheduled_at` falls in
 * the [now − 10 min, now + 5 min] window is "due". At most ONE notice shows
 * at a time — the most overdue one.
 *
 * Joining goes through the SAME flow as the lobby's invited-meetings list:
 * the start gate in Collab handles a still-`scheduled` room, so the user
 * lands on WaitingForStart — and if they're the host, that's exactly where
 * the Start button lives. No special-casing needed here.
 */

// How far PAST the scheduled time we still nag (someone who opens the app
// 8 minutes late should still get the nudge)…
const DUE_PAST_MS = 10 * 60 * 1000;
// …and how far AHEAD we pre-announce ("about to start").
const DUE_SOON_MS = 5 * 60 * 1000;
const POLL_MS = 60 * 1000;

// Soft attention: prefix the tab title with a bell while the notice is up.
// Deliberately NOT the Notification API — no permission prompt, no OS toast.
const BELL_PREFIX = "🔔 ";

// Session-scoped dismissals — module-level (not component state) so a shell
// remount (e.g. leaving a meeting) doesn't re-toast a meeting the user
// already waved off this session. Cleared by a full page reload, which is
// the right reset point for a "this session" memory.
const dismissedIds = new Set<string>();

/** The single most-due meeting in the window, or null. Earliest scheduled
 *  time wins — the longer a meeting has been waiting, the louder it asks. */
const findMostDue = (meetings: CalMeeting[]): CalMeeting | null => {
  const now = Date.now();
  const candidates = meetings.filter((m) => {
    if (dismissedIds.has(m.id) || !m.scheduled_at) {
      return false;
    }
    // Only `scheduled` meetings prompt — live ones are already underway
    // (the invited list covers joining those), finished ones never nag.
    if (normalizeMeetingStatus(m.status) !== "scheduled") {
      return false;
    }
    const at = new Date(m.scheduled_at).getTime();
    return (
      !Number.isNaN(at) && at >= now - DUE_PAST_MS && at <= now + DUE_SOON_MS
    );
  });
  candidates.sort(
    (a, b) =>
      new Date(a.scheduled_at!).getTime() - new Date(b.scheduled_at!).getTime(),
  );
  return candidates[0] ?? null;
};

/** "14:05" — the window is ±minutes around now, so time-of-day is enough. */
const fmtTime = (s: string): string => {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const MeetingDueNotice = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const session = useAtomValue(sessionAtom);

  const [due, setDue] = useState<CalMeeting | null>(null);
  const [busy, setBusy] = useState(false);
  // Last fetched calendar — lets dismiss promote the NEXT due meeting
  // immediately instead of waiting out the poll interval.
  const lastListRef = useRef<CalMeeting[]>([]);

  // Poll the calendar while signed in and OUTSIDE a meeting. Re-arms when
  // the user leaves a meeting (isCollaborating flips false → fresh fetch).
  useEffect(() => {
    if (!session || isCollaborating) {
      setDue(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const list = await getMyMeetings();
      if (!cancelled) {
        lastListRef.current = list;
        setDue(findMostDue(list));
      }
    };
    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session, isCollaborating]);

  const visible = !!session && !isCollaborating && !!collabAPI && !!due;

  // Tab-title bell while the notice is up; restored on dismiss/join/unmount.
  // Idempotent (startsWith guard) so re-renders can't stack prefixes.
  useEffect(() => {
    if (!visible) {
      return;
    }
    if (!document.title.startsWith(BELL_PREFIX)) {
      document.title = BELL_PREFIX + document.title;
    }
    return () => {
      if (document.title.startsWith(BELL_PREFIX)) {
        document.title = document.title.slice(BELL_PREFIX.length);
      }
    };
  }, [visible]);

  if (!visible || !due) {
    return null;
  }

  const dismiss = () => {
    dismissedIds.add(due.id);
    setDue(findMostDue(lastListRef.current));
  };

  const join = async () => {
    if (busy || !collabAPI) {
      return;
    }
    setBusy(true);
    try {
      // Same flow as InvitedMeetings.join: resolve the room key, tear down
      // any current room so startCollaboration actually switches, then enter.
      // A still-`scheduled` meeting parks on the start gate — correct: the
      // user may BE the host who should press Start.
      const m = await getMeeting(due.id);
      if (!m?.room_key) {
        showAppToast(t("errors.openMeetingFailed"));
        return;
      }
      dismissedIds.add(due.id); // joined — never re-toast this one
      collabAPI.stopCollaboration(false);
      window.history.pushState(
        {},
        "",
        getCollaborationLink({ roomId: due.id, roomKey: m.room_key }),
      );
      await collabAPI.startCollaboration({
        roomId: due.id,
        roomKey: m.room_key,
      });
    } finally {
      setBusy(false);
    }
  };

  const at = new Date(due.scheduled_at!).getTime();
  const upcoming = at > Date.now();

  return (
    <div className="mcm-due" role="alert" aria-live="assertive">
      <CalendarClock size={20} className="mcm-due__icon" />
      <div className="mcm-due__body">
        <span className="mcm-due__eyebrow">
          {upcoming ? t("due.title") : t("due.now")}
        </span>
        <strong className="mcm-due__title">
          {due.title || t("folder.meetingFallbackTitle")}
        </strong>
        <span className="mcm-due__when">
          {[due.project_name, fmtTime(due.scheduled_at!)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <button
          type="button"
          className="mcm-due__join"
          onClick={() => void join()}
          disabled={busy}
        >
          <LogIn size={14} /> {t("due.join")}
        </button>
      </div>
      <button
        type="button"
        className="mcm-due__close"
        onClick={dismiss}
        aria-label={t("due.dismiss")}
        title={t("due.dismiss")}
      >
        <X size={15} />
      </button>
    </div>
  );
};

export default MeetingDueNotice;
