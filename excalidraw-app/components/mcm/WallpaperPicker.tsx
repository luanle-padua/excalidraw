import { Image as ImageIcon, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  DEFAULT_WALLPAPER,
  WALLPAPER_PRESETS,
  resizeWallpaperImage,
  setWallpaper,
  wallpaperAtom,
} from "../../data/wallpaper";

import "./Wallpaper.scss";

/**
 * Wallpaper picker — small glass popover (same pattern as the
 * NotificationBell dropdown) letting the user dress the dashboard desk with
 * a background image/gradient behind the glass panes. Yêu cầu anh Luân
 * 06-12. Choosing a tile applies instantly (data-attr + --mcm-wallpaper on
 * .mcm-lobby, painted by Wallpaper.scss) and persists to localStorage.
 *
 * Mounted in the lobby header cluster (MeetingLobby), next to
 * NotificationBell. Labels hardcoded Vietnamese (i18n tạm dừng).
 */
export const WallpaperPicker = () => {
  const current = useAtomValue(wallpaperAtom);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const customActive = current.kind === "custom" && !!current.value;

  // Upload riêng (yêu cầu anh Luân 06-12): resize/nén client-side TRƯỚC khi
  // persist — localStorage chỉ nhận data URL đã downscale ≤1920/JPEG q0.8.
  const pickFile = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) {
      return;
    }
    let dataURL: string;
    try {
      dataURL = await resizeWallpaperImage(file);
    } catch {
      window.alert("Không đọc được ảnh, chọn ảnh khác");
      return;
    }
    if (!setWallpaper({ kind: "custom", value: dataURL })) {
      // QuotaExceeded — even after compression (rare; near-full quota).
      window.alert("Ảnh quá lớn, chọn ảnh khác");
    }
  };

  // Click anywhere outside closes the panel (same as NotificationBell).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="mcm-wallp" ref={rootRef}>
      <button
        type="button"
        className="mcm-wallp__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Hình nền"
        title="Hình nền"
        aria-expanded={open}
      >
        <ImageIcon size={17} />
      </button>

      {open && (
        <div className="mcm-wallp__panel" role="dialog" aria-label="Hình nền">
          <div className="mcm-wallp__head">Hình nền</div>
          <div className="mcm-wallp__grid">
            {WALLPAPER_PRESETS.map((p) => {
              const active =
                current.kind === p.wallpaper.kind &&
                current.value === p.wallpaper.value;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`mcm-wallp__tile${
                    active ? " mcm-wallp__tile--active" : ""
                  }`}
                  onClick={() => setWallpaper(p.wallpaper)}
                  aria-pressed={active}
                  title={p.label}
                >
                  <span
                    className={`mcm-wallp__thumb${
                      p.thumb ? "" : " mcm-wallp__thumb--none"
                    }`}
                    style={p.thumb ? { backgroundImage: p.thumb } : undefined}
                  />
                  <span className="mcm-wallp__label">{p.label}</span>
                </button>
              );
            })}

            {/* Ô upload — cuối grid. Wrapper là div (không lồng button
                trong button): nút chính mở file picker (hoặc đổi ảnh khi
                đang active), nút x nhỏ gỡ về Mặc định. */}
            <div
              className={`mcm-wallp__tile mcm-wallp__tile--upload${
                customActive ? " mcm-wallp__tile--active" : ""
              }`}
            >
              <button
                type="button"
                className="mcm-wallp__upbtn"
                onClick={() => fileRef.current?.click()}
                aria-pressed={customActive}
                title={customActive ? "Đổi ảnh đã tải lên" : "Tải ảnh lên"}
              >
                <span
                  className={`mcm-wallp__thumb mcm-wallp__thumb--upload${
                    customActive ? "" : " mcm-wallp__thumb--empty"
                  }`}
                  style={
                    customActive
                      ? { backgroundImage: `url("${current.value}")` }
                      : undefined
                  }
                >
                  {!customActive && <Upload size={15} />}
                </span>
                <span className="mcm-wallp__label">
                  {customActive ? "Ảnh của bạn" : "Tải ảnh lên"}
                </span>
              </button>
              {customActive && (
                <button
                  type="button"
                  className="mcm-wallp__remove"
                  onClick={() => setWallpaper(DEFAULT_WALLPAPER)}
                  aria-label="Gỡ ảnh, về Mặc định"
                  title="Gỡ ảnh, về Mặc định"
                >
                  <X size={11} />
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = ""; // cho phép chọn lại đúng file cũ
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WallpaperPicker;
