import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Mic,
  MoreHorizontal,
  Presentation,
  Settings,
  Share2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";

import { useAtomValue } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import { activeRoomLinkAtom, collabAPIAtom } from "../../collab/Collab";
import { getMeeting, registerMeeting, updateMeeting } from "../../data/projects";
import { transcriptionLogAtom } from "../../data/transcription";
import { useT } from "../../i18n/mcm";

import { LangThemeSwitcher } from "./LangThemeSwitcher";
import { MetadataEditor } from "./MetadataEditor";
import { buildMeetingFields } from "./metadataFields";
import { MOCK_MEETING_DURATION_S } from "./meetingMock";

const fmt = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

export const MeetingHeader = ({
  participantCount: participantCountProp,
  onInvite,
  onLeave,
  onOpenLog,
  onOpenProfile,
  onOpenFolder,
  onPresent,
  isPresenting,
  presentDisabled,
}: {
  /** Fallback head-count when there's no live collab room (preview /
   *  storybook). Real call counts come from the collab atom + Excalidraw
   *  collaborators map. */
  participantCount?: number;
  onInvite?: () => void;
  onLeave?: () => void;
  onOpenLog?: () => void;
  /** Opens the project folder (switch project / reopen / new meeting).
   *  Host-only: MeetingShell passes it only when the local user is the
   *  meeting host, so the button is absent for everyone else. */
  onOpenFolder?: () => void;
  /** Opens the user-profile modal (name + company + avatar editor).
   *  Wired into the gear icon — same affordance as Zoom / Meet's
   *  account-settings entry point. */
  onOpenProfile?: () => void;
  /** Toggle screen sharing. When someone else is presenting this is passed
   *  with `presentDisabled` true so the button locks (single-sharer). */
  onPresent?: () => void;
  /** true while WE are the active presenter (button shows the active state). */
  isPresenting?: boolean;
  /** true in read-only review OR while another participant is presenting. */
  presentDisabled?: boolean;
}) => {
  const t = useT();
  const [elapsed, setElapsed] = useState(MOCK_MEETING_DURATION_S);
  const log = useAtomValue(transcriptionLogAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const audioState = useAtomValue(audioStateAtom);
  const excalidrawAPI = useExcalidrawAPI();

  // Real meeting title + project name (from the storage registry) — NOT
  // a mock. Re-fetched whenever the active room changes or we edit it.
  const [meetingInfo, setMeetingInfo] = useState<{
    title: string | null;
    topic: string | null;
    description: string | null;
    type: string | null;
    status: string | null;
    discipline: string | null;
    priority: string | null;
    confidentiality: string | null;
    scheduled_at: string | null;
    projectName: string | null;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  const roomId =
    activeRoomLink?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;
  const roomKey =
    activeRoomLink?.match(/#room=[^,]+,([a-zA-Z0-9_-]+)/)?.[1] ?? undefined;

  const refetchMeeting = useCallback(async () => {
    if (!roomId) {
      setMeetingInfo(null);
      return;
    }
    const m = await getMeeting(roomId);
    setMeetingInfo(
      m
        ? {
            title: m.title,
            topic: m.topic,
            description: m.description,
            type: m.type,
            status: m.status,
            discipline: m.discipline,
            priority: m.priority,
            confidentiality: m.confidentiality,
            scheduled_at: m.scheduled_at,
            projectName: m.project_name,
          }
        : null,
    );
  }, [roomId]);

  useEffect(() => {
    void refetchMeeting();
  }, [refetchMeeting]);

  const saveMeeting = async (values: Record<string, string>) => {
    if (!roomId) {
      return;
    }
    // Register the meeting first if it isn't in the registry yet (e.g. an
    // ad-hoc room edited before its first scene auto-save).
    if (!meetingInfo) {
      await registerMeeting({ roomId, roomKey, title: values.title });
    }
    await updateMeeting(roomId, {
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
    setEditing(false);
    await refetchMeeting();
  };

  // Mirror the participant tracking pattern from ParticipantsBar:
  // subscribe to Excalidraw's onChange so we re-render when peers
  // join/leave the collab room. Cheap referential gate.
  const [collaborators, setCollaborators] = useState<
    ReadonlyMap<SocketId, Collaborator>
  >(() => new Map());

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    setCollaborators(excalidrawAPI.getAppState().collaborators);
    const unsub = excalidrawAPI.onChange((_elements, appState) => {
      setCollaborators((prev) =>
        prev === appState.collaborators ? prev : appState.collaborators,
      );
    });
    return unsub;
  }, [excalidrawAPI]);

  // Real count: collaborators map already includes self when in a
  // room (Excalidraw stamps `isCurrentUser` on the entry). When the
  // user hasn't joined a collab room yet, fall back to the prop
  // (used for the design preview / storybook).
  const selfSocketId = collabAPI?.portal.socket?.id;
  const realCount = activeRoomLink
    ? collaborators.size +
      (selfSocketId && collaborators.has(selfSocketId as SocketId) ? 0 : 1)
    : participantCountProp ?? 0;
  const inCallCount =
    audioState.status === "live" ? audioState.peers.size + 1 : 0;

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="mcm-header">
      <div className="mcm-header__brand">
        <div className="mcm-header__brand-mark">M</div>
        <div className="mcm-header__brand-name">
          <strong>MAP CANVAS MEET</strong>
          <span>(MCM)</span>
        </div>
      </div>

      <div className="mcm-header__divider" />

      <button
        type="button"
        className="mcm-header__title"
        onClick={() => setEditing(true)}
        aria-label={t("header.meetingMenu")}
        title={t("header.editMeetingTitle")}
      >
        <span className="mcm-header__title-stack">
          {meetingInfo?.projectName && (
            <span className="mcm-header__project">
              {meetingInfo.projectName}
            </span>
          )}
          <span className="mcm-header__meeting-name">
            {meetingInfo?.title || t("header.untitledMeeting")}
          </span>
        </span>
        <ChevronDown size={18} />
      </button>

      <div className="mcm-header__stat" title="Recording">
        <span className="mcm-header__stat-dot" />
        <span>{fmt(elapsed)}</span>
      </div>

      <div
        className="mcm-header__stat"
        title={
          activeRoomLink
            ? inCallCount > 0
              ? t("header.participantsInCallWith", {
                  count: realCount,
                  inCall: inCallCount,
                })
              : t("header.participantsInCall", { count: realCount })
            : t("header.previewNotInRoom")
        }
      >
        <Users size={18} />
        <span>
          {realCount === 1
            ? t("header.participantSingular", { count: realCount })
            : t("header.participantCount", { count: realCount })}
          {inCallCount > 0 && (
            <span className="mcm-header__stat-sub">
              {" · "}
              <Mic size={12} /> {inCallCount}
            </span>
          )}
        </span>
      </div>

      <div className="mcm-header__actions">
        {onOpenFolder && (
          <button
            type="button"
            className="mcm-header__btn mcm-header__btn--ghost"
            onClick={onOpenFolder}
            title={t("header.projects")}
          >
            <FolderOpen size={18} />
            {t("header.projects")}
          </button>
        )}
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--ghost"
          onClick={onOpenLog}
          title={t("header.transcript")}
        >
          <FileText size={18} />
          {t("header.transcript")}
          {log.length > 0 && (
            <span className="mcm-header__btn-count">{log.length}</span>
          )}
        </button>
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--ghost"
          title={t("header.share")}
        >
          <Share2 size={18} />
          {t("header.share")}
        </button>
        <button
          type="button"
          className="mcm-header__icon-btn"
          title={t("header.layout")}
        >
          <LayoutGrid size={18} />
        </button>
        <button
          type="button"
          className={`mcm-header__icon-btn${
            isPresenting ? " mcm-header__icon-btn--active" : ""
          }`}
          title={t("header.present")}
          aria-label={t("header.present")}
          onClick={onPresent}
          disabled={presentDisabled && !isPresenting}
        >
          <Presentation size={18} />
        </button>
        <LangThemeSwitcher />
        <button
          type="button"
          className="mcm-header__icon-btn"
          title={t("profile.openSettings")}
          onClick={onOpenProfile}
          aria-label={t("profile.openSettings")}
        >
          <Settings size={18} />
        </button>
        <button
          type="button"
          className="mcm-header__icon-btn"
          title={t("header.more")}
        >
          <MoreHorizontal size={18} />
        </button>
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--primary"
          onClick={onInvite}
        >
          <UserPlus size={18} />
          {t("header.invite")}
        </button>
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--ghost"
          onClick={onLeave}
        >
          <LogOut size={18} />
          {t("header.leave")}
        </button>
      </div>

      {editing && roomId && (
        <MetadataEditor
          title={t("folder.editMeeting")}
          fields={buildMeetingFields(meetingInfo ?? {})}
          onSave={saveMeeting}
          onClose={() => setEditing(false)}
        />
      )}
    </header>
  );
};

export default MeetingHeader;
