// In-call "blur background" control, anchored RIGHT NEXT to the camera toggle
// (where the user manages video). It is a compact header icon button that opens
// a small opaque popover to pick None / Blur (light · medium · strong).
//
// State is the SAME shared atom + helpers the User Settings → Preferences picker
// uses (videoBgAtom / setVideoBgPref / audioRoom.setVideoBackground), so the two
// surfaces stay in sync automatically: choose blur here and the settings picker
// reflects it (and vice-versa) with no extra wiring.
//
// Gated by isVideoBgSupported() — Daily's background processors are DESKTOP-only
// (no-op on iPad / phone web), so on an unsupported device the button renders
// nothing rather than offering a control that silently does nothing.
//
// Glass-dropdown footgun: the popover surface is OPAQUE (var(--mcm-surface)),
// and we deliberately do NOT add backdrop-filter to it or to any ancestor — a
// blurred ancestor traps/clips a position:absolute child. The styles live in a
// dedicated SCSS so no glass mixin ever wraps this menu.

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { audioRoomInstanceAtom } from "../../audio/audioState";
import {
  BLUR_STRENGTHS,
  isVideoBgSupported,
  setVideoBgPref,
  videoBgAtom,
  type BlurLevel,
  type VideoBg,
} from "../../audio/videoBg";
import { useT } from "../../i18n/mcm";

import { VideoBgImageRow } from "./VideoBgImageRow";

import "./MeetingBlurControl.scss";

const ICON_SIZE = 18;

// Stable, ordered blur levels for the chip row (light → strong). Derived from
// the single source of truth in videoBg.ts so adding a strength there flows
// through here automatically.
const BLUR_LEVELS = Object.keys(BLUR_STRENGTHS) as BlurLevel[];

export const MeetingBlurControl = () => {
  const t = useT();
  const videoBg = useAtomValue(videoBgAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);

  // Probe Daily's desktop-only capability ONCE (it can't change for the life of
  // the page). A bare call in render would re-probe every render; useState locks
  // the value in. When unsupported we render nothing — no dead control.
  const [supported] = useState(isVideoBgSupported);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Escape — same pattern as the reactions popover.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        e.target instanceof Node &&
        !wrapRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!supported) {
    return null;
  }

  // Persist the choice (survives reload + auto-applies on the next camera-on —
  // videoBg.ts owns that) AND push it to the live call now so an already-on
  // camera updates instantly. Fire-and-forget: a processor failure must never
  // break the picker. Mirrors UserSettings.applyVideoBg so the two stay aligned.
  const apply = (bg: VideoBg) => {
    setVideoBgPref(bg);
    void audioRoom?.setVideoBackground(bg).catch(() => undefined);
    setOpen(false);
  };

  // "On" = any active effect (the icon highlights when a background is applied).
  const active = videoBg.kind !== "none";

  return (
    <div className="mcm-blur-control" ref={wrapRef}>
      <button
        type="button"
        className={`mcm-header__icon-btn mcm-tip${
          active || open ? " mcm-header__icon-btn--active" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
        data-mcm-tip={t("videoBg.title")}
        aria-label={t("videoBg.title")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Sparkles size={ICON_SIZE} />
      </button>

      {open && (
        <div className="mcm-blur-control__popover">
          <div
            className="mcm-blur-control__group"
            role="radiogroup"
            aria-label={t("videoBg.title")}
          >
            <button
              type="button"
              role="radio"
              aria-checked={videoBg.kind === "none"}
              className={`mcm-blur-control__chip${
                videoBg.kind === "none" ? " --active" : ""
              }`}
              onClick={() => apply({ kind: "none" })}
            >
              {t("videoBg.none")}
            </button>

            {BLUR_LEVELS.map((level) => {
              const isActive =
                videoBg.kind === "blur" && videoBg.level === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={`mcm-blur-control__chip${
                    isActive ? " --active" : ""
                  }`}
                  onClick={() => apply({ kind: "blur", level })}
                >
                  {t("videoBg.blur")} · {t(`videoBg.blur_${level}`)}
                </button>
              );
            })}
          </div>

          {/* Image presets + custom upload — same shared row as Settings. */}
          <VideoBgImageRow current={videoBg} onPick={apply} />
        </div>
      )}
    </div>
  );
};

export default MeetingBlurControl;
