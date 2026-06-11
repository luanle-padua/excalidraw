import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  LogOut,
  Mic,
  PhoneOff,
  Presentation,
  Settings,
  Share2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import {
  activeRoomLinkAtom,
  chatMessagesAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
  participantsPanelOpenAtom,
} from "../../collab/Collab";
import { showAppToast } from "../../data/appToast";
import { listInvitees } from "../../data/invite";
import { clearLastMeeting } from "../../data/lastMeeting";
import {
  getMeeting,
  registerMeeting,
  saveMeetingAiSummary,
  updateMeeting,
} from "../../data/projects";
import { markReviewRoom } from "../../data/reviewMode";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { transcriptionLogAtom } from "../../data/transcription";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

import { InvitePanel } from "./InvitePanel";
import { LangThemeSwitcher } from "./LangThemeSwitcher";
import { MetadataEditor } from "./MetadataEditor";
import { buildMeetingFields } from "./metadataFields";
import { canManageMeeting, isEditableMeetingStatus } from "./meetingStatus";

const fmt = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

export const MeetingHeader = ({
  participantCount: participantCountProp,
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
  // Real elapsed time of the current meeting session, counted from when we
  // entered the room (wall-clock based, so it stays accurate even if the tab
  // is backgrounded and interval ticks are throttled). Resets on leave.
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
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
    organizerEmail: string | null;
    hostEmail: string | null;
    createdAt: number | null;
    projectName: string | null;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  const roomId = activeRoomLink?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;
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
            organizerEmail: m.organizer_email,
            hostEmail: m.host_email,
            createdAt: m.created_at,
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
    // `status` is intentionally absent — the lifecycle only moves through its
    // actions (Start / End-for-all / Cancel / Restore), never an editor.
    await updateMeeting(roomId, {
      title: values.title,
      topic: values.topic,
      description: values.description,
      type: values.type,
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

  // The meeting clock is OBJECTIVE: it counts from when the HOST started the
  // meeting (the registry `created_at`, shared by all), so late joiners see the
  // SAME elapsed time — not their own per-person count. Falls back to our
  // room-entry time only for an unregistered ad-hoc room with no shared anchor.
  const meetingStartMs =
    typeof meetingInfo?.createdAt === "number" ? meetingInfo.createdAt : null;
  useEffect(() => {
    if (!activeRoomLink) {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const start = meetingStartMs ?? startedAtRef.current;
    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [activeRoomLink, meetingStartMs]);

  // Edit rights: the ORGANIZER owns meeting edits (title/agenda/metadata) —
  // server-enforced; this just hides the affordance from everyone else.
  // Unregistered ad-hoc rooms (no registry row yet) stay editable by any
  // internal user — registering on first save claims them properly. Review
  // mode (finished) never edits.
  const session = useAtomValue(sessionAtom);
  const canEditMeeting =
    canManageMeeting(
      session?.email,
      meetingInfo?.organizerEmail ?? null,
      isInternalEmail(session?.email),
    ) && isEditableMeetingStatus(meetingInfo?.status);

  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const setViewOnly = useSetAtom(meetingViewOnlyAtom);
  const setPanelOpen = useSetAtom(participantsPanelOpenAtom);

  // End-for-all is gated by DESIGNATED role, not the socket election (quyết
  // định 06-11): host / co-host / organizer only. The acting-host rule still
  // governs in-room controls (kick/mute via hostSocketIdAtom elsewhere), but a
  // random internal participant must not be able to end the meeting. Identity
  // = login email; the worker re-enforces the same rule on the PATCH (403).
  const [isCohost, setIsCohost] = useState(false);
  useEffect(() => {
    setIsCohost(false);
    const myEmail = session?.email?.toLowerCase();
    if (!roomId || !myEmail || !isInternalEmail(myEmail)) {
      return;
    }
    let alive = true;
    void listInvitees(roomId).then((invitees) => {
      if (alive) {
        setIsCohost(
          invitees.some(
            (iv) =>
              iv.email === myEmail &&
              iv.role === "cohost" &&
              iv.status !== "revoked",
          ),
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [roomId, session?.email]);

  const myEmail = session?.email?.toLowerCase();
  const canEndMeeting =
    !!myEmail &&
    (meetingInfo?.hostEmail?.toLowerCase() === myEmail ||
      meetingInfo?.organizerEmail?.toLowerCase() === myEmail ||
      isCohost ||
      // Legacy/ad-hoc rooms without a registry identity: keep the old
      // internal-allow so dev rooms can still be ended (worker mirrors this).
      (!meetingInfo?.hostEmail &&
        !meetingInfo?.organizerEmail &&
        isInternalEmail(myEmail)));

  // AI summary-first (quyết định 06-10 #4): when the host ends the meeting,
  // auto-generate a recap from the transcript + chat and store it in D1
  // (meeting.ai_summary) so the detail panel / search can surface it without
  // touching the E2E transcript blob. Strictly fire-and-forget — a Gemini
  // hiccup must never block (or even delay) ending the meeting.
  const chatMessages = useAtomValue(chatMessagesAtom);
  const preferredLang = useAtomValue(preferredLanguageAtom);
  const generateAiSummary = useCallback(
    async (targetRoomId: string) => {
      if (log.length === 0 && chatMessages.length === 0) {
        return; // nothing was said or typed — no recap to make
      }
      const res = await fetch("/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: log.map((s) => ({
            speaker: s.username,
            text: s.text,
            lang: s.lang,
            ts: s.ts,
          })),
          chat: chatMessages.map((m) => ({
            username: m.username,
            text: m.text,
          })),
          language: preferredLang,
        }),
      });
      if (!res.ok) {
        throw new Error(`summarize failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        summary?: string;
        decisions?: string[];
        actionItems?: { owner: string; task: string; due?: string }[];
      };
      // Flatten the structured recap into the single plaintext column the
      // registry stores (summary prose + decisions + action items).
      const parts: string[] = [];
      if (body.summary?.trim()) {
        parts.push(body.summary.trim());
      }
      if (Array.isArray(body.decisions) && body.decisions.length) {
        parts.push(
          `${t("log.sectionDecisions")}:\n${body.decisions
            .map((d) => `• ${d}`)
            .join("\n")}`,
        );
      }
      if (Array.isArray(body.actionItems) && body.actionItems.length) {
        parts.push(
          `${t("log.sectionActionItems")}:\n${body.actionItems
            .map((a) => `• ${a.owner} — ${a.task}${a.due ? ` (${a.due})` : ""}`)
            .join("\n")}`,
        );
      }
      const text = parts.join("\n\n").trim();
      if (text) {
        await saveMeetingAiSummary(targetRoomId, text);
      }
    },
    [log, chatMessages, preferredLang, t],
  );

  // Share = copy the live room link. Same clipboard fallback as InvitePanel:
  // the async clipboard API can be unavailable (insecure context / permission
  // denied), in which case a prompt lets the user copy manually.
  const handleShare = useCallback(async () => {
    if (!activeRoomLink) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activeRoomLink);
    } catch {
      window.prompt(t("header.share"), activeRoomLink);
    }
    excalidrawAPI?.setToast({ message: t("header.shareCopied") });
  }, [activeRoomLink, excalidrawAPI, t]);

  const handleEndMeeting = useCallback(async () => {
    if (!roomId || !canEndMeeting) {
      return;
    }
    if (!window.confirm(t("header.endConfirm"))) {
      return;
    }
    // Mark the meeting finished in the registry FIRST (so reopen = read-only
    // review). If the write fails, abort before any local/broadcast side
    // effects — nothing changes, the host can simply retry.
    const ok = await updateMeeting(roomId, { status: "finished" });
    if (!ok) {
      showAppToast(t("errors.endMeetingFailed"));
      return;
    }
    // …kick off the AI recap in the background (never blocks the ending)…
    void generateAiSummary(roomId).catch((error) => {
      console.warn("AI summary generation failed (non-blocking):", error);
    });
    // …drop our own "Resume" pointer right away — a finished meeting must
    // never be offered for resume, and the lobby's status re-check shouldn't
    // be the only line of defense on the ender's own browser…
    clearLastMeeting();
    // …tell everyone in the room to switch to review…
    collabAPI?.portal?.broadcastHostCommand({ action: "END_MEETING" });
    // …and switch ourselves too.
    markReviewRoom(roomId);
    setViewOnly(true);
  }, [roomId, canEndMeeting, collabAPI, setViewOnly, generateAiSummary, t]);

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

      {/* Editing is an ORGANIZER affordance (and never in read-only review) —
          everyone else just sees the title as static text. */}
      <button
        type="button"
        className="mcm-header__title"
        onClick={() => canEditMeeting && !viewOnly && setEditing(true)}
        disabled={!canEditMeeting || viewOnly}
        aria-label={t("header.meetingMenu")}
        title={
          canEditMeeting && !viewOnly ? t("header.editMeetingTitle") : undefined
        }
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
        {canEditMeeting && !viewOnly && <ChevronDown size={18} />}
      </button>

      <div className="mcm-header__stat" title="Recording">
        <span className="mcm-header__stat-dot" />
        <span>{fmt(elapsed)}</span>
      </div>

      <button
        type="button"
        className="mcm-header__stat mcm-header__stat--btn"
        onClick={() => activeRoomLink && setPanelOpen(true)}
        disabled={!activeRoomLink}
        title={
          activeRoomLink
            ? t("participants.panelTitle")
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
      </button>

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
          onClick={() => void handleShare()}
          disabled={!activeRoomLink}
          title={t("header.share")}
        >
          <Share2 size={18} />
          {t("header.share")}
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
        {/* No inviting into a finished meeting — the worker 409s it anyway;
            don't offer a doomed panel in review. */}
        {!viewOnly && (
          <button
            type="button"
            className="mcm-header__btn mcm-header__btn--primary"
            onClick={() => setInviteOpen(true)}
            title={t("header.invite")}
          >
            <UserPlus size={18} />
            {t("header.invite")}
          </button>
        )}
        {canEndMeeting && !viewOnly && (
          <button
            type="button"
            className="mcm-header__btn mcm-header__btn--danger"
            onClick={() => void handleEndMeeting()}
            title={t("header.endMeeting")}
          >
            <PhoneOff size={18} />
            {t("header.endMeeting")}
          </button>
        )}
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
      {inviteOpen && roomId && (
        <InvitePanel
          roomId={roomId}
          roomKey={roomKey}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </header>
  );
};

export default MeetingHeader;
