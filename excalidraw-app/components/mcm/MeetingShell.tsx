import { useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { hydrateMeetingFiles } from "../../data/meetingLibrary";
import { ensureMyJoinedAt, userProfileAtom } from "../../data/userProfile";

import { CADViewPane } from "./cad/CADViewPane";
import { CADViewTriggers } from "./cad/CADViewTriggers";
import { CanvasNavWidget } from "./CanvasNavWidget";
import { DXFCanvasOverlay } from "./dxf/DXFCanvasOverlay";
import { PDFCanvasOverlay } from "./pdf/PDFCanvasOverlay";
import { MeetingCallControls } from "./MeetingCallControls";
import { MeetingHeader } from "./MeetingHeader";
import { MeetingLogModal } from "./MeetingLogModal";
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
  const collabAPI = useAtomValue(collabAPIAtom);
  const userProfile = useAtomValue(userProfileAtom);

  // Capture the user's session start timestamp as early as possible —
  // before any collab broadcast fires. Host election ranks participants
  // by smallest joinedAt, so anchoring it here (rather than letting it
  // happen when broadcastUserProfileSnapshot first runs after the
  // socket connects) means a user with a slow network handshake still
  // wins host over a peer who joined later but connected faster.
  useEffect(() => {
    ensureMyJoinedAt();
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

  // Auto-open the profile modal the first time a user lands in a
  // meeting with no saved profile so they can introduce themselves
  // before peers see a generic "Friendly Otter" placeholder. Only
  // fires once per session (the next mount with a stored profile
  // skips it). After saving, Collab's atom subscription broadcasts
  // the new info to everyone in the room.
  useEffect(() => {
    if (!userProfile) {
      setProfileOpen(true);
    }
    // intentionally only react to MOUNT — re-running on userProfile
    // changes would re-open the modal every time a peer broadcasts
    // their own profile (because the atom's identity changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mcm-shell">
      <MeetingHeader
        participantCount={MOCK_PARTICIPANTS.length}
        onOpenLog={() => setLogOpen(true)}
        onOpenProfile={() => setProfileOpen(true)}
      />
      <div className="mcm-shell__canvas-wrap">
        {/* Canvas area takes the remaining height once FrameViewPane
            claims its share at the bottom. All overlays anchor here
            so their absolute positioning is relative to the canvas
            area, NOT the FrameViewPane. */}
        <div className="mcm-shell__canvas-area">
          {children}
          <DXFCanvasOverlay />
          <PDFCanvasOverlay />
          <PinnedImagesOverlay />
          <StickerPicker />
          <CADViewTriggers />
          <SpeechToTextPanel />
          <MeetingCallControls />
          <ParticipantsBar onOpenProfile={() => setProfileOpen(true)} />
          <CanvasNavWidget />
          <TextTranslateOverlay />
        </div>
        <CADViewPane />
      </div>
      <TranscriptionController />
      {logOpen && <MeetingLogModal onClose={() => setLogOpen(false)} />}
      <UserProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        defaultUsername={collabAPI?.getUsername() || undefined}
      />
    </div>
  );
};

export default MeetingShell;
