import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { subscribeLobbyMeetings, type CalMeeting } from "../../data/calendar";
import { respondInvitation } from "../../data/invitations";
import { getMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { normalizeMeetingStatus } from "./meetingStatus";

import "./NotificationBell.scss";

/**
 * Notification bell — dashboard top-bar entry point that COLLECTS pending
 * meeting invitations so none get lost (the MeetingDueNotice toast only
 * surfaces one at a time, and only in its due window). The dropdown lists
 * every invitation still awaiting MY answer; each row carries its own
 * Accept / Decline, and accepting a LIVE meeting joins it on the spot.
 *
 * Mounted in the lobby header — only rendered while signed in and outside
 * a meeting (the lobby itself guarantees that).
 */

/** /v1/me/meetings also carries my own RSVP state ('invited' | 'accepted' |
 *  'declined' | NULL when I'm not a direct invitee) — the calendar type
 *  doesn't surface it, so widen locally rather than touch data/calendar. */
type PendingInvite = CalMeeting & { my_invite_status?: string | null };

/** Invitations still waiting on me: directly invited, never joined, not yet
 *  answered, and the meeting can still happen (live or scheduled — finished
 *  and cancelled rooms have nothing left to accept). */
const findPending = (meetings: PendingInvite[]): PendingInvite[] =>
  meetings.filter((m) => {
    const status = normalizeMeetingStatus(m.status);
    return (
      !!m.invited_direct &&
      !m.attended &&
      m.my_invite_status === "invited" &&
      (status === "live" || status === "scheduled")
    );
  });

/** "11/06 14:05" — unlike the due toast, an invitation can point days ahead,
 *  so time-of-day alone isn't enough. */
const fmtWhen = (s: string): string => {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString([], {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export const NotificationBell = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const session = useAtomValue(sessionAtom);

  const [items, setItems] = useState<PendingInvite[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Same poll rhythm as MeetingDueNotice — the invite grants access but
  // sends no email/push, so this poll IS the notification channel.
  // (History of past actions deliberately lives in the SEPARATE ActivityLog
  // next door — the bell stays a to-do list, quyết định anh Luân 06-11.)
  useEffect(() => {
    if (!session) {
      setItems([]);
      return;
    }
    const { unsubscribe } = subscribeLobbyMeetings((list) => {
      setItems(findPending(list as PendingInvite[]));
    });
    return unsubscribe;
  }, [session]);

  // Click anywhere outside the bell closes the panel.
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

  // Join a live meeting — same flow as MeetingDueNotice: resolve the room
  // key, tear down any current room so startCollaboration actually switches,
  // then enter.
  const joinLive = async (m: PendingInvite) => {
    if (!collabAPI) {
      return;
    }
    const full = await getMeeting(m.id);
    if (!full?.room_key) {
      showAppToast(t("errors.openMeetingFailed"));
      return;
    }
    setOpen(false);
    collabAPI.stopCollaboration(false);
    window.history.pushState(
      {},
      "",
      getCollaborationLink({ roomId: m.id, roomKey: full.room_key }),
    );
    await collabAPI.startCollaboration({
      roomId: m.id,
      roomKey: full.room_key,
    });
  };

  const accept = async (m: PendingInvite) => {
    if (busyId) {
      return;
    }
    setBusyId(m.id);
    try {
      if (!(await respondInvitation(m.id, "accepted"))) {
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== m.id));
      // A live meeting accepted = "I'm coming" — join right away.
      if (normalizeMeetingStatus(m.status) === "live") {
        await joinLive(m);
      }
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (m: PendingInvite) => {
    if (busyId) {
      return;
    }
    setBusyId(m.id);
    try {
      if (await respondInvitation(m.id, "declined")) {
        setItems((prev) => prev.filter((x) => x.id !== m.id));
        showAppToast(t("notif.declinedDone"));
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mcm-bell" ref={rootRef}>
      <button
        type="button"
        className="mcm-bell__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notif.bellAria")}
        title={t("notif.bellAria")}
        aria-expanded={open}
      >
        <Bell size={17} />
        {items.length > 0 && (
          <span className="mcm-bell__badge">{items.length}</span>
        )}
      </button>

      {open && (
        <div
          className="mcm-bell__panel"
          role="dialog"
          aria-label={t("notif.title")}
        >
          <div className="mcm-bell__head">{t("notif.title")}</div>
          {items.length === 0 ? (
            <div className="mcm-bell__empty">{t("notif.empty")}</div>
          ) : (
            <ul className="mcm-bell__list">
              {items.map((m) => {
                const live = normalizeMeetingStatus(m.status) === "live";
                return (
                  <li key={m.id} className="mcm-bell__item">
                    <div className="mcm-bell__info">
                      <strong className="mcm-bell__title">
                        {m.title || t("folder.meetingFallbackTitle")}
                      </strong>
                      <span className="mcm-bell__meta">
                        {live ? (
                          <span className="mcm-bell__live">
                            {t("notif.live")}
                          </span>
                        ) : m.scheduled_at ? (
                          <span>{fmtWhen(m.scheduled_at)}</span>
                        ) : null}
                        {m.project_name && <span>{m.project_name}</span>}
                      </span>
                    </div>
                    <div className="mcm-bell__actions">
                      <button
                        type="button"
                        className="mcm-bell__accept"
                        onClick={() => void accept(m)}
                        disabled={busyId === m.id}
                      >
                        {t("notif.accept")}
                      </button>
                      <button
                        type="button"
                        className="mcm-bell__decline"
                        onClick={() => void decline(m)}
                        disabled={busyId === m.id}
                      >
                        {t("notif.decline")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
