import { useEffect, useMemo, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { getFontString, sceneCoordsToViewportCoords } from "@excalidraw/common";

import { useAtomValue } from "../app-jotai";
import { meetingFilesAtom } from "../data/meetingLibrary";

import "./MentionOverlay.scss";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

type Badge = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Single shared 2D context used solely for text measurement. We never
 *  draw on it, so its actual size doesn't matter. */
let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = () => {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  return measureCtx;
};

/**
 * Renders translucent purple rectangles behind every `@filename` substring
 * inside text elements, where filename matches a file currently in the
 * Meeting Library. Pure visual layer — `pointer-events: none` so the
 * canvas keeps all interaction (selection, drag, etc.). Clicking the
 * mention to scroll to the image is still done via Excalidraw's element
 * link icon (set by `linkTextToFile` after `@`-mention).
 */
export const MentionOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  const [, setTick] = useState(0);

  // re-render the overlay on every scene/scroll/zoom change
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    return excalidrawAPI.onChange(() => setTick((t) => (t + 1) % 1_000_000));
  }, [excalidrawAPI]);

  const badges = useMemo<Badge[]>(() => {
    if (!excalidrawAPI || files.length === 0) {
      return [];
    }
    const ctx = getMeasureCtx();
    if (!ctx) {
      return [];
    }
    const appState = excalidrawAPI.getAppState();
    const elements = excalidrawAPI.getSceneElements();
    const fileNames = files.map((f) => f.name);

    const out: Badge[] = [];
    for (const el of elements) {
      if (el.type !== "text") {
        continue;
      }
      const text = el as ExcalidrawTextElement;
      ctx.font = getFontString({
        fontSize: text.fontSize,
        fontFamily: text.fontFamily,
      });
      const lines = text.text.split("\n");
      const linePx = text.fontSize * (text.lineHeight ?? 1.25);

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        let i = 0;
        while (i < line.length) {
          if (line[i] === "@" && (i === 0 || /\s/.test(line[i - 1]))) {
            // greedy: pick longest matching filename starting at i+1
            let matched: string | null = null;
            for (const name of fileNames) {
              if (
                line.startsWith(name, i + 1) &&
                (!matched || name.length > matched.length)
              ) {
                matched = name;
              }
            }
            if (matched) {
              const prefixW = ctx.measureText(line.slice(0, i)).width;
              const mentionW = ctx.measureText(`@${matched}`).width;
              const sceneX = text.x + prefixW;
              const sceneY = text.y + li * linePx;
              const screen = sceneCoordsToViewportCoords(
                { sceneX, sceneY },
                {
                  zoom: appState.zoom,
                  offsetLeft: appState.offsetLeft,
                  offsetTop: appState.offsetTop,
                  scrollX: appState.scrollX,
                  scrollY: appState.scrollY,
                },
              );
              out.push({
                key: `${text.id}:${li}:${i}`,
                left: screen.x,
                top: screen.y,
                width: mentionW * appState.zoom.value,
                height: linePx * appState.zoom.value,
              });
              i += 1 + matched.length;
              continue;
            }
          }
          i++;
        }
      }
    }
    return out;
    // tick triggers recompute via onChange → setTick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, files]);

  if (badges.length === 0) {
    return null;
  }

  return (
    <div className="MentionOverlay" aria-hidden>
      {badges.map((b) => (
        <div
          key={b.key}
          className="MentionOverlay__badge"
          // dynamic per-badge positioning — must be inline
          // eslint-disable-next-line react/forbid-dom-props
          style={{
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
          }}
        />
      ))}
    </div>
  );
};

export default MentionOverlay;
