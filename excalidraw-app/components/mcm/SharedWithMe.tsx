import {
  FileText,
  FolderOpen,
  Inbox,
  LayoutGrid,
  List as ListIcon,
  Package,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  listMyPackages,
  type MeetingPackageListItem,
} from "../../data/packages";
import { useT } from "../../i18n/mcm";

import { MeetingPackageViewer } from "./MeetingPackageViewer";

// Local view-mode toggle (NOT wired into ProjectBrowser's global viewMode — kept
// self-contained so the two surfaces don't collide). Persisted to localStorage
// so the recipient's choice survives a reload, same spirit as the meeting cards.
type ShareView = "grid" | "list";
const VIEW_KEY = "mcm.sharedWithMe.view";

const readStoredView = (): ShareView => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "grid" || v === "list" ? v : "list";
  } catch {
    return "list";
  }
};

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
 * tell them apart at a glance, instead of a flat list of bare titles. The
 * grouping is preserved in BOTH the list and the thumbnail (grid) view — the
 * group/meeting headers are identical; only the inner item layout swaps.
 *
 * A LOCAL grid⇄list toggle (mirrors the meeting-card .mcm-segmented control so
 * it reads as the same app) lets the recipient choose a tidy row list or a
 * responsive thumbnail grid of recap tiles. The choice is persisted locally.
 *
 * The list is already audience-gated server-side (canSeePackage); this only
 * ever shows what the host chose to share with this user. Empty state when none.
 */
export const SharedWithMe = () => {
  const t = useT();
  const [items, setItems] = useState<MeetingPackageListItem[] | null>(null);
  const [viewPkgId, setViewPkgId] = useState<string | null>(null);
  const [view, setView] = useState<ShareView>(readStoredView);

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

  const setViewMode = (next: ShareView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode) — view still works
      // for the session, it just won't persist. Non-fatal.
    }
  };

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

  // One recap, rendered for whichever view is active. List view keeps the
  // original row card; grid view is a self-contained tile with a glyph
  // thumbnail (no image exists for a recap) + title / context / meta footer.
  const renderItem = (p: MeetingPackageListItem) => {
    const title = p.title?.trim() || t("pkg.viewerTitle");
    const meta = [
      fmtWhen(p.published_at),
      p.created_by ? p.created_by : "",
      p.file_count ? t("pkg.selectedCount", { count: p.file_count }) : "",
    ]
      .filter(Boolean)
      .join(" · ");

    if (view === "grid") {
      const context = [p.project_name?.trim(), p.meeting_title?.trim()]
        .filter(Boolean)
        .join(" · ");
      return (
        <li key={p.id} className="mcm-sharedtile">
          <button
            type="button"
            className="mcm-sharedtile__btn"
            onClick={() => setViewPkgId(p.id)}
            title={title}
          >
            <span className="mcm-sharedtile__thumb" aria-hidden="true">
              <Package size={28} />
            </span>
            <span className="mcm-sharedtile__body">
              <strong className="mcm-sharedtile__title">{title}</strong>
              {context && (
                <span className="mcm-sharedtile__context">{context}</span>
              )}
              {meta && <span className="mcm-sharedtile__meta">{meta}</span>}
            </span>
          </button>
        </li>
      );
    }

    return (
      <li key={p.id} className="mcm-invited__card">
        <span className="mcm-shared__icon" aria-hidden="true">
          <Package size={16} />
        </span>
        <div className="mcm-invited__meta">
          <strong>{title}</strong>
          <span>{meta}</span>
        </div>
        <button
          type="button"
          className="mcm-invited__join"
          onClick={() => setViewPkgId(p.id)}
        >
          <FileText size={15} /> {t("pkg.open")}
        </button>
      </li>
    );
  };

  return (
    <section className="mcm-shared" aria-label={t("pkg.sharedWithMe")}>
      <div className="mcm-shared__bar">
        <div
          className="mcm-segmented"
          role="group"
          aria-label={t("view.label")}
        >
          <button
            type="button"
            className={`mcm-segmented__btn${
              view === "grid" ? " mcm-segmented__btn--active" : ""
            }`}
            onClick={() => setViewMode("grid")}
            title={t("view.grid")}
            aria-label={t("view.grid")}
            aria-pressed={view === "grid" ? "true" : "false"}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            className={`mcm-segmented__btn${
              view === "list" ? " mcm-segmented__btn--active" : ""
            }`}
            onClick={() => setViewMode("list")}
            title={t("view.list")}
            aria-label={t("view.list")}
            aria-pressed={view === "list" ? "true" : "false"}
          >
            <ListIcon size={14} />
          </button>
        </div>
      </div>

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
              <ul
                className={
                  view === "grid"
                    ? "mcm-shared__tiles"
                    : "mcm-invited__list"
                }
              >
                {mg.items.map(renderItem)}
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
