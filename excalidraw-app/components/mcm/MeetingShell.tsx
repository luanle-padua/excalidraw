import { MeetingHeader } from "./MeetingHeader";
import { SpeechToTextPanel } from "./SpeechToTextPanel";
import { VideoTilesStrip } from "./VideoTilesStrip";
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
export const MeetingShell = ({ children }: { children: ReactNode }) => (
  <div className="mcm-shell">
    <MeetingHeader participantCount={MOCK_PARTICIPANTS.length} />
    <div className="mcm-shell__canvas-wrap">
      {children}
      <SpeechToTextPanel />
      <VideoTilesStrip />
    </div>
  </div>
);

export default MeetingShell;
