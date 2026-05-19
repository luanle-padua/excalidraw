// HTML overlay that paints a "stuck-on" decoration (📌 pin or washi-
// tape) at the top of every locked image on the canvas. Excalidraw's
// canvas can't be drawn into without forking its renderer, so this
// layer sits transparently above the canvas, with each decoration
// positioned via scene→viewport math and tinted by a stable colour
// derived from the file id (so every pinned image looks different →
// "sinh động" / lively without any user effort).
//
// "Locked" here means EITHER:
//   • the underlying library file has a lockedBy username set, OR
//   • the Excalidraw image element itself has `locked: true`.
//
// Clicking a decoration removes the pin (if the user has permission).

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useId, useState } from "react";

import type {
  AppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { canUnlockFile, meetingFilesAtom } from "../../data/meetingLibrary";
import { useT } from "../../i18n/mcm";

// -----------------------------------------------------------------------
// Decoration palette + chooser
// -----------------------------------------------------------------------
// Cute Apple-leaning colours. Deliberately saturated so the pins/tape
// pop against any canvas background and read as playful stationery.
const PALETTE = [
  "#ef4444", // red
  "#f97316", // coral
  "#fbbf24", // golden
  "#10b981", // mint
  "#0ea5e9", // sky
  "#ec4899", // pink
  "#8b5cf6", // lavender
];

// Mix of integer-only ops; the multiplications/xors guarantee enough
// avalanche that adjacent file ids land in different palette buckets.
const stableHash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};

// Lock decoration is now PIN-ONLY: when a file is locked we always
// stamp the MAP-branded thumbtack on it, no random tape/sticker mix.
// User-driven stickers + stamps live in their own toolbar picker —
// keeping the auto-decoration single-purpose makes "this image is
// locked" instantly readable.
type Decoration = {
  kind: "pin";
  color: string;
  /** degrees — small random tilt so a row of pinned images doesn't
   *  read as a perfect grid. */
  rotation: number;
};

const decorationFor = (fileId: string): Decoration => {
  const h = stableHash(fileId);
  const color = PALETTE[h % PALETTE.length];
  const rotation = (((h * 31) >>> 0) % 30) - 15;
  return { kind: "pin", color, rotation };
};

// -----------------------------------------------------------------------
// Overlay
// -----------------------------------------------------------------------
type PinPosition = {
  /** stable key for React reconciliation */
  key: string;
  /** the library file id that backs this canvas element — needed so the
   *  click handler can call publishLibraryFileLock(fileId, …). */
  fileId: string | null;
  /** "locked" → render the real pin/tape decoration (click → unlock).
   *  "selected-unlocked" → render a ghost pin button (click → lock). */
  state: "locked" | "selected-unlocked";
  /** image rect in viewport px, used for layout (pin sticks at top-right
   *  corner; tape lays across the top centre). */
  left: number;
  top: number;
  width: number;
  height: number;
};

const isImage = (el: ExcalidrawElement): el is ExcalidrawImageElement =>
  el.type === "image" && !el.isDeleted;

export const PinnedImagesOverlay = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const files = useAtomValue(meetingFilesAtom);
  const [pins, setPins] = useState<PinPosition[]>([]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }

    const lockedLibraryFileIds = new Set<string>();
    for (const f of files) {
      if (f.lockedBy) {
        lockedLibraryFileIds.add(f.id);
      }
    }

    const recompute = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      const next: PinPosition[] = [];
      const zoom = appState.zoom.value;
      const selectedIds = appState.selectedElementIds;
      for (const el of elements) {
        if (!isImage(el)) {
          continue;
        }
        const fileId = typeof el.fileId === "string" ? el.fileId : null;
        const fileLocked = fileId !== null && lockedLibraryFileIds.has(fileId);
        const elementLocked = el.locked === true;
        const isLocked = fileLocked || elementLocked;
        const isSelected = !!selectedIds[el.id];
        // Render anchor when locked (real decoration) OR when selected
        // but unlocked (ghost pin to offer a one-click lock action).
        // Selected-AND-locked images already have their decoration,
        // which itself is the click-to-unlock affordance.
        const showGhost = isSelected && !isLocked && fileId !== null;
        if (!isLocked && !showGhost) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        next.push({
          key: el.id,
          fileId,
          state: isLocked ? "locked" : "selected-unlocked",
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
        });
      }
      setPins((prev) => {
        if (prev.length === next.length) {
          const same = prev.every(
            (p, i) =>
              p.key === next[i].key &&
              p.state === next[i].state &&
              p.left === next[i].left &&
              p.top === next[i].top &&
              p.width === next[i].width &&
              p.height === next[i].height,
          );
          if (same) {
            return prev;
          }
        }
        return next;
      });
    };

    recompute(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    const unsub = excalidrawAPI.onChange(recompute);
    return unsub;
  }, [excalidrawAPI, files]);

  // Two paths converge here:
  //   • file IS in meetingFilesAtom → route through publishLibraryFileLock
  //     so the library entry's lockedBy + element.locked + peer broadcast
  //     all stay in sync. Permission check applies on unlock.
  //   • file NOT in meetingFilesAtom (legacy paste, direct addFiles, or
  //     just lost track) → fall back to toggleCanvasImageElementLock,
  //     which only flips Excalidraw's native element.locked + broadcasts
  //     via Excalidraw's own element sync. No permission gate — anyone
  //     with edit access to the canvas can toggle a raw element lock,
  //     matching Excalidraw's built-in behaviour.
  const handleUnpin = (fileId: string | null) => {
    if (!fileId || !collabAPI) {
      return;
    }
    const file = files.find((f) => f.id === fileId);
    if (file && file.lockedBy) {
      const username = collabAPI.getUsername() || "Local";
      if (!canUnlockFile(file, username)) {
        window.alert(
          t("pin.permissionDenied", {
            locker: file.lockedBy,
            author: file.author,
          }),
        );
        return;
      }
      collabAPI.publishLibraryFileLock(fileId, null);
      return;
    }
    // Element-only lock (file not tracked or already unlocked at file
    // level but element.locked is still on).
    collabAPI.toggleCanvasImageElementLock(fileId, false);
  };

  const handlePin = (fileId: string | null) => {
    if (!fileId || !collabAPI) {
      return;
    }
    const file = files.find((f) => f.id === fileId);
    if (file) {
      if (file.lockedBy) {
        return;
      }
      const username = collabAPI.getUsername() || "Local";
      collabAPI.publishLibraryFileLock(fileId, username);
      return;
    }
    collabAPI.toggleCanvasImageElementLock(fileId, true);
  };

  if (pins.length === 0) {
    return null;
  }

  // pointerdown handler on the buttons stops Excalidraw's canvas-level
  // listeners from receiving the press, which otherwise deselects the
  // image (the source of the ghost pin) BEFORE the click fires — the
  // disappearing target then swallowed the click event. Calling
  // stopPropagation + the native stopImmediatePropagation belts-and-
  // braces it (Excalidraw mostly delegates via React but also adds
  // some window-level handlers during drag state).
  const swallowPointer = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
  };

  return (
    <div className="mcm-pin-layer">
      {pins.map((p) => {
        // GHOST PIN: clicking the body of a selected unlocked image
        // → shows a faded SVG pin at the top-right corner inviting
        // "pin this". On hover it firms up; click locks (and on next
        // render becomes a real pin/tape).
        if (p.state === "selected-unlocked") {
          const size = Math.max(44, Math.min(76, p.width * 0.2));
          const left = p.left + p.width - size * 0.55;
          const top = p.top - size * 0.35;
          return (
            <button
              key={p.key}
              type="button"
              className="mcm-pin-layer__pin mcm-pin-layer__pin--ghost"
              // eslint-disable-next-line react/forbid-dom-props
              style={
                {
                  left,
                  top,
                  width: size,
                  height: size * 1.15,
                  "--pin-rotation": "0deg",
                } as React.CSSProperties
              }
              onPointerDown={swallowPointer}
              onClick={(e) => {
                e.stopPropagation();
                handlePin(p.fileId);
              }}
              title={t("pin.pinTitle")}
            >
              <MapPinSVG />
            </button>
          );
        }

        // LOCKED → render the MAP pin (only kind now — stickers and
        // stamps are user-driven via the toolbar picker).
        const dec = decorationFor(p.fileId ?? p.key);
        const size = Math.max(44, Math.min(76, p.width * 0.2));
        const left = p.left + p.width - size * 0.55;
        const top = p.top - size * 0.35;
        return (
          <button
            key={p.key}
            type="button"
            className="mcm-pin-layer__pin"
            // eslint-disable-next-line react/forbid-dom-props
            style={
              {
                left,
                top,
                width: size,
                height: size * 1.15,
                "--pin-rotation": `${dec.rotation}deg`,
              } as React.CSSProperties
            }
            onPointerDown={swallowPointer}
            onClick={(e) => {
              e.stopPropagation();
              handleUnpin(p.fileId);
            }}
            title={t("pin.unpinTitle")}
          >
            <MapPinSVG />
          </button>
        );
      })}
    </div>
  );
};

// -----------------------------------------------------------------------
// MAP pin SVG — properly designed thumbtack with the brand "M" baked
// into the head. Uses radial gradients for the rounded glossy head and
// a tapered linear gradient on the needle, plus a soft shadow. The
// M is rendered as <text> inside the SVG so it tilts/scales perfectly
// with the pin, no overlay alignment headaches.
//
// We mint unique gradient IDs per instance via useId — multiple pins
// on the page would otherwise share the first SVG's gradient defs and
// break theme variations down the line.
// -----------------------------------------------------------------------
const MapPinSVG = () => {
  const id = useId();
  const headGrad = `mcm-pin-head-${id}`;
  const needleGrad = `mcm-pin-needle-${id}`;
  return (
    <svg
      viewBox="0 0 100 115"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* radial gradient gives the head a 3D ball look — bright
            upper-left highlight, deep wine red at the bottom */}
        <radialGradient id={headGrad} cx="32%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#ffb4b4" />
          <stop offset="35%" stopColor="#ef4444" />
          <stop offset="100%" stopColor="#7f1d1d" />
        </radialGradient>
        {/* metallic needle gradient — light strip down the middle */}
        <linearGradient id={needleGrad} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#3f3f46" />
          <stop offset="50%" stopColor="#a1a1aa" />
          <stop offset="100%" stopColor="#27272a" />
        </linearGradient>
      </defs>

      {/* ground shadow under needle tip */}
      <ellipse cx="50" cy="110" rx="9" ry="2" fill="rgba(0,0,0,0.28)" />

      {/* needle */}
      <path d="M44 58 L56 58 L52.5 108 L47.5 108 Z" fill={`url(#${needleGrad})`} />
      {/* needle highlight stripe */}
      <path
        d="M47.5 58 L49.5 58 L48.7 104 L47.5 104 Z"
        fill="rgba(255,255,255,0.45)"
      />

      {/* head */}
      <circle cx="50" cy="36" r="30" fill={`url(#${headGrad})`} />

      {/* soft inner bottom shade for roundness */}
      <ellipse
        cx="50"
        cy="48"
        rx="26"
        ry="14"
        fill="rgba(0,0,0,0.18)"
        opacity="0.6"
      />

      {/* glossy highlight on top-left */}
      <ellipse
        cx="37"
        cy="22"
        rx="14"
        ry="7"
        fill="rgba(255,255,255,0.45)"
      />
      <ellipse
        cx="34"
        cy="20"
        rx="7"
        ry="3.5"
        fill="rgba(255,255,255,0.7)"
      />

      {/* outer rim shadow for definition against light backgrounds */}
      <circle
        cx="50"
        cy="36"
        r="30"
        fill="none"
        stroke="rgba(0,0,0,0.18)"
        strokeWidth="1"
      />

      {/* MAP brand M — centred on head, bold sans-serif, white */}
      <text
        x="50"
        y="36"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, 'SF Pro Display', 'Segoe UI', 'Arial Black', sans-serif"
        fontWeight="900"
        fontSize="32"
        fill="#ffffff"
        letterSpacing="-1"
        style={{ paintOrder: "stroke" }}
        stroke="rgba(0,0,0,0.2)"
        strokeWidth="0.6"
      >
        M
      </text>
    </svg>
  );
};

export default PinnedImagesOverlay;
