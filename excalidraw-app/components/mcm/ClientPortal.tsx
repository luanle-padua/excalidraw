import { CalendarClock, Eye, LogIn } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { getMyMeetingsChecked, type CalMeeting } from "../../data/calendar";
import { getMeeting } from "../../data/projects";
import { type Session } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { ClientCalendar } from "./ClientCalendar";
import { statusBucket } from "./meetingColors";
import { isFinishedStatus, meetingStatusLabel } from "./meetingStatus";
import { PortalBackdrop } from "./PortalBackdrop";

/**
 * ClientPortal — the minimal "guest lobby" for an external, project-scoped
 * client (synthetic login `pg-<hex>@guest.canvasm.app`, JWT role "guest").
 *
 * Safe-by-construction (docs/plans/client-portal.md): a guest NEVER mounts the
 * staff `ProjectBrowser`. This is a single column that lists ONLY the meetings
 * the guest was invited to (server-scoped `/v1/me/meetings`), split into
 * "happening now / upcoming" (join) and "finished" (read-only review), plus a
 * small read-only month calendar marking their meeting days. No sidebar, no
 * project tools, no create-meeting. The security boundary is the Worker's
 * per-meeting invite gate — this screen is UX only.
 */

const fmtWhen = (m: CalMeeting): string => {
  const ms = m.scheduled_at ? Date.parse(m.scheduled_at) : m.created_at;
  if (!ms || Number.isNaN(ms)) {
    return "";
  }
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const ClientPortal = ({ session }: { session: Session }) => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);

  const [meetings, setMeetings] = useState<CalMeeting[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getMyMeetingsChecked();
      setFailed(!r.ok);
      setMeetings(r.ok ? r.items : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Revoke = kick (06-11): a guest removed from the invitee list loses the
    // meeting. Re-pull on focus so the list reflects access changes promptly.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  // Reuse the exact lobby/ProjectBrowser join path: resolve the room key from
  // the registry, restore the canonical collab URL, then startCollaboration.
  // A finished meeting opens read-only (review = immutable, extract-only).
  const join = async (m: CalMeeting) => {
    if (!collabAPI || busy) {
      return;
    }
    setBusy(true);
    try {
      const meeting = await getMeeting(m.id);
      if (!meeting?.room_key) {
        showAppToast(t("errors.openMeetingFailed"));
        return;
      }
      const finished = isFinishedStatus(meeting.status);
      if (collabAPI.isCollaborating()) {
        collabAPI.stopCollaboration(false);
      }
      window.history.pushState(
        {},
        "",
        getCollaborationLink({ roomId: m.id, roomKey: meeting.room_key }),
      );
      await collabAPI.startCollaboration(
        { roomId: m.id, roomKey: meeting.room_key },
        { viewOnly: finished },
      );
    } finally {
      setBusy(false);
    }
  };

  // Split: live + scheduled → "active" (Join); finished/cancelled → "past"
  // (read-only review). Mirrors the lobby's lifecycle vocabulary.
  const active = meetings.filter((m) => !isFinishedStatus(m.status));
  const past = meetings.filter((m) => isFinishedStatus(m.status));

  const row = (m: CalMeeting, kind: "active" | "past") => {
    return (
      <li key={m.id} className="mcm-portal__row">
        <span className="mcm-portal__row-main">
          <span className="mcm-portal__row-title">
            {m.title || t("folder.meetingFallbackTitle")}
          </span>
          <span className="mcm-portal__row-meta">
            <span className="mcm-portal__row-when">{fmtWhen(m)}</span>
            {m.status && (
              <span className={`mcm-pill mcm-pill--${statusBucket(m.status)}`}>
                {meetingStatusLabel(t, m.status)}
              </span>
            )}
          </span>
        </span>
        <button
          type="button"
          className={`mcm-btn mcm-btn--sm${
            kind === "active" ? " mcm-btn--primary" : ""
          }`}
          onClick={() => void join(m)}
          disabled={busy || !collabAPI}
        >
          {kind === "active" ? (
            <>
              <LogIn size={15} /> {t("portal.join")}
            </>
          ) : (
            <>
              <Eye size={15} /> {t("portal.review")}
            </>
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="mcm-portal">
      <PortalBackdrop />
      {/* Greeting lives ON the backdrop (not in the card) — left-aligned, the
          MAP-GROUP Global wordmark in the brand serif (anh Luân 06-16). */}
      <header className="mcm-portal__head">
        <span className="mcm-portal__brand">MAP-GROUP Global</span>
        <h1 className="mcm-portal__title">{t("portal.title")}</h1>
        <p className="mcm-portal__hello">
          {t("portal.hello", { name: session.name })}
        </p>
      </header>
      <div className="mcm-portal__stage">
        <div className="mcm-portal__inner">
          {loading ? (
            <div className="mcm-portal__hint">…</div>
          ) : failed ? (
            <div className="mcm-portal__hint">
              {t("errors.loadFailed")}{" "}
              <button
                type="button"
                className="mcm-portal__retry"
                onClick={() => void refresh()}
              >
                {t("errors.retry")}
              </button>
            </div>
          ) : meetings.length === 0 ? (
            <div className="mcm-portal__empty">
              <CalendarClock size={30} strokeWidth={1.5} />
              <p>{t("portal.empty")}</p>
            </div>
          ) : (
            <div className="mcm-portal__sections">
              {active.length > 0 && (
                <section className="mcm-portal__section">
                  <h2 className="mcm-portal__section-title">
                    {t("portal.activeTitle")}
                  </h2>
                  <ul className="mcm-portal__list">
                    {active.map((m) => row(m, "active"))}
                  </ul>
                </section>
              )}
              {past.length > 0 && (
                <section className="mcm-portal__section">
                  <h2 className="mcm-portal__section-title">
                    {t("portal.pastTitle")}
                  </h2>
                  <ul className="mcm-portal__list">
                    {past.map((m) => row(m, "past"))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
        <ClientCalendar meetings={meetings} />
      </div>
    </div>
  );
};

export default ClientPortal;
