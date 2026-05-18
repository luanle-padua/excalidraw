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
import { useEffect, useState } from "react";

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

type Decoration = {
  kind: "pin" | "tape";
  color: string;
  /** degrees — small random tilt so a row of decorations doesn't read
   *  as a perfect grid. */
  rotation: number;
};

const decorationFor = (fileId: string): Decoration => {
  const h = stableHash(fileId);
  const color = PALETTE[h % PALETTE.length];
  // ~30% tape, 70% pin — pins are more recognisable, tape adds variety.
  const kind: Decoration["kind"] = ((h * 17) >>> 0) % 10 < 3 ? "tape" : "pin";
  // pin tilts further than tape (real tape lays mostly flat).
  const rotationRange = kind === "pin" ? 30 : 16;
  const rotation = (((h * 31) >>> 0) % rotationRange) - rotationRange / 2;
  return { kind, color, rotation };
};

// -----------------------------------------------------------------------
// Overlay
// -----------------------------------------------------------------------
type PinPosition = {
  /** stable key for React reconciliation */
  key: string;
  /** the library file id that backs this canvas element — needed so the
   *  click handler can call publishLibraryFileLock(fileId, null). */
  fileId: string | null;
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
      for (const el of elements) {
        if (!isImage(el)) {
          continue;
        }
        const fileId = typeof el.fileId === "string" ? el.fileId : null;
        const fileLocked = fileId !== null && lockedLibraryFileIds.has(fileId);
        const elementLocked = el.locked === true;
        if (!fileLocked && !elementLocked) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        next.push({
          key: el.id,
          fileId,
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

  // Permission-aware unpin. For files that have a `lockedBy` user we
  // route through publishLibraryFileLock so peers get the update too
  // (which in turn clears the element.locked flag via the matching
  // sync logic in Collab.setCanvasImagesLockedByFileId). For files
  // that are NOT in our library map (rare edge case where someone
  // toggled Excalidraw's native lock directly) we just leave the
  // element locked — the user can clear it via Excalidraw's selection
  // panel instead.
  const handleUnpin = (fileId: string | null) => {
    if (!fileId || !collabAPI) {
      return;
    }
    const file = files.find((f) => f.id === fileId);
    if (!file || !file.lockedBy) {
      return;
    }
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
  };

  if (pins.length === 0) {
    return null;
  }

  return (
    <div className="mcm-pin-layer" aria-hidden="true">
      {pins.map((p) => {
        const dec = decorationFor(p.fileId ?? p.key);
        // Pin sticks at the top-right corner, the tape lays across the
        // top edge with the tape's centre at ~80% of the image width
        // (offset right so it reads as decorative, not blocking).
        if (dec.kind === "pin") {
          // Emoji renders larger than the box because OS emoji fonts
          // pad heavily inside their bounding box. The `size` here
          // controls font-size; the actual visual is ~80% of that.
          const size = Math.max(40, Math.min(72, p.width * 0.18));
          const left = p.left + p.width - size * 0.55;
          const top = p.top - size * 0.4;
          return (
            <button
              key={p.key}
              type="button"
              className="mcm-pin-layer__pin"
              // Per-pin layout is data-driven.
              // eslint-disable-next-line react/forbid-dom-props
              style={
                {
                  left,
                  top,
                  fontSize: size,
                  "--pin-rotation": `${dec.rotation}deg`,
                } as React.CSSProperties
              }
              onClick={() => handleUnpin(p.fileId)}
              title={t("pin.unpinTitle")}
            >
              📌
            </button>
          );
        }
        // Tape: rectangular strip glued across the top edge, half off
        // the image (so it reads as decorative, like a polaroid in a
        // mood board). Width scales with image width.
        const tapeW = Math.max(60, Math.min(180, p.width * 0.45));
        const tapeH = 26;
        const left = p.left + p.width * 0.5 - tapeW * 0.5;
        const top = p.top - tapeH * 0.55;
        return (
          <button
            key={p.key}
            type="button"
            className="mcm-pin-layer__tape"
            // eslint-disable-next-line react/forbid-dom-props
            style={
              {
                left,
                top,
                width: tapeW,
                height: tapeH,
                "--tape-color": dec.color,
                "--tape-rotation": `${dec.rotation}deg`,
              } as React.CSSProperties
            }
            onClick={() => handleUnpin(p.fileId)}
            title={t("pin.unpinTitle")}
          />
        );
      })}
    </div>
  );
};

export default PinnedImagesOverlay;
