// FILMSTRIP video surface — a horizontal RAIL of camera tiles docked to the
// bottom edge of the viewport (~140px tall, full width). Unlike the floating
// avatar strip, the rail is an OPAQUE bar so the canvas above it is clean and
// usable — the canvas is pushed up, not covered.
//
// Presentational only: it renders the SAME per-person `Tile[]` ParticipantsBar
// already builds (name / avatar / live camera stream / mic state), so there's no
// duplicate presence/identity logic — strip, filmstrip and gallery stay in
// lockstep. A tile shows the live <video> when the person's camera is on,
// otherwise their avatar. The active speaker (read from audio/videoPerf.ts) gets
// a green ring. Horizontal scroll when there are many tiles.

import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { activeSpeakerAtom, visibleTilesAtom } from "../../audio/videoPerf";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { TileVideo } from "./ParticipantsBar";
import { shortDisplayName } from "./animalEmoji";

import type { Tile } from "./ParticipantsBar";

import "./VideoFilmstrip.scss";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const VideoFilmstrip = ({
  tiles,
  selfSocketId,
  focusedSocketId,
  onPick,
}: {
  tiles: Tile[];
  selfSocketId: string;
  /** The ONE shared focused person (pin > screenshare > active-speaker > host >
   *  first), resolved in ParticipantsBar — ringed here so the filmstrip, the
   *  gallery-speaker stage and the floating PiP all agree on the presenter. */
  focusedSocketId?: string | null;
  /** Click a tile to toggle the local pin (promote to focus). */
  onPick?: (id: string) => void;
}) => {
  const t = useT();
  // Contract with the Daily-perf lane: the socketId of the current active
  // speaker (or null). We ring whichever tile id matches.
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  const setVisibleTiles = useSetAtom(visibleTilesAtom);

  // Tag <body> while the rail is up so global CSS can (a) raise the floating
  // bottom call controls above the 140px rail and (b) slim the people-bar to
  // just the layout switcher — the rail is the participant display now.
  useEffect(() => {
    document.body.classList.add("mcm-has-filmstrip");
    return () => document.body.classList.remove("mcm-has-filmstrip");
  }, []);

  // Phase 5 — visible-tile signalling for manual subscription + pagination.
  // Publish the socket.ids the rail is currently rendering so DailyAudio can
  // subscribe only these (+ active speaker) in a big meeting. Best-effort: the
  // rail renders every tile today, so this reports "all rendered" — honest, and
  // it lets DailyAudio drop nothing while paging on speaker/headcount instead.
  // Cleared on unmount so a layout switch back to "minimal" releases the signal
  // and DailyAudio falls back to automatic subscription.
  const visibleKey = tiles.map((tile) => tile.id).join("|");
  useEffect(() => {
    setVisibleTiles(new Set(tiles.map((tile) => tile.id)));
    return () => setVisibleTiles(new Set());
    // visibleKey captures the membership; tiles identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, setVisibleTiles]);

  return createPortal(
    <div
      className="mcm-filmstrip"
      role="region"
      aria-label={t("participants.label")}
    >
      <div className="mcm-filmstrip__rail">
        {tiles.map((tile) => {
          const isSpeaking = tile.id === activeSpeaker;
          const isFocused = tile.id === focusedSocketId;
          const clickable = !!onPick;
          return (
            <div
              key={tile.id}
              className={`mcm-filmstrip__tile${
                isSpeaking ? " mcm-filmstrip__tile--speaking" : ""
              }${isFocused ? " mcm-filmstrip__tile--focused" : ""}${
                clickable ? " mcm-filmstrip__tile--clickable" : ""
              }`}
              title={tile.name}
              data-socket-id={tile.id}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
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
                <div className="mcm-filmstrip__avatar">
                  <MCMAvatar
                    name={tile.name}
                    avatar={tile.avatarRaw ?? undefined}
                    email={tile.email ?? undefined}
                    identityKey={tile.email ?? tile.id}
                  />
                </div>
              )}
              <div className="mcm-filmstrip__label">
                {tile.inCall && !tile.micOn && (
                  <span
                    className="mcm-filmstrip__mic-off"
                    aria-label={t("participants.micOffAria")}
                  >
                    🔇
                  </span>
                )}
                <span className="mcm-filmstrip__name">
                  {shortDisplayName(tile.name)}
                  {tile.isMe ? ` (${t("participants.you")})` : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};

export default VideoFilmstrip;
