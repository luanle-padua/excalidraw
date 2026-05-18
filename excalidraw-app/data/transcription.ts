// Atoms + persistence for the realtime speech-to-text feature.
//
//   • `sttEnabledAtom`           — toggle in the UI; off = no mic stream
//                                   sent to Deepgram (cost + privacy).
//   • `liveTranscriptsAtom`      — current interim line per speaker.
//                                   Overwritten as Deepgram refines.
//   • `transcriptionLogAtom`     — finalized segments, append-only,
//                                   chronological. Persisted to
//                                   localStorage keyed by roomId so
//                                   re-opening the meeting recovers it.
//   • `meetingSummaryAtom`       — last-generated summary for the
//                                   current room (Gemini output).
//
// A "segment" is one finalized utterance from one speaker. Interim
// hypotheses live separately and don't accumulate in the log.

import { atom } from "../app-jotai";

export type STTLang = "vi" | "en" | "ko" | "ja" | "zh" | "multi";

export type TranscriptSegment = {
  id: string;
  /** WebRTC socketId of the speaker, OR `"local"` for self when not
   *  in a collab room (lets the test/upload flow still produce a log). */
  socketId: string;
  username: string;
  text: string;
  /** ISO 639-1 from Deepgram's detection; `undefined` if we didn't ask. */
  lang?: string;
  /** Unix ms when the segment was finalized. */
  ts: number;
};

/** Per-speaker interim line. Replaced on every Deepgram partial. */
export type InterimEntry = {
  socketId: string;
  username: string;
  text: string;
  ts: number;
};

const STT_ENABLED_LS_KEY = "mcm:sttEnabled";
const STT_TRANSLATE_LS_KEY = "mcm:sttTranslateEnabled";
const TRANSCRIPT_LOG_LS_PREFIX = "mcm:transcript:";
const SUMMARY_LS_PREFIX = "mcm:summary:";

const readBool = (key: string, fallback: boolean): boolean => {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};

export const sttEnabledAtom = atom<boolean>(readBool(STT_ENABLED_LS_KEY, true));

export const setSttEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(STT_ENABLED_LS_KEY, enabled ? "1" : "0");
  } catch {
    // ignore — best-effort
  }
};

/** Per-viewer toggle: translate each finalised transcript segment to
 *  the viewer's preferred language. Mirrors the chat translation
 *  feature. Off → only the original is rendered. */
export const sttTranslateEnabledAtom = atom<boolean>(
  readBool(STT_TRANSLATE_LS_KEY, true),
);

export const setSttTranslateEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(STT_TRANSLATE_LS_KEY, enabled ? "1" : "0");
  } catch {
    // ignore
  }
};

/** Map<socketId, InterimEntry> wrapped as an atom. We store as plain
 *  object (not Map) so equality checks in components work via reference. */
export const liveTranscriptsAtom = atom<Record<string, InterimEntry>>({});

/** Append-only list. Newest at the end. */
export const transcriptionLogAtom = atom<TranscriptSegment[]>([]);

export type MeetingActionItem = {
  owner: string;
  task: string;
  due?: string;
};

/** Per-room generated summary (Gemini output). Lives until the user
 *  generates a fresh one or clears the log. */
export type MeetingSummary = {
  summary: string;
  decisions: string[];
  actionItems: MeetingActionItem[];
  participants: string[];
  /** High-level themes the meeting touched on. May be empty. */
  keyTopics: string[];
  generatedAt: number;
};

export const meetingSummaryAtom = atom<MeetingSummary | null>(null);

// ---------------------------------------------------------------------
// localStorage persistence keyed by roomId. We do this manually rather
// than via an atom effect because the roomId isn't known until the
// user joins a room — atoms are scope-less.
// ---------------------------------------------------------------------

const logKey = (roomId: string) => `${TRANSCRIPT_LOG_LS_PREFIX}${roomId}`;
const summaryKey = (roomId: string) => `${SUMMARY_LS_PREFIX}${roomId}`;

export const loadTranscriptLog = (roomId: string): TranscriptSegment[] => {
  try {
    const raw = window.localStorage.getItem(logKey(roomId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as TranscriptSegment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveTranscriptLog = (
  roomId: string,
  log: TranscriptSegment[],
): void => {
  try {
    window.localStorage.setItem(logKey(roomId), JSON.stringify(log));
  } catch {
    // quota exceeded or blocked — best-effort
  }
};

export const loadMeetingSummary = (roomId: string): MeetingSummary | null => {
  try {
    const raw = window.localStorage.getItem(summaryKey(roomId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as MeetingSummary;
  } catch {
    return null;
  }
};

export const saveMeetingSummary = (
  roomId: string,
  summary: MeetingSummary,
): void => {
  try {
    window.localStorage.setItem(summaryKey(roomId), JSON.stringify(summary));
  } catch {
    // ignore
  }
};

export const clearTranscriptLog = (roomId: string): void => {
  try {
    window.localStorage.removeItem(logKey(roomId));
    window.localStorage.removeItem(summaryKey(roomId));
  } catch {
    // ignore
  }
};

// ---------------------------------------------------------------------
// List of room IDs for which we have a stored transcript — drives the
// "past meetings" picker when reviewing history. Walks localStorage
// once on demand.
// ---------------------------------------------------------------------

export const listArchivedRooms = (): string[] => {
  try {
    const ids: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(TRANSCRIPT_LOG_LS_PREFIX)) {
        ids.push(key.slice(TRANSCRIPT_LOG_LS_PREFIX.length));
      }
    }
    return ids;
  } catch {
    return [];
  }
};
