// Shared IMAGE row for the virtual-background pickers: the curated preset
// thumbnails + a "custom upload" tile. Used by BOTH the in-call camera popover
// (MeetingBlurControl) and the User Settings → Preferences picker, so image
// selection looks and behaves identically in both places (DRY — one upload path,
// one thumbnail style).
//
// Custom upload: Daily's background-image processor accepts a data-URL string as
// its `source`, so we read the picked file, downscale + re-encode it to a small
// JPEG data URL via resizeWallpaperImage (the same util the dashboard wallpaper
// uses), then hand it back as { kind:"image", src:<dataURL> }. That src persists
// in localStorage like any preset and re-applies on the next camera-on — no R2
// upload, no CORS, fully client-side. Only jpg/jpeg/png are accepted (Daily's
// format whitelist; other formats fail silently).

import { Upload } from "lucide-react";
import { useRef } from "react";

import { VIDEO_BG_IMAGE_PRESETS, type VideoBg } from "../../audio/videoBg";
import { resizeWallpaperImage } from "../../data/wallpaper";
import { useT } from "../../i18n/mcm";

import "./VideoBgImageRow.scss";

// Cap the custom image at 1280px long-edge: matches the 720p camera capture, keeps
// the base64 data URL well under the localStorage quota, and speeds Daily's first
// texture upload. resizeWallpaperImage re-encodes as JPEG q0.8.
const CUSTOM_MAX_EDGE = 1280;

export const VideoBgImageRow = ({
  current,
  onPick,
  disabled = false,
}: {
  current: VideoBg;
  onPick: (bg: VideoBg) => void;
  disabled?: boolean;
}) => {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // A "custom" background is an image whose src is an uploaded data URL (not one
  // of the same-origin preset paths). Used to light up the upload tile + paint it
  // with the chosen image.
  const isCustom =
    current.kind === "image" && current.src.startsWith("data:");

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the SAME file again still fires onChange.
    e.target.value = "";
    if (!file) {
      return;
    }
    try {
      const src = await resizeWallpaperImage(file, CUSTOM_MAX_EDGE);
      onPick({ kind: "image", src });
    } catch {
      // Bad/undecodable image — ignore; the current background stays.
    }
  };

  return (
    <div
      className="mcm-vbg-row"
      role="radiogroup"
      aria-label={t("videoBg.images")}
    >
      {VIDEO_BG_IMAGE_PRESETS.map((preset) => {
        const active = current.kind === "image" && current.src === preset.src;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`mcm-vbg-thumb${active ? " --active" : ""}`}
            style={{ backgroundImage: `url("${preset.src}")` }}
            onClick={() => onPick({ kind: "image", src: preset.src })}
            title={t(preset.labelKey)}
            aria-label={t(preset.labelKey)}
          />
        );
      })}

      {/* Custom upload — paints itself with the chosen image when active. */}
      <button
        type="button"
        disabled={disabled}
        className={`mcm-vbg-thumb mcm-vbg-thumb--upload${
          isCustom ? " --active" : ""
        }`}
        style={
          isCustom ? { backgroundImage: `url("${current.src}")` } : undefined
        }
        onClick={() => fileRef.current?.click()}
        title={t("videoBg.custom")}
        aria-label={t("videoBg.custom")}
      >
        {!isCustom && <Upload size={16} aria-hidden />}
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={onFile}
      />
    </div>
  );
};

export default VideoBgImageRow;
