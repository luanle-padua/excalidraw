// Dashboard wallpaper preference — yêu cầu anh Luân 06-12: "user cần được
// tùy chỉnh giao diện của app ở mức đổi hình nền … để làm đẹp thêm hiệu ứng
// glass". Per-browser preference (localStorage, NOT synced to the account —
// cosmetic only), read once at module init so the first paint already has it.
//
// The wallpaper itself is applied in CSS (components/mcm/Wallpaper.scss):
// `.mcm-lobby[data-mcm-wallpaper]` + inline `--mcm-wallpaper` var paint
// a static cover image under the 3-col desk, behind a THIN
// `--mcm-wall-scrim` veil. 06-12 frosted-mirror rev (PM đảo hướng: "cho rõ
// lên đi"): the image renders SHARP — frost lives on the glass panes'
// backdrop-filter instead. The attr VALUE still tells the CSS the material:
// "image" (preset file or custom upload — desk-level labels get a
// legibility text-shadow) vs "flat" (gradient — no helper needed).
// This module only owns the STATE + the DOM-side application of that
// data-attr/var pair.

import { atom, appJotaiStore } from "../app-jotai";

const KEY = "mcm:wallpaper";

export type Wallpaper = {
  kind: "none" | "preset" | "gradient" | "custom";
  /** preset → image path under /backgrounds; gradient → full CSS gradient;
   *  custom → data URL of a user-uploaded image (resized client-side);
   *  none → "" (the Glass-Desk gradient from MeetingShell.scss shows). */
  value: string;
};

export const DEFAULT_WALLPAPER: Wallpaper = { kind: "none", value: "" };

// Two subtle gradients tuned to the Glass-Desk palette: one champagne-on-
// olive for the dark "lamplight on green leather" read, one bright pastel
// for light. Both deliberately low-chroma so glass panes stay readable.
const GRAD_OLIVE_CHAMPAGNE =
  "linear-gradient(135deg, #14180f 0%, #232a1a 38%, #3a3a26 72%, #585032 100%)";
const GRAD_PASTEL_DAY =
  "linear-gradient(135deg, #f3efe7 0%, #e9eef7 45%, #eee7f2 78%, #e6f0ea 100%)";

export type WallpaperPreset = {
  id: string;
  /** Hardcoded Vietnamese — i18n đang tạm dừng (06-12). */
  label: string;
  wallpaper: Wallpaper;
  /** CSS background-image for the picker thumbnail ("" = the default tile,
   *  styled in Wallpaper.scss to mimic the desk gradient). */
  thumb: string;
};

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: "none",
    label: "Mặc định",
    wallpaper: DEFAULT_WALLPAPER,
    thumb: "",
  },
  {
    id: "forest-mist",
    label: "Rừng sương",
    wallpaper: { kind: "preset", value: "/backgrounds/forest-mist.png" },
    thumb: 'url("/backgrounds/forest-mist.png")',
  },
  {
    id: "crystal-leaves",
    label: "Lá pha lê",
    wallpaper: { kind: "preset", value: "/backgrounds/crystal-leaves.png" },
    thumb: 'url("/backgrounds/crystal-leaves.png")',
  },
  {
    id: "olive-champagne",
    label: "Olive sâm panh",
    wallpaper: { kind: "gradient", value: GRAD_OLIVE_CHAMPAGNE },
    thumb: GRAD_OLIVE_CHAMPAGNE,
  },
  {
    id: "pastel-day",
    label: "Pastel sáng",
    wallpaper: { kind: "gradient", value: GRAD_PASTEL_DAY },
    thumb: GRAD_PASTEL_DAY,
  },
];

const isKind = (k: unknown): k is Wallpaper["kind"] =>
  k === "none" || k === "preset" || k === "gradient" || k === "custom";

const loadWallpaper = (): Wallpaper => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return DEFAULT_WALLPAPER;
    }
    const p = JSON.parse(raw);
    return isKind(p?.kind) && typeof p?.value === "string"
      ? { kind: p.kind, value: p.value }
      : DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;
  }
};

/** Initialised from localStorage at module load — components that mount the
 *  lobby can apply it on first render without waiting for any effect. */
export const wallpaperAtom = atom<Wallpaper>(loadWallpaper());

/** The value Wallpaper.scss expects in `--mcm-wallpaper` (a CSS
 *  <image> — url() for file presets, the gradient string as-is). */
export const wallpaperCssImage = (w: Wallpaper): string | null => {
  if ((w.kind === "preset" || w.kind === "custom") && w.value) {
    return `url("${w.value}")`;
  }
  if (w.kind === "gradient" && w.value) {
    return w.value;
  }
  return null;
};

/** Stamp the data-attr + inline var pair Wallpaper.scss keys on. The lobby
 *  root (MeetingLobby) calls this in its ref callback so the persisted
 *  choice paints on first render. */
export const applyWallpaperToElement = (
  el: HTMLElement,
  w: Wallpaper,
): void => {
  const css = wallpaperCssImage(w);
  if (css) {
    // "image" → Wallpaper.scss adds a text-shadow helper for desk-level
    // labels (photo behind); "flat" (gradients) needs no helper.
    el.dataset.mcmWallpaper = w.kind === "gradient" ? "flat" : "image";
    el.style.setProperty("--mcm-wallpaper", css);
  } else {
    delete el.dataset.mcmWallpaper;
    el.style.removeProperty("--mcm-wallpaper");
  }
};

/** Set + persist + apply immediately to every mounted lobby root (there is
 *  at most one, but querySelectorAll keeps this side effect idempotent).
 *
 *  Returns false when a CUSTOM image could not be persisted (QuotaExceeded —
 *  data URLs eat into the ~5MB origin cap): we then deliberately do NOT
 *  apply it either (it would vanish on reload, worse than failing loudly),
 *  so the caller can tell the user to pick a smaller image. Presets and
 *  gradients are a few bytes — if storage still fails for them we apply
 *  for the session anyway and report success. */
export const setWallpaper = (w: Wallpaper): boolean => {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    if (w.kind === "custom") {
      return false;
    }
  }
  appJotaiStore.set(wallpaperAtom, w);
  document
    .querySelectorAll<HTMLElement>(".mcm-lobby")
    .forEach((el) => applyWallpaperToElement(el, w));
  return true;
};

/** Downscale + recompress a user-picked wallpaper file BEFORE it goes to
 *  localStorage: long edge capped (default 1920 — a wallpaper never needs
 *  more), re-encoded as JPEG q0.8 (drops alpha — irrelevant under the desk
 *  scrim; ~5-10× smaller than PNG so the data URL stays well under quota).
 *  Same recipe as MetadataEditor's cover resize, kept here as its own util
 *  so components don't import each other for it. */
export const resizeWallpaperImage = (
  file: File,
  maxEdge = 1920,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image load failed"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas 2d unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
