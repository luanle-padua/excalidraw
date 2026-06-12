// Trang "Quản lý dự án" — the dedicated admin surface for projects (anh
// Luân, 06-12): create / metadata / members / delete all live HERE, so the
// per-project meeting view stays a clean meeting list (project name appears
// exactly once per surface, no admin strip between header and cards).
//
// Two modes in one panel, switched by `manageProjectId`:
//   • LIST   — search + grouped rows (my projects / invited-only)
//   • DETAIL — hero + meta grid + member roster + danger zone (drill-in
//              with a breadcrumb back; sidebar click ≠ this page: sidebar
//              = "go to meetings", this page = "administer")
//
// The parent (ProjectBrowser) owns the data (projects list, refresh) and
// the create/edit modals — this panel only renders + navigates, except
// delete which it performs itself (it owns the danger zone).

import {
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { showAppToast } from "../../data/appToast";
import { deleteProject } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { ProjectMemberRoster } from "./ProjectMemberRoster";

import "./ProjectManager.scss";

import type { Project } from "../../data/projects";

type Props = {
  projects: Project[];
  /** Last list fetch failed — show the shared "couldn't load + retry". */
  projectsFailed: boolean;
  onRetryProjects: () => void;
  /** null = LIST; a project id = DETAIL. Owned by the parent so nav
   *  clicks elsewhere can reset it (same pattern as detailRoomId). */
  manageProjectId: string | null;
  onManage: (id: string | null) => void;
  /** "Xem cuộc họp →" — jump to the project's meeting list view. */
  onOpenMeetings: (id: string) => void;
  /** Open the create-project modal (owned by the parent). */
  onCreate: () => void;
  /** Open the edit-metadata modal (owned by the parent). */
  onEdit: (p: Project) => void;
  /** A mutation happened here (delete) — parent refreshes the list. */
  onProjectsChanged: () => void;
};

const fmtCreated = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "—";

export const ProjectManagerPanel = ({
  projects,
  projectsFailed,
  onRetryProjects,
  manageProjectId,
  onManage,
  onOpenMeetings,
  onCreate,
  onEdit,
  onProjectsChanged,
}: Props) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [q, setQ] = useState("");

  const detail = manageProjectId
    ? projects.find((p) => p.id === manageProjectId) ?? null
    : null;

  // The open detail's project vanished from the list (deleted elsewhere /
  // access revoked, surfaced by a refresh) — fall back to the list rather
  // than rendering a ghost.
  useEffect(() => {
    if (manageProjectId && projects.length > 0 && !detail) {
      onManage(null);
    }
  }, [manageProjectId, detail, projects.length, onManage]);

  if (detail) {
    return (
      <ProjectDetail
        project={detail}
        isOwner={
          detail.host_email?.toLowerCase() === session?.email?.toLowerCase() ||
          !!session?.isAdmin
        }
        onBack={() => onManage(null)}
        onOpenMeetings={() => onOpenMeetings(detail.id)}
        onEdit={() => onEdit(detail)}
        onDeleted={() => {
          onManage(null);
          onProjectsChanged();
        }}
      />
    );
  }

  const norm = q.trim().toLowerCase();
  const matches = (p: Project): boolean =>
    !norm ||
    [p.name, p.code, p.client, p.location]
      .filter(Boolean)
      .some((s) => (s as string).toLowerCase().includes(norm));

  const byUpdated = (a: Project, b: Project) =>
    (b.updated_at ?? 0) - (a.updated_at ?? 0);
  const mine = projects
    .filter((p) => p.access !== "invitee" && matches(p))
    .sort(byUpdated);
  const invited = projects
    .filter((p) => p.access === "invitee" && matches(p))
    .sort(byUpdated);

  const row = (p: Project) => {
    const meta =
      [p.code, p.client, p.location].filter(Boolean).join(" · ") ||
      p.description ||
      t("pmgr.noMeta");
    return (
      <li key={p.id}>
        <button
          type="button"
          className="mcm-pmgr__row"
          onClick={() => onManage(p.id)}
        >
          <span className="mcm-pmgr__row-cover" aria-hidden="true">
            {p.cover ? (
              <img src={p.cover} alt="" />
            ) : (
              p.name.trim()[0]?.toUpperCase() ?? "#"
            )}
          </span>
          <span className="mcm-pmgr__row-main">
            <span className="mcm-pmgr__row-top">
              <span className="mcm-pmgr__row-name">{p.name}</span>
              {p.access === "invitee" ? (
                <span className="mcm-pmgr__tag mcm-pmgr__tag--invited">
                  {t("folder.invitedBadge")}
                </span>
              ) : (
                p.stage && <span className="mcm-pmgr__tag">{p.stage}</span>
              )}
            </span>
            <span className="mcm-pmgr__row-meta">{meta}</span>
          </span>
          <ChevronRight size={16} className="mcm-pmgr__row-chevron" />
        </button>
      </li>
    );
  };

  return (
    <div className="mcm-pmgr">
      <div className="mcm-pmgr__head">
        <label className="mcm-pmgr__search">
          <Search size={14} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("pmgr.searchPlaceholder")}
            aria-label={t("pmgr.searchPlaceholder")}
          />
        </label>
        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--sm"
          onClick={onCreate}
        >
          <Plus size={15} /> {t("pmgr.newProject")}
        </button>
      </div>

      {projectsFailed && projects.length === 0 ? (
        <div className="mcm-3col__hint">
          {t("errors.loadFailed")}{" "}
          <button
            type="button"
            className="mcm-3col__retry"
            onClick={onRetryProjects}
          >
            {t("errors.retry")}
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="mcm-pmgr__empty">
          <FolderKanban size={48} aria-hidden="true" />
          <span className="mcm-pmgr__empty-title">{t("pmgr.empty")}</span>
          <span className="mcm-pmgr__empty-hint">{t("pmgr.emptyHint")}</span>
          <button
            type="button"
            className="mcm-btn mcm-btn--primary mcm-btn--sm"
            onClick={onCreate}
          >
            <Plus size={15} /> {t("pmgr.newProject")}
          </button>
        </div>
      ) : mine.length === 0 && invited.length === 0 ? (
        <div className="mcm-pmgr__empty">
          <span className="mcm-pmgr__empty-title">
            {t("pmgr.emptySearch", { q: q.trim() })}
          </span>
          <button
            type="button"
            className="mcm-pmgr__clear-search"
            onClick={() => setQ("")}
          >
            {t("pmgr.clearSearch")}
          </button>
        </div>
      ) : (
        <>
          {mine.length > 0 && (
            <>
              <h3 className="mcm-pmgr__group-label">
                {t("pmgr.groupMine")} ({mine.length})
              </h3>
              <ul className="mcm-pmgr__list">{mine.map(row)}</ul>
            </>
          )}
          {invited.length > 0 && (
            <>
              <h3 className="mcm-pmgr__group-label">
                {t("pmgr.groupInvited")} ({invited.length})
              </h3>
              <ul className="mcm-pmgr__list">{invited.map(row)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

// ---- Detail ----------------------------------------------------------------

const ProjectDetail = ({
  project,
  isOwner,
  onBack,
  onOpenMeetings,
  onEdit,
  onDeleted,
}: {
  project: Project;
  isOwner: boolean;
  onBack: () => void;
  onOpenMeetings: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) => {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const isInvitee = project.access === "invitee";

  const metaCells = useMemo(
    () =>
      [
        [t("pmgr.metaClient"), project.client],
        [t("pmgr.metaLocation"), project.location],
        [t("pmgr.metaBranch"), project.branch],
        [t("pmgr.metaType"), project.type],
        [t("pmgr.createdAt"), fmtCreated(project.created_at)],
        [t("pmgr.ownerLabel"), project.host_email],
      ] as const,
    [project, t],
  );

  const handleDelete = async () => {
    if (
      deleting ||
      !window.confirm(t("proj.deleteConfirm", { name: project.name }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      const { ok, status } = await deleteProject(project.id);
      if (ok) {
        showAppToast(t("pmgr.deleted", { name: project.name }));
        onDeleted();
        return;
      }
      if (status === 409) {
        // Still has meetings — the "Xem cuộc họp →" button above is the
        // way to go clean them up.
        window.alert(t("proj.deleteNotEmpty"));
        return;
      }
      showAppToast(t("proj.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mcm-pdetail">
      <button type="button" className="mcm-pdetail__back" onClick={onBack}>
        <ChevronLeft size={15} /> {t("pmgr.back")}
      </button>

      <div className="mcm-pdetail__hero">
        {project.cover && (
          <img className="mcm-pdetail__cover" src={project.cover} alt="" />
        )}
        <div className="mcm-pdetail__hero-row">
          <h2 className="mcm-pdetail__name">{project.name}</h2>
          {project.stage && (
            <span className="mcm-pmgr__tag">{project.stage}</span>
          )}
          {project.code && (
            <span className="mcm-pdetail__code">{project.code}</span>
          )}
          <div className="mcm-pdetail__actions">
            {isOwner && !isInvitee && (
              <button
                type="button"
                className="mcm-btn mcm-btn--sm"
                onClick={onEdit}
              >
                <Pencil size={14} /> {t("folder.editProject")}
              </button>
            )}
            <button
              type="button"
              className="mcm-btn mcm-btn--primary mcm-btn--sm"
              onClick={onOpenMeetings}
            >
              {t("pmgr.viewMeetings")} →
            </button>
          </div>
        </div>
      </div>

      {isInvitee && (
        <div className="mcm-pdetail__readonly-banner">{t("pmgr.readOnly")}</div>
      )}

      <h3 className="mcm-pdetail__section-title">{t("pmgr.sectionInfo")}</h3>
      <div className="mcm-pdetail__metagrid">
        {metaCells.map(([label, value]) => (
          <div className="mcm-pdetail__meta-cell" key={label}>
            <span className="mcm-pdetail__meta-label">{label}</span>
            <span className="mcm-pdetail__meta-value">{value || "—"}</span>
          </div>
        ))}
      </div>
      {project.description && (
        <p className="mcm-pdetail__desc">{project.description}</p>
      )}

      {/* Members — true membership only. An invitee detail never fetches
          the roster (the worker would 403; no console noise). */}
      {!isInvitee && (
        <>
          <h3 className="mcm-pdetail__section-title">{t("proj.members")}</h3>
          <ProjectMemberRoster projectId={project.id} isOwner={isOwner} />
        </>
      )}

      {isOwner && !isInvitee && (
        <>
          <h3 className="mcm-pdetail__section-title">
            {t("pmgr.sectionDanger")}
          </h3>
          <div className="mcm-pdetail__danger">
            <span className="mcm-pdetail__danger-hint">
              {t("pmgr.dangerDeleteHint")}
            </span>
            <button
              type="button"
              className="mcm-pdetail__danger-btn"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              <Trash2 size={14} /> {t("proj.delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ProjectManagerPanel;
