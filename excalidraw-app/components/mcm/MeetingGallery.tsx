// Full-screen participant GALLERY (grid of everyone's camera, like Zoom/Meet),
// PLUS a "speaker" sub-mode that promotes one focused person to a big tile with
// the rest in a strip below.
//
// Presentational only: it renders the SAME per-person `Tile[]` ParticipantsBar
// already builds (name / avatar / live camera stream / speaking / mic state), so
// there is no duplicate presence/identity logic — the strip and the gallery stay
// in lockstep. A tile shows the live <video> when the person's camera is on,
// otherwise their avatar. The grid is responsive (auto-fit) and the active
// speaker gets a ring. Toggled via galleryOpenAtom from the participant strip.
//
// The focused person (speaker sub-mode big tile) follows the ONE shared focus
// model (pin > screenshare > active-speaker > host > first), computed in
// ParticipantsBar and passed down — clicking any tile toggles the local pin.

import { LayoutGrid, Pin, PinOff, SquareUser } from "lucide-react";

import { useT } from "../../i18n/mcm";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { gallerySubModeAtom } from "../../audio/videoFocus";
import { activeSpeakerAtom } from "../../audio/videoPerf";

import { MCMAvatar } from "./Avatar";
import { TileVideo } from "./ParticipantsBar";

import type { Tile } from "./ParticipantsBar";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import "./MeetingGallery.scss";

// One reusable tile renderer — used by the responsive grid, the speaker big
// tile and the speaker bottom strip so the camera/avatar/label rules never
// drift. `variant` only changes class namespace + label verbosity.
const GalleryTile = ({
  tile,
  selfSocketId,
  activeSpeaker,
  focused,
  pinned,
  onPick,
}: {
  tile: Tile;
  selfSocketId: string;
  activeSpeaker: string | null;
  /** This tile is the resolved focus (rings + pin glyph affordance). */
  focused: boolean;
  /** This tile is the MANUAL pin (shows the explicit Unpin affordance). */
  pinned: boolean;
  onPick?: (id: string) => void;
}) => {
  const t = useT();
  const speaking = tile.id === activeSpeaker;
  const clickable = !!onPick;
  return (
    <div
      className={`mcm-gallery__tile${
        speaking ? " mcm-gallery__tile--speaking" : ""
      }${focused ? " mcm-gallery__tile--focused" : ""}${
        clickable ? " mcm-gallery__tile--clickable" : ""
      }`}
      data-socket-id={tile.id}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            title: pinned ? t("gallery.unpin") : t("gallery.pinHint"),
            onClick: () => onPick(tile.id),
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(tile.id);
              }
            },
          }
        : {})}
    >
      {tile.videoStream ? (
        <TileVideo
          stream={tile.videoStream}
          mirror={tile.isMe ?? tile.id === selfSocketId}
        />
      ) : (
        <div className="mcm-gallery__avatar">
          <MCMAvatar
            name={tile.name}
            avatar={tile.avatarRaw ?? undefined}
            email={tile.email ?? undefined}
            identityKey={tile.email ?? tile.id}
          />
        </div>
      )}
      {pinned && (
        <span className="mcm-gallery__pin" title={t("gallery.unpin")}>
          <PinOff size={13} strokeWidth={2} /> {t("gallery.unpin")}
        </span>
      )}
      {!pinned && focused && (
        <span
          className="mcm-gallery__pin mcm-gallery__pin--auto"
          aria-hidden="true"
        >
          <Pin size={13} strokeWidth={2} />
        </span>
      )}
      <div className="mcm-gallery__label">
        {!tile.micOn && (
          <span className="mcm-gallery__mic-off" aria-hidden="true">
            🔇
          </span>
        )}
        <span className="mcm-gallery__name">
          {tile.name}
          {tile.isMe ? ` (${t("gallery.you")})` : ""}
        </span>
        {tile.isHost && (
          <span className="mcm-gallery__host">{t("gallery.host")}</span>
        )}
      </div>
    </div>
  );
};

export const MeetingGallery = ({
  tiles,
  selfSocketId,
  focusedSocketId,
  pinnedSocketId,
  onPick,
  onClose,
}: {
  tiles: Tile[];
  selfSocketId: string;
  /** The ONE shared focused person (pin > screenshare > active-speaker > host >
   *  first), resolved in ParticipantsBar. */
  focusedSocketId: string | null;
  /** The MANUAL pin (or null) — distinguishes an explicit pin (shows "Unpin")
   *  from an auto-focus (quiet pin glyph). */
  pinnedSocketId: string | null;
  /** Toggle the local pin on the clicked tile. */
  onPick: (id: string) => void;
  onClose: () => void;
}) => {
  const t = useT();
  // Ring on the Daily active-speaker (same signal the filmstrip uses) so both
  // surfaces agree on who's talking — including self.
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  const subMode = useAtomValue(gallerySubModeAtom);
  const setSubMode = useSetAtom(gallerySubModeAtom);

  const focusTile =
    tiles.find((tile) => tile.id === focusedSocketId) ?? tiles[0] ?? null;
  const others = tiles.filter((tile) => tile.id !== focusTile?.id);

  return (
    <div className="mcm-gallery" role="dialog" aria-modal="true">
      <div className="mcm-gallery__bar">
        <span className="mcm-gallery__title">
          {t("gallery.title")} · {tiles.length}
        </span>
        {/* Grid ↔ Speaker sub-mode — a per-user view preference. */}
        <div className="mcm-gallery__submode" role="group">
          <button
            type="button"
            className={`mcm-gallery__submode-btn${
              subMode === "grid" ? " mcm-gallery__submode-btn--active" : ""
            }`}
            aria-pressed={subMode === "grid"}
            onClick={() => setSubMode("grid")}
            title={t("gallery.subGrid")}
          >
            <LayoutGrid size={15} strokeWidth={1.9} />
            {t("gallery.subGrid")}
          </button>
          <button
            type="button"
            className={`mcm-gallery__submode-btn${
              subMode === "speaker" ? " mcm-gallery__submode-btn--active" : ""
            }`}
            aria-pressed={subMode === "speaker"}
            onClick={() => setSubMode("speaker")}
            title={t("gallery.subSpeaker")}
          >
            <SquareUser size={15} strokeWidth={1.9} />
            {t("gallery.subSpeaker")}
          </button>
        </div>
        <button
          type="button"
          className="mcm-gallery__close"
          onClick={onClose}
          aria-label={t("gallery.close")}
        >
          ✕ {t("gallery.close")}
        </button>
      </div>

      {subMode === "grid" || !focusTile ? (
        <div className="mcm-gallery__grid">
          {tiles.map((tile) => (
            <GalleryTile
              key={tile.id}
              tile={tile}
              selfSocketId={selfSocketId}
              activeSpeaker={activeSpeaker}
              focused={tile.id === focusedSocketId}
              pinned={tile.id === pinnedSocketId}
              onPick={onPick}
            />
          ))}
        </div>
      ) : (
        <div className="mcm-gallery__speaker">
          <div className="mcm-gallery__stage">
            <GalleryTile
              key={focusTile.id}
              tile={focusTile}
              selfSocketId={selfSocketId}
              activeSpeaker={activeSpeaker}
              focused
              pinned={focusTile.id === pinnedSocketId}
              onPick={onPick}
            />
          </div>
          {others.length > 0 && (
            <div
              className="mcm-gallery__rail"
              aria-label={t("gallery.subSpeaker")}
            >
              {others.map((tile) => (
                <GalleryTile
                  key={tile.id}
                  tile={tile}
                  selfSocketId={selfSocketId}
                  activeSpeaker={activeSpeaker}
                  focused={false}
                  pinned={tile.id === pinnedSocketId}
                  onPick={onPick}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
