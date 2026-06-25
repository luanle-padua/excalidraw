import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  Captions,
  ChevronDown,
  Clock3,
  FileText,
  Files,
  FolderOpen,
  History,
  LogOut,
  Mic,
  Power,
  ScreenShare,
  Settings,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";

import { useAtom, useAtomValue, useSetAtom } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import {
  activeRoomLinkAtom,
  chatMessagesAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
  participantsPanelOpenAtom,
} from "../../collab/Collab";
import { showAppToast } from "../../data/appToast";
import { collectCanvasText } from "../../data/canvasText";
import {
  captionDockEnabledAtom,
  setCaptionDockEnabled,
} from "../../data/captionState";
import { listInvitees } from "../../data/invite";
import { clearLastMeeting } from "../../data/lastMeeting";
import { aiBackendUrl } from "../../data/aiBackend";
import { fetchWithAuth } from "../../data/fetchWithAuth";
import {
  postMeetingEvents,
  type MeetingEventInput,
} from "../../data/meetingEventLog";
import {
  getMeeting,
  registerMeeting,
  saveMeetingAiSummary,
  updateMeeting,
} from "../../data/projects";
import { markReviewRoom } from "../../data/reviewMode";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { meetingViewerAuthorityAtom } from "../../data/userProfile";
import { transcriptionLogAtom } from "../../data/transcription";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

import { CanvasReplayPlayer } from "./CanvasReplayPlayer";
import { InvitePanel } from "./InvitePanel";
import { LangThemeSwitcher } from "./LangThemeSwitcher";
import { LayoutSwitcher } from "./LayoutSwitcher";
import { MeetingCallControls } from "./MeetingCallControls";
import { RecordingIndicator } from "./RecordingIndicator";
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
  presentTitle,
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
  /** Overrides the Present button tooltip — used to explain WHY it's disabled
   *  (e.g. screen share unsupported on this device). */
  presentTitle?: string;
}) => {
  const t = useT();
  // Real elapsed time of the current meeting session, counted from when we
  // entered the room (wall-clock based, so it stays accurate even if the tab
  // is backgrounded and interval ticks are throttled). Resets on leave.
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Standalone Canvas Replay ("Tua lại") — review-mode only. One click docks a
  // clean player CONTROL BAR at the bottom of the EXISTING review canvas (no
  // modal shell, no intermediate menu): the bar drives that canvas in place (no
  // second Excalidraw, no rebroadcast). Previously this was a tab buried in the
  // meeting-log modal, then a modal-shell-then-peek step; now it's a one-click
  // bottom bar.
  const [replayOpen, setReplayOpen] = useState(false);
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
  // E2E room key for the standalone Canvas Replay — the same key the log-modal
  // replay used. Prefer the live portal key (authoritative), fall back to the
  // hash-parsed one for a preview/ad-hoc link.
  const replayRoomKey = collabAPI?.portal.roomKey ?? roomKey ?? null;

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

  // Close the bottom-docked replay bar on Escape — same dismiss etiquette as
  // any meeting overlay.
  useEffect(() => {
    if (!replayOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReplayOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [replayOpen]);

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
  // Review mode (finished meeting) is read-only: the LIVE elapsed clock is a
  // live-session concept, so we STOP the ticker here (and hide the stat in the
  // render below). The authoritative time info for a finished meeting is the
  // replay timeline's span — not a header clock that keeps counting `now -
  // start` forever after the meeting has ended.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  useEffect(() => {
    if (!activeRoomLink || viewOnly) {
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
  }, [activeRoomLink, meetingStartMs, viewOnly]);

  // Edit rights: the ORGANIZER owns meeting edits (title/agenda/metadata) —
  // server-enforced; this just hides the affordance from everyone else.
  // Unregistered ad-hoc rooms (no registry row yet) stay editable by any
  // internal user — registering on first save claims them properly. Review
  // mode (finished) never edits.
  const session = useAtomValue(sessionAtom);
  const viewerAuthority = useAtomValue(meetingViewerAuthorityAtom);
  const canEditMeeting =
    canManageMeeting(
      session?.email,
      meetingInfo?.organizerEmail ?? null,
      isInternalEmail(session?.email),
      viewerAuthority,
    ) && isEditableMeetingStatus(meetingInfo?.status);

  const setViewOnly = useSetAtom(meetingViewOnlyAtom);
  const setPanelOpen = useSetAtom(participantsPanelOpenAtom);

  // CC toggle on the HEADER (not just the Caption Dock). The dock only mounts on
  // surfaces that own the viewport (share pane / presenter / overlay); in the
  // "panel-only" / "none" views there's NO dock and therefore no CC puck to flip.
  // Putting the toggle here lets a viewer turn captions on/off in EVERY view.
  // Writes the persisted flag too (setCaptionDockEnabled) so the choice survives
  // reloads — same write the dock's own CC button does. This is the CAPTION DOCK
  // toggle, distinct from STT source (sttEnabledAtom) and the STT panel control.
  const [captionEnabled, setCaptionEnabled] = useAtom(captionDockEnabledAtom);
  const toggleCaption = useCallback(() => {
    const next = !captionEnabled;
    setCaptionEnabled(next);
    setCaptionDockEnabled(next);
  }, [captionEnabled, setCaptionEnabled]);

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

  // External project-scoped guest: host/organizer controls are hidden (the
  // Worker also 403s them — this is the UX half). A guest keeps leave,
  // transcript, present and their profile.
  const isGuest = !!session?.isGuest;

  const myEmail = session?.email?.toLowerCase();
  const canEndMeeting =
    !isGuest &&
    !!myEmail &&
    (meetingInfo?.hostEmail?.toLowerCase() === myEmail ||
      meetingInfo?.organizerEmail?.toLowerCase() === myEmail ||
      isCohost ||
      // A division HEAD / project LEADER auto-hosts every meeting in their
      // division (anh Luân 06-16: admin = head-only power tier) — the worker
      // authorizes End via isMeetingProjectAuthority, so the head must see the
      // End button too. viewerAuthority is the server-computed authority flag
      // (deputy already excluded server-side).
      viewerAuthority ||
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
      // WHOLE-meeting recap (anh Luân 06-23): the summary must synthesize the
      // entire meeting log — canvas notes + chat + transcript — not just
      // speech. Canvas notes (labeled "Name: text") are real discussion
      // content people wrote on the board, so a canvas-only meeting still
      // warrants a recap.
      const canvasText = collectCanvasText(excalidrawAPI);
      if (
        log.length === 0 &&
        chatMessages.length === 0 &&
        canvasText.length === 0
      ) {
        return; // nothing was said, typed, or written — no recap to make
      }
      const res = await fetchWithAuth(`${aiBackendUrl()}/summarize`, {
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
          canvasText,
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
    [log, chatMessages, preferredLang, excalidrawAPI, t],
  );

  // Consolidate-on-end (meeting-event-log P1 MVP): at End-for-all the host's
  // client holds the room key and already has the whole meeting log loaded
  // (transcript + chat + canvas text). Parse it into a server-readable event
  // timeline so an AI can later read the FLOW of the meeting and leadership can
  // read that project information. This is a DERIVED, plaintext copy — NO
  // per-person scoring/profiling, just attributed "what was said / typed /
  // written" lines. Idempotent (stable server-side ids) so a re-run can't
  // duplicate; fire-and-forget / fail-soft so it never blocks ending.
  const consolidateMeetingLog = useCallback(
    async (targetRoomId: string) => {
      const events: MeetingEventInput[] = [];
      // Transcript segments — one event per finalized utterance, ordered.
      log.forEach((s, i) => {
        events.push({
          kind: "transcript.segment",
          ts: s.ts,
          seq: i,
          payload: {
            speaker: s.username,
            text: s.text,
            lang: s.lang,
            segIdx: i,
          },
        });
      });
      // Chat messages — one event per message.
      chatMessages.forEach((m, i) => {
        events.push({
          kind: "chat.message",
          ts: m.ts,
          seq: i,
          payload: { speaker: m.username, text: m.text },
        });
      });
      // Canvas text — a few human-meaningful notes people wrote on the board.
      // collectCanvasText already dedupes, author-prefixes, caps + truncates.
      const endTs = Date.now();
      collectCanvasText(excalidrawAPI).forEach((text, i) => {
        events.push({
          kind: "canvas.text",
          ts: endTs,
          seq: i,
          payload: { text },
        });
      });
      if (events.length) {
        await postMeetingEvents(targetRoomId, events);
      }
    },
    [log, chatMessages, excalidrawAPI],
  );

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
    // …and consolidate the meeting log into the server-readable event timeline
    // (same fire-and-forget contract — idempotent, must never block ending)…
    void consolidateMeetingLog(roomId).catch((error) => {
      console.warn(
        "Meeting event-log consolidation failed (non-blocking):",
        error,
      );
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
  }, [
    roomId,
    canEndMeeting,
    collabAPI,
    setViewOnly,
    generateAiSummary,
    consolidateMeetingLog,
    t,
  ]);

  return (
    <header className="mcm-header">
      {/* ===== LEFT: identity — real Canvas M logo + meeting title +
          objective timer + people count. This block answers "WHERE am I"
          and never scrolls into the action groups. ===== */}
      <div className="mcm-header__identity">
        {/* Real brand wordmark (same asset as login + lobby), not the old CSS
            "M" placeholder. Scaled to the header height; inverted to near-white
            on the dark Olive-Royal theme by .mcm-header__logo-img in SCSS. */}
        <img
          src="/canvas-m.png"
          alt="Canvas M"
          decoding="async"
          className="mcm-header__logo-img"
        />

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
            canEditMeeting && !viewOnly
              ? t("header.editMeetingTitle")
              : undefined
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
          {canEditMeeting && !viewOnly && <ChevronDown size={16} />}
        </button>

        {/* Objective meeting clock — shared start, so late joiners see the same
            elapsed time. (Recording state lives in its own button in the
            "Meeting" group; this is purely the running timer.) Hidden in review:
            a finished meeting has no "running" elapsed — its time lives in the
            replay timeline's span, not a header clock. */}
        {!viewOnly && (
          <div className="mcm-header__stat" title={t("header.elapsedTitle")}>
            <Clock3 size={14} strokeWidth={2} />
            <span className="mcm-header__stat-num">{fmt(elapsed)}</span>
          </div>
        )}

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
          <Users size={14} strokeWidth={2} />
          <span className="mcm-header__stat-num">
            {t("header.participantCount", { count: realCount })}
          </span>
          {inCallCount > 0 && (
            <span className="mcm-header__stat-sub">
              <Mic size={11} strokeWidth={2.25} /> {inCallCount}
            </span>
          )}
        </button>

        {/* Phase 5 — elegant REC indicator, visible to EVERYONE while a cloud
            recording is active (legally required). Self-hides when nothing is
            recording. Reads the shared roomRecordingAtom the host's controls
            broadcast over RECORDING_STATE. */}
        <RecordingIndicator />
      </div>

      {/* Elastic gap — pushes the action groups to the right and lets the left
          identity block keep its natural width. */}
      <div className="mcm-header__spacer" />

      {/* ===== RIGHT: action groups, every control an icon + hover tooltip,
          separated by hairlines so related tools read as one cluster.
          MEDIA · INTERACTION · MEETING · ROOM-CHROME · EXIT ===== */}
      <div className="mcm-header__actions">
        {/* --- MEDIA: call · mic · camera (call lifecycle) · present — the
            "what I broadcast" group. MeetingCallControls renders the
            call/mic/cam buttons as `mcm-header__icon-btn`s; we frame them with
            Present so all sharing controls sit together. --- */}
        <div className="mcm-header__group" role="group">
          <MeetingCallControls />
          {/* No "share room link" affordance at all (anh Luân 06-16: "không
              share bằng link nữa vì bảo mật"). Access is by explicit invite
              only — login + a meeting_invitee row — never a room URL. */}
          <button
            type="button"
            className={`mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip${
              isPresenting ? " mcm-header__icon-btn--active" : ""
            }`}
            data-mcm-tip={presentTitle ?? t("header.present")}
            aria-label={t("header.present")}
            aria-pressed={isPresenting}
            onClick={onPresent}
            disabled={presentDisabled && !isPresenting}
          >
            {/* ScreenShare (monitor + arrow), not Presentation (a slide-deck
                board): this button shares the live SCREEN, so the monitor glyph
                reads truer than a flip-chart and won't be mistaken for a
                whiteboard/slides tool. */}
            <ScreenShare size={18} />
            <span className="mcm-header__icon-label">
              {t("header.present")}
            </span>
          </button>
        </div>

        <div className="mcm-header__group-sep" aria-hidden="true" />

        {/* --- INTERACTION: captions / transcript — the "follow along"
            group. Raise-hand & reactions live in MEDIA's call cluster (they
            only exist mid-call); here sit the always-available read affordances. --- */}
        <div className="mcm-header__group" role="group">
          {/* CC toggle — turns the Live Caption Dock on/off from ANY view. The
              dock's own CC puck is absent on panel-only / no-share surfaces, so
              this is the only place to reach the toggle there. */}
          <button
            type="button"
            className={`mcm-header__icon-btn mcm-tip${
              captionEnabled ? " mcm-header__icon-btn--active" : ""
            }`}
            data-mcm-tip={
              captionEnabled ? t("header.captionOn") : t("header.captionOff")
            }
            aria-label={t("header.captionToggle")}
            aria-pressed={captionEnabled}
            onClick={toggleCaption}
          >
            <Captions size={18} />
          </button>
          <button
            type="button"
            className="mcm-header__icon-btn mcm-tip"
            onClick={onOpenLog}
            data-mcm-tip={t("header.meetingLog")}
            aria-label={t("header.meetingLog")}
          >
            <FileText size={18} />
          </button>
          {/* Standalone Canvas Replay ("Tua lại") — review-mode only. One click
              docks a player control bar at the bottom of the EXISTING review
              canvas; it drives that canvas in place, so it never spawns a second
              Excalidraw nor rebroadcasts. Lives next to the meeting-log entry
              since both are "read the record" affordances. */}
          {viewOnly && roomId && (
            <button
              type="button"
              className="mcm-header__icon-btn mcm-tip"
              onClick={() => setReplayOpen(true)}
              data-mcm-tip={t("header.replay")}
              aria-label={t("header.replay")}
            >
              <History size={18} />
            </button>
          )}
        </div>

        <div className="mcm-header__group-sep" aria-hidden="true" />

        {/* --- MEETING: layout · invite · projects(host) — the
            "manage the meeting" group. --- */}
        <div className="mcm-header__group" role="group">
          {/* Video-surface switcher (minimal / filmstrip / gallery + floating
              presenter toggle). Drives videoLayoutAtom. */}
          <LayoutSwitcher />
          {/* Files — opens THIS meeting's material library (upload + view
              DXF/IFC/PDF). Hidden in review: the meeting-library tab itself is
              hidden when reviewing a finished meeting (AppSidebar).
              TODO(pull-from-project): aggregate project-level materials here
              once that feature exists; today it scopes to the meeting library +
              upload only. */}
          {!viewOnly && (
            <button
              type="button"
              className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip"
              onClick={() =>
                excalidrawAPI?.updateScene({
                  appState: {
                    ...excalidrawAPI.getAppState(),
                    openSidebar: { name: "default", tab: "meeting-library" },
                  },
                })
              }
              data-mcm-tip={t("header.files")}
              aria-label={t("header.files")}
            >
              <Files size={18} />
              <span className="mcm-header__icon-label">
                {t("header.files")}
              </span>
            </button>
          )}
          {/* Inviting is MEETING-MANAGEMENT (anh Luân 06-15: "mời đúng chuẩn
              role") — only organizer / host / co-host / project authority
              (canEditMeeting), never a plain participant or guest, and not into
              a finished meeting (canEditMeeting already excludes those). */}
          {canEditMeeting && !viewOnly && (
            <button
              type="button"
              className="mcm-header__icon-btn mcm-tip mcm-header__icon-btn--accent"
              onClick={() => setInviteOpen(true)}
              data-mcm-tip={t("header.invite")}
              aria-label={t("header.invite")}
            >
              <UserPlus size={18} />
            </button>
          )}
          {onOpenFolder && (
            <button
              type="button"
              className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip"
              onClick={onOpenFolder}
              data-mcm-tip={t("header.projects")}
              aria-label={t("header.projects")}
            >
              {/* FolderOpen (a folder), distinct from Files' document-stack
                  glyph: Projects switches the whole project context, Files opens
                  this meeting's material library. */}
              <FolderOpen size={18} />
              <span className="mcm-header__icon-label">
                {t("header.projects")}
              </span>
            </button>
          )}
        </div>

        <div className="mcm-header__group-sep" aria-hidden="true" />

        {/* --- CHROME: language/theme · settings — app-level preferences,
            quietest group, furthest from the live controls. --- */}
        <div className="mcm-header__group" role="group">
          <LangThemeSwitcher />
          <button
            type="button"
            className="mcm-header__icon-btn mcm-tip"
            data-mcm-tip={t("profile.openSettings")}
            onClick={onOpenProfile}
            aria-label={t("profile.openSettings")}
          >
            <Settings size={18} />
          </button>
        </div>

        <div className="mcm-header__group-sep" aria-hidden="true" />

        {/* --- EXIT: leave meeting · end-for-all (host). Visually loud
            (red end-meeting) so the destructive action is unmistakable and
            isolated at the far edge. Three exit verbs use three distinct
            glyphs so they never blur together: the CALL toggle (active Phone,
            in MeetingCallControls) drops just the call, leave MEETING = LogOut
            (I walk out), end FOR ALL = Power (kill the whole room). --- */}
        <div className="mcm-header__group" role="group">
          {/* Leave meeting — I exit the room; everyone else stays. LogOut's
              arrow-out-of-box says "I'm leaving", not "shut it down". */}
          <button
            type="button"
            className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip"
            onClick={onLeave}
            data-mcm-tip={t("header.leave")}
            aria-label={t("header.leave")}
          >
            <LogOut size={18} />
            <span className="mcm-header__icon-label">{t("header.leave")}</span>
          </button>
          {canEndMeeting && !viewOnly && (
            // End for all — host-only, destructive. Power icon (not a phone)
            // signals "power off the meeting for EVERYONE", clearly different
            // from the call hang-up and the personal leave. Painted red.
            <button
              type="button"
              className="mcm-header__icon-btn mcm-header__icon-btn--labeled mcm-tip mcm-header__icon-btn--danger"
              onClick={() => void handleEndMeeting()}
              data-mcm-tip={t("header.endMeeting")}
              aria-label={t("header.endMeeting")}
            >
              <Power size={18} />
              <span className="mcm-header__icon-label">
                {t("header.endMeeting")}
              </span>
            </button>
          )}
        </div>
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

      {/* Standalone Canvas Replay — a clean player CONTROL BAR docked at the
          bottom of the review canvas (NO modal shell, NO intermediate menu). It
          floats over the EXISTING review canvas and drives it in place via the
          live excalidrawAPI, restoring the original finished-meeting scene when
          it closes. Its own × / Escape dismiss it. */}
      {replayOpen && (
        <div
          className="mcm-replay-dock"
          role="region"
          aria-label={t("header.replay")}
        >
          <CanvasReplayPlayer
            roomId={roomId}
            roomKey={replayRoomKey}
            excalidrawAPI={excalidrawAPI}
            onClose={() => setReplayOpen(false)}
          />
        </div>
      )}
    </header>
  );
};

export default MeetingHeader;
