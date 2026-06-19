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

import { floatingPresenterAtom } from "../audio/videoFocus";
import { videoLayoutAtom } from "../audio/videoLayout";
import { galleryOpenAtom } from "../audio/videoState";
import { screenShareMediaAtom } from "../screenshare/screenShareState";

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

// ---------------------------------------------------------------------
// Central surface router — the ONE place that decides where (if anywhere)
// the caption dock mounts for the current context.
// ---------------------------------------------------------------------
//
// Every surface that COULD carry captions (the share viewer pane, the floating-
// presenter PiP, the gallery, a canvas overlay, the pop-out window) used to
// decide on its own from a local mix of share / PiP flags. Nothing coordinated
// them, so combinations DOUBLE-mounted (a viewer who popped the floating
// presenter while watching a share got TWO docks) and the dock leaked onto the
// plain canvas next to the STT panel. This derived atom is the SINGLE source of
// truth: it returns the ONE surface that owns captions right now, and each mount
// point renders only when `captionSurfaceAtom === <its value>`. Precedence =
// "whichever surface visually owns the viewport".

export type CaptionSurface =
  | "popout" // share video is in a separate OS window — caption rides it there
  | "pane" // watching a remote share in the in-app viewer pane
  | "gallery" // gallery grid/speaker is open (a full-screen modal over everything)
  | "presenter" // we're presenting with the floating-presenter PiP up
  | "overlay" // we're presenting, no PiP — a bottom overlay on the canvas
  | "panel-only" // plain canvas / no share — only the STT panel, NO dock
  | "none";

/** True while the share video has been popped out to a Document-PiP window, so
 *  the in-app pane (and its dock) steps aside and the caption rides the pop-out
 *  window instead. Set by ScreenSharePane on pop-out / return. */
export const captionPoppedOutAtom = atom<boolean>(false);

/** Read-only selector: the single surface that owns captions for THIS client's
 *  current view. Routes off the local share MEDIA state (who's viewing/sharing)
 *  + layout (gallery / floating presenter), deliberately NOT the share PRESENCE
 *  map — media is what determines whether *this* viewer actually has a pane to
 *  pin to, and reading it avoids importing the heavy Collab module. */
export const captionSurfaceAtom = atom<CaptionSurface>((get) => {
  const media = get(screenShareMediaAtom);
  const pipOn = get(floatingPresenterAtom);
  const galleryOpen =
    get(galleryOpenAtom) || get(videoLayoutAtom) === "gallery";
  const poppedOut = get(captionPoppedOutAtom);

  const viewingRemote = media.remoteStream !== null;
  const localSharing = media.localActive;

  // Watching a remote share that's been popped out → the caption lives in that
  // separate window; the in-app surfaces stay quiet.
  if (viewingRemote && poppedOut) {
    return "popout";
  }
  // Gallery is a full-screen modal that covers the pane + canvas — captions ride
  // its bottom edge (so they're visible in grid / speaker view).
  if (galleryOpen) {
    return "gallery";
  }
  // Watching someone's shared screen in the in-app pane.
  if (viewingRemote) {
    return "pane";
  }
  // We're the presenter: ride the PiP when it's up, else a bottom overlay.
  if (localSharing) {
    return pipOn ? "presenter" : "overlay";
  }
  // Plain canvas (minimal / filmstrip), no share for us → the STT panel owns
  // captions; NO dock (kills the "redundant dock on the canvas" case).
  return "panel-only";
});
