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

import { useEffect, useRef } from "react";

import { LayoutGrid, MonitorUp, Pin, PinOff, SquareUser } from "lucide-react";

import { useT } from "../../i18n/mcm";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  galleryOwnsScreenAtom,
  gallerySubModeAtom,
  resolveGallerySubMode,
} from "../../audio/videoFocus";
import { activeSpeakerAtom, visibleTilesAtom } from "../../audio/videoPerf";
import { captionSurfaceAtom } from "../../data/captionState";
import { screenShareMediaAtom } from "../../screenshare/screenShareState";

import { MCMAvatar } from "./Avatar";
import { LiveCaptionDock } from "./LiveCaptionDock";
import { TileVideo } from "./ParticipantsBar";

import type { Tile } from "./ParticipantsBar";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import "./MeetingGallery.scss";

// Mounts the shared SCREEN stream into the "together"-layout stage. Mirrors the
// ScreenSharePane <video> binding (imperative srcObject, object-fit:contain on a
// black well) so the same MediaStream renders identically whether it lands here
// (gallery stage) or in the floating pane — only one is mounted at a time.
const ScreenStage = ({
  stream,
  label,
}: {
  stream: MediaStream;
  label: string;
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
    return () => {
      // Release the track on unmount / stream swap so the well never freezes.
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);
  return (
    <div className="mcm-gallery__screen-well">
      <video
        ref={videoRef}
        className="mcm-gallery__screen-video"
        autoPlay
        playsInline
        muted
      />
      {label && <span className="mcm-gallery__screen-tag">{label}</span>}
    </div>
  );
};

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
  const rawSubMode = useAtomValue(gallerySubModeAtom);
  const setSubMode = useSetAtom(gallerySubModeAtom);

  // Shared screen for the Zoom-style "together" layout. A VIEWER gets the remote
  // presenter's stream; the SHARER themselves has no remoteStream but can preview
  // their OWN screen via localStream — so the presenter also sees the together
  // layout (what everyone else sees) instead of a blank stage.
  const screenMedia = useAtomValue(screenShareMediaAtom);
  const screenStream = screenMedia.remoteStream ?? screenMedia.localStream;
  const hasScreen = !!screenStream;
  const screenLabel = screenMedia.remoteStream
    ? t("screenShare.presenting", { name: screenMedia.remoteSharerName ?? "" })
    : t("screenShare.youArePresenting");

  // "screen" (together) is only honoured while a share exists; once it ends the
  // effective mode degrades back to grid so the stage is never left empty.
  const subMode = resolveGallerySubMode(rawSubMode, hasScreen);

  // AUTO-SELECT the together layout on the RISING EDGE of a share — the natural
  // default whenever the gallery first sees a live screen (a share that started
  // while it was open, OR opening the gallery while a share is already running:
  // the ref seeds `false` so that opening case fires once too). It is on the EDGE
  // only, so it is non-destructive and reversible — the user can immediately
  // switch back to grid/speaker and we won't yank them to "screen" again for the
  // same share.
  const prevHasScreen = useRef(false);
  useEffect(() => {
    if (hasScreen && !prevHasScreen.current) {
      setSubMode("screen");
    }
    prevHasScreen.current = hasScreen;
  }, [hasScreen, setSubMode]);

  // Tell MeetingShell when the gallery OWNS the screen (together layout actively
  // mounting it) so it suppresses the duplicate floating ScreenSharePane —
  // "one stream, one mount". Reset on unmount so closing the gallery hands the
  // floating pane back to the other surfaces.
  const showingScreen = subMode === "screen" && hasScreen;
  const setGalleryOwnsScreen = useSetAtom(galleryOwnsScreenAtom);
  useEffect(() => {
    setGalleryOwnsScreen(showingScreen);
    return () => setGalleryOwnsScreen(false);
  }, [showingScreen, setGalleryOwnsScreen]);
  // The caption surface router (data/captionState.ts) returns "gallery" while
  // this full-screen modal is open, so the dock mounts HERE and nowhere else —
  // this is the single guard that keeps the live-transcription strip from
  // double-mounting on the pane/canvas behind the gallery.
  const captionSurface = useAtomValue(captionSurfaceAtom);
  const captionsOnGallery = captionSurface === "gallery";
  const setVisibleTiles = useSetAtom(visibleTilesAtom);

  // Phase 5 — visible-tile signalling for manual subscription + pagination.
  // Publish the socket.ids the gallery is rendering so DailyAudio subscribes
  // only these (+ active speaker) in a big meeting. Both sub-modes render the
  // full tile set (grid = all; speaker = focus + rail), so we report all tile
  // ids — best-effort, honest about what is mounted. Cleared on unmount so
  // closing the gallery releases the signal (DailyAudio → automatic).
  const visibleKey = tiles.map((tile) => tile.id).join("|");
  useEffect(() => {
    setVisibleTiles(new Set(tiles.map((tile) => tile.id)));
    return () => setVisibleTiles(new Set());
    // visibleKey captures membership; `tiles` identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, setVisibleTiles]);

  const focusTile =
    tiles.find((tile) => tile.id === focusedSocketId) ?? tiles[0] ?? null;
  const others = tiles.filter((tile) => tile.id !== focusTile?.id);

  return (
    <div className="mcm-gallery" role="dialog" aria-modal="true">
      <div className="mcm-gallery__bar">
        <span className="mcm-gallery__title">
          {t("gallery.title")} · {tiles.length}
        </span>
        {/* Grid ↔ Speaker ↔ Screen sub-mode — a per-user view preference. The
            Screen ("together") toggle only appears while a screen is shared. */}
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
          {hasScreen && (
            <button
              type="button"
              className={`mcm-gallery__submode-btn${
                subMode === "screen" ? " mcm-gallery__submode-btn--active" : ""
              }`}
              aria-pressed={subMode === "screen"}
              onClick={() => setSubMode("screen")}
              title={t("gallery.subScreen")}
            >
              <MonitorUp size={15} strokeWidth={1.9} />
              {t("gallery.subScreen")}
            </button>
          )}
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

      {showingScreen && screenStream ? (
        // SCREEN ("together", Zoom-style): the shared SCREEN is the big stage and
        // EVERY camera rides the filmstrip below it. Reuses the speaker sub-mode's
        // `__speaker/__stage/__rail` skeleton — only the stage content differs (a
        // screen well instead of a face tile), so the layout/caption rules stay in
        // lockstep. All tiles go to the rail (the screen, not a person, is focus).
        <div className="mcm-gallery__speaker mcm-gallery__speaker--screen">
          <div className="mcm-gallery__stage">
            <ScreenStage stream={screenStream} label={screenLabel} />
            {captionsOnGallery && <LiveCaptionDock variant="embedded" />}
          </div>
          {tiles.length > 0 && (
            <div
              className="mcm-gallery__rail"
              aria-label={t("gallery.subScreen")}
            >
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
          )}
        </div>
      ) : subMode === "grid" || !focusTile ? (
        // GRID: the dock is a sibling of the scrolling grid, pinned to the bottom
        // of `.mcm-gallery` (the relative anchor) so it stays put while the grid
        // scrolls. `.mcm-gallery__grid` carries extra bottom padding (SCSS) so the
        // last tile row clears the dock instead of hiding behind it.
        <>
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
          {captionsOnGallery && <LiveCaptionDock variant="embedded" />}
        </>
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
            {/* SPEAKER: the dock pins to the bottom of the big-tile stage (above
                the rail), so captions ride the focused speaker's frame and never
                cover the thumbnail rail below. */}
            {captionsOnGallery && <LiveCaptionDock variant="embedded" />}
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
