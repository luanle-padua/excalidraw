import { Eye } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  isCollaboratingAtom,
  meetingViewOnlyAtom,
} from "../../collab/Collab";
import { useT } from "../../i18n/mcm";
import { clearLastMeeting, setLastMeeting } from "../../data/lastMeeting";
import { hydrateMeetingFiles } from "../../data/meetingLibrary";
import { getMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import {
  ensureMyJoinedAt,
  hostSocketIdAtom,
  meetingCreatorAtom,
  mySocketIdAtom,
  saveUserProfile,
  userProfileAtom,
} from "../../data/userProfile";

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
import { MeetingHeader } from "./MeetingHeader";
import { MeetingLobby } from "./MeetingLobby";
import { MeetingLogModal } from "./MeetingLogModal";
import { ProjectFolder, projectFolderOpenAtom } from "./ProjectFolder";
import { PinnedImagesOverlay } from "./PinnedImagesOverlay";
import { SpeechToTextPanel } from "./SpeechToTextPanel";
import { StickerPicker } from "./StickerPicker";
import { ParticipantsBar } from "./ParticipantsBar";
import { TextTranslateOverlay } from "./TextTranslateOverlay";
import { TranscriptionController } from "./TranscriptionController";
import { UserProfileModal } from "./UserProfileModal";
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
  const [profileOpen, setProfileOpen] = useState(false);
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

  // The project browser (switch project / reopen / pull) is a host-only
  // affordance for now — the host owns the project folder.
  const isHost = !!mySocketId && hostSocketId === mySocketId;

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

  // Resolve the meeting's creator → drives host election (host = creator,
  // consistent for everyone). Cleared when leaving / between rooms.
  const setMeetingCreator = useSetAtom(meetingCreatorAtom);
  useEffect(() => {
    if (!roomId) {
      setMeetingCreator(null);
      return;
    }
    let cancelled = false;
    void getMeeting(roomId).then((m) => {
      if (!cancelled) {
        setMeetingCreator(m?.created_by ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, setMeetingCreator]);

  // Logged-in users get their identity from the account (session). The
  // display name everywhere — participant tile, chat sender, on-canvas cursor
  // — must ALWAYS reflect the login, overwriting any stale profile/username
  // a PREVIOUS user left in this browser's localStorage (the "name doesn't
  // match who logged in" bug, incl. two logged-in users showing each other's
  // / wrong names). We keep the user's chosen avatar but force username (and
  // company) from the session, and keep the collab username — which drives
  // the Excalidraw collaborator name + chat sender — in lockstep. Only
  // anonymous (link-join, NO session) users still get the fake-name prompt.
  useEffect(() => {
    if (session) {
      const needsProfileSync =
        !userProfile ||
        userProfile.username !== session.name ||
        (!!session.company && userProfile.company !== session.company);
      if (needsProfileSync) {
        saveUserProfile({
          ...userProfile,
          username: session.name,
          company: session.company ?? userProfile?.company,
        });
      }
      if (collabAPI && collabAPI.getUsername() !== session.name) {
        collabAPI.setUsername(session.name);
      }
      return;
    }
    if (isCollaborating && !userProfile) {
      setProfileOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollaborating, session, userProfile, collabAPI]);

  return (
    <div className="mcm-shell">
      <MeetingHeader
        participantCount={MOCK_PARTICIPANTS.length}
        onOpenLog={() => setLogOpen(true)}
        onOpenProfile={() => setProfileOpen(true)}
        onLeave={handleLeave}
        onOpenFolder={isHost ? () => setFolderOpen(true) : undefined}
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
          <ParticipantsBar onOpenProfile={() => setProfileOpen(true)} />
          <CanvasNavWidget />
          <TextTranslateOverlay />
          <AuthorBadgeOverlay />
        </div>
        <CADViewPane />
        <IFC3DViewPane />
      </div>
      <TranscriptionController />
      {logOpen && <MeetingLogModal onClose={() => setLogOpen(false)} />}
      <UserProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        defaultUsername={collabAPI?.getUsername() || undefined}
      />
      <MeetingLobby />
      <ProjectFolder />
    </div>
  );
};

export default MeetingShell;
