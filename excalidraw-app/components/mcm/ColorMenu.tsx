// Shared cosmetic popover menus for the dashboard (extracted from
// ProjectBrowser, UI-2 06-12) so meeting cards AND the project manager use
// one implementation:
//   • ColorMenu — preset swatch row + a "none" option that clears back to
//     the default accent.
//   • EmojiMenu — emoji grid + clear, for the meeting/project icon. NOTE:
//     the meeting-icon (UI-1) task landed its own inline copy in
//     ProjectBrowser at the same time this file was created; that copy was
//     folded in here (same props, its MEETING_ICON_PRESETS kept as the
//     default `presets`) — import from "./ColorMenu", don't redefine.
//
// Both render in a portal positioned just under their trigger so scroll
// containers can't clip them, and close on outside-click / Esc. Cell styles:
// .mcm-swatches__dot (MeetingShell.scss) / .mcm-swatches__emoji
// (ProjectManager.scss — parked there while MeetingShell.scss is under
// concurrent edit).

import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { MEETING_COLOR_PRESETS } from "./meetingColors";

// Work-themed emoji presets for the meeting-icon picker (kiến trúc/xây dựng
// + generic meeting glyphs). Cosmetic, like MEETING_COLOR_PRESETS.
export const MEETING_ICON_PRESETS: readonly string[] = [
  "📐",
  "🏗️",
  "📋",
  "💡",
  "🔍",
  "📊",
  "🤝",
  "🎯",
  "⚡",
  "🧱",
  "🪟",
  "🚪",
  "🛗",
  "🌿",
  "🔥",
  "💧",
  "⚙️",
  "📁",
  "🗓️",
  "✅",
  "❓",
  "🚧",
  "🎨",
  "📌",
] as const;

// Building/place flavoured presets for the PROJECT icon (a project is a
// site/building; a meeting is an activity).
export const PROJECT_ICON_PRESETS: readonly string[] = [
  "🏢",
  "🏠",
  "🏗️",
  "🏭",
  "🏥",
  "🏫",
  "🏛️",
  "🌉",
  "🛣️",
  "✈️",
  "⚓",
  "🌳",
  "💧",
  "⚡",
  "🧱",
  "📐",
  "🗺️",
  "📌",
  "⭐",
  "🔥",
  "💡",
  "🎯",
] as const;

/** Outside-click + Esc dismissal, shared by both menus. */
const useDismiss = (
  ref: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
) => {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
};

// Clamp the fixed popover to the viewport (the .mcm-swatches--pop shell is
// 232px wide). `headroom` = expected popover height-ish margin at the bottom.
const popPosition = (anchor: DOMRect, headroom: number) => ({
  top: Math.min(anchor.bottom + 6, window.innerHeight - headroom),
  left: Math.max(8, Math.min(anchor.right - 224, window.innerWidth - 232)),
});

// Portal into .mcm-shell (NOT document.body) so the --mcm-* design tokens —
// surface/hairline/elev/dark-mode — resolve; on body they'd be undefined and
// the popover would render with no background.
const portalTarget = () =>
  document.querySelector(".mcm-shell") ?? document.body;

/**
 * Small colour picker popover — a row of preset swatches plus a "none"
 * option that clears the colour back to the default.
 */
export const ColorMenu = ({
  anchor,
  current,
  onPick,
  onClose,
  clearLabel,
}: {
  anchor: DOMRect;
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
  clearLabel: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const { top, left } = popPosition(anchor, 80);

  return createPortal(
    <div
      className="mcm-swatches mcm-swatches--pop"
      ref={ref}
      style={{ position: "fixed", top, left } as React.CSSProperties}
    >
      {MEETING_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          className={`mcm-swatches__dot${
            current?.toLowerCase() === c.toLowerCase()
              ? " mcm-swatches__dot--active"
              : ""
          }`}
          style={{ ["--swatch" as string]: c } as React.CSSProperties}
          onClick={() => onPick(c)}
          aria-label={c}
          title={c}
        >
          {current?.toLowerCase() === c.toLowerCase() && <Check size={12} />}
        </button>
      ))}
      <button
        type="button"
        className="mcm-swatches__clear"
        onClick={() => onPick(null)}
        title={clearLabel}
      >
        {clearLabel}
      </button>
    </div>,
    portalTarget(),
  );
};

/**
 * Small emoji picker popover for the icon accent — same portal/outside-click/
 * Esc pattern as ColorMenu, a grid of work emoji plus a clear option.
 * `presets` defaults to the meeting set; the project manager passes
 * PROJECT_ICON_PRESETS.
 */
export const EmojiMenu = ({
  anchor,
  current,
  onPick,
  onClose,
  clearLabel,
  presets = MEETING_ICON_PRESETS,
}: {
  anchor: DOMRect;
  current: string | null;
  onPick: (icon: string | null) => void;
  onClose: () => void;
  clearLabel: string;
  presets?: readonly string[];
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  // Taller than the colour row, so clamp with more headroom.
  const { top, left } = popPosition(anchor, 180);

  return createPortal(
    <div
      className="mcm-swatches mcm-swatches--pop"
      ref={ref}
      style={{ position: "fixed", top, left } as React.CSSProperties}
    >
      {presets.map((ic) => (
        <button
          key={ic}
          type="button"
          className={`mcm-swatches__emoji${
            current === ic ? " mcm-swatches__emoji--active" : ""
          }`}
          onClick={() => onPick(ic)}
          aria-label={ic}
          title={ic}
        >
          {ic}
        </button>
      ))}
      <button
        type="button"
        className="mcm-swatches__clear"
        onClick={() => onPick(null)}
        title={clearLabel}
      >
        {clearLabel}
      </button>
    </div>,
    portalTarget(),
  );
};
