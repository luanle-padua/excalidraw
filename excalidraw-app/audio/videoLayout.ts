// Which video SURFACE the meeting renders — a per-user, persisted preference
// (not synced). Drives ParticipantsBar's view switcher:
//   • "minimal"   → the existing avatar strip only (canvas stays maximal).
//   • "filmstrip" → a bottom rail of camera tiles that PUSHES the canvas up.
//   • "gallery"   → the full-screen MeetingGallery grid.
//
// Persisted to localStorage so a reload keeps the chosen layout. Room is
// deliberately left to add "floating" / "speaker" / "split" later — only these
// three ship now; widen the union + the runtime guard when adding more.

import { atom, appJotaiStore } from "../app-jotai";

export type VideoLayout = "minimal" | "filmstrip" | "gallery";

const LS_KEY = "mcm:videoLayout";
const DEFAULT_LAYOUT: VideoLayout = "minimal";

const isLayout = (v: unknown): v is VideoLayout =>
  v === "minimal" || v === "filmstrip" || v === "gallery";

const guessInitial = (): VideoLayout => {
  if (typeof window === "undefined") {
    return DEFAULT_LAYOUT;
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return isLayout(raw) ? raw : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
};

const baseAtom = atom<VideoLayout>(guessInitial());

/** The active video layout. Reading is plain; writing also persists the choice
 *  to localStorage so it survives a reload (best-effort). */
export const videoLayoutAtom = atom<VideoLayout, [VideoLayout], void>(
  (get) => get(baseAtom),
  (_get, set, next) => {
    set(baseAtom, next);
    try {
      window.localStorage.setItem(LS_KEY, next);
    } catch {
      // best-effort — a read-only / full storage just keeps the in-memory value.
    }
  },
);

/** Imperative setter for non-React callers (mirrors cadViewState's helpers). */
export const setVideoLayout = (next: VideoLayout): void => {
  appJotaiStore.set(videoLayoutAtom, next);
};
