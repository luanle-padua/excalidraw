// Decoration toolbar — injects TWO buttons (sticker + stamp) into
// Excalidraw's Island App-toolbar via React portals. Each button opens
// its own popover with a grid of assets. Picking an asset enters
// "placing mode": a translucent ghost follows the pointer and the
// next click on the canvas drops the image at the click position.
//
// Placing mode uses pointer events throughout so an Apple Pencil /
// Surface Pen / touch finger all work identically to a mouse.
// pointerType === "pen" gets a smaller ghost offset so the preview
// sits next to the stylus tip rather than under the user's hand.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newImageElement } from "@excalidraw/element";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";

import { STAMP_ASSETS, STICKER_ASSETS } from "./decorations/assets";

const MAX_INSERT = 240; // px (logical) on canvas

type Kind = "sticker" | "stamp";

type PlacingState = {
  kind: Kind;
  path: string;
  dataURL: string;
  width: number;
  height: number;
};

const KINDS: ReadonlyArray<{
  kind: Kind;
  label: string;
  assets: readonly string[];
}> = [
  { kind: "sticker", label: "Stickers", assets: STICKER_ASSETS },
  { kind: "stamp", label: "Stamps", assets: STAMP_ASSETS },
];

const newFileId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const pathToDataURL = async (path: string): Promise<string> => {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`fetch ${path}: ${res.status}`);
  }
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

const probeDims = (
  dataURL: string,
): Promise<{ width: number; height: number }> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 240, height: 240 });
    img.src = dataURL;
  });

const scaleDown = (w: number, h: number, max: number) => {
  if (w <= max && h <= max) {
    return { w, h };
  }
  const k = max / Math.max(w, h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
};

export const StickerPicker = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const [openKind, setOpenKind] = useState<Kind | null>(null);
  const [placing, setPlacing] = useState<PlacingState | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [ghostIsPen, setGhostIsPen] = useState(false);

  const buttonRefs = useRef<Record<Kind, HTMLButtonElement | null>>({
    sticker: null,
    stamp: null,
  });
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Pointerdown fires BEFORE pointerup, but we want a click-pattern
  // (down + up in same area), so we record the pointerdown coords and
  // only commit the placement on pointerup if movement is small.
  const placeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Locate Excalidraw's toolbar in the DOM, re-locate on remount
  // (zen mode, viewport switch).
  useEffect(() => {
    const find = () =>
      (document.querySelector(".App-toolbar") as HTMLElement) ?? null;
    setToolbarEl(find());
    const obs = new MutationObserver(() => {
      const next = find();
      setToolbarEl((prev) => (prev === next ? prev : next));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // Outside-click + Escape close the OPEN POPOVER (not placing mode).
  useEffect(() => {
    if (!openKind) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) {
        return;
      }
      if (popoverRef.current?.contains(t)) {
        return;
      }
      const allButtons = Object.values(buttonRefs.current);
      if (allButtons.some((b) => b?.contains(t))) {
        return;
      }
      setOpenKind(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenKind(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKind]);

  // Insert the placed asset onto the canvas at scene coordinates
  // converted from the pointer's clientX/Y.
  const placeAt = useCallback(
    async (clientX: number, clientY: number) => {
      if (!excalidrawAPI || !placing) {
        return;
      }
      const container = document.querySelector(
        ".excalidraw-container",
      ) as HTMLElement | null;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      // Refuse to drop outside the canvas — silently cancel instead.
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setPlacing(null);
        return;
      }
      const appState = excalidrawAPI.getAppState();
      const zoom = appState.zoom.value;
      const sceneX = -appState.scrollX + (clientX - rect.left) / zoom;
      const sceneY = -appState.scrollY + (clientY - rect.top) / zoom;
      const { w, h } = scaleDown(placing.width, placing.height, MAX_INSERT);
      const id = newFileId();
      excalidrawAPI.addFiles([
        {
          id: id as FileId,
          dataURL: placing.dataURL as unknown as BinaryFileData["dataURL"],
          mimeType: "image/png" as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      const element = newImageElement({
        type: "image",
        x: sceneX - w / 2,
        y: sceneY - h / 2,
        width: w,
        height: h,
        fileId: id as FileId,
        status: "saved",
      });
      excalidrawAPI.updateScene({
        elements: [...excalidrawAPI.getSceneElements(), element],
      });
      if (collabAPI) {
        collabAPI.publishLibraryFile({
          id,
          name: `${placing.kind}-${placing.path.split("/").pop()}`,
          ts: Date.now(),
          author: collabAPI.getUsername() || "Local",
          mimeType: "image/png",
          dataURL: placing.dataURL,
          width: placing.width,
          height: placing.height,
        });
      }
      setPlacing(null);
    },
    [excalidrawAPI, placing, collabAPI],
  );

  // Pointer plumbing during placing mode. We listen at the window
  // level in the capture phase so we beat Excalidraw's React handlers,
  // but ONLY swallow events whose target is inside .excalidraw-container.
  // Clicks on the toolbar/popover stay normal so the user can still
  // pick a different sticker / hit ESC affordances.
  //
  // Critically: we ALSO stop pointerdown (not just pointerup) on the
  // canvas. Otherwise Excalidraw starts a selection-drag on pointerdown
  // and gets stuck because we swallow the matching pointerup — leaving
  // a dangling selection rectangle after the placement.
  useEffect(() => {
    if (!placing) {
      setGhostPos(null);
      return undefined;
    }
    const isCanvasTarget = (e: PointerEvent) => {
      const container = document.querySelector(".excalidraw-container");
      return (
        !!container &&
        e.target instanceof Node &&
        container.contains(e.target)
      );
    };
    const onMove = (e: PointerEvent) => {
      setGhostPos({ x: e.clientX, y: e.clientY });
      setGhostIsPen(e.pointerType === "pen");
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !isCanvasTarget(e)) {
        return;
      }
      placeStartRef.current = { x: e.clientX, y: e.clientY };
      // Stop Excalidraw from receiving the pointerdown → no selection
      // drag starts, so swallowing the matching pointerup below is safe.
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = (e: PointerEvent) => {
      const start = placeStartRef.current;
      placeStartRef.current = null;
      if (!start || !isCanvasTarget(e)) {
        return;
      }
      // Treat as "click" if movement is small (finger wiggle, pen
      // micro-jitter) — otherwise the user was panning, ignore.
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 6) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void placeAt(e.clientX, e.clientY);
    };
    // Some browsers (and Excalidraw) wire onClick separately from
    // pointer events. Swallow the synthetic click too so it can't
    // re-trigger Excalidraw's selection clear.
    const onClick = (e: MouseEvent) => {
      const container = document.querySelector(".excalidraw-container");
      if (
        container &&
        e.target instanceof Node &&
        container.contains(e.target)
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlacing(null);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [placing, placeAt]);

  // Open the picker → load the asset bytes → enter placing mode.
  const pickAsset = useCallback(async (kind: Kind, path: string) => {
    try {
      const dataURL = await pathToDataURL(path);
      const dims = await probeDims(dataURL);
      setOpenKind(null);
      setPlacing({ kind, path, dataURL, width: dims.width, height: dims.height });
    } catch (err) {
      console.error("[StickerPicker] failed to load asset", err);
    }
  }, []);

  // Position the popover relative to its trigger button.
  const popoverPos = useMemo(() => {
    if (!openKind) {
      return null;
    }
    const btn = buttonRefs.current[openKind];
    if (!btn) {
      return null;
    }
    const r = btn.getBoundingClientRect();
    const POPOVER_W = 312;
    const POPOVER_H_GUESS = 360;
    const placeAbove = r.top > POPOVER_H_GUESS + 12;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - POPOVER_W - 8,
        r.left + r.width / 2 - POPOVER_W / 2,
      ),
    );
    const top = placeAbove ? r.top - POPOVER_H_GUESS - 8 : r.bottom + 8;
    return { left, top };
  }, [openKind]);

  if (!toolbarEl) {
    return null;
  }

  const activeKind = openKind
    ? KINDS.find((k) => k.kind === openKind)
    : null;

  return (
    <>
      {/* Inject 2 buttons (sticker + stamp) into the Excalidraw toolbar
            via a portal, so they sit next to the shape buttons. */}
      {createPortal(
        <>
          {KINDS.map(({ kind, label, assets }) => {
            const previewSrc = assets[0]; // first asset acts as the icon
            const isOpen = openKind === kind;
            return (
              <button
                key={kind}
                ref={(el) => {
                  buttonRefs.current[kind] = el;
                }}
                type="button"
                className={`ToolIcon ToolIcon_type_button ToolIcon_size_medium ToolIcon--plain mcm-deco-trigger mcm-deco-trigger--${kind}${
                  isOpen ? " mcm-deco-trigger--open" : ""
                }${placing?.kind === kind ? " mcm-deco-trigger--placing" : ""}`}
                aria-label={label}
                title={label}
                onClick={() => setOpenKind(isOpen ? null : kind)}
              >
                <div className="ToolIcon__icon">
                  {previewSrc ? (
                    <img
                      src={previewSrc}
                      alt=""
                      draggable={false}
                      className="mcm-deco-trigger__preview"
                    />
                  ) : (
                    <span className="mcm-deco-trigger__empty">+</span>
                  )}
                </div>
              </button>
            );
          })}
        </>,
        toolbarEl,
      )}

      {/* Picker popover */}
      {openKind &&
        activeKind &&
        popoverPos &&
        createPortal(
          <div
            ref={popoverRef}
            className="mcm-sticker-popover"
            role="dialog"
            aria-label={`${activeKind.label} picker`}
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: popoverPos.left, top: popoverPos.top }}
          >
            <div className="mcm-sticker-popover__header">
              <span className="mcm-sticker-popover__title">
                {activeKind.label}
              </span>
              <span className="mcm-sticker-popover__hint">
                Chọn rồi click vào canvas để dán
              </span>
            </div>
            <div className="mcm-sticker-popover__grid">
              {activeKind.assets.length === 0 ? (
                <div className="mcm-sticker-popover__empty">
                  Chưa có {activeKind.label.toLowerCase()} nào trong thư viện.
                </div>
              ) : (
                activeKind.assets.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="mcm-sticker-popover__item"
                    onClick={() => void pickAsset(activeKind.kind, path)}
                    title={path.split("/").pop()}
                  >
                    <img src={path} alt="" draggable={false} />
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Placing ghost — follows the pointer/pen tip. We render via
            a portal to document.body so the ghost can sit above
            everything, including the Excalidraw canvas + our own UI. */}
      {placing &&
        ghostPos &&
        createPortal(
          <div
            className={`mcm-placing-ghost mcm-placing-ghost--${placing.kind}${
              ghostIsPen ? " mcm-placing-ghost--pen" : ""
            }`}
            // Per-frame position is data-driven.
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: ghostPos.x, top: ghostPos.y }}
            aria-hidden="true"
          >
            <img src={placing.path} alt="" draggable={false} />
          </div>,
          document.body,
        )}
    </>
  );
};

export default StickerPicker;
