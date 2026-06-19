// Atoms + persistence for the LIVE CAPTION DOCK — the thin glass subtitle strip
// pinned to the bottom of whichever surface owns the viewport while someone is
// presenting / sharing their screen. It is a pure CONSUMER of the existing STT +
// translation + active-speaker atoms (see data/transcription.ts,
// data/translation.ts, audio/videoPerf.ts); nothing here touches the STT
// pipeline. These atoms only hold the viewer's PRESENTATION preferences for the
// dock, persisted to localStorage so each device remembers them.
//
//   • `captionDockEnabledAtom`  — the "CC" on/off toggle. Default ON so captions
//                                 light up automatically the moment a share
//                                 starts (the PM wants zero-click captions); the
//                                 user can mute them via the CC button.
//   • `captionLineCountAtom`    — how many of the newest lines to keep visible
//                                 (1 / 2 / 3). Older lines fade + slide up out.
//   • `captionFontScaleAtom`    — caption text size step (S / M / L). Drives a
//                                 CSS variable (`--mcm-caption-scale`) so the
//                                 size is a single multiplier applied to the line
//                                 font-size — no per-element overrides.
//
// Kept in its OWN module (rather than appended to transcription.ts) so the
// caption layer's view-state stays decoupled from the STT data model: caption
// prefs are per-device cosmetics, the transcript log is meeting content.

import { atom } from "../app-jotai";

const CAPTION_ENABLED_LS_KEY = "mcm:captionDockEnabled";
const CAPTION_LINES_LS_KEY = "mcm:captionLineCount";
const CAPTION_FONT_SCALE_LS_KEY = "mcm:captionFontScale";

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

// ---------------------------------------------------------------------
// CC on/off
// ---------------------------------------------------------------------

// Default ON: when a present/share begins we want captions to appear without the
// viewer hunting for a toggle. The dock still self-hides during silence, so an
// ON-by-default that goes quiet costs nothing visually.
export const captionDockEnabledAtom = atom<boolean>(
  readBool(CAPTION_ENABLED_LS_KEY, true),
);

export const setCaptionDockEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(CAPTION_ENABLED_LS_KEY, enabled ? "1" : "0");
  } catch {
    // best-effort
  }
};

// ---------------------------------------------------------------------
// Visible line count (1 / 2 / 3)
// ---------------------------------------------------------------------

export type CaptionLineCount = 1 | 2 | 3;
export const CAPTION_LINE_COUNTS: readonly CaptionLineCount[] = [1, 2, 3];

const readLineCount = (): CaptionLineCount => {
  if (typeof window === "undefined") {
    return 2;
  }
  try {
    const v = Number(window.localStorage.getItem(CAPTION_LINES_LS_KEY));
    return v === 1 || v === 2 || v === 3 ? (v as CaptionLineCount) : 2;
  } catch {
    return 2;
  }
};

// Default 2 lines — enough to read a sentence rolling over a line break without
// the dock growing tall enough to feel like it's covering content.
export const captionLineCountAtom = atom<CaptionLineCount>(readLineCount());

export const setCaptionLineCount = (count: CaptionLineCount): void => {
  try {
    window.localStorage.setItem(CAPTION_LINES_LS_KEY, String(count));
  } catch {
    // best-effort
  }
};

// ---------------------------------------------------------------------
// Font size step (S / M / L) → CSS multiplier
// ---------------------------------------------------------------------

export type CaptionFontScale = "s" | "m" | "l";
export const CAPTION_FONT_SCALES: readonly CaptionFontScale[] = ["s", "m", "l"];

/** Multiplier applied to the base caption font-size via `--mcm-caption-scale`.
 *  Kept here (not in SCSS) so the value is the single source of truth shared by
 *  the embedded, overlay, and pop-out mounts. */
export const CAPTION_FONT_SCALE_VALUE: Record<CaptionFontScale, number> = {
  s: 0.85,
  m: 1,
  l: 1.25,
};

const readFontScale = (): CaptionFontScale => {
  if (typeof window === "undefined") {
    return "m";
  }
  try {
    const v = window.localStorage.getItem(CAPTION_FONT_SCALE_LS_KEY);
    return v === "s" || v === "m" || v === "l" ? v : "m";
  } catch {
    return "m";
  }
};

// Default M — comfortable on a laptop; S for dense screens, L for a far-away
// room display / projector (the PM's "tăng/giảm cỡ chữ" request).
export const captionFontScaleAtom = atom<CaptionFontScale>(readFontScale());

export const setCaptionFontScale = (scale: CaptionFontScale): void => {
  try {
    window.localStorage.setItem(CAPTION_FONT_SCALE_LS_KEY, scale);
  } catch {
    // best-effort
  }
};
