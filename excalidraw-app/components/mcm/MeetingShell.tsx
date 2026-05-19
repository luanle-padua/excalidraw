import { useState } from "react";

import { CADViewPane } from "./cad/CADViewPane";
import { CADViewTriggers } from "./cad/CADViewTriggers";
import { DXFCanvasOverlay } from "./dxf/DXFCanvasOverlay";
import { MeetingCallControls } from "./MeetingCallControls";
import { MeetingHeader } from "./MeetingHeader";
import { MeetingLogModal } from "./MeetingLogModal";
import { PinnedImagesOverlay } from "./PinnedImagesOverlay";
import { SpeechToTextPanel } from "./SpeechToTextPanel";
import { StickerPicker } from "./StickerPicker";
import { ParticipantsBar } from "./ParticipantsBar";
import { TranscriptionController } from "./TranscriptionController";
import { MOCK_PARTICIPANTS } from "./meetingMock";

import "./MeetingShell.scss";

import type { ReactNode } from "react";

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
  return (
    <div className="mcm-shell">
      <MeetingHeader
        participantCount={MOCK_PARTICIPANTS.length}
        onOpenLog={() => setLogOpen(true)}
      />
      <div className="mcm-shell__canvas-wrap">
        {/* Canvas area takes the remaining height once FrameViewPane
            claims its share at the bottom. All overlays anchor here
            so their absolute positioning is relative to the canvas
            area, NOT the FrameViewPane. */}
        <div className="mcm-shell__canvas-area">
          {children}
          <DXFCanvasOverlay />
          <PinnedImagesOverlay />
          <StickerPicker />
          <CADViewTriggers />
          <SpeechToTextPanel />
          <MeetingCallControls />
          <ParticipantsBar />
        </div>
        <CADViewPane />
      </div>
      <TranscriptionController />
      {logOpen && <MeetingLogModal onClose={() => setLogOpen(false)} />}
    </div>
  );
};

export default MeetingShell;
