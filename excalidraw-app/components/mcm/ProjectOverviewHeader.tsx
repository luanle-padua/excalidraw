// Project context strip at the top of the project view. THIS IS A MEETING
// APP (quyết định anh Luân 06-11): project info stays COMPACT by default —
// one row of identity + counters — and the details (description, member
// roster via `children`, destructive actions) only appear when the user
// expands. Pure presentation — the parent owns mutations.

import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { useT } from "../../i18n/mcm";

import { normalizeMeetingStatus } from "./meetingStatus";

import "./ProjectOverviewHeader.scss";

import type { MeetingSummary, Project } from "../../data/projects";

type Props = {
  project: Project;
  meetings: MeetingSummary[];
  isOwner: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Detail content shown only when expanded (the member roster). */
  children?: React.ReactNode;
};

export const ProjectOverviewHeader = ({
  project,
  meetings,
  isOwner,
  onEdit,
  onDelete,
  children,
}: Props) => {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const total = meetings.length;
  const now = Date.now();

  let upcoming = 0;
  let live = 0;
  for (const m of meetings) {
    const status = normalizeMeetingStatus(m.status);
    if (status === "live") {
      live += 1;
    } else if (status === "scheduled" && m.scheduled_at) {
      const at = new Date(m.scheduled_at).getTime();
      if (!Number.isNaN(at) && at > now) {
        upcoming += 1;
      }
    }
  }

  return (
    <header className="mcm-proj-overview" aria-label={t("proj.overview")}>
      {/* Compact row — always visible: name · stage · inline counters ·
          expand toggle. Nothing here competes with the meeting list. */}
      <div className="mcm-proj-overview__top">
        <h2 className="mcm-proj-overview__name">{project.name}</h2>
        {project.stage && (
          <span className="mcm-proj-overview__stage">{project.stage}</span>
        )}
        <div className="mcm-proj-overview__counters">
          <span className="mcm-proj-overview__counter">
            {total} {t("proj.stats.total")}
          </span>
          {upcoming > 0 && (
            <span className="mcm-proj-overview__counter">
              {upcoming} {t("proj.stats.upcoming")}
            </span>
          )}
          {live > 0 && (
            <span className="mcm-proj-overview__counter mcm-proj-overview__counter--live">
              {live} {t("proj.stats.live")}
            </span>
          )}
        </div>
        <button
          type="button"
          className={`mcm-proj-overview__expand${
            expanded ? " mcm-proj-overview__expand--open" : ""
          }`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={t("proj.overview")}
          aria-label={t("proj.overview")}
        >
          <ChevronDown size={15} />
        </button>
      </div>

      {/* Detail — opt-in: description, member roster (children), owner
          actions. The meeting app stays a meeting app until asked. */}
      {expanded && (
        <div className="mcm-proj-overview__detail">
          {project.description && (
            <p className="mcm-proj-overview__desc">{project.description}</p>
          )}
          {children}
          {isOwner && (
            <div className="mcm-proj-overview__actions">
              <button
                type="button"
                className="mcm-proj-overview__btn"
                onClick={onEdit}
              >
                <Pencil size={15} strokeWidth={2} />
                <span>{t("folder.editProject")}</span>
              </button>
              <button
                type="button"
                className="mcm-proj-overview__btn mcm-proj-overview__btn--danger"
                onClick={onDelete}
              >
                <Trash2 size={15} strokeWidth={2} />
                <span>{t("proj.delete")}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
};
