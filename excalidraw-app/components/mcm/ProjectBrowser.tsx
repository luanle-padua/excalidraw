import {
  Clock,
  Eye,
  Image as ImageIcon,
  Pencil,
  Plus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
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
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { CalendarX } from "./CalendarX";
import { MeetingDetailPreview } from "./MeetingDetailPreview";
import { MetadataEditor } from "./MetadataEditor";
import { ScheduleMeetingForm } from "./ScheduleMeetingForm";
import { buildMeetingFields, buildProjectFields } from "./metadataFields";

import type { MeetingSummary, Project } from "../../data/projects";
import type { MeetingFieldsInput } from "./metadataFields";

type MeetingDraft = { id: string } & MeetingFieldsInput;

// "all" = my whole calendar · "invited" = invitations · else a project id.
type View = "all" | "invited" | string;

const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString() : "—";

const fmtDuration = (s: number): string => {
  const m = Math.round(s / 60);
  return m < 60
    ? `${m}m`
    : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

// Adapt the calendar/invite shapes to the card grid's MeetingSummary so the
// middle column renders the same card for every context.
const calToSummary = (c: CalMeeting): MeetingSummary => ({
  id: c.id,
  title: c.title,
  topic: null,
  type: null,
  status: c.status,
  created_by: c.created_by,
  thumbnail: null,
  participant_count: null,
  duration_s: null,
  scene_updated_at: null,
  updated_at: c.created_at,
  last_opened_at: null,
  scheduled_at: c.scheduled_at,
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
  const [editingMeeting, setEditingMeeting] = useState<MeetingDraft | null>(
    null,
  );
  const [detailRoomId, setDetailRoomId] = useState<string | null>(null);
  const [meetingFormOpen, setMeetingFormOpen] = useState<
    "now" | "schedule" | null
  >(null);
  const [formDefaultWhen, setFormDefaultWhen] = useState<string | undefined>();
  // Calendar column width: null = equal 50/50 split (default); a number = px
  // once the user drags the divider.
  const [calWidth, setCalWidth] = useState<number | null>(null);

  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  // Load the middle column for the current context.
  const refreshCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      if (view === "all") {
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

  const selectedProject =
    view === "all" || view === "invited"
      ? null
      : projects.find((p) => p.id === view) ?? null;
  // The project a new meeting attaches to (the open one, else the first).
  const targetProject = selectedProject ?? projects[0] ?? null;

  const contextLabel = selectedProject
    ? selectedProject.name
    : view === "invited"
    ? t("invited.title")
    : t("cal.upcoming");

  const enterRoom = async (roomId: string, roomKey: string, viewOnly = false) => {
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
      return;
    }
    const finished = m.status === "Completed" || m.status === "Cancelled";
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
      setCalWidth(Math.max(300, Math.min(760, window.innerWidth - ev.clientX)));
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
      const project = await createProject(name, session?.email);
      setNewProjectName("");
      await refreshProjects();
      if (project) {
        setView(project.id);
      }
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
        const finished =
          meeting.status === "Completed" || meeting.status === "Cancelled";
        await enterRoom(m.id, meeting.room_key, finished);
      }
    } finally {
      setBusy(false);
    }
  };

  const openMeetingEditor = async (m: MeetingSummary) => {
    const full = await getMeeting(m.id);
    setEditingMeeting({
      id: m.id,
      title: full?.title ?? m.title ?? "",
      topic: full?.topic ?? m.topic ?? "",
      description: full?.description ?? "",
      type: full?.type ?? m.type ?? "",
      status: full?.status ?? m.status ?? "",
      discipline: full?.discipline ?? "",
      priority: full?.priority ?? "",
      confidentiality: full?.confidentiality ?? "",
      scheduled_at: full?.scheduled_at ?? "",
    });
  };

  const saveProject = async (values: Record<string, string>) => {
    if (!editingProject) {
      return;
    }
    await updateProject(editingProject.id, {
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
    setEditingProject(null);
    await refreshProjects();
  };

  const saveMeeting = async (values: Record<string, string>) => {
    if (!editingMeeting) {
      return;
    }
    await updateMeeting(editingMeeting.id, {
      title: values.title,
      topic: values.topic,
      description: values.description,
      type: values.type,
      status: values.status,
      discipline: values.discipline,
      priority: values.priority,
      confidentiality: values.confidentiality,
      scheduled_at: values.scheduled_at,
    });
    setEditingMeeting(null);
    await refreshCards();
  };

  const navItem = (key: View, label: string) => (
    <button
      type="button"
      className={`mcm-nav__item${view === key ? " mcm-nav__item--active" : ""}`}
      onClick={() => {
        setView(key);
        setDetailRoomId(null);
        setMeetingFormOpen(null);
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
                  }}
                >
                  <span className="mcm-nav__item-label">{p.name}</span>
                  {p.stage && (
                    <span className="mcm-nav__item-stage">{p.stage}</span>
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
          <h2 className="mcm-3col__middle-title">{contextLabel}</h2>
          {selectedProject && (
            <button
              type="button"
              className="mcm-folder__edit"
              onClick={() => setEditingProject(selectedProject)}
              title={t("folder.editProject")}
              aria-label={t("folder.editProject")}
            >
              <Pencil size={14} />
            </button>
          )}
          {view !== "invited" && targetProject && !detailRoomId && (
            <button
              type="button"
              className="mcm-3col__new-meeting"
              onClick={() => setMeetingFormOpen("now")}
              disabled={busy}
            >
              <Plus size={15} /> {t("folder.newMeetingInProject")}
            </button>
          )}
        </div>

        <div className="mcm-3col__middle-body mcm-scroll">
          {detailRoomId ? (
            <MeetingDetailPreview
              roomId={detailRoomId}
              onClose={() => setDetailRoomId(null)}
              onEdit={() => {
                const m = cards.find((x) => x.id === detailRoomId);
                setDetailRoomId(null);
                if (m) {
                  void openMeetingEditor(m);
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
            <ul className="mcm-3col__grid">
              {cards.map((m) => (
                <li key={m.id} className="mcm-folder__card">
                  <button
                    type="button"
                    className="mcm-folder__card-btn"
                    onClick={() => handleReopen(m)}
                    disabled={busy}
                    title={t("folder.reopen")}
                  >
                    <div className="mcm-folder__thumb">
                      {m.thumbnail ? (
                        <img src={m.thumbnail} alt="" draggable={false} />
                      ) : (
                        <ImageIcon
                          className="mcm-folder__thumb-glyph"
                          size={26}
                        />
                      )}
                    </div>
                    <div className="mcm-folder__card-meta">
                      <span className="mcm-folder__card-title">
                        {m.title || t("folder.meetingFallbackTitle")}
                      </span>
                      {(m.type || m.status || m.discipline) && (
                        <span className="mcm-folder__card-chips">
                          {m.type && (
                            <span className="mcm-folder__card-type">
                              {m.type}
                            </span>
                          )}
                          {m.discipline && (
                            <span className="mcm-folder__card-type mcm-folder__card-type--alt">
                              {m.discipline}
                            </span>
                          )}
                          {m.status && (
                            <span
                              className={`mcm-folder__card-status mcm-folder__card-status--${m.status
                                .replace(/\s+/g, "-")
                                .toLowerCase()}`}
                            >
                              {m.status}
                            </span>
                          )}
                        </span>
                      )}
                      {m.topic && (
                        <span className="mcm-folder__card-topic">
                          {m.topic}
                        </span>
                      )}
                      <span className="mcm-folder__card-date">
                        {fmtDate(m.scene_updated_at ?? m.updated_at)}
                      </span>
                      {(m.participant_count != null ||
                        m.duration_s != null) && (
                        <span className="mcm-folder__card-stats">
                          {m.participant_count != null && (
                            <span>
                              <Users size={12} /> {m.participant_count}
                            </span>
                          )}
                          {m.duration_s != null && (
                            <span>
                              <Clock size={12} /> {fmtDuration(m.duration_s)}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="mcm-folder__card-actions">
                    <button
                      type="button"
                      className="mcm-folder__card-act"
                      onClick={() => setDetailRoomId(m.id)}
                      title={t("folder.detail")}
                      aria-label={t("folder.detail")}
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      type="button"
                      className="mcm-folder__card-act"
                      onClick={() => void openMeetingEditor(m)}
                      title={t("folder.editMeeting")}
                      aria-label={t("folder.editMeeting")}
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                </li>
              ))}
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
      {editingMeeting && (
        <MetadataEditor
          title={t("folder.editMeeting")}
          fields={buildMeetingFields(editingMeeting)}
          onSave={saveMeeting}
          onClose={() => setEditingMeeting(null)}
        />
      )}
    </div>
  );
};

export default ProjectBrowser;
