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

import { preferredLanguageAtom } from "./translation";

import type { STTLang } from "../audio/sttSession";

export type { STTLang };

/** Languages the LOCAL user can pick as the one they SPEAK — i.e. what
 *  Deepgram transcribes their mic in. Restricted to the nova-3
 *  monolingual languages this app supports (subset of STTLang). */
export const SPOKEN_LANGUAGES: STTLang[] = ["en", "ko", "vi"];

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
const STT_DUAL_LANG_LS_KEY = "mcm:sttDualLanguage";
const STT_SPOKEN_LANG_LS_KEY = "mcm:sttSpokenLang";
const STT_PANEL_STYLE_LS_KEY = "mcm:sttPanelStyle";
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

// Default OFF — streaming mic audio to Deepgram costs money and is a
// privacy decision each user should opt into per device.
export const sttEnabledAtom = atom<boolean>(
  readBool(STT_ENABLED_LS_KEY, false),
);

export const setSttEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(STT_ENABLED_LS_KEY, enabled ? "1" : "0");
  } catch {
    // ignore — best-effort
  }
};

/** Last LIVE STT session error (capture/handshake), surfaced in the panel so a
 *  silent failure — e.g. a WS 401/403 from the Worker gate or a blocked
 *  AudioContext on iPad Safari — is visible instead of dying in console.warn.
 *  null = no current error; cleared when a session (re)starts or tears down. */
export const sttLiveErrorAtom = atom<string | null>(null);

/** Ground-truth "is the LOCAL user's mic actually being captured into STT right
 *  now?" — true only while PCM is genuinely flowing from the worklet (see
 *  STTSession.onCapture). Distinct from `sttEnabledAtom`, which is just the
 *  user's intent: a session can be enabled + {ready} yet capture NOTHING (a
 *  suspended AudioContext or dead mic-clone on iPad), and this atom is the only
 *  thing that tells those apart. AudioRoomController owns the write side (sets it
 *  true on each onCapture frame, flips it back to false ~1.5s after the last
 *  frame). The panel renders it as a pulsing "Live" dot vs an amber "No audio"
 *  warning. Resets to false on teardown so a stale true never lingers. */
export const sttCapturingAtom = atom<boolean>(false);

/** How the on-canvas transcript panel renders:
 *   • "full"    — the complete, scrollable history with avatars, every
 *                 control, and resize handle (the original layout).
 *   • "compact" — a slim card showing only the ~3 newest finalised
 *                 segments (+ any live interim), trimmed chrome, so it
 *                 sips canvas space. Same translation + speaker colour.
 *  Persisted per device like the other STT prefs. Default "full" so
 *  existing users see no behaviour change until they opt in. */
export type STTPanelStyle = "full" | "compact";

const readPanelStyle = (): STTPanelStyle => {
  if (typeof window === "undefined") {
    return "full";
  }
  try {
    const v = window.localStorage.getItem(STT_PANEL_STYLE_LS_KEY);
    return v === "compact" ? "compact" : "full";
  } catch {
    return "full";
  }
};

export const sttPanelStyleAtom = atom<STTPanelStyle>(readPanelStyle());

export const setSttPanelStyle = (style: STTPanelStyle): void => {
  try {
    window.localStorage.setItem(STT_PANEL_STYLE_LS_KEY, style);
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

/** Per-viewer toggle: show BOTH the speaker's ORIGINAL spoken-language text
 *  AND the translation for each finalised segment, instead of only one. Shared
 *  by both transcript surfaces (the SpeechToTextPanel history view + the
 *  LiveCaptionDock subtitle strip) so the user's choice is consistent.
 *
 *  Only meaningful while translation is ON (`sttTranslateEnabledAtom`): with
 *  translation OFF there is nothing to pair the original with, so the surfaces
 *  fall back to showing the original alone. Default OFF — single line is the
 *  established behaviour; the user opts in. The original spoken text is always
 *  retained in `TranscriptSegment.text`, so dual is purely a render choice (no
 *  pipeline change needed). */
export const sttDualLanguageAtom = atom<boolean>(
  readBool(STT_DUAL_LANG_LS_KEY, false),
);

export const setSttDualLanguage = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(STT_DUAL_LANG_LS_KEY, enabled ? "1" : "0");
  } catch {
    // ignore
  }
};

// Read the persisted spoken-language choice. Returns null when nothing is
// stored (so the atom can fall back to the UI preferred language) or when the
// stored value is no longer a supported language.
const readSpokenLang = (): STTLang | null => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const v = window.localStorage.getItem(STT_SPOKEN_LANG_LS_KEY);
    return v !== null && (SPOKEN_LANGUAGES as string[]).includes(v)
      ? (v as STTLang)
      : null;
  } catch {
    return null;
  }
};

// Primitive override: null = "not yet chosen", so the derived atom below
// falls back to the user's current UI preferred language. Seeded from
// localStorage so a prior choice survives reloads.
const sttSpokenLangOverrideAtom = atom<STTLang | null>(readSpokenLang());

/** The language Deepgram transcribes the LOCAL user's mic in. INDEPENDENT of
 *  the app UI language — a user whose UI is English may speak Korean. Reads as
 *  the UI preferred language until the user explicitly picks one (so behaviour
 *  is unchanged until they do). The write side updates the in-memory override;
 *  pair it with `setSttSpokenLanguage` to persist, exactly like the
 *  `sttEnabledAtom` / `setSttEnabled` pattern above. */
export const sttSpokenLanguageAtom = atom<STTLang, [STTLang], void>(
  (get) => get(sttSpokenLangOverrideAtom) ?? get(preferredLanguageAtom),
  (_get, set, lang) => set(sttSpokenLangOverrideAtom, lang),
);

export const setSttSpokenLanguage = (lang: STTLang): void => {
  try {
    window.localStorage.setItem(STT_SPOKEN_LANG_LS_KEY, lang);
  } catch {
    // ignore — best-effort
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
