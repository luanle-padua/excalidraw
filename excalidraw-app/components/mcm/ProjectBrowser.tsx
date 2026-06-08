import { Clock, Image as ImageIcon, Pencil, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
} from "../../data";
import {
  createProject,
  getMeeting,
  listMeetings,
  listProjects,
  registerMeeting,
  updateMeeting,
  updateProject,
} from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { InvitedMeetings } from "./InvitedMeetings";
import { MetadataEditor } from "./MetadataEditor";
import { buildMeetingFields, buildProjectFields } from "./metadataFields";

import type { MeetingSummary, Project } from "../../data/projects";
import type { MeetingFieldsInput } from "./metadataFields";

type MeetingDraft = { id: string } & MeetingFieldsInput;

const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString() : "—";

const fmtDuration = (s: number): string => {
  const m = Math.round(s / 60);
  return m < 60
    ? `${m}m`
    : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

/**
 * Project-first browser: projects on the left, the selected project's
 * meetings on the right. Shared by the lobby home (inline) and the
 * in-canvas folder modal (ProjectFolder).
 *
 * Projects and meetings can be renamed + given metadata (project stage /
 * description, meeting topic / description) via a shared MetadataEditor —
 * the field set is the only thing that grows as more metadata accrues.
 *
 * `onEntered` fires after a room is joined/created so a wrapping modal
 * can close itself (the lobby auto-hides via isCollaborating).
 */
export const ProjectBrowser = ({ onEntered }: { onEntered?: () => void }) => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const session = useAtomValue(sessionAtom);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [loadingMeetings, setLoadingMeetings] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingMeeting, setEditingMeeting] = useState<MeetingDraft | null>(
    null,
  );

  const refreshProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    setSelectedId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  const refreshMeetings = useCallback(async () => {
    if (!selectedId) {
      setMeetings([]);
      return;
    }
    setLoadingMeetings(true);
    try {
      setMeetings(await listMeetings(selectedId));
    } finally {
      setLoadingMeetings(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void refreshMeetings();
  }, [refreshMeetings]);

  if (!collabAPI) {
    return null;
  }

  const createdBy = session?.name || collabAPI.getUsername() || undefined;
  const selectedProject = projects.find((p) => p.id === selectedId) ?? null;

  const enterRoom = async (
    roomId: string,
    roomKey: string,
    // Reopening a past meeting from the folder = REVIEW (read-only,
    // immutable, extract-only). Creating a new meeting = editable.
    viewOnly = false,
  ) => {
    // If the folder was opened from INSIDE a live meeting, tear that down
    // first. Otherwise startCollaboration early-returns (`if portal.socket
    // return null`) and the room never actually switches — leaving the
    // review/edit state set for a room we never entered (the sticky /
    // inverted view-mode bug). stopCollaboration saves the old scene, then
    // resets the canvas + review state before we join the new room.
    if (collabAPI.isCollaborating()) {
      collabAPI.stopCollaboration(false);
    }
    window.history.pushState({}, "", getCollaborationLink({ roomId, roomKey }));
    await collabAPI.startCollaboration({ roomId, roomKey }, { viewOnly });
    onEntered?.();
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
        setSelectedId(project.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleNewMeeting = async () => {
    if (!selectedId || busy) {
      return;
    }
    setBusy(true);
    try {
      const { roomId, roomKey } = await generateCollaborationLinkData();
      await registerMeeting({
        roomId,
        roomKey,
        projectId: selectedId,
        title: t("folder.newMeetingDefaultTitle"),
        createdBy,
      });
      await enterRoom(roomId, roomKey);
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
        // Review (read-only) ONLY for FINISHED meetings. An in-progress /
        // scheduled meeting reopened from the folder is still editable —
        // you're rejoining live work, not reviewing a closed record.
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
    await refreshMeetings();
  };

  return (
    <div className="mcm-folder__body mcm-browser">
      {/* Left: projects */}
      <aside className="mcm-folder__projects">
        <InvitedMeetings />
        <ul className="mcm-folder__project-list">
          {projects.length === 0 && (
            <li className="mcm-folder__empty">{t("folder.empty")}</li>
          )}
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`mcm-folder__project${
                  p.id === selectedId ? " mcm-folder__project--active" : ""
                }`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="mcm-folder__project-name">{p.name}</span>
                {p.stage && (
                  <span className="mcm-folder__project-stage">{p.stage}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="mcm-folder__new-project">
          <input
            type="text"
            className="mcm-folder__input"
            placeholder={t("folder.projectNamePlaceholder")}
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handleCreateProject();
              }
            }}
          />
          <button
            type="button"
            className="mcm-folder__create"
            onClick={handleCreateProject}
            disabled={busy || !newProjectName.trim()}
          >
            {t("folder.create")}
          </button>
        </div>
      </aside>

      {/* Right: meetings in the selected project */}
      <section className="mcm-folder__meetings">
        {!selectedProject ? (
          <div className="mcm-folder__hint">{t("folder.selectProject")}</div>
        ) : (
          <>
            {selectedProject.cover && (
              <div className="mcm-folder__cover">
                <img src={selectedProject.cover} alt="" draggable={false} />
              </div>
            )}
            <div className="mcm-folder__meetings-head">
              <div className="mcm-folder__headline">
                <span className="mcm-folder__meetings-title">
                  {selectedProject.name}
                </span>
                {selectedProject.stage && (
                  <span className="mcm-folder__stage">
                    {selectedProject.stage}
                  </span>
                )}
                <button
                  type="button"
                  className="mcm-folder__edit"
                  onClick={() => setEditingProject(selectedProject)}
                  title={t("folder.editProject")}
                  aria-label={t("folder.editProject")}
                >
                  <Pencil size={14} />
                </button>
              </div>
              <button
                type="button"
                className="mcm-folder__new-meeting"
                onClick={handleNewMeeting}
                disabled={busy}
              >
                {t("folder.newMeetingInProject")}
              </button>
            </div>
            {selectedProject.description && (
              <p className="mcm-folder__project-desc">
                {selectedProject.description}
              </p>
            )}
            {loadingMeetings ? (
              <div className="mcm-folder__hint">…</div>
            ) : meetings.length === 0 ? (
              <div className="mcm-folder__hint">{t("folder.noMeetings")}</div>
            ) : (
              <ul className="mcm-folder__meeting-grid">
                {meetings.map((m) => (
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
                        {(m.type || m.status) && (
                          <span className="mcm-folder__card-chips">
                            {m.type && (
                              <span className="mcm-folder__card-type">
                                {m.type}
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
                    <button
                      type="button"
                      className="mcm-folder__edit mcm-folder__card-edit"
                      onClick={() => void openMeetingEditor(m)}
                      title={t("folder.editMeeting")}
                      aria-label={t("folder.editMeeting")}
                    >
                      <Pencil size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

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
