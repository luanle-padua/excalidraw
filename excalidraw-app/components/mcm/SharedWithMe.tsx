import { FileText, FolderOpen, Inbox, Package } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  listMyPackages,
  type MeetingPackageListItem,
} from "../../data/packages";
import { useT } from "../../i18n/mcm";

import { MeetingPackageViewer } from "./MeetingPackageViewer";

const fmtWhen = (ms: number | null): string => {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

// Group the flat package list into project → meeting buckets so a recipient
// with recaps across many meetings can tell which is which. Packages keep their
// server order (published_at DESC) within each meeting; meetings/projects appear
// in first-seen order. Recaps whose project is unknown fall into a trailing
// "Other recaps" group (sortKey "" sorts last because every named group keys on
// a non-empty id). The shape is purely presentational — opening still uses p.id.
type MeetingGroup = {
  meetingId: string;
  meetingTitle: string | null;
  items: MeetingPackageListItem[];
};
type ProjectGroup = {
  // Stable bucket key: the project_id, or "" for the no-project group.
  key: string;
  projectName: string | null;
  meetings: MeetingGroup[];
};

const groupByProjectAndMeeting = (
  items: MeetingPackageListItem[],
): ProjectGroup[] => {
  const projects = new Map<string, ProjectGroup>();
  for (const p of items) {
    const pKey = p.project_id ?? "";
    let pg = projects.get(pKey);
    if (!pg) {
      pg = { key: pKey, projectName: p.project_name, meetings: [] };
      projects.set(pKey, pg);
    }
    let mg = pg.meetings.find((m) => m.meetingId === p.meeting_id);
    if (!mg) {
      mg = {
        meetingId: p.meeting_id,
        meetingTitle: p.meeting_title,
        items: [],
      };
      pg.meetings.push(mg);
    }
    mg.items.push(p);
  }
  // Named projects first (first-seen order), the no-project bucket last.
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

/**
 * "Shared with me" — the recipient-facing dashboard surface for the Meeting
 * Package feature. Lists the PUBLISHED recap packages addressed to the current
 * user across every meeting (worker GET /v1/me/packages → listMyPackages) and
 * opens the existing MeetingPackageViewer to read the recap + download the .zip.
 *
 * Recaps are GROUPED by project → meeting (server now returns project_name /
 * meeting_title per package) so a user with recaps spanning many meetings can
 * tell them apart at a glance, instead of a flat list of bare titles.
 *
 * The list is already audience-gated server-side (canSeePackage); this only
 * ever shows what the host chose to share with this user. Empty state when none.
 */
export const SharedWithMe = () => {
  const t = useT();
  const [items, setItems] = useState<MeetingPackageListItem[] | null>(null);
  const [viewPkgId, setViewPkgId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listMyPackages().then((rows) => {
      if (alive) {
        setItems(rows);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(
    () => groupByProjectAndMeeting(items ?? []),
    [items],
  );

  // Loading / empty state — a quiet glass card, never a hard error (the fetch
  // reads "nothing to show" on any failure, same as the other dashboard tabs).
  if (items !== null && items.length === 0) {
    return (
      <section className="mcm-shared" aria-label={t("pkg.sharedWithMe")}>
        <p className="mcm-shared__empty">
          <Inbox size={18} aria-hidden="true" /> {t("pkg.sharedEmpty")}
        </p>
      </section>
    );
  }

  return (
    <section className="mcm-shared" aria-label={t("pkg.sharedWithMe")}>
      {groups.map((pg) => (
        <div key={pg.key || "__no_project__"} className="mcm-shared__group">
          <h3 className="mcm-shared__group-title">
            <FolderOpen size={14} aria-hidden="true" />
            <span>{pg.projectName?.trim() || t("pkg.noProject")}</span>
          </h3>
          {pg.meetings.map((mg) => (
            <div key={mg.meetingId} className="mcm-shared__meeting">
              <p className="mcm-shared__meeting-title">
                {mg.meetingTitle?.trim() || t("pkg.meetingFallback")}
              </p>
              <ul className="mcm-invited__list">
                {mg.items.map((p) => (
                  <li key={p.id} className="mcm-invited__card">
                    <span className="mcm-shared__icon" aria-hidden="true">
                      <Package size={16} />
                    </span>
                    <div className="mcm-invited__meta">
                      <strong>
                        {p.title?.trim() || t("pkg.viewerTitle")}
                      </strong>
                      <span>
                        {[
                          fmtWhen(p.published_at),
                          p.created_by ? `· ${p.created_by}` : "",
                          p.file_count
                            ? t("pkg.selectedCount", { count: p.file_count })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="mcm-invited__join"
                      onClick={() => setViewPkgId(p.id)}
                    >
                      <FileText size={15} /> {t("pkg.open")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}

      {viewPkgId && (
        <MeetingPackageViewer
          pkgId={viewPkgId}
          onClose={() => setViewPkgId(null)}
        />
      )}
    </section>
  );
};

export default SharedWithMe;
