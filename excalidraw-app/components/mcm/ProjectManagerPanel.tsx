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
  LayoutGrid,
  List,
  Palette,
  Pencil,
  Plus,
  Search,
  SmilePlus,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { showAppToast } from "../../data/appToast";
import {
  deleteProject,
  listDivisions,
  setProjectDivision,
  updateProject,
  type Division,
} from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { ColorMenu, EmojiMenu, PROJECT_ICON_PRESETS } from "./ColorMenu";
import { ProjectGuestRoster } from "./ProjectGuestRoster";
import { ProjectMemberRoster } from "./ProjectMemberRoster";

import "./ProjectManager.scss";

import type { Project } from "../../data/projects";
import type { ReactNode } from "react";

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
  /** Cosmetic colour/icon saved — parent patches its list IN PLACE (no
   *  refetch flash; same pattern as the meeting cards' assignColor). */
  onPatchProject: (
    id: string,
    patch: { color?: string | null; icon?: string | null },
  ) => void;
};

/** Cosmetic colour/icon PATCH. Any member may set these (the worker exempts
 *  them from the owner-only guard). The worker COALESCEs nulls (null = keep),
 *  so clearing sends "" — falsy for every consumer, same effect as null. */
const saveCosmetic = async (
  id: string,
  patch: { color?: string | null; icon?: string | null },
): Promise<boolean> => {
  const wire: { color?: string; icon?: string } = {};
  if (patch.color !== undefined) {
    wire.color = patch.color ?? "";
  }
  if (patch.icon !== undefined) {
    wire.icon = patch.icon ?? "";
  }
  return updateProject(id, wire);
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
  onPatchProject,
}: Props) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [q, setQ] = useState("");
  // LIST ⇄ CARD, same affordance as the meeting list (anh Luân, 06-12).
  // Card is the default — covers carry the page.
  const [viewMode, setViewMode] = useState<"list" | "card">("card");
  // The project whose colour-swatch menu is open (one at a time), by id —
  // same pattern as the meeting cards.
  const [colorMenuFor, setColorMenuFor] = useState<string | null>(null);
  const [colorMenuAnchor, setColorMenuAnchor] = useState<DOMRect | null>(null);

  // PM: "project card cũng cần được set màu tương tự như meeting card" —
  // save, then patch the parent's list in place + background reconcile.
  const assignCosmetic = async (
    id: string,
    patch: { color?: string | null; icon?: string | null },
  ) => {
    setColorMenuFor(null);
    if (!(await saveCosmetic(id, patch))) {
      showAppToast("Không lưu được màu/biểu tượng dự án");
      return;
    }
    onPatchProject(id, patch);
    onProjectsChanged();
  };

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
    const isAdmin = !!session?.isAdmin;
    return (
      <ProjectDetail
        project={detail}
        // Manage = admin / leader / co-operator / head — edit metadata, guests,
        // members. Server-computed (can_manage); a plain participant is false.
        canManage={isAdmin || !!detail.can_manage}
        // Leadership = admin / leader / head (NOT a co-operator) — delete,
        // delegate co-operators, change the leading division.
        isLeadership={isAdmin || !!detail.is_leadership}
        // Assign leader = admin or the leading-division HEAD only.
        canAssignLeader={isAdmin || !!detail.can_assign_leader}
        onBack={() => onManage(null)}
        onOpenMeetings={() => onOpenMeetings(detail.id)}
        onEdit={() => onEdit(detail)}
        onRefresh={onProjectsChanged}
        onDeleted={() => {
          onManage(null);
          onProjectsChanged();
        }}
        onAssignCosmetic={(patch) => void assignCosmetic(detail.id, patch)}
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

  // Inline style contract shared with the meeting cards: --mcard-color is
  // the project's user hue; the SCSS --tinted modifiers do the colour math.
  const tintStyle = (p: Project): React.CSSProperties | undefined =>
    p.color
      ? ({ ["--mcard-color" as string]: p.color } as React.CSSProperties)
      : undefined;

  // Palette trigger + its popover. Lives OUTSIDE the row/card hit <button>
  // (nested buttons are invalid HTML) — the wrapper div carries the layout.
  const paletteButton = (p: Project) => (
    <>
      <button
        type="button"
        className="mcm-icon-btn mcm-icon-btn--sm"
        onClick={(e) => {
          if (colorMenuFor === p.id) {
            setColorMenuFor(null);
          } else {
            setColorMenuAnchor(e.currentTarget.getBoundingClientRect());
            setColorMenuFor(p.id);
          }
        }}
        title="Đổi màu dự án"
        aria-label="Đổi màu dự án"
      >
        <Palette size={14} />
      </button>
      {colorMenuFor === p.id && colorMenuAnchor && (
        <ColorMenu
          anchor={colorMenuAnchor}
          current={p.color ?? null}
          onPick={(c) => void assignCosmetic(p.id, { color: c })}
          onClose={() => setColorMenuFor(null)}
          clearLabel={t("color.none")}
        />
      )}
    </>
  );

  const row = (p: Project) => {
    const meta =
      [p.code, p.client, p.location].filter(Boolean).join(" · ") ||
      p.description ||
      t("pmgr.noMeta");
    return (
      <li key={p.id}>
        <div
          className={`mcm-pmgr__row${p.color ? " mcm-pmgr__row--tinted" : ""}`}
          style={tintStyle(p)}
        >
          <button
            type="button"
            className="mcm-pmgr__row-hit"
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
                {p.icon && (
                  <span className="mcm-pmgr__icon" aria-hidden="true">
                    {p.icon}
                  </span>
                )}
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
          </button>
          {paletteButton(p)}
          <ChevronRight size={16} className="mcm-pmgr__row-chevron" />
        </div>
      </li>
    );
  };

  // CARD mode — cover-first tile, same click target as a row (the palette
  // action floats over the cover's corner, outside the hit button).
  const card = (p: Project) => {
    const meta =
      [p.code, p.client, p.location].filter(Boolean).join(" · ") ||
      p.description ||
      t("pmgr.noMeta");
    return (
      <li key={p.id}>
        <div
          className={`mcm-pmgr__card${
            p.color ? " mcm-pmgr__card--tinted" : ""
          }`}
          style={tintStyle(p)}
        >
          <button
            type="button"
            className="mcm-pmgr__card-hit"
            onClick={() => onManage(p.id)}
          >
            <span className="mcm-pmgr__card-cover" aria-hidden="true">
              {p.cover ? (
                <img src={p.cover} alt="" />
              ) : (
                <span className="mcm-pmgr__card-initial">
                  {p.name.trim()[0]?.toUpperCase() ?? "#"}
                </span>
              )}
            </span>
            <span className="mcm-pmgr__card-body">
              <span className="mcm-pmgr__card-top">
                {p.icon && (
                  <span className="mcm-pmgr__icon" aria-hidden="true">
                    {p.icon}
                  </span>
                )}
                <span className="mcm-pmgr__card-name">{p.name}</span>
                {p.access === "invitee" ? (
                  <span className="mcm-pmgr__tag mcm-pmgr__tag--invited">
                    {t("folder.invitedBadge")}
                  </span>
                ) : (
                  p.stage && <span className="mcm-pmgr__tag">{p.stage}</span>
                )}
              </span>
              <span className="mcm-pmgr__card-meta">{meta}</span>
            </span>
          </button>
          <div className="mcm-pmgr__card-actions">{paletteButton(p)}</div>
        </div>
      </li>
    );
  };

  const group = (items: Project[]) =>
    viewMode === "card" ? (
      <ul className="mcm-pmgr__cards">{items.map(card)}</ul>
    ) : (
      <ul className="mcm-pmgr__list">{items.map(row)}</ul>
    );

  return (
    <div className="mcm-pmgr">
      {/* Head hides when there is nothing to search/arrange — the empty
          state carries its own create CTA (no redundant buttons). */}
      {projects.length > 0 && (
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
          <div
            className="mcm-segmented"
            role="group"
            aria-label={t("view.label")}
          >
            <button
              type="button"
              className={`mcm-segmented__btn${
                viewMode === "card" ? " mcm-segmented__btn--active" : ""
              }`}
              onClick={() => setViewMode("card")}
              title={t("view.grid")}
              aria-label={t("view.grid")}
              aria-pressed={viewMode === "card" ? "true" : "false"}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              type="button"
              className={`mcm-segmented__btn${
                viewMode === "list" ? " mcm-segmented__btn--active" : ""
              }`}
              onClick={() => setViewMode("list")}
              title={t("view.list")}
              aria-label={t("view.list")}
              aria-pressed={viewMode === "list" ? "true" : "false"}
            >
              <List size={14} />
            </button>
          </div>
          <button
            type="button"
            className="mcm-btn mcm-btn--primary mcm-btn--sm"
            onClick={onCreate}
          >
            <Plus size={15} /> {t("pmgr.newProject")}
          </button>
        </div>
      )}

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
              {group(mine)}
            </>
          )}
          {invited.length > 0 && (
            <>
              <h3 className="mcm-pmgr__group-label">
                {t("pmgr.groupInvited")} ({invited.length})
              </h3>
              {group(invited)}
            </>
          )}
        </>
      )}
    </div>
  );
};

// ---- Detail ----------------------------------------------------------------

// Collapsible section — native <details> so each block (info / members /
// guests / danger) can expand+collapse, keeping the long detail page tidy and
// every section reachable without endless scrolling. Module-level = stable
// identity (no remount of the children, so guest-form inputs keep focus).
const Section = ({
  title,
  defaultOpen = true,
  id,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  id?: string;
  children: ReactNode;
}) => (
  <details id={id} className="mcm-pdetail__section" open={defaultOpen}>
    <summary className="mcm-pdetail__section-title">
      <ChevronRight size={14} className="mcm-pdetail__section-chevron" />
      {title}
    </summary>
    <div className="mcm-pdetail__section-body">{children}</div>
  </details>
);

const ProjectDetail = ({
  project,
  isLeadership,
  canManage,
  canAssignLeader,
  onBack,
  onOpenMeetings,
  onEdit,
  onRefresh,
  onDeleted,
  onAssignCosmetic,
}: {
  project: Project;
  /** Admin / leader / leading-division head (NOT a co-operator) — delete,
   *  delegate co-operators, change the leading division. */
  isLeadership: boolean;
  /** Admin / leader / co-operator / head — guests + member admin + edit. */
  canManage: boolean;
  /** Admin / leading-division head — may assign/replace the project leader. */
  canAssignLeader: boolean;
  onBack: () => void;
  onOpenMeetings: () => void;
  onEdit: () => void;
  /** Re-fetch the project list after an in-place change (division reassign). */
  onRefresh: () => void;
  onDeleted: () => void;
  /** Save a colour/icon accent (panel owns the PATCH + in-place update). */
  onAssignCosmetic: (patch: {
    color?: string | null;
    icon?: string | null;
  }) => void;
}) => {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  // Which cosmetic popover is open in the hero (colour XOR emoji).
  const [cosmeticMenu, setCosmeticMenu] = useState<"color" | "icon" | null>(
    null,
  );
  const [cosmeticAnchor, setCosmeticAnchor] = useState<DOMRect | null>(null);
  const isInvitee = project.access === "invitee";

  // Division catalogue for the "leading department" picker (leadership only).
  const [divisions, setDivisions] = useState<Division[]>([]);
  useEffect(() => {
    void listDivisions().then(setDivisions);
  }, []);
  const currentDivision =
    divisions.find((d) => d.id === project.lead_division_id) ?? null;
  const changeDivision = async (divisionId: string | null) => {
    if (!(await setProjectDivision(project.id, divisionId))) {
      window.alert(t("proj.divisionChangeFailed"));
      return;
    }
    onRefresh();
  };

  const toggleCosmeticMenu = (
    kind: "color" | "icon",
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (cosmeticMenu === kind) {
      setCosmeticMenu(null);
    } else {
      setCosmeticAnchor(e.currentTarget.getBoundingClientRect());
      setCosmeticMenu(kind);
    }
  };

  const metaCells = useMemo(
    () =>
      [
        [t("pmgr.metaClient"), project.client],
        [t("pmgr.metaLocation"), project.location],
        [t("pmgr.metaBranch"), project.branch],
        [t("pmgr.metaType"), project.type],
        [t("pmgr.createdAt"), fmtCreated(project.created_at)],
        // "Owner" wording retired — the responsible person is the LEADER
        // (defaults to the creator until a head reassigns it). (anh Luân 06-15)
        [t("proj.roleOwner"), project.leader_email || project.host_email],
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

  // "Add guest" (sits next to Add member) jumps to the Project-guests section's
  // issue form — opens it (if collapsed) and scrolls it into view.
  const scrollToGuests = () => {
    const el = document.getElementById(
      "proj-guest-section",
    ) as HTMLDetailsElement | null;
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="mcm-pdetail">
      <button type="button" className="mcm-pdetail__back" onClick={onBack}>
        <ChevronLeft size={15} /> {t("pmgr.back")}
      </button>

      <div className="mcm-pdetail__hero">
        {project.cover && (
          <div className="mcm-pdetail__cover">
            <img src={project.cover} alt="" />
            {/* Name sits ON the cover — the SCSS scrim keeps it AA. */}
            <h2 className="mcm-pdetail__name mcm-pdetail__name--cover">
              {project.icon ? `${project.icon} ` : ""}
              {project.name}
            </h2>
          </div>
        )}
        <div className="mcm-pdetail__hero-row">
          {!project.cover && (
            <h2 className="mcm-pdetail__name">
              {project.icon ? `${project.icon} ` : ""}
              {project.name}
            </h2>
          )}
          {project.stage && (
            <span className="mcm-pmgr__tag">{project.stage}</span>
          )}
          {project.code && (
            <span className="mcm-pdetail__code">{project.code}</span>
          )}
          <div className="mcm-pdetail__actions">
            {/* Cosmetic accents — colour + icon. Any member (the worker
                exempts these from owner-only); hidden for invitees. */}
            {!isInvitee && (
              <>
                <button
                  type="button"
                  className="mcm-icon-btn mcm-icon-btn--sm"
                  onClick={(e) => toggleCosmeticMenu("color", e)}
                  title="Đổi màu dự án"
                  aria-label="Đổi màu dự án"
                >
                  <Palette size={14} />
                </button>
                <button
                  type="button"
                  className="mcm-icon-btn mcm-icon-btn--sm"
                  onClick={(e) => toggleCosmeticMenu("icon", e)}
                  title="Gán biểu tượng dự án"
                  aria-label="Gán biểu tượng dự án"
                >
                  <SmilePlus size={14} />
                </button>
                {cosmeticMenu === "color" && cosmeticAnchor && (
                  <ColorMenu
                    anchor={cosmeticAnchor}
                    current={project.color ?? null}
                    onPick={(c) => {
                      setCosmeticMenu(null);
                      onAssignCosmetic({ color: c });
                    }}
                    onClose={() => setCosmeticMenu(null)}
                    clearLabel={t("color.none")}
                  />
                )}
                {cosmeticMenu === "icon" && cosmeticAnchor && (
                  <EmojiMenu
                    anchor={cosmeticAnchor}
                    current={project.icon ?? null}
                    presets={PROJECT_ICON_PRESETS}
                    onPick={(ic) => {
                      setCosmeticMenu(null);
                      onAssignCosmetic({ icon: ic });
                    }}
                    onClose={() => setCosmeticMenu(null)}
                    clearLabel="Bỏ biểu tượng"
                  />
                )}
              </>
            )}
            {canManage && !isInvitee && (
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

      <Section title={t("pmgr.sectionInfo")}>
        <div className="mcm-pdetail__metagrid">
          {metaCells.map(([label, value]) => (
            <div className="mcm-pdetail__meta-cell" key={label}>
              <span className="mcm-pdetail__meta-label">{label}</span>
              <span
                className={`mcm-pdetail__meta-value${
                  value ? "" : " mcm-pdetail__meta-value--empty"
                }`}
              >
                {value || "—"}
              </span>
            </div>
          ))}
        </div>
        {project.description && (
          <p className="mcm-pdetail__desc">{project.description}</p>
        )}
        {/* Leading department — whose head manages the project. Defaults to the
            creator's division; leadership can refile it to the correct one (so
            a head doesn't "cover" projects that aren't really their dept). */}
        {!isInvitee && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: 12,
              maxWidth: 340,
            }}
          >
            <span className="mcm-pdetail__meta-label">
              {t("proj.leadDivision")}
            </span>
            {isLeadership ? (
              <select
                className="mcm-roster__in"
                value={project.lead_division_id ?? ""}
                onChange={(e) => void changeDivision(e.target.value || null)}
              >
                <option value="">{t("proj.leadDivisionNone")}</option>
                {divisions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="mcm-pdetail__meta-value">
                {currentDivision?.name || "—"}
              </span>
            )}
          </div>
        )}
      </Section>

      {/* Members — true membership only. An invitee detail never fetches
          the roster (the worker would 403; no console noise). A plain
          participant sees the roster READ-ONLY (canManage=false → no Add/
          remove/promote, no Add-guest shortcut). */}
      {!isInvitee && (
        <Section title={t("proj.members")}>
          <ProjectMemberRoster
            projectId={project.id}
            canManage={canManage}
            canLead={isLeadership}
            canAssignLeader={canAssignLeader}
            extraAction={
              canManage ? (
                <button
                  type="button"
                  className="mcm-btn mcm-roster__add"
                  onClick={scrollToGuests}
                >
                  <UserPlus size={15} /> {t("projGuest.addGuest")}
                </button>
              ) : undefined
            }
          />
        </Section>
      )}

      {/* Project-scoped guests — issue/reset/revoke/clean. MANAGERS only
          (admin/owner/manager); a plain participant never sees it (matches
          the worker's canManageProject gate; an invitee never renders it). */}
      {!isInvitee && canManage && (
        <Section id="proj-guest-section" title={t("projGuest.section")}>
          <ProjectGuestRoster projectId={project.id} />
        </Section>
      )}

      {isLeadership && !isInvitee && (
        <Section title={t("pmgr.sectionDanger")} defaultOpen={false}>
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
        </Section>
      )}
    </div>
  );
};

export default ProjectManagerPanel;
