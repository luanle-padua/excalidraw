// Video-surface switcher popover — picks the mutually-exclusive SURFACE
// (minimal strip / bottom filmstrip / full-screen gallery) AND carries the
// orthogonal "Floating presenter" toggle, so every video-surface control lives
// in one popover. Lifted out of ParticipantsBar so the header (the only global
// layout control now) and any future caller can render the exact same control.
//
// Wiring: it reads/writes videoLayoutAtom and keeps the legacy galleryOpenAtom
// in lockstep via the shared usePickVideoLayout() hook (so "gallery" mode IS
// the gallery being open, no matter which signal a consumer reads).

import {
  Check,
  LayoutGrid,
  Minus,
  PanelBottom,
  PictureInPicture,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { floatingPresenterAtom } from "../../audio/videoFocus";
import { videoLayoutAtom, type VideoLayout } from "../../audio/videoLayout";
import { galleryOpenAtom } from "../../audio/videoState";
import { useT } from "../../i18n/mcm";

import type { McmKey } from "../../i18n/mcm";

const LAYOUT_MODES: {
  mode: VideoLayout;
  icon: typeof LayoutGrid;
  labelKey: McmKey;
}[] = [
  { mode: "minimal", icon: Minus, labelKey: "videoLayout.modeMinimal" },
  {
    mode: "filmstrip",
    icon: PanelBottom,
    labelKey: "videoLayout.modeFilmstrip",
  },
  { mode: "gallery", icon: LayoutGrid, labelKey: "videoLayout.modeGallery" },
];

/** Shared "pick the video surface" action: drive the persisted layout AND keep
 *  the legacy galleryOpenAtom consistent (true only in gallery mode) so both
 *  signals agree no matter which one a consumer reads. Used by the header
 *  switcher and the gallery's own grid↔speaker bar wouldn't need it, but the
 *  gallery close path does. */
export const usePickVideoLayout = (): ((mode: VideoLayout) => void) => {
  const setVideoLayout = useSetAtom(videoLayoutAtom);
  const setGalleryOpen = useSetAtom(galleryOpenAtom);
  return (mode: VideoLayout) => {
    setVideoLayout(mode);
    setGalleryOpen(mode === "gallery");
  };
};

/** Variant decides which class namespace the popover uses so it can sit either
 *  in the header actions cluster (default) or, historically, the people-bar. */
export const LayoutSwitcher = () => {
  const t = useT();
  const layout = useAtomValue(videoLayoutAtom);
  const pickLayout = usePickVideoLayout();
  const floating = useAtomValue(floatingPresenterAtom);
  const setFloating = useSetAtom(floatingPresenterAtom);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Esc — standard popover dismissal (copied verbatim
  // from the old in-strip switcher).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
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

  const ActiveIcon =
    LAYOUT_MODES.find((m) => m.mode === layout)?.icon ?? LayoutGrid;

  return (
    <div className="mcm-layout-switcher" ref={wrapRef}>
      <button
        type="button"
        className="mcm-header__icon-btn"
        title={t("videoLayout.switcherLabel")}
        aria-label={t("videoLayout.switcherLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* strokeWidth omitted → lucide default 2.0, matching every other 18px
            action icon in the header row (mic/cam/present/CC/invite/exit) so
            the whole cluster reads as one icon family. */}
        <ActiveIcon size={18} />
      </button>
      {open && (
        <div className="mcm-layout-switcher__menu" role="menu">
          {LAYOUT_MODES.map(({ mode, icon: Icon, labelKey }) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={layout === mode}
              className={`mcm-layout-switcher__item${
                layout === mode ? " mcm-layout-switcher__item--active" : ""
              }`}
              onClick={() => {
                pickLayout(mode);
                setOpen(false);
              }}
            >
              <Icon size={15} strokeWidth={1.8} />
              <span className="mcm-layout-switcher__label">{t(labelKey)}</span>
              {layout === mode && (
                <Check size={14} className="mcm-layout-switcher__check" />
              )}
            </button>
          ))}
          {/* Floating presenter is ORTHOGONAL to the surface (an overlay), so it
              is a separate toggle row, not a radio — checkable independently. */}
          <div className="mcm-layout-switcher__sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={floating}
            className={`mcm-layout-switcher__item${
              floating ? " mcm-layout-switcher__item--active" : ""
            }`}
            onClick={() => {
              setFloating((v) => !v);
              setOpen(false);
            }}
          >
            <PictureInPicture size={15} strokeWidth={1.8} />
            <span className="mcm-layout-switcher__label">
              {t("videoLayout.floating")}
            </span>
            {floating && (
              <Check size={14} className="mcm-layout-switcher__check" />
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default LayoutSwitcher;
