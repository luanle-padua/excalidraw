// FLOATING PRESENTER — a draggable picture-in-picture of the ONE focused person
// (the same socketId the gallery-speaker stage + filmstrip ring resolve to) so
// you can keep working on the canvas while still watching the presenter.
//
// Behaviour:
//   • Shows the focused person's live camera (<TileVideo>, reused) with a name
//     chip + the shared green ring when they're the active speaker; falls back
//     to <MCMAvatar> when their camera is off.
//   • Draggable via pointer events on the card header → on release SNAPS to the
//     nearest of 4 corners (persisted in floatingPresenterCornerAtom).
//   • "−" minimises to a ~44px circular puck (avatar + ring) that still snaps;
//     click the puck to restore. "×" hides it (floatingPresenterAtom → false).
//   • Mounted inside .mcm-shell__canvas-area (positioned absolute) so it floats
//     over the canvas without ever covering the header or the bottom strip.
//
// It is gated to minimal/filmstrip by the caller (ParticipantsBar) — redundant
// over the gallery, which already shows everyone full-screen.

import { Minus, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  floatingPresenterAtom,
  floatingPresenterCornerAtom,
  type FloatingCorner,
} from "../../audio/videoFocus";
import { activeSpeakerAtom } from "../../audio/videoPerf";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { TileVideo } from "./ParticipantsBar";

import "./FloatingPresenter.scss";

import type { Tile } from "./ParticipantsBar";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

const MARGIN = 14;

/** Pick the nearest of 4 corners for the card's current top-left, relative to
 *  its parent (canvas-area) bounds. */
const nearestCorner = (
  x: number,
  y: number,
  parentW: number,
  parentH: number,
): FloatingCorner => {
  const left = x < parentW / 2 - 1;
  const top = y < parentH / 2 - 1;
  return `${top ? "t" : "b"}${left ? "l" : "r"}` as FloatingCorner;
};

export const FloatingPresenter = ({
  tiles,
  selfSocketId,
  focusedSocketId,
}: {
  tiles: Tile[];
  selfSocketId: string;
  focusedSocketId: string | null;
}) => {
  const t = useT();
  const setOn = useSetAtom(floatingPresenterAtom);
  const corner = useAtomValue(floatingPresenterCornerAtom);
  const setCorner = useSetAtom(floatingPresenterCornerAtom);
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  const [minimised, setMinimised] = useState(false);

  const cardRef = useRef<HTMLDivElement | null>(null);
  // Live drag offset (px) applied via transform during a drag; null when docked
  // to a corner (CSS handles the corner placement + the snap transition).
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // True once the pointer moved past a small threshold during this gesture — so
  // the puck's click-to-restore can tell a real DRAG (reposition) from a click.
  // (dragRef is nulled on pointerup BEFORE the click fires, so it can't be the
  // signal.)
  const didDragRef = useRef(false);

  const focusTile =
    tiles.find((tile) => tile.id === focusedSocketId) ?? tiles[0] ?? null;

  // End-drag listeners are attached to the window so a fast drag that leaves
  // the card still tracks; cleaned up when the drag ends.
  useEffect(() => {
    if (!dragPos && !dragRef.current) {
      return undefined;
    }
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const card = cardRef.current;
      if (!d || !card) {
        return;
      }
      const parent = card.parentElement;
      if (!parent) {
        return;
      }
      const pb = parent.getBoundingClientRect();
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (
        Math.abs(e.clientX - d.startX) > 4 ||
        Math.abs(e.clientY - d.startY) > 4
      ) {
        didDragRef.current = true;
      }
      let nx = d.originX + (e.clientX - d.startX);
      let ny = d.originY + (e.clientY - d.startY);
      // Clamp to the parent bounds so it can never be dragged off-canvas.
      nx = Math.max(MARGIN, Math.min(nx, pb.width - w - MARGIN));
      ny = Math.max(MARGIN, Math.min(ny, pb.height - h - MARGIN));
      setDragPos({ x: nx, y: ny });
    };
    const onUp = () => {
      const d = dragRef.current;
      const card = cardRef.current;
      dragRef.current = null;
      if (d && card && dragPos) {
        const parent = card.parentElement;
        if (parent) {
          const pb = parent.getBoundingClientRect();
          setCorner(nearestCorner(dragPos.x, dragPos.y, pb.width, pb.height));
        }
      }
      // Release the live offset → CSS animates from the dropped spot to the
      // resolved corner.
      setDragPos(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragPos, setCorner]);

  const onPointerDown = (e: ReactPointerEvent) => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const parent = card.parentElement;
    if (!parent) {
      return;
    }
    const cb = card.getBoundingClientRect();
    const pb = parent.getBoundingClientRect();
    didDragRef.current = false;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: cb.left - pb.left,
      originY: cb.top - pb.top,
    };
    // Seed dragPos with the current docked position so the transform takes over
    // smoothly (and the move-listener effect arms).
    setDragPos({ x: cb.left - pb.left, y: cb.top - pb.top });
  };

  if (!focusTile) {
    return null;
  }

  const isMe = focusTile.isMe ?? focusTile.id === selfSocketId;
  const speaking = focusTile.id === activeSpeaker;
  const dragging = !!dragPos;

  // When dragging we drive position via inline left/top (no corner class); when
  // docked the corner class + CSS handle placement and the snap transition.
  const cornerClass = dragging ? "" : ` mcm-floating-presenter--${corner}`;

  if (minimised) {
    return (
      <button
        type="button"
        ref={cardRef as unknown as RefObject<HTMLButtonElement>}
        className={`mcm-floating-presenter mcm-floating-presenter--puck${cornerClass}${
          speaking ? " mcm-floating-presenter--speaking" : ""
        }${dragging ? " mcm-floating-presenter--dragging" : ""}`}
        title={t("videoLayout.floatingRestore")}
        aria-label={t("videoLayout.floatingRestore")}
        onPointerDown={onPointerDown}
        onClick={() => {
          // Only restore on a genuine click (not the tail of a drag-reposition).
          if (!didDragRef.current) {
            setMinimised(false);
          }
        }}
        // eslint-disable-next-line react/forbid-dom-props
        style={
          dragging && dragPos ? { left: dragPos.x, top: dragPos.y } : undefined
        }
      >
        <MCMAvatar
          name={focusTile.name}
          avatar={focusTile.avatarRaw ?? undefined}
          email={focusTile.email ?? undefined}
          identityKey={focusTile.email ?? focusTile.id}
        />
      </button>
    );
  }

  return (
    <div
      ref={cardRef}
      className={`mcm-floating-presenter mcm-floating-presenter--card${cornerClass}${
        speaking ? " mcm-floating-presenter--speaking" : ""
      }${dragging ? " mcm-floating-presenter--dragging" : ""}`}
      // eslint-disable-next-line react/forbid-dom-props
      style={
        dragging && dragPos ? { left: dragPos.x, top: dragPos.y } : undefined
      }
    >
      <div
        className="mcm-floating-presenter__head"
        onPointerDown={onPointerDown}
        role="presentation"
      >
        <Pin
          size={11}
          strokeWidth={2}
          className="mcm-floating-presenter__grip"
        />
        <span className="mcm-floating-presenter__name">
          {focusTile.name}
          {isMe ? ` (${t("gallery.you")})` : ""}
        </span>
        <button
          type="button"
          className="mcm-floating-presenter__btn"
          title={t("videoLayout.floatingMinimise")}
          aria-label={t("videoLayout.floatingMinimise")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMinimised(true)}
        >
          <Minus size={13} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className="mcm-floating-presenter__btn"
          title={t("videoLayout.floatingHide")}
          aria-label={t("videoLayout.floatingHide")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setOn(false)}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>
      <div className="mcm-floating-presenter__body">
        {focusTile.videoStream ? (
          <TileVideo stream={focusTile.videoStream} mirror={isMe} />
        ) : (
          <div className="mcm-floating-presenter__avatar">
            <MCMAvatar
              name={focusTile.name}
              avatar={focusTile.avatarRaw ?? undefined}
              email={focusTile.email ?? undefined}
              identityKey={focusTile.email ?? focusTile.id}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default FloatingPresenter;
