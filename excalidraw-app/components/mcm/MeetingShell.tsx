import { Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  isCollaboratingAtom,
  kickedAtom,
  meetingViewOnlyAtom,
  screenShareStateAtom,
} from "../../collab/Collab";
import { useT } from "../../i18n/mcm";
import { showAppToast } from "../../data/appToast";
import { clearLastMeeting, setLastMeeting } from "../../data/lastMeeting";
import { hydrateMeetingFiles } from "../../data/meetingLibrary";
import { getMeeting, logParticipation } from "../../data/projects";
import { isStealthRoom } from "../../data/reviewMode";
import { sessionAtom } from "../../data/session";
import {
  ensureMyJoinedAt,
  hostSocketIdAtom,
  meetingCreatorAtom,
  meetingHostEmailAtom,
  meetingViewerAuthorityAtom,
  mySocketIdAtom,
  saveUserProfile,
  userProfileAtom,
} from "../../data/userProfile";

import { ScreenShareController } from "../../screenshare/ScreenShareController";

import { ScreenSharePane } from "../../screenshare/ScreenSharePane";

import {
  screenShareInstanceAtom,
  screenShareMediaAtom,
} from "../../screenshare/screenShareState";

import { captionSurfaceAtom } from "../../data/captionState";

import { AiActivityIndicator } from "./AiActivityIndicator";
import { AppToast } from "./AppToast";
import { AuthorBadgeOverlay } from "./AuthorBadgeOverlay";
import { CADViewPane } from "./cad/CADViewPane";
import { CADViewTriggers } from "./cad/CADViewTriggers";
import { CanvasBotTool } from "./CanvasBotTool";
import { CanvasNavWidget } from "./CanvasNavWidget";
import { DXFCanvasOverlay } from "./dxf/DXFCanvasOverlay";
import { IFCCanvasOverlay } from "./ifc/IFCCanvasOverlay";
import { IFC3DViewPane } from "./ifc/IFC3DViewPane";
import { IFC3DViewTriggers } from "./ifc/IFC3DViewTriggers";
import { PDFCanvasOverlay } from "./pdf/PDFCanvasOverlay";
import { MeetingCallControls } from "./MeetingCallControls";
import { MeetingDueNotice } from "./MeetingDueNotice";
import { MeetingHeader } from "./MeetingHeader";
import { MeetingLobby } from "./MeetingLobby";
import { MeetingLogModal } from "./MeetingLogModal";
import { ProjectFolder, projectFolderOpenAtom } from "./ProjectFolder";
import { PinnedImagesOverlay } from "./PinnedImagesOverlay";
import { LiveCaptionDock } from "./LiveCaptionDock";
import { SpeechToTextPanel } from "./SpeechToTextPanel";
import { StickerPicker } from "./StickerPicker";
import { ParticipantsBar } from "./ParticipantsBar";
import { TextTranslateOverlay } from "./TextTranslateOverlay";
import { TranscriptionController } from "./TranscriptionController";
import { UserSettings } from "./UserSettings";
import { WaitingForStart } from "./WaitingForStart";
import { WaitingRoom } from "./WaitingRoom";
import { MOCK_PARTICIPANTS } from "./meetingMock";

import "./MeetingShell.scss";

import type { ReactNode } from "react";

/** Pull the roomId out of a collab room link. Mirrors the helper in
 *  MeetingLibrary — duplicated here so MeetingShell doesn't need to
 *  reach into a sibling component's internals. */
const extractRoomId = (link: string | null | undefined): string | null => {
  if (!link) {
    return null;
  }
  const m = link.match(/#room=([a-zA-Z0-9_-]+),/);
  return m ? m[1] : null;
};

/**
 * Outer chrome around the Excalidraw canvas for the MCM (Map Canvas Meet)
 * UI shell. Header on top, participants strip on the bottom, live
 * transcript panel overlaying the bottom-left of the canvas.
 *
 * `AIToolsPanel` and `MCMAssistant` are NOT mounted here — they live
 * inside the chat sidebar (rendered by `ChatView`) so they don't overlap
 * with Excalidraw's docked sidebar.
 */
export const MeetingShell = ({ children }: { children: ReactNode }) => {
  const [logOpen, setLogOpen] = useState(false);
  // Single Settings surface for everything user-account: the header ⚙, the
  // participants-bar self avatar, and the "set up your profile" nudge all open
  // it. Profile + avatar live on its Profile tab (the default), so the old
  // standalone profile modal was merged away — no more duplicate editor.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const userProfile = useAtomValue(userProfileAtom);
  const session = useAtomValue(sessionAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  // Finished meeting opened for review: canvas is locked read-only, and we
  // hide the content-creating tools (sticker, bot). Extract-only.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  const mySocketId = useAtomValue(mySocketIdAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const setFolderOpen = useSetAtom(projectFolderOpenAtom);

  // Screen share: presence map (who's sharing, over the socket) drives the
  // single-share lock + the Present button; media holds our own live state.
  const screenSharePresence = useAtomValue(screenShareStateAtom);
  const screenShareMedia = useAtomValue(screenShareMediaAtom);
  const screenShareInstance = useAtomValue(screenShareInstanceAtom);
  // Caption surface is decided centrally by captionSurfaceAtom (data/captionState.ts) —
  // the single source of truth for WHERE the dock mounts. This canvas-bottom overlay
  // is the LOCAL presenter's fallback (they watch their own screen, so they have no
  // viewer pane, and the floating PiP may be closed). It renders only when the central
  // selector hands ownership to "overlay"; the prior local share/PiP heuristic is gone
  // so this can never double-mount with the pane / presenter docks.
  const captionSurface = useAtomValue(captionSurfaceAtom);

  // The project browser (switch project / reopen / pull) is a host-only
  // affordance for now — the host owns the project folder. A project-scoped
  // GUEST never owns it (even on the off chance socket host-election lands on
  // them): the folder reaches into the staff project surface.
  // Host AFFORDANCES (End / kick / mute / folder) go to the socket-elected host
  // OR anyone the server says holds project authority (leader / division head),
  // so a division head always has full meeting control (anh Luân 06-15). Guests
  // never host. Destructive lifecycle moves (End) are re-checked server-side.
  const viewerAuthority = useAtomValue(meetingViewerAuthorityAtom);
  const isHost =
    !session?.isGuest &&
    ((!!mySocketId && hostSocketId === mySocketId) || viewerAuthority);

  // Present button state. We're presenting when our own Daily screen track is
  // live; the button locks (disabled) while a *different* participant presents.
  const iAmPresenting = screenShareMedia.localActive;
  // Screen sharing needs getDisplayMedia, which iOS/iPadOS Safari does NOT
  // implement at all (and some locked-down browsers omit). Detecting the API's
  // ABSENCE is more robust than UA-sniffing iPad (iPadOS spoofs a desktop UA).
  // When unavailable, the Present button is disabled with an explanatory tip
  // instead of silently failing inside Daily's startScreenShare().
  const canScreenShare =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const someoneElseSharing = Array.from(screenSharePresence.keys()).some(
    (id) => id !== mySocketId,
  );
  // Surface a screen-share failure as an app toast — only on the
  // TRANSITION into "error" (tracked via ref) so re-renders while the
  // error state persists don't re-fire the same toast.
  const prevShareStatusRef = useRef(screenShareMedia.status);
  useEffect(() => {
    const prev = prevShareStatusRef.current;
    prevShareStatusRef.current = screenShareMedia.status;
    if (screenShareMedia.status === "error" && prev !== "error") {
      showAppToast(
        t("errors.presentFailed", {
          detail: screenShareMedia.errorMessage ?? "",
        }),
      );
    }
  }, [screenShareMedia, t]);

  const handlePresent = () => {
    const mgr = screenShareInstance;
    if (!mgr) {
      return;
    }
    if (iAmPresenting) {
      mgr.stopSharing();
    } else if (canScreenShare) {
      void mgr.startSharing();
    }
  };

  // Remember the active meeting so the project home can offer "Resume"
  // after a clean-URL reopen. Cleared explicitly on Leave (below).
  useEffect(() => {
    const m = activeRoomLink?.match(/#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)/);
    if (m) {
      setLastMeeting({ roomId: m[1], roomKey: m[2] });
    }
  }, [activeRoomLink]);

  // Leave the meeting → stop the socket (saves the scene first), then
  // clear the room from the URL so the project home reappears and we
  // don't auto-rejoin on reload.
  const handleLeave = () => {
    clearLastMeeting();
    collabAPI?.stopCollaboration(false);
    window.history.pushState({}, "", window.location.pathname);
  };

  // The host removed me (KICK over HOST_COMMAND): notify, then leave the room.
  const kicked = useAtomValue(kickedAtom);
  const setKicked = useSetAtom(kickedAtom);
  useEffect(() => {
    if (kicked) {
      setKicked(false);
      window.alert(t("participants.kickedMsg"));
      handleLeave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kicked]);

  // Capture the user's session start timestamp as early as possible —
  // before any collab broadcast fires. Host election ranks participants
  // by smallest joinedAt, so anchoring it here (rather than letting it
  // happen when broadcastUserProfileSnapshot first runs after the
  // socket connects) means a user with a slow network handshake still
  // wins host over a peer who joined later but connected faster.
  useEffect(() => {
    ensureMyJoinedAt();
  }, []);

  // Pre-load the default canvas font (Nunito) + the Google-hosted Noto
  // fallbacks for VN / KR. The browser
  // fetches the woff2 lazily — without touching them up front the
  // FIRST piece of text the user types renders with a missing-glyph
  // "tofu" or a wrong-metric substitute until the network round-trip
  // completes. `document.fonts.load(...)` resolves when each font
  // is ready AND triggers Excalidraw's own `fonts.onloadingdone`
  // listener, which busts the canvas shape cache so existing scenes
  // re-render with the correct font.
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) {
      return;
    }
    document.fonts.load("16px 'Nunito'").catch(() => undefined);
    document.fonts.load("16px 'Noto Sans'").catch(() => undefined);
    document.fonts.load("16px 'Noto Sans KR'").catch(() => undefined);
  }, []);

  // Hydrate the meeting-library atom AS SOON AS the shell mounts (or
  // the user joins / changes room). The library tile used to do this
  // inside its own mount effect, but that meant a fresh reload with
  // the sidebar closed left `meetingFilesAtom` empty — and the canvas
  // overlays (DXF / PDF) then showed "Đang chờ file từ peer…" until
  // the user actually clicked the library tab. Moving the call up
  // here makes the canvas content visible immediately on reload.
  const roomId = extractRoomId(collabAPI?.getActiveRoomLink() ?? null);
  useEffect(() => {
    void hydrateMeetingFiles(roomId);
  }, [roomId]);

  // Resolve the meeting's rightful host identity → drives host election.
  // Primary key is the registry host/organizer EMAIL (verified login
  // identity); the creator display NAME is kept only for legacy rows that
  // predate host_email. Cleared when leaving / between rooms.
  const setMeetingCreator = useSetAtom(meetingCreatorAtom);
  const setMeetingHostEmail = useSetAtom(meetingHostEmailAtom);
  const setViewerAuthority = useSetAtom(meetingViewerAuthorityAtom);
  useEffect(() => {
    if (!roomId) {
      setMeetingCreator(null);
      setMeetingHostEmail(null);
      setViewerAuthority(false);
      return;
    }
    let cancelled = false;
    void getMeeting(roomId).then((m) => {
      if (!cancelled) {
        setMeetingCreator(m?.created_by ?? null);
        setMeetingHostEmail(
          (m?.host_email ?? m?.organizer_email)?.toLowerCase() ?? null,
        );
        setViewerAuthority(!!m?.viewer_is_authority);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, setMeetingCreator, setMeetingHostEmail, setViewerAuthority]);

  // Record WHO joined this meeting (for the admin meeting-detail view). Only
  // logged-in users; the authoritative email is taken from the JWT server-side,
  // the session name is just the display label. A STEALTH compliance review
  // (admin, "ẩn hoàn toàn") leaves no participant row — the audit_log entry
  // is its only trace.
  useEffect(() => {
    // Reviewing ≠ attending: a review open must not mint a participant row
    // (it pollutes "attended" history + the activity log). The worker also
    // 409s this for finished meetings — the skip avoids the doomed call.
    if (!(roomId && session && !isStealthRoom(roomId) && !viewOnly)) {
      return undefined;
    }
    void logParticipation(roomId, session.name);
    // HEARTBEAT (06-18): re-post every 40s so meeting_participant.last_seen_at
    // stays current. The admin Realtime monitor derives host_present + the
    // connected count from a 90s last_seen_at window; without a heartbeat it
    // froze after 90s (the collab WS heartbeat only refreshes the Durable
    // Object, never D1). Cheap upsert; cleared on leave/unmount.
    const id = window.setInterval(() => {
      void logParticipation(roomId, session.name);
    }, 40_000);
    return () => window.clearInterval(id);
  }, [roomId, session, viewOnly]);

  // Logged-in users get their identity from the account (session). The
  // display name everywhere — participant tile, chat sender, on-canvas cursor
  // — must ALWAYS reflect the login, overwriting any stale profile a PREVIOUS
  // user left in this browser's localStorage (`mcm:userProfile:v1` is ONE key
  // per browser, not per account — the root cause of both the "name doesn't
  // match who logged in" bug AND the "every account shows the same avatar"
  // bug on shared demo machines). Username/company are forced from the
  // session; the avatar hydrates FROM the account (user_metadata.avatar) and
  // any cached avatar that belongs to a DIFFERENT email is dropped, so user
  // A's avatar can never show on user B. The collab username — which drives
  // the Excalidraw collaborator name + chat sender — stays in lockstep. Only
  // anonymous (link-join, NO session) users still get the fake-name prompt.
  useEffect(() => {
    if (session) {
      // The cached profile is OURS only when its email matches the login (or
      // it never carried one — a fresh/anon profile made by the person now
      // logging in). A different email = a previous user's leftovers.
      const cachedIsMine =
        !userProfile?.email ||
        userProfile.email.toLowerCase() === session.email.toLowerCase();
      // Avatar precedence: this device's LOCAL pick is the user's latest
      // intent and always wins — whether a data-URL upload (intentionally NOT
      // in user_metadata; see syncAvatarToAccount) or a fresh "lib:" gallery
      // pick. The account avatar only HYDRATES when there is no local pick yet
      // (cross-device roam). The earlier `session.avatar ?? localAvatar` order
      // let a STALE account avatar clobber a just-chosen "lib:" pick before
      // syncAvatarToAccount round-tripped — the header reverted to the old
      // avatar/initials right after saving (anh Luân: "đổi avatar nhưng header
      // vẫn hiện chữ cũ"). The `cachedIsMine` gate still drops another
      // account's leftover avatar, so account-switch safety is preserved.
      const localAvatar = cachedIsMine ? userProfile?.avatar : undefined;
      const nextAvatar = localAvatar ?? session.avatar;
      const nextCompany =
        session.company ?? (cachedIsMine ? userProfile?.company : undefined);
      const needsProfileSync =
        !userProfile ||
        userProfile.username !== session.name ||
        userProfile.email !== session.email ||
        userProfile.avatar !== nextAvatar ||
        userProfile.company !== nextCompany;
      if (needsProfileSync) {
        // Rebuilt EXPLICITLY (no `...userProfile` spread) so no stale field
        // from a previous login can survive an account switch.
        saveUserProfile({
          username: session.name,
          email: session.email,
          ...(nextCompany ? { company: nextCompany } : {}),
          ...(nextAvatar ? { avatar: nextAvatar } : {}),
        });
      }
      if (collabAPI && collabAPI.getUsername() !== session.name) {
        collabAPI.setUsername(session.name);
      }
      return;
    }
    if (isCollaborating && !userProfile) {
      // No saved profile yet — nudge the user into Settings (its Profile tab
      // is the default) so they pick a name/avatar before peers see them.
      setSettingsOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollaborating, session, userProfile, collabAPI]);

  return (
    <div className="mcm-shell">
      <MeetingHeader
        // PREVIEW-ONLY count: MeetingHeader uses this prop solely for the
        // empty/showcase state (no activeRoomLink); once in a real room it
        // derives the count from the live collaborator map instead. It MUST
        // match what ParticipantsBar renders in that same preview — the bar
        // slices MOCK_PARTICIPANTS to 4 tiles, so passing the full 8 here made
        // the header say "8" while the bar showed 4 (the "8 vs 4" mismatch).
        participantCount={Math.min(MOCK_PARTICIPANTS.length, 4)}
        onOpenLog={() => setLogOpen(true)}
        onOpenProfile={() => setSettingsOpen(true)}
        onLeave={handleLeave}
        onOpenFolder={isHost ? () => setFolderOpen(true) : undefined}
        onPresent={handlePresent}
        isPresenting={iAmPresenting}
        presentDisabled={viewOnly || someoneElseSharing || !canScreenShare}
        presentTitle={
          !canScreenShare ? t("header.presentUnsupported") : undefined
        }
      />
      <div className="mcm-shell__canvas-wrap">
        {/* Canvas area takes the remaining height once FrameViewPane
            claims its share at the bottom. All overlays anchor here
            so their absolute positioning is relative to the canvas
            area, NOT the FrameViewPane. */}
        <div className="mcm-shell__canvas-area">
          {children}
          {viewOnly && (
            <div className="mcm-review-banner" role="status">
              <Eye size={15} strokeWidth={1.75} />
              <span>{t("review.banner")}</span>
            </div>
          )}
          <DXFCanvasOverlay />
          <PDFCanvasOverlay />
          <IFCCanvasOverlay />
          <PinnedImagesOverlay />
          {/* Content-creating tools are hidden while reviewing a finished
              meeting — it's immutable, extract-only. */}
          {!viewOnly && <StickerPicker />}
          {!viewOnly && <CanvasBotTool />}
          <CADViewTriggers />
          <IFC3DViewTriggers />
          <SpeechToTextPanel />
          <MeetingCallControls />
          <ScreenSharePane />
          {captionSurface === "overlay" && (
            <LiveCaptionDock variant="overlay" />
          )}
          {/* Self-avatar click → Settings (Profile tab) — the single editor. */}
          <ParticipantsBar onOpenProfile={() => setSettingsOpen(true)} />
          <CanvasNavWidget />
          {/* Translating canvas text WRITES translated child elements — a
              review canvas takes no writes. */}
          {!viewOnly && <TextTranslateOverlay />}
          <AuthorBadgeOverlay />
        </div>
        <CADViewPane />
        <IFC3DViewPane />
      </div>
      <TranscriptionController />
      <ScreenShareController />
      {logOpen && <MeetingLogModal onClose={() => setLogOpen(false)} />}
      <UserSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        defaultUsername={collabAPI?.getUsername() || undefined}
      />
      <MeetingLobby />
      {/* Renders above the lobby when a join is parked on a not-yet-started
          (or cancelled) meeting — the Phase 4.5 start gate. */}
      <WaitingForStart />
      {/* Guest knock-to-join lobby — renders above the canvas when an external
          guest joins a LIVE meeting they haven't been admitted to yet. */}
      <WaitingRoom />
      {/* "Meeting tới giờ" toast — nudges the user to join a scheduled
          meeting whose time has arrived. Hides itself while collaborating
          so the in-meeting canvas stays clean. */}
      <MeetingDueNotice />
      {/* App-level error toast (showAppToast) — same corner, error tone. */}
      <AppToast />
      {/* Subtle AI-in-use pill — fades in whenever any AI endpoint is in
          flight (translate / chatbot / summarize / STT). */}
      <AiActivityIndicator />
      <ProjectFolder />
    </div>
  );
};

export default MeetingShell;
