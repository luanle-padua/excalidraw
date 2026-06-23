import { CalendarClock, Eye, FileText, LogIn, Package } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { getMyMeetingsChecked, type CalMeeting } from "../../data/calendar";
import {
  listMyPackages,
  type MeetingPackageListItem,
} from "../../data/packages";
import { getMeeting } from "../../data/projects";
import { type Session } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { ClientCalendar } from "./ClientCalendar";
import { statusBucket } from "./meetingColors";
import { MeetingPackageViewer } from "./MeetingPackageViewer";
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

// Recap packages carry a coarse published date (no clock time) — show just the
// day so the row meta stays calm.
const fmtRecapWhen = (ms: number | null): string => {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
};

// Group a flat recap list into project → meeting buckets for the portal recaps
// section. Purely presentational (opening still keys on the package id). Named
// projects appear in first-seen order; recaps with no known project fall into a
// trailing "Other recaps" bucket (key "").
type PortalMeetingGroup = {
  meetingId: string;
  meetingTitle: string | null;
  items: MeetingPackageListItem[];
};
type PortalProjectGroup = {
  key: string;
  projectName: string | null;
  meetings: PortalMeetingGroup[];
};
const groupRecaps = (
  items: MeetingPackageListItem[],
): PortalProjectGroup[] => {
  const projects = new Map<string, PortalProjectGroup>();
  for (const p of items) {
    const pKey = p.project_id ?? "";
    let pg = projects.get(pKey);
    if (!pg) {
      pg = { key: pKey, projectName: p.project_name, meetings: [] };
      projects.set(pKey, pg);
    }
    let mg = pg.meetings.find((m) => m.meetingId === p.meeting_id);
    if (!mg) {
      mg = { meetingId: p.meeting_id, meetingTitle: p.meeting_title, items: [] };
      pg.meetings.push(mg);
    }
    mg.items.push(p);
  }
  return [...projects.values()].sort((a, b) => {
    if (a.key === "" && b.key !== "") {
      return 1;
    }
    if (b.key === "" && a.key !== "") {
      return -1;
    }
    return 0;
  });
};

export const ClientPortal = ({ session }: { session: Session }) => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);

  const [meetings, setMeetings] = useState<CalMeeting[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Shared recap packages addressed to this guest (server audience-gated via
  // /v1/me/packages → listMyPackages). null = still loading, [] = none shared.
  const [recaps, setRecaps] = useState<MeetingPackageListItem[] | null>(null);
  const [viewPkgId, setViewPkgId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getMyMeetingsChecked();
      setFailed(!r.ok);
      setMeetings(r.ok ? r.items : []);
    } finally {
      setLoading(false);
    }
    // Recaps load alongside meetings (and re-pull on focus): a revoked recipient
    // stops seeing the package, mirroring revoke = kick for live meetings.
    const pkgs = await listMyPackages();
    setRecaps(pkgs);
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
      if (!meeting) {
        showAppToast(t("errors.openMeetingFailed"));
        return;
      }
      const finished = isFinishedStatus(meeting.status);
      // The server WITHHOLDS room_key from an external guest until a host admits
      // them (waiting-room). A null key on a LIVE meeting is NOT a failure — we
      // must still enter startCollaboration so the guest is parked in the lobby
      // to knock; WaitingRoom re-fetches the real key after admission (06-18
      // deadlock fix). Only a missing key on a non-live meeting is fatal (review
      // has no knock flow to recover it).
      const roomKey = meeting.room_key ?? "";
      if (!roomKey && finished) {
        showAppToast(t("errors.openMeetingFailed"));
        return;
      }
      if (collabAPI.isCollaborating()) {
        collabAPI.stopCollaboration(false);
      }
      // Only canonicalise the URL once we actually hold a key (an empty key in
      // the link would be a broken deep-link). After admission WaitingRoom sets it.
      if (roomKey) {
        window.history.pushState(
          {},
          "",
          getCollaborationLink({ roomId: m.id, roomKey }),
        );
      }
      await collabAPI.startCollaboration(
        { roomId: m.id, roomKey },
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

  // A shared-recap row — reuses the meeting row's glass styling but opens the
  // MeetingPackageViewer (recap iframe + .zip download) instead of joining.
  const recapRow = (p: MeetingPackageListItem) => {
    const meta = [
      fmtRecapWhen(p.published_at),
      p.file_count ? t("pkg.selectedCount", { count: p.file_count }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={p.id} className="mcm-portal__row">
        <span className="mcm-portal__row-main">
          <span className="mcm-portal__row-title">
            {p.title?.trim() || t("pkg.viewerTitle")}
          </span>
          {meta && (
            <span className="mcm-portal__row-meta">
              <span className="mcm-portal__row-when">{meta}</span>
            </span>
          )}
        </span>
        <button
          type="button"
          className="mcm-btn mcm-btn--sm"
          onClick={() => setViewPkgId(p.id)}
        >
          <FileText size={15} /> {t("pkg.open")}
        </button>
      </li>
    );
  };

  // Group recaps by project → meeting so a guest with recaps across several
  // meetings can tell which is which (server returns project_name/meeting_title
  // per package). Named projects keep first-seen order; the no-project bucket
  // sinks to the end. Each meeting becomes a labelled sub-block of recap rows.
  const recapGroups = groupRecaps(recaps ?? []);

  // The recap surface stands on its own — a guest may have shared recaps even
  // when they have no current/past meetings, so it must not be gated behind the
  // meetings list.
  const hasRecaps = (recaps?.length ?? 0) > 0;
  const noMeetings = meetings.length === 0;

  return (
    <div className="mcm-portal">
      <PortalBackdrop />
      {/* Greeting lives ON the backdrop (not in the card) — left-aligned, the
          MAP-GROUP Global wordmark in the brand serif (anh Luân 06-16). */}
      <header className="mcm-portal__head">
        <span className="mcm-portal__brand">MAP-GROUP Global</span>
        <h1 className="mcm-portal__hello">
          {t("portal.hello", { name: session.name })}
        </h1>
        <p className="mcm-portal__title">{t("portal.title")}</p>
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
          ) : noMeetings && !hasRecaps ? (
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
              {/* Shared recaps — packages a host published to this guest. Hidden
                  while empty UNLESS the guest has no meetings either (then we
                  still show the section with a tasteful empty line so the page
                  isn't blank). */}
              {(hasRecaps || noMeetings) && (
                <section className="mcm-portal__section">
                  <h2 className="mcm-portal__section-title">
                    {t("portal.recapsTitle")}
                  </h2>
                  {hasRecaps ? (
                    <div className="mcm-portal__recap-groups">
                      {recapGroups.map((pg) => (
                        <div
                          key={pg.key || "__no_project__"}
                          className="mcm-portal__recap-project"
                        >
                          <h3 className="mcm-portal__recap-project-title">
                            {pg.projectName?.trim() || t("pkg.noProject")}
                          </h3>
                          {pg.meetings.map((mg) => (
                            <div
                              key={mg.meetingId}
                              className="mcm-portal__recap-meeting"
                            >
                              <p className="mcm-portal__recap-meeting-title">
                                {mg.meetingTitle?.trim() ||
                                  t("pkg.meetingFallback")}
                              </p>
                              <ul className="mcm-portal__list">
                                {mg.items.map((p) => recapRow(p))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mcm-portal__recaps-empty">
                      <Package size={18} strokeWidth={1.5} aria-hidden="true" />
                      <span>{t("portal.recapsEmpty")}</span>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
        <ClientCalendar meetings={meetings} />
      </div>
      {viewPkgId && (
        <MeetingPackageViewer
          pkgId={viewPkgId}
          onClose={() => setViewPkgId(null)}
        />
      )}
    </div>
  );
};

export default ClientPortal;
