// Full-screen participant GALLERY (grid of everyone's camera, like Zoom/Meet).
//
// Presentational only: it renders the SAME per-person `Tile[]` ParticipantsBar
// already builds (name / avatar / live camera stream / speaking / mic state), so
// there is no duplicate presence/identity logic — the strip and the gallery stay
// in lockstep. A tile shows the live <video> when the person's camera is on,
// otherwise their avatar. The grid is responsive (auto-fit) and the active
// speaker gets a ring. Toggled via galleryOpenAtom from the participant strip.

import { useT } from "../../i18n/mcm";

import { useAtomValue } from "../../app-jotai";
import { activeSpeakerAtom } from "../../audio/videoPerf";

import { MCMAvatar } from "./Avatar";
import { TileVideo } from "./ParticipantsBar";

import type { Tile } from "./ParticipantsBar";

import "./MeetingGallery.scss";

export const MeetingGallery = ({
  tiles,
  selfSocketId,
  onClose,
}: {
  tiles: Tile[];
  selfSocketId: string;
  onClose: () => void;
}) => {
  const t = useT();
  // Ring on the Daily active-speaker (same signal the filmstrip uses) so both
  // surfaces agree on who's talking — including self.
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  return (
    <div className="mcm-gallery" role="dialog" aria-modal="true">
      <div className="mcm-gallery__bar">
        <span className="mcm-gallery__title">
          {t("gallery.title")} · {tiles.length}
        </span>
        <button
          type="button"
          className="mcm-gallery__close"
          onClick={onClose}
          aria-label={t("gallery.close")}
        >
          ✕ {t("gallery.close")}
        </button>
      </div>
      <div className="mcm-gallery__grid">
        {tiles.map((tile) => (
          <div
            key={tile.id}
            className={`mcm-gallery__tile${
              tile.id === activeSpeaker ? " mcm-gallery__tile--speaking" : ""
            }`}
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
        ))}
      </div>
    </div>
  );
};
