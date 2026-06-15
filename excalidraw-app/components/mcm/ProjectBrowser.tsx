import {
  ArrowUpDown,
  Eye,
  Folder,
  FolderHeart,
  FolderKanban,
  LayoutGrid,
  List as ListIcon,
  Palette,
  Pencil,
  Plus,
  Settings,
  SmilePlus,
  Users,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { getMyMeetingsChecked, type CalMeeting } from "../../data/calendar";
import { getMyInvitationsChecked, type MyInvitation } from "../../data/invite";
import {
  createProject,
  getMeeting,
  listMeetingsChecked,
  listProjectsChecked,
  updateMeeting,
  updateProject,
} from "../../data/projects";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { CalendarX } from "./CalendarX";
import { ClientsManager } from "./ClientsManager";
// Shared cosmetic popovers — extracted to their own file (UI-2) so the
// project manager reuses the exact same menus as the meeting cards.
import { ColorMenu, EmojiMenu } from "./ColorMenu";
import { EditMeetingForm } from "./EditMeetingForm";
import { MeetingDetailPreview } from "./MeetingDetailPreview";
import { meetingColor, personColor, statusBucket } from "./meetingColors";
import {
  canManageMeeting,
  isEditableMeetingStatus,
  isFinishedStatus,
  meetingStatusLabel,
  normalizeMeetingStatus,
} from "./meetingStatus";
import { MetadataEditor } from "./MetadataEditor";
import { MyFilesPanel } from "./MyFilesPanel";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import { ScheduleMeetingForm } from "./ScheduleMeetingForm";
import { buildProjectFields } from "./metadataFields";

import type { MeetingSummary, Project } from "../../data/projects";

// "all" = my whole calendar · "invited" = invitations · "myfiles" = the
// personal document shelf (internal only) · "projects" = the project
// management page (reserved id — never collides with project UUIDs) ·
// else a project id (its meeting list).
type View = "all" | "invited" | "myfiles" | "projects" | string;

// Middle-column presentation controls (persisted in component state).
type ViewMode = "grid" | "list";
type SortBy = "time" | "title" | "status";

// When a meeting sits in time: its scheduled slot if set, else when the row
// was last touched. Used for both display and sort.
const meetingWhenMs = (m: MeetingSummary): number => {
  if (m.scheduled_at) {
    const t = Date.parse(m.scheduled_at);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return m.scene_updated_at ?? m.updated_at ?? 0;
};

const fmtDateOnly = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

const fmtTimeOnly = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

// Adapt the calendar/invite shapes to the card grid's MeetingSummary so the
// middle column renders the same card for every context.
const calToSummary = (c: CalMeeting): MeetingSummary => ({
  id: c.id,
  title: c.title,
  topic: null,
  type: null,
  status: c.status,
  created_by: c.created_by,
  organizer_email: c.organizer_email,
  thumbnail: null,
  participant_count: null,
  duration_s: null,
  scene_updated_at: null,
  updated_at: c.created_at,
  last_opened_at: null,
  scheduled_at: c.scheduled_at,
  color: c.color ?? null,
  icon: c.icon ?? null,
  project_name: c.project_name,
  project_id: c.project_id,
});

const invToSummary = (i: MyInvitation): MeetingSummary => ({
  id: i.id,
  title: i.title,
  topic: i.topic,
  type: null,
  status: i.status,
  created_by: i.created_by,
  thumbnail: null,
  participant_count: null,
  duration_s: null,
  scene_updated_at: null,
  updated_at: 0,
  last_opened_at: null,
  scheduled_at: i.scheduled_at,
  project_name: i.project_name,
});

/**
 * Unified home (Notion-style 3 columns): a sidebar (calendar / invited / the
 * project list) on the LEFT, the selected context's meeting cards in the
 * MIDDLE (which the inline detail + create/schedule form replace), and the
 * calendar always on the RIGHT. `onEntered` fires after a room is joined.
 */
export const ProjectBrowser = ({ onEntered }: { onEntered?: () => void }) => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const session = useAtomValue(sessionAtom);

  const [projects, setProjects] = useState<Project[]>([]);
  // Last list fetch failed (network / worker error) — the empty-states
  // must say "couldn't load", not pretend there is genuinely nothing.
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [view, setView] = useState<View>("all");
  const [cards, setCards] = useState<MeetingSummary[]>([]);
  const [cardsFailed, setCardsFailed] = useState(false);
  const [loadingCards, setLoadingCards] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  /** Project open in the management page's detail (view === "projects"). */
  const [manageProjectId, setManageProjectId] = useState<string | null>(null);
  /** Create-project modal (full-metadata MetadataEditor). */
  const [creatingProject, setCreatingProject] = useState(false);
  /** Meeting being edited in the middle column (full organizer editor). */
  const [editRoomId, setEditRoomId] = useState<string | null>(null);
  const [detailRoomId, setDetailRoomId] = useState<string | null>(null);
  const [meetingFormOpen, setMeetingFormOpen] = useState<
    "now" | "schedule" | null
  >(null);
  const [formDefaultWhen, setFormDefaultWhen] = useState<string | undefined>();
  // Calendar column width: null = equal 50/50 split (default); a number = px
  // once the user drags the divider.
  const [calWidth, setCalWidth] = useState<number | null>(null);
  // Middle-column presentation (persisted in component state for the session).
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortBy>("time");
  // Status filter chips for the card list (overview + project views).
  const [statusFilter, setStatusFilter] = useState<
    "all" | "live" | "upcoming" | "done" | "cancelled"
  >("all");
  // The card whose colour-swatch menu is open (one at a time), by room id.
  const [colorMenuFor, setColorMenuFor] = useState<string | null>(null);
  const [colorMenuAnchor, setColorMenuAnchor] = useState<DOMRect | null>(null);
  // Same pattern for the emoji (icon) picker — one open at a time.
  const [emojiMenuFor, setEmojiMenuFor] = useState<string | null>(null);
  const [emojiMenuAnchor, setEmojiMenuAnchor] = useState<DOMRect | null>(null);
  // Bumped on any meeting change so the calendar (which self-fetches) re-pulls
  // and its event colours stay in sync with the cards.
  const [calRefresh, setCalRefresh] = useState(0);

  const refreshProjects = useCallback(async () => {
    const r = await listProjectsChecked();
    // On failure keep whatever we already have (stale beats blank) and
    // flag it so the sidebar's empty slot says "couldn't load", not
    // "no projects".
    setProjectsFailed(!r.ok);
    if (r.ok) {
      setProjects(r.items);
    }
  }, []);

  // Load the middle column for the current context.
  const refreshCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      if (view === "myfiles" || view === "projects" || view === "clients") {
        // These panels self-manage — no meeting cards in these views.
        setCards([]);
        setCardsFailed(false);
      } else if (view === "all") {
        const r = await getMyMeetingsChecked();
        setCardsFailed(!r.ok);
        setCards(r.ok ? r.items.map(calToSummary) : []);
      } else if (view === "invited") {
        const r = await getMyInvitationsChecked();
        setCardsFailed(!r.ok);
        setCards(r.ok ? r.items.map(invToSummary) : []);
      } else {
        const r = await listMeetingsChecked(view);
        setCardsFailed(!r.ok);
        setCards(r.ok ? r.items : []);
      }
    } finally {
      setLoadingCards(false);
    }
  }, [view]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void refreshCards();
  }, [refreshCards]);

  if (!collabAPI) {
    return null;
  }

  const isInternal = isInternalEmail(session?.email);

  const selectedProject =
    view === "all" ||
    view === "invited" ||
    view === "myfiles" ||
    view === "projects" ||
    view === "clients"
      ? null
      : projects.find((p) => p.id === view) ?? null;
  // True membership only — an "invitee" folder (mời vào 1 cuộc họp của phòng
  // ban khác) is browse-filtered, not ours to create meetings in or edit.
  const isMemberProject = (p: Project | null): boolean =>
    !!p && p.access !== "invitee";
  // The project a new meeting attaches to: the open one if we're a member,
  // else the first project we actually belong to.
  const targetProject = isMemberProject(selectedProject)
    ? selectedProject
    : projects.find((p) => isMemberProject(p)) ?? null;

  const contextLabel = selectedProject
    ? selectedProject.name
    : view === "invited"
    ? t("invited.title")
    : view === "myfiles"
    ? t("myfiles.title")
    : view === "projects"
    ? t("pmgr.title")
    : view === "clients"
    ? t("clients.navLabel")
    : t("cal.upcoming");

  const enterRoom = async (
    roomId: string,
    roomKey: string,
    viewOnly = false,
  ) => {
    if (collabAPI.isCollaborating()) {
      collabAPI.stopCollaboration(false);
    }
    window.history.pushState({}, "", getCollaborationLink({ roomId, roomKey }));
    await collabAPI.startCollaboration({ roomId, roomKey }, { viewOnly });
    onEntered?.();
  };

  const joinMeetingById = async (roomId: string) => {
    const m = await getMeeting(roomId);
    if (!m?.room_key) {
      showAppToast(t("errors.openMeetingFailed"));
      return;
    }
    const finished = isFinishedStatus(m.status);
    await enterRoom(roomId, m.room_key, finished);
  };

  // Calendar (right column) callbacks — the detail + create form open in the
  // always-visible middle column, so no view switch is needed.
  const calJoin = (id: string) => void joinMeetingById(id);
  const calOpen = (id: string) => setDetailRoomId(id);
  const calCreate = (dateISO: string) => {
    setFormDefaultWhen(dateISO);
    setMeetingFormOpen("schedule");
  };

  // Drag the divider between the meetings + calendar columns to resize.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      // Floor 360 matches the calendar column's CSS min so dragging can't
      // shrink Schedule-X into a cramped/agenda reflow.
      setCalWidth(Math.max(360, Math.min(760, window.innerWidth - ev.clientX)));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Create with FULL metadata in one modal. The worker's POST only takes a
  // name, so this is a 2-call flow: POST name → PATCH the extra fields.
  // POST fail keeps the modal (and everything typed) open for a retry;
  // PATCH fail still lands in the new project's detail with a toast — the
  // user presses Sửa and re-enters, nothing is lost twice.
  const handleCreateProject = async (values: Record<string, string>) => {
    const name = values.name?.trim();
    if (!name || busy) {
      return;
    }
    setBusy(true);
    try {
      const project = await createProject(name);
      if (!project) {
        showAppToast(t("errors.createProjectFailed"));
        return;
      }
      const extras: Record<string, string> = {};
      for (const key of [
        "code",
        "client",
        "location",
        "stage",
        "type",
        "branch",
        "cover",
        "description",
      ] as const) {
        if (values[key]?.trim()) {
          extras[key] = values[key];
        }
      }
      if (Object.keys(extras).length > 0) {
        const ok = await updateProject(project.id, extras);
        if (!ok) {
          showAppToast(t("pmgr.savePartialFailed"));
        }
      }
      setCreatingProject(false);
      await refreshProjects();
      // Stay in management mode: the natural next step after creating is
      // adding members in the detail — not staring at an empty meeting list.
      setView("projects");
      setManageProjectId(project.id);
    } finally {
      setBusy(false);
    }
  };

  // Blank shape for the create modal's field builder.
  const BLANK_PROJECT: Project = {
    id: "",
    name: "",
    host_email: null,
    code: null,
    client: null,
    location: null,
    stage: null,
    type: null,
    branch: null,
    cover: null,
    description: null,
    created_at: 0,
    updated_at: 0,
  };

  const handleReopen = async (m: MeetingSummary) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const meeting = await getMeeting(m.id);
      if (meeting?.room_key) {
        const finished = isFinishedStatus(meeting.status);
        await enterRoom(m.id, meeting.room_key, finished);
      } else {
        showAppToast(t("errors.openMeetingFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  // "User tạo meeting mới edit được meeting" — the Edit affordance only shows
  // for the organizer (legacy rows without one: any internal), and only while
  // the meeting still takes edits (scheduled/live — never finished/cancelled).
  // The "invited" view never shows Edit: its adapter has no organizer data,
  // and you don't edit a meeting you were merely invited to.
  const canEditCard = (m: MeetingSummary): boolean =>
    view !== "invited" &&
    canManageMeeting(
      session?.email,
      m.organizer_email ?? null,
      isInternalEmail(session?.email),
    ) &&
    isEditableMeetingStatus(m.status);

  const openMeetingEditor = (m: MeetingSummary) => {
    setDetailRoomId(null);
    setMeetingFormOpen(null);
    setEditRoomId(m.id);
  };

  // Assign (or clear) a meeting's colour. Patch ONLY the one card in place —
  // a full refreshCards() re-fetched and re-rendered the whole list, which
  // flashed the entire meeting viewer. The calendar self-refetches via
  // calRefresh so its event tint stays in sync.
  const assignColor = async (id: string, color: string | null) => {
    setColorMenuFor(null);
    const ok = await updateMeeting(id, { color });
    if (!ok) {
      showAppToast(t("errors.colorFailed"));
      return;
    }
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
    setCalRefresh((k) => k + 1);
  };

  // Assign (or clear) a meeting's icon (emoji) — same in-place patch as
  // assignColor so the list never flashes.
  const assignIcon = async (id: string, icon: string | null) => {
    setEmojiMenuFor(null);
    const ok = await updateMeeting(id, { icon });
    if (!ok) {
      showAppToast("Không gán được biểu tượng");
      return;
    }
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, icon } : c)));
    setCalRefresh((k) => k + 1);
  };

  const saveProject = async (values: Record<string, string>) => {
    if (!editingProject) {
      return;
    }
    const ok = await updateProject(editingProject.id, {
      name: values.name,
      code: values.code,
      client: values.client,
      location: values.location,
      stage: values.stage,
      type: values.type,
      branch: values.branch,
      cover: values.cover,
      description: values.description,
    });
    if (!ok) {
      // Keep the modal open so the edits aren't silently lost.
      window.alert(t("folder.saveFailed"));
      return;
    }
    setEditingProject(null);
    await refreshProjects();
  };

  // Project administration (edit/delete/members) lives in the management
  // page (ProjectManagerPanel) — the meeting view keeps no admin controls
  // beyond the ⚙ shortcut in the title row.

  // Apply the chosen sort. "By time" is CALENDAR logic, not a flat list:
  // today/future days first (nearest day first), each day's meetings in
  // chronological order; past days follow, most recent past day first. The
  // renderer inserts a day separator whenever the day changes.
  const dayKeyOf = (ms: number): string => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const todayKey = dayKeyOf(Date.now());
  const sortedCards = [...cards].sort((a, b) => {
    if (sortBy === "title") {
      return (a.title || "").localeCompare(b.title || "");
    }
    if (sortBy === "status") {
      return (a.status || "").localeCompare(b.status || "");
    }
    const aMs = meetingWhenMs(a);
    const bMs = meetingWhenMs(b);
    const aDay = dayKeyOf(aMs);
    const bDay = dayKeyOf(bMs);
    const aPast = aDay < todayKey;
    const bPast = bDay < todayKey;
    if (aPast !== bPast) {
      return aPast ? 1 : -1; // upcoming block before the past block
    }
    if (aDay !== bDay) {
      // Upcoming: nearest day first (asc). Past: most recent day first (desc).
      return aPast ? bDay.localeCompare(aDay) : aDay.localeCompare(bDay);
    }
    return aMs - bMs; // within a day: chronological
  });

  // Status filter chips narrow the (already-sorted) card list before render.
  // Map the normalized lifecycle to the chip buckets: live→live,
  // scheduled→upcoming, finished→done, cancelled→cancelled.
  const filteredCards =
    statusFilter === "all"
      ? sortedCards
      : sortedCards.filter((m) => {
          const n = normalizeMeetingStatus(m.status);
          if (statusFilter === "upcoming") {
            return n === "scheduled";
          }
          if (statusFilter === "done") {
            return n === "finished";
          }
          return n === statusFilter; // live | cancelled
        });

  // Human day label for the separators: Hôm nay / Ngày mai / locale date.
  const dayLabelOf = (ms: number): string => {
    const key = dayKeyOf(ms);
    if (key === todayKey) {
      return t("cal.today");
    }
    if (key === dayKeyOf(Date.now() + 86400000)) {
      return t("cal.tomorrow");
    }
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  // Every nav click resets the middle column's sub-views (detail/forms)
  // AND the management page's drill-in, so switching context never leaves
  // a stale detail behind.
  const resetSubViews = () => {
    setDetailRoomId(null);
    setMeetingFormOpen(null);
    setEditRoomId(null);
    setManageProjectId(null);
  };

  const navItem = (key: View, label: string) => (
    <button
      type="button"
      className={`mcm-nav__item${view === key ? " mcm-nav__item--active" : ""}`}
      onClick={() => {
        setView(key);
        resetSubViews();
      }}
    >
      <span className="mcm-nav__item-label">{label}</span>
    </button>
  );

  return (
    <div
      className="mcm-home mcm-3col"
      style={
        calWidth != null
          ? ({ ["--cal-w" as string]: `${calWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* LEFT — sidebar nav */}
      <aside className="mcm-3col__sidebar mcm-scroll">
        <div className="mcm-nav__section">
          {navItem("all", t("cal.myMeetings"))}
          {navItem("invited", t("invited.title"))}
          {/* Personal document shelf — internal staff only (the Worker
              also gates /v1/me/files to internal accounts). */}
          {isInternal && (
            <button
              type="button"
              className={`mcm-nav__item${
                view === "myfiles" ? " mcm-nav__item--active" : ""
              }`}
              onClick={() => {
                setView("myfiles");
                resetSubViews();
              }}
            >
              <FolderHeart size={14} className="mcm-nav__item-icon" />
              <span className="mcm-nav__item-label">{t("myfiles.title")}</span>
            </button>
          )}
          {/* Project management page — create/metadata/members/delete all
              live there; the per-project view below stays a clean meeting
              list. Internal staff only, same gate as the shelf. */}
          {isInternal && (
            <button
              type="button"
              className={`mcm-nav__item${
                view === "projects" ? " mcm-nav__item--active" : ""
              }`}
              onClick={() => {
                setView("projects");
                resetSubViews();
              }}
            >
              <FolderKanban size={14} className="mcm-nav__item-icon" />
              <span className="mcm-nav__item-label">{t("pmgr.navLabel")}</span>
            </button>
          )}
          {/* Clients — external contact cards + provisioning a login account
              for each. Internal staff only (Worker gates /v1/clients). */}
          {isInternal && (
            <button
              type="button"
              className={`mcm-nav__item${
                view === "clients" ? " mcm-nav__item--active" : ""
              }`}
              onClick={() => {
                setView("clients");
                resetSubViews();
              }}
            >
              <Users size={14} className="mcm-nav__item-icon" />
              <span className="mcm-nav__item-label">
                {t("clients.navLabel")}
              </span>
            </button>
          )}
        </div>
        <div className="mcm-nav__section">
          <h3 className="mcm-nav__section-label">{t("header.projects")}</h3>
          <ul className="mcm-nav__items">
            {projects.length === 0 &&
              (projectsFailed ? (
                <li className="mcm-nav__empty">
                  {t("errors.loadFailed")}{" "}
                  <button
                    type="button"
                    className="mcm-nav__retry"
                    onClick={() => void refreshProjects()}
                  >
                    {t("errors.retry")}
                  </button>
                </li>
              ) : (
                <li className="mcm-nav__empty">{t("folder.empty")}</li>
              ))}
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`mcm-nav__item${
                    view === p.id ? " mcm-nav__item--active" : ""
                  }`}
                  onClick={() => {
                    setView(p.id);
                    resetSubViews();
                  }}
                >
                  {/* Project colour dot — mirrors the card tint at a glance. */}
                  {p.color && (
                    <span
                      className="mcm-nav__item-dot"
                      style={{ background: p.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="mcm-nav__item-label">
                    {p.icon ? `${p.icon} ` : ""}
                    {p.name}
                  </span>
                  {/* Invited-only access (no membership): badge instead of
                      the stage — the folder shows just their meetings. */}
                  {p.access === "invitee" ? (
                    <span className="mcm-nav__item-stage mcm-nav__item-stage--invited">
                      {t("folder.invitedBadge")}
                    </span>
                  ) : (
                    p.stage && (
                      <span className="mcm-nav__item-stage">{p.stage}</span>
                    )
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {/* One create path with full metadata (the old quick-name input
            made half-configured projects) — same modal as the management
            page's button. Internal only, like project creation itself. */}
        {isInternal && (
          <div className="mcm-nav__footer">
            <button
              type="button"
              className="mcm-btn mcm-btn--block"
              onClick={() => setCreatingProject(true)}
              disabled={busy}
            >
              <Plus size={15} /> {t("pmgr.newProject")}
            </button>
          </div>
        )}
      </aside>

      {/* MIDDLE — context meetings, or the inline detail / create form */}
      <section className="mcm-3col__middle">
        <div className="mcm-3col__middle-head">
          <div className="mcm-3col__middle-titlebox">
            <h2 className="mcm-3col__middle-title">{contextLabel}</h2>
            {/* Project view = clean meeting list: the name appears HERE
                once, with just the stage pill and a ⚙ shortcut into the
                management page's detail (hidden for invitee folders —
                nothing there for them to administer). */}
            {selectedProject && selectedProject.stage && (
              <span className="mcm-nav__item-stage">
                {selectedProject.stage}
              </span>
            )}
            {selectedProject && isMemberProject(selectedProject) && (
              <button
                type="button"
                className="mcm-icon-btn mcm-icon-btn--sm"
                onClick={() => {
                  setView("projects");
                  resetSubViews();
                  setManageProjectId(selectedProject.id);
                }}
                title={t("pmgr.manage")}
                aria-label={t("pmgr.manage")}
              >
                <Settings size={14} />
              </button>
            )}
          </div>
          {/* Toolbar — view toggle + sort. Only meaningful on the card list,
              so it hides while a detail/create/edit form occupies the column. */}
          {view !== "myfiles" &&
            view !== "projects" &&
            !detailRoomId &&
            !meetingFormOpen &&
            !editRoomId && (
              <div className="mcm-toolbar">
                <div
                  className="mcm-segmented"
                  role="group"
                  aria-label={t("view.label")}
                >
                  <button
                    type="button"
                    className={`mcm-segmented__btn${
                      viewMode === "grid" ? " mcm-segmented__btn--active" : ""
                    }`}
                    onClick={() => setViewMode("grid")}
                    title={t("view.grid")}
                    aria-label={t("view.grid")}
                    aria-pressed={viewMode === "grid" ? "true" : "false"}
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
                    <ListIcon size={14} />
                  </button>
                </div>
                <label className="mcm-select" title={t("sort.label")}>
                  <ArrowUpDown size={13} className="mcm-select__icon" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    aria-label={t("sort.label")}
                  >
                    <option value="time">{t("sort.time")}</option>
                    <option value="title">{t("sort.title")}</option>
                    <option value="status">{t("sort.status")}</option>
                  </select>
                </label>
                {/* Status filter chips — narrow the card list by lifecycle. */}
                <div
                  className="mcm-chips"
                  role="group"
                  aria-label={t("sort.status")}
                >
                  {(
                    [
                      ["all", t("proj.filterAll")],
                      ["live", t("proj.filterLive")],
                      ["upcoming", t("proj.filterUpcoming")],
                      ["done", t("proj.filterDone")],
                      ["cancelled", t("proj.filterCancelled")],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`mcm-chip${
                        statusFilter === key ? " mcm-chip--active" : ""
                      }`}
                      onClick={() => setStatusFilter(key)}
                      aria-pressed={statusFilter === key ? "true" : "false"}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          {view !== "invited" &&
            view !== "myfiles" &&
            view !== "projects" &&
            view !== "clients" &&
            targetProject &&
            !detailRoomId &&
            !editRoomId &&
            (!selectedProject || isMemberProject(selectedProject)) && (
              <button
                type="button"
                className="mcm-btn mcm-btn--primary mcm-btn--sm"
                onClick={() => setMeetingFormOpen("now")}
                disabled={busy}
              >
                <Plus size={15} /> {t("folder.newMeetingInProject")}
              </button>
            )}
        </div>

        <div className="mcm-3col__middle-body mcm-scroll">
          {view === "myfiles" ? (
            <MyFilesPanel />
          ) : view === "clients" ? (
            <ClientsManager />
          ) : view === "projects" ? (
            <ProjectManagerPanel
              projects={projects}
              projectsFailed={projectsFailed}
              onRetryProjects={() => void refreshProjects()}
              manageProjectId={manageProjectId}
              onManage={setManageProjectId}
              onOpenMeetings={(id) => {
                setView(id);
                resetSubViews();
              }}
              onCreate={() => setCreatingProject(true)}
              onEdit={(p) => setEditingProject(p)}
              onProjectsChanged={() => void refreshProjects()}
              onPatchProject={(id, patch) =>
                // Cosmetic colour/icon: patch the one project in place so
                // the list (and the open detail) updates without a flash.
                setProjects((prev) =>
                  prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
                )
              }
            />
          ) : editRoomId ? (
            <EditMeetingForm
              roomId={editRoomId}
              onClose={() => setEditRoomId(null)}
              onSaved={() => {
                setEditRoomId(null);
                void refreshCards();
                setCalRefresh((k) => k + 1);
              }}
            />
          ) : detailRoomId ? (
            <MeetingDetailPreview
              roomId={detailRoomId}
              onClose={() => setDetailRoomId(null)}
              onChanged={() => {
                void refreshCards();
                setCalRefresh((k) => k + 1);
              }}
              onEdit={() => {
                const m = cards.find((x) => x.id === detailRoomId);
                setDetailRoomId(null);
                if (m) {
                  openMeetingEditor(m);
                }
              }}
            />
          ) : meetingFormOpen && targetProject ? (
            <ScheduleMeetingForm
              projectId={targetProject.id}
              projectName={targetProject.name}
              mode={meetingFormOpen}
              defaultWhen={formDefaultWhen}
              onClose={() => {
                setMeetingFormOpen(null);
                setFormDefaultWhen(undefined);
              }}
              onCreated={() => {
                setMeetingFormOpen(null);
                void refreshCards();
                setCalRefresh((k) => k + 1);
              }}
              onCreatedEnter={(roomId, roomKey) => {
                setMeetingFormOpen(null);
                void enterRoom(roomId, roomKey);
              }}
            />
          ) : loadingCards ? (
            <div className="mcm-3col__hint">…</div>
          ) : cardsFailed ? (
            <div className="mcm-3col__hint">
              {t("errors.loadFailed")}{" "}
              <button
                type="button"
                className="mcm-3col__retry"
                onClick={() => void refreshCards()}
              >
                {t("errors.retry")}
              </button>
            </div>
          ) : filteredCards.length === 0 ? (
            <div className="mcm-3col__hint">{t("folder.noMeetings")}</div>
          ) : (
            <div className="mcm-mcards-scroll">
              <ul
                className={`mcm-mcards mcm-mcards--${viewMode}`}
                data-sort={sortBy}
              >
                {filteredCards.map((m, idx) => {
                  const when = meetingWhenMs(m);
                  const stripe = meetingColor(m.color, m.status);
                  // Project chip only in the overview/invited lists — inside
                  // a project view every card shares the (visible) context.
                  const chipProject =
                    view === "all" || view === "invited"
                      ? m.project_name
                      : null;
                  // "By time" groups by DAY: emit a separator whenever this
                  // card's day differs from the previous card's.
                  const daySep =
                    sortBy === "time" &&
                    (idx === 0 ||
                      dayKeyOf(meetingWhenMs(filteredCards[idx - 1])) !==
                        dayKeyOf(when)) ? (
                      <li
                        key={`day-${dayKeyOf(when)}`}
                        className="mcm-mcards__daysep"
                        aria-hidden="true"
                      >
                        {dayLabelOf(when)}
                      </li>
                    ) : null;
                  return (
                    <Fragment key={m.id}>
                      {daySep}
                      <li
                        className={`mcm-mcard mcm-mcard--${statusBucket(
                          m.status,
                        )}`}
                        style={
                          {
                            ["--mcard-color" as string]: stripe,
                          } as React.CSSProperties
                        }
                      >
                        <span
                          className="mcm-mcard__stripe"
                          aria-hidden="true"
                        />
                        {statusBucket(m.status) === "in-progress" && (
                          <span
                            className="mcm-mcard__livedot"
                            aria-hidden="true"
                          />
                        )}
                        <button
                          type="button"
                          className="mcm-mcard__main"
                          onClick={() => handleReopen(m)}
                          disabled={busy}
                          title={t("folder.reopen")}
                        >
                          <span className="mcm-mcard__title">
                            {m.icon && (
                              <span
                                className="mcm-mcard__title-icon"
                                aria-hidden="true"
                              >
                                {m.icon}
                              </span>
                            )}
                            {m.title || t("folder.meetingFallbackTitle")}
                          </span>
                          {m.topic && (
                            <span className="mcm-mcard__topic">{m.topic}</span>
                          )}
                          <span className="mcm-mcard__when">
                            <span className="mcm-mcard__date">
                              {fmtDateOnly(when)}
                            </span>
                            {fmtTimeOnly(when) && (
                              <span className="mcm-mcard__time">
                                {fmtTimeOnly(when)}
                              </span>
                            )}
                          </span>
                          {/* Creator — always visible on the card so ownership
                          ("ai tạo cuộc họp này") reads at a glance. */}
                          {(m.created_by || m.organizer_email) && (
                            <span
                              className="mcm-mcard__creator"
                              style={
                                {
                                  ["--pa" as string]: personColor(
                                    m.organizer_email || m.created_by,
                                  ),
                                } as React.CSSProperties
                              }
                              title={m.organizer_email ?? undefined}
                            >
                              <span
                                className="mcm-mcard__creator-ava"
                                aria-hidden="true"
                              >
                                {(m.created_by || m.organizer_email)!
                                  .trim()[0]
                                  ?.toUpperCase()}
                              </span>
                              <span className="mcm-mcard__creator-name">
                                {m.created_by ||
                                  m.organizer_email!.split("@")[0]}
                              </span>
                            </span>
                          )}
                          <span className="mcm-mcard__foot">
                            {m.status && (
                              <span
                                className={`mcm-pill mcm-pill--${statusBucket(
                                  m.status,
                                )}`}
                              >
                                {meetingStatusLabel(t, m.status)}
                              </span>
                            )}
                            {chipProject && (
                              <span
                                className={`mcm-mcard__project${
                                  m.project_id
                                    ? " mcm-mcard__project--link"
                                    : ""
                                }`}
                                role={m.project_id ? "button" : undefined}
                                tabIndex={m.project_id ? 0 : undefined}
                                title={chipProject}
                                onClick={
                                  m.project_id
                                    ? (e) => {
                                        // Don't reopen the meeting — the chip
                                        // navigates to the project instead.
                                        e.stopPropagation();
                                        setView(m.project_id!);
                                        resetSubViews();
                                      }
                                    : undefined
                                }
                                onKeyDown={
                                  m.project_id
                                    ? (e) => {
                                        if (
                                          e.key === "Enter" ||
                                          e.key === " "
                                        ) {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          setView(m.project_id!);
                                          resetSubViews();
                                        }
                                      }
                                    : undefined
                                }
                              >
                                <Folder size={11} aria-hidden="true" />
                                <span className="mcm-mcard__project-name">
                                  {chipProject}
                                </span>
                              </span>
                            )}
                          </span>
                        </button>
                        <div className="mcm-mcard__actions">
                          <div className="mcm-mcard__color">
                            <button
                              type="button"
                              className="mcm-icon-btn mcm-icon-btn--sm"
                              onClick={(e) => {
                                if (colorMenuFor === m.id) {
                                  setColorMenuFor(null);
                                } else {
                                  setEmojiMenuFor(null);
                                  setColorMenuAnchor(
                                    e.currentTarget.getBoundingClientRect(),
                                  );
                                  setColorMenuFor(m.id);
                                }
                              }}
                              title={t("color.label")}
                              aria-label={t("color.label")}
                            >
                              <Palette size={14} />
                            </button>
                            {colorMenuFor === m.id && colorMenuAnchor && (
                              <ColorMenu
                                anchor={colorMenuAnchor}
                                current={m.color ?? null}
                                onPick={(c) => void assignColor(m.id, c)}
                                onClose={() => setColorMenuFor(null)}
                                clearLabel={t("color.none")}
                              />
                            )}
                          </div>
                          <div className="mcm-mcard__color">
                            <button
                              type="button"
                              className="mcm-icon-btn mcm-icon-btn--sm"
                              onClick={(e) => {
                                if (emojiMenuFor === m.id) {
                                  setEmojiMenuFor(null);
                                } else {
                                  setColorMenuFor(null);
                                  setEmojiMenuAnchor(
                                    e.currentTarget.getBoundingClientRect(),
                                  );
                                  setEmojiMenuFor(m.id);
                                }
                              }}
                              title="Gán biểu tượng"
                              aria-label="Gán biểu tượng"
                            >
                              <SmilePlus size={14} />
                            </button>
                            {emojiMenuFor === m.id && emojiMenuAnchor && (
                              <EmojiMenu
                                anchor={emojiMenuAnchor}
                                current={m.icon ?? null}
                                onPick={(ic) => void assignIcon(m.id, ic)}
                                onClose={() => setEmojiMenuFor(null)}
                                clearLabel="Bỏ biểu tượng"
                              />
                            )}
                          </div>
                          <button
                            type="button"
                            className="mcm-icon-btn mcm-icon-btn--sm"
                            onClick={() => setDetailRoomId(m.id)}
                            title={t("folder.detail")}
                            aria-label={t("folder.detail")}
                          >
                            <Eye size={14} />
                          </button>
                          {canEditCard(m) && (
                            <button
                              type="button"
                              className="mcm-icon-btn mcm-icon-btn--sm"
                              onClick={() => openMeetingEditor(m)}
                              title={t("folder.editMeeting")}
                              aria-label={t("folder.editMeeting")}
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                        </div>
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* RIGHT — calendar, always visible (drag the left edge to resize) */}
      <div className="mcm-3col__calendar">
        <div
          className="mcm-3col__resize"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          title="Resize"
        />
        <CalendarX
          refreshKey={calRefresh}
          onJoinMeeting={calJoin}
          onOpenMeeting={calOpen}
          onCreateOnDay={calCreate}
        />
      </div>

      {editingProject && (
        <MetadataEditor
          title={t("folder.editProject")}
          fields={buildProjectFields(editingProject)}
          onSave={saveProject}
          onClose={() => setEditingProject(null)}
        />
      )}

      {/* Create with full metadata — POST name then PATCH extras; the
          modal stays open (with everything typed) if the POST fails. */}
      {creatingProject && (
        <MetadataEditor
          title={t("pmgr.createTitle")}
          fields={buildProjectFields(BLANK_PROJECT)}
          onSave={handleCreateProject}
          onClose={() => setCreatingProject(false)}
        />
      )}
    </div>
  );
};

export default ProjectBrowser;
