// Virtual-background preference for the in-meeting CAMERA video. Daily applies
// this as a video PROCESSOR on the same call object that publishes the camera
// (DailyAudio) — see DailyAudio.setVideoBackground / callObject
// .updateInputSettings({ video: { processor } }). Three kinds:
//
//   • none  → processor { type: "none" }  (raw camera)
//   • blur  → processor { type: "background-blur", config: { strength } }
//   • image → processor { type: "background-image", config: { source: <URL> } }
//
// The choice is a PER-BROWSER cosmetic preference (localStorage, NOT synced to
// the account — same policy as the dashboard wallpaper in data/wallpaper.ts),
// so it survives a reload and re-applies automatically the next time the user
// turns their camera on.
//
// Image sources are the SAME public preset photos the dashboard wallpaper
// picker uses (/backgrounds/*.{png,webp}). They're served as plain static
// assets (no auth), so Daily can fetch them by URL with the bare `source`
// string — unlike the R2 client backdrops (data/backdrops.ts), which are
// JWT-gated and would need an ArrayBuffer fetch. Public presets keep this
// simple and dependency-free.
//
// IMPORTANT (platform limit): Daily's background processors run ONLY on desktop
// browsers — they are a no-op / unsupported on mobile web. The UI gates the
// control to desktop (see isVideoBgSupported); this module just owns the state.

import Daily from "@daily-co/daily-js";

import { atom, appJotaiStore } from "../app-jotai";

const KEY = "mcm:videoBg";

/** Blur strengths exposed in the UI. Daily's `strength` is 0..1; these three
 *  presets cover "barely there" → "fully obscured" without a fiddly slider. */
export const BLUR_STRENGTHS = {
  light: 0.35,
  medium: 0.6,
  strong: 0.9,
} as const;

export type BlurLevel = keyof typeof BLUR_STRENGTHS;

export type VideoBg =
  | { kind: "none" }
  | { kind: "blur"; level: BlurLevel }
  /** `image` carries the public asset URL Daily fetches as the processor
   *  source (e.g. "/backgrounds/forest-mist.png"). */
  | { kind: "image"; src: string };

export const DEFAULT_VIDEO_BG: VideoBg = { kind: "none" };

/** A selectable image background. `src` is a public asset path (served at the
 *  site root) — usable directly as Daily's `background-image` source AND as the
 *  CSS thumbnail in the picker. */
export type VideoBgImagePreset = {
  id: string;
  /** i18n key under `videoBg.*` for the accessible label. */
  labelKey: "videoBg.imgForest" | "videoBg.imgCrystal" | "videoBg.imgOffice";
  src: string;
};

// Reuse the dashboard wallpaper photos (data/wallpaper.ts) + one company
// client backdrop already shipped under /public/backgrounds. All are public
// static assets, so the bare URL works as Daily's processor source.
export const VIDEO_BG_IMAGE_PRESETS: VideoBgImagePreset[] = [
  {
    id: "forest-mist",
    labelKey: "videoBg.imgForest",
    src: "/backgrounds/forest-mist.png",
  },
  {
    id: "crystal-leaves",
    labelKey: "videoBg.imgCrystal",
    src: "/backgrounds/crystal-leaves.png",
  },
  {
    id: "office-forest",
    labelKey: "videoBg.imgOffice",
    // PLACEHOLDER src. Daily's `background-image` processor accepts ONLY
    // jpg/jpeg/png (URL or ArrayBuffer) — a .webp source fails SILENTLY (no
    // processor attaches, camera publishes raw). The original
    // "/backgrounds/client-forest.webp" (and every other client-* backdrop
    // under /public/backgrounds) is webp, so there is no png/jpg "office/client"
    // asset to point at. The ONLY png/jpg presets shipped today are forest-mist
    // and crystal-leaves, so this placeholder must reuse one of them (it cannot
    // be visually unique until a real office png/jpg is added). We point at
    // crystal-leaves rather than ship a new binary asset; swap this for a real
    // png/jpg office backdrop once one is added to /public/backgrounds.
    src: "/backgrounds/crystal-leaves.png",
  },
];

/**
 * Whether Daily's video-background processors can run here. The AUTHORITATIVE
 * signal is Daily's own `supportedBrowser().supportsVideoProcessing` flag —
 * it covers the real requirements (WebGL + OffscreenCanvas, excludes desktop
 * Safari) far more accurately than a pointer/touch heuristic, so the toggle is
 * only shown where the processor will actually run (not where it silently
 * no-ops).
 *
 * The old coarse-pointer / touch heuristic is kept ONLY as a fallback for when
 * `supportedBrowser()` throws or returns nothing (defensive — the SDK probe
 * reads UA/feature state and could in principle fail). SSR-guarded throughout:
 * with no window/navigator there is nothing to run the processor on.
 */
export const isVideoBgSupported = (): boolean => {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  // Primary signal: Daily's official capability probe.
  try {
    const info = Daily.supportedBrowser();
    if (info && typeof info.supportsVideoProcessing === "boolean") {
      return info.supportsVideoProcessing;
    }
  } catch {
    // Probe threw (unexpected) — fall through to the legacy heuristic below so
    // the control still degrades gracefully rather than vanishing entirely.
  }
  // Fallback heuristic: a touch-only device (no fine pointer) is mobile/tablet
  // web. `pointer: fine` is present on anything with a mouse/trackpad (desktop
  // + hybrid laptops), absent on phones/tablets. Conservative — a hybrid device
  // reads as desktop, the safe default (worst case the toggle no-ops).
  const hasFinePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches;
  if (hasFinePointer) {
    return true;
  }
  // Final fallback when matchMedia is unavailable: treat a touch device as mobile.
  const touch = "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  return !touch;
};

const isVideoBg = (v: unknown): v is VideoBg => {
  if (!v || typeof v !== "object") {
    return false;
  }
  const k = (v as { kind?: unknown }).kind;
  if (k === "none") {
    return true;
  }
  if (k === "blur") {
    return (
      (v as { level?: unknown }).level != null &&
      (v as { level?: string }).level! in BLUR_STRENGTHS
    );
  }
  if (k === "image") {
    return typeof (v as { src?: unknown }).src === "string";
  }
  return false;
};

const loadVideoBg = (): VideoBg => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return DEFAULT_VIDEO_BG;
    }
    const parsed = JSON.parse(raw);
    return isVideoBg(parsed) ? (parsed as VideoBg) : DEFAULT_VIDEO_BG;
  } catch {
    return DEFAULT_VIDEO_BG;
  }
};

/** Current virtual-background choice. Initialised from localStorage at module
 *  load so DailyAudio.setCamera() can apply the persisted choice the moment the
 *  camera turns on, and the picker reflects it without a flash of "none". */
export const videoBgAtom = atom<VideoBg>(loadVideoBg());

/** Read the persisted choice synchronously (DailyAudio reads this when the
 *  camera comes up — it has no Jotai store handle of its own). */
export const getVideoBg = (): VideoBg => appJotaiStore.get(videoBgAtom);

/** Set + persist the choice. The UI also pushes it to the live call object so
 *  the change shows immediately (see MeetingCallControls). */
export const setVideoBgPref = (bg: VideoBg): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(bg));
  } catch {
    // Cosmetic-only — if storage is full the choice still applies for this
    // session; it just won't persist across reloads.
  }
  appJotaiStore.set(videoBgAtom, bg);
};

/** Translate a VideoBg into the Daily video PROCESSOR descriptor consumed by
 *  updateInputSettings({ video: { processor } }). Centralised here so DailyAudio
 *  and any future caller agree on the exact Daily shape. */
export const toDailyProcessor = (
  bg: VideoBg,
):
  | { type: "none" }
  | { type: "background-blur"; config: { strength: number } }
  | { type: "background-image"; config: { source: string } } => {
  if (bg.kind === "blur") {
    return {
      type: "background-blur",
      config: { strength: BLUR_STRENGTHS[bg.level] },
    };
  }
  if (bg.kind === "image") {
    return { type: "background-image", config: { source: bg.src } };
  }
  return { type: "none" };
};
