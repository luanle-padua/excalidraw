import {
  ArrowUpDown,
  Check,
  Eye,
  FolderHeart,
  LayoutGrid,
  List as ListIcon,
  Palette,
  Pencil,
  Plus,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { showAppToast } from "../../data/appToast";
import { getMyMeetings, type CalMeeting } from "../../data/calendar";
import { getMyInvitations, type MyInvitation } from "../../data/invite";
import {
  createProject,
  getMeeting,
  listMeetings,
  listProjects,
  updateMeeting,
  updateProject,
} from "../../data/projects";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { CalendarX } from "./CalendarX";
import { EditMeetingForm } from "./EditMeetingForm";
import { MeetingDetailPreview } from "./MeetingDetailPreview";
import {
  MEETING_COLOR_PRESETS,
  meetingColor,
  personColor,
  statusBucket,
} from "./meetingColors";
import {
  canManageMeeting,
  isEditableMeetingStatus,
  isFinishedStatus,
  meetingStatusLabel,
} from "./meetingStatus";
import { MetadataEditor } from "./MetadataEditor";
import { MyFilesPanel } from "./MyFilesPanel";
import { ScheduleMeetingForm } from "./ScheduleMeetingForm";
import { buildProjectFields } from "./metadataFields";

import type { MeetingSummary, Project } from "../../data/projects";

// "all" = my whole calendar · "invited" = invitations · "myfiles" = the
// personal document shelf (internal only) · else a project id.
type View = "all" | "invited" | "myfiles" | string;

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
  project_name: c.project_name,
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
  const [view, setView] = useState<View>("all");
  const [cards, setCards] = useState<MeetingSummary[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
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
  // The card whose colour-swatch menu is open (one at a time), by room id.
  const [colorMenuFor, setColorMenuFor] = useState<string | null>(null);
  const [colorMenuAnchor, setColorMenuAnchor] = useState<DOMRect | null>(null);
  // Bumped on any meeting change so the calendar (which self-fetches) re-pulls
  // and its event colours stay in sync with the cards.
  const [calRefresh, setCalRefresh] = useState(0);

  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  // Load the middle column for the current context.
  const refreshCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      if (view === "myfiles") {
        // The shelf panel self-fetches — no meeting cards in this view.
        setCards([]);
      } else if (view === "all") {
        setCards((await getMyMeetings()).map(calToSummary));
      } else if (view === "invited") {
        setCards((await getMyInvitations()).map(invToSummary));
      } else {
        setCards(await listMeetings(view));
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
    view === "all" || view === "invited" || view === "myfiles"
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

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || busy) {
      return;
    }
    setBusy(true);
    try {
      const project = await createProject(name);
      if (!project) {
        // Keep the typed name so the user can just retry.
        showAppToast(t("errors.createProjectFailed"));
        return;
      }
      setNewProjectName("");
      await refreshProjects();
      setView(project.id);
    } finally {
      setBusy(false);
    }
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

  // Assign (or clear) a meeting's colour, then refresh so the card stripe and
  // the calendar event (which reads meeting.color) update together.
  const assignColor = async (id: string, color: string | null) => {
    setColorMenuFor(null);
    const ok = await updateMeeting(id, { color });
    if (!ok) {
      showAppToast(t("errors.colorFailed"));
      return;
    }
    await refreshCards();
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

  const navItem = (key: View, label: string) => (
    <button
      type="button"
      className={`mcm-nav__item${view === key ? " mcm-nav__item--active" : ""}`}
      onClick={() => {
        setView(key);
        setDetailRoomId(null);
        setMeetingFormOpen(null);
        setEditRoomId(null);
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
          {navItem("all", t("cal.title"))}
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
                setDetailRoomId(null);
                setMeetingFormOpen(null);
                setEditRoomId(null);
              }}
            >
              <FolderHeart size={14} className="mcm-nav__item-icon" />
              <span className="mcm-nav__item-label">{t("myfiles.title")}</span>
            </button>
          )}
        </div>
        <div className="mcm-nav__section">
          <h3 className="mcm-nav__section-label">{t("header.projects")}</h3>
          <ul className="mcm-nav__items">
            {projects.length === 0 && (
              <li className="mcm-nav__empty">{t("folder.empty")}</li>
            )}
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`mcm-nav__item${
                    view === p.id ? " mcm-nav__item--active" : ""
                  }`}
                  onClick={() => {
                    setView(p.id);
                    setDetailRoomId(null);
                    setMeetingFormOpen(null);
                    setEditRoomId(null);
                  }}
                >
                  <span className="mcm-nav__item-label">{p.name}</span>
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
        <div className="mcm-nav__footer">
          <input
            type="text"
            className="mcm-nav__input"
            placeholder={t("folder.projectNamePlaceholder")}
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleCreateProject()}
          />
          <button
            type="button"
            className="mcm-nav__create"
            onClick={handleCreateProject}
            disabled={busy || !newProjectName.trim()}
          >
            {t("folder.create")}
          </button>
        </div>
      </aside>

      {/* MIDDLE — context meetings, or the inline detail / create form */}
      <section className="mcm-3col__middle">
        <div className="mcm-3col__middle-head">
          <div className="mcm-3col__middle-titlebox">
            <h2 className="mcm-3col__middle-title">{contextLabel}</h2>
            {/* Edit only for the project HOST (or an admin) — the Worker
                rejects the PATCH for anyone else, so don't offer a button
                that "saves" into a 403. Legacy projects with a null
                host_email: only admins can edit (accepted trade-off). */}
            {selectedProject &&
              (selectedProject.host_email?.toLowerCase() ===
                session?.email?.toLowerCase() ||
                session?.isAdmin) && (
                <button
                  type="button"
                  className="mcm-icon-btn mcm-icon-btn--sm"
                  onClick={() => setEditingProject(selectedProject)}
                  title={t("folder.editProject")}
                  aria-label={t("folder.editProject")}
                >
                  <Pencil size={14} />
                </button>
              )}
          </div>
          {/* Toolbar — view toggle + sort. Only meaningful on the card list,
              so it hides while a detail/create/edit form occupies the column. */}
          {view !== "myfiles" &&
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
              </div>
            )}
          {view !== "invited" &&
            view !== "myfiles" &&
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
          ) : cards.length === 0 ? (
            <div className="mcm-3col__hint">{t("folder.noMeetings")}</div>
          ) : (
            <ul
              className={`mcm-mcards mcm-mcards--${viewMode}`}
              data-sort={sortBy}
            >
              {sortedCards.map((m, idx) => {
                const when = meetingWhenMs(m);
                const stripe = meetingColor(m.color, m.status);
                const projectName = selectedProject?.name ?? m.project_name;
                // "By time" groups by DAY: emit a separator whenever this
                // card's day differs from the previous card's.
                const daySep =
                  sortBy === "time" &&
                  (idx === 0 ||
                    dayKeyOf(meetingWhenMs(sortedCards[idx - 1])) !==
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
                      <span className="mcm-mcard__stripe" aria-hidden="true" />
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
                              {m.created_by || m.organizer_email!.split("@")[0]}
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
                          {projectName && (
                            <span className="mcm-mcard__project">
                              {projectName}
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
    </div>
  );
};

/**
 * Small colour picker popover for a meeting card — a row of preset swatches
 * plus a "none" option that clears the colour back to the status default.
 * Closes on outside-click / Esc.
 */
const ColorMenu = ({
  anchor,
  current,
  onPick,
  onClose,
  clearLabel,
}: {
  anchor: DOMRect;
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
  clearLabel: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Render in a portal positioned just under the trigger so the scroll
  // container can't clip it (the "underlay" bug). Clamp to the viewport.
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 80);
  const left = Math.max(
    8,
    Math.min(anchor.right - 224, window.innerWidth - 232),
  );

  return createPortal(
    <div
      className="mcm-swatches mcm-swatches--pop"
      ref={ref}
      style={{ position: "fixed", top, left } as React.CSSProperties}
    >
      {MEETING_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          className={`mcm-swatches__dot${
            current?.toLowerCase() === c.toLowerCase()
              ? " mcm-swatches__dot--active"
              : ""
          }`}
          style={{ ["--swatch" as string]: c } as React.CSSProperties}
          onClick={() => onPick(c)}
          aria-label={c}
          title={c}
        >
          {current?.toLowerCase() === c.toLowerCase() && <Check size={12} />}
        </button>
      ))}
      <button
        type="button"
        className="mcm-swatches__clear"
        onClick={() => onPick(null)}
        title={clearLabel}
      >
        {clearLabel}
      </button>
    </div>,
    // Portal into .mcm-shell (NOT document.body) so the --mcm-* design tokens —
    // surface/hairline/elev/dark-mode — resolve; on body they'd be undefined and
    // the popover would render with no background.
    document.querySelector(".mcm-shell") ?? document.body,
  );
};

export default ProjectBrowser;
