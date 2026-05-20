// Modal that lets the local participant set their display name,
// company, and avatar before / during the meeting. Auto-opens on
// first load (no saved profile) and reachable from the meeting
// header for later edits.
//
// Avatars come from two sources:
//   1. Built-in gallery in `public/decorations/avatars/NN.png` —
//      stored as `"lib:NN.png"` in the profile.
//   2. User-uploaded image — read as a data URL, resized below 256px
//      on the longest edge to keep the broadcast payload reasonable,
//      stored as the data URL itself.
//
// On Save, both the local user's `userProfileAtom` and (indirectly,
// via Collab's atom subscription) every peer's `peerProfilesAtom`
// receive the new values.

import { useEffect, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import {
  AVATAR_LIBRARY,
  resolveAvatarUrl,
  saveUserProfile,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import type { UserProfile } from "../../data/userProfile";

/** Resize an uploaded image to at most `maxDim` px on its longest
 *  edge, returning a PNG dataURL. Keeps the broadcast payload bounded
 *  (a 4K screenshot at full resolution would be 5-10MB which is
 *  excessive for a 60px avatar tile). */
const resizeImageToDataUrl = async (
  file: File,
  maxDim = 256,
): Promise<string> => {
  const reader = new FileReader();
  const dataUrl: string = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
  const scale = Math.min(
    1,
    maxDim / Math.max(img.naturalWidth, img.naturalHeight),
  );
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return dataUrl;
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the username field on first-open. Useful when Excalidraw
   *  already has a system-assigned name (e.g. "Friendly Otter") that
   *  the user might want to keep before they pick something custom. */
  defaultUsername?: string;
};

export const UserProfileModal = ({ open, onClose, defaultUsername }: Props) => {
  const t = useT();
  const profile = useAtomValue(userProfileAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const excalidrawAPI = useExcalidrawAPI();

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the form to the latest stored profile every time the modal
  // opens so a cancel + reopen doesn't carry stale edits.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(profile?.username ?? defaultUsername ?? "");
    setCompany(profile?.company ?? "");
    setAvatar(profile?.avatar);
    setUploadError(null);
  }, [open, profile, defaultUsername]);

  // Esc to dismiss without saving.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0;

  const handleSave = () => {
    if (!canSave) {
      return;
    }
    const next: UserProfile = {
      username: trimmedName,
      ...(company.trim() ? { company: company.trim() } : {}),
      ...(avatar ? { avatar } : {}),
    };
    saveUserProfile(next);
    // Keep Excalidraw's Collaborator.username in sync so the built-in
    // avatar list / mouse-pointer labels also reflect the new name.
    if (collabAPI) {
      collabAPI.setUsername(trimmedName);
    } else if (excalidrawAPI) {
      excalidrawAPI.updateScene({ appState: { name: trimmedName } });
    }
    onClose();
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setUploadError(t("profile.uploadInvalidType"));
      return;
    }
    try {
      const resized = await resizeImageToDataUrl(file);
      setAvatar(resized);
      setUploadError(null);
    } catch (err) {
      console.warn("[profile] avatar upload failed", err);
      setUploadError(t("profile.uploadFailed"));
    }
  };

  const previewUrl = resolveAvatarUrl(avatar);

  return (
    <div
      className="mcm-profile-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("profile.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="mcm-profile-modal__card" role="document">
        <header className="mcm-profile-modal__header">
          <h2 className="mcm-profile-modal__title">{t("profile.title")}</h2>
          <button
            type="button"
            className="mcm-profile-modal__close"
            onClick={onClose}
            aria-label={t("profile.close")}
            title={t("profile.close")}
          >
            ×
          </button>
        </header>

        <div className="mcm-profile-modal__body">
          <div className="mcm-profile-modal__preview">
            <div className="mcm-profile-modal__preview-avatar">
              {previewUrl ? (
                <img src={previewUrl} alt="" draggable={false} />
              ) : (
                <span className="mcm-profile-modal__preview-emoji" aria-hidden>
                  🙂
                </span>
              )}
            </div>
            <div className="mcm-profile-modal__preview-meta">
              <div className="mcm-profile-modal__preview-name">
                {trimmedName || t("profile.namePlaceholder")}
              </div>
              {company.trim() && (
                <div className="mcm-profile-modal__preview-company">
                  {company.trim()}
                </div>
              )}
            </div>
          </div>

          <label className="mcm-profile-modal__field">
            <span className="mcm-profile-modal__label">
              {t("profile.nameLabel")}
            </span>
            <input
              type="text"
              className="mcm-profile-modal__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("profile.namePlaceholder")}
              maxLength={48}
              autoFocus
            />
          </label>

          <label className="mcm-profile-modal__field">
            <span className="mcm-profile-modal__label">
              {t("profile.companyLabel")}
            </span>
            <input
              type="text"
              className="mcm-profile-modal__input"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t("profile.companyPlaceholder")}
              maxLength={48}
            />
          </label>

          <div className="mcm-profile-modal__avatar-section">
            <div className="mcm-profile-modal__avatar-header">
              <span className="mcm-profile-modal__label">
                {t("profile.avatarLabel")}
              </span>
              <div className="mcm-profile-modal__avatar-actions">
                <button
                  type="button"
                  className="mcm-profile-modal__avatar-action"
                  onClick={handleUploadClick}
                >
                  ⬆ {t("profile.uploadAvatar")}
                </button>
                {avatar && (
                  <button
                    type="button"
                    className="mcm-profile-modal__avatar-action mcm-profile-modal__avatar-action--ghost"
                    onClick={() => setAvatar(undefined)}
                  >
                    {t("profile.clearAvatar")}
                  </button>
                )}
              </div>
            </div>
            {uploadError && (
              <div className="mcm-profile-modal__error">{uploadError}</div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="mcm-profile-modal__file-input"
              onChange={handleUploadChange}
              aria-label={t("profile.uploadAvatar")}
            />
            <div className="mcm-profile-modal__gallery">
              {AVATAR_LIBRARY.map((file) => {
                const key = `lib:${file}`;
                const isSelected = avatar === key;
                return (
                  <button
                    key={file}
                    type="button"
                    className={`mcm-profile-modal__avatar-tile${
                      isSelected
                        ? " mcm-profile-modal__avatar-tile--selected"
                        : ""
                    }`}
                    onClick={() => setAvatar(key)}
                    aria-label={t("profile.pickAvatar", { name: file })}
                    aria-pressed={isSelected ? "true" : "false"}
                  >
                    <img
                      src={`/decorations/avatars/${file}`}
                      alt=""
                      loading="lazy"
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="mcm-profile-modal__footer">
          <button
            type="button"
            className="mcm-profile-modal__btn mcm-profile-modal__btn--ghost"
            onClick={onClose}
          >
            {t("profile.cancel")}
          </button>
          <button
            type="button"
            className="mcm-profile-modal__btn mcm-profile-modal__btn--primary"
            onClick={handleSave}
            disabled={!canSave}
          >
            {t("profile.save")}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default UserProfileModal;
