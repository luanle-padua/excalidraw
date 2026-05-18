// Owns the transcript log lifecycle for the active collab room.
//
//   - On room join (roomId becomes non-null): load persisted log from
//     localStorage and seed `transcriptionLogAtom` so prior segments
//     reappear after a reload.
//   - On room leave: clear the in-memory atom but leave the storage
//     intact so re-joining the same room recovers history.
//
// Side-effect-only component — returns null. Mounted once at the
// shell level next to AudioRoomController.

import { useEffect, useRef } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { activeRoomLinkAtom, collabAPIAtom } from "../../collab/Collab";
import {
  liveTranscriptsAtom,
  loadTranscriptLog,
  meetingSummaryAtom,
  loadMeetingSummary,
  transcriptionLogAtom,
} from "../../data/transcription";

export const TranscriptionController = () => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const setLog = useSetAtom(transcriptionLogAtom);
  const setLiveTranscripts = useSetAtom(liveTranscriptsAtom);
  const setSummary = useSetAtom(meetingSummaryAtom);
  const lastLoadedRoomRef = useRef<string | null>(null);

  useEffect(() => {
    const roomId = collabAPI?.portal.roomId ?? null;
    if (!activeRoomLink || !roomId) {
      // Left the room — clear in-memory atoms. Storage stays so the
      // log returns intact when the user re-opens the same room.
      if (lastLoadedRoomRef.current !== null) {
        setLog([]);
        setLiveTranscripts({});
        setSummary(null);
        lastLoadedRoomRef.current = null;
      }
      return;
    }
    if (lastLoadedRoomRef.current === roomId) {
      return;
    }
    // First time we see this room this mount — load persisted log.
    const persisted = loadTranscriptLog(roomId);
    setLog(persisted);
    const persistedSummary = loadMeetingSummary(roomId);
    setSummary(persistedSummary);
    lastLoadedRoomRef.current = roomId;
  }, [activeRoomLink, collabAPI, setLog, setLiveTranscripts, setSummary]);

  return null;
};

export default TranscriptionController;
