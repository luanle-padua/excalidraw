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
import {
  newElementWith,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";

import { STAMP_ASSETS, STICKER_ASSETS } from "./decorations/assets";
import { findOrCreateToolbarExtras } from "./toolbarExtras";

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
  /** Optional toolbar-button icon; defaults to assets[0]. */
  icon?: string;
}> = [
  {
    kind: "sticker",
    label: "Stickers",
    assets: STICKER_ASSETS,
    // Use a colourful MAP character instead of the plain hand-drawn 01.png
    // so the toolbar button reads clearly as "stickers".
    icon: "/decorations/stickers/02.png",
  },
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
  // Multiplier applied to the asset's base on-canvas size while placing.
  // The mouse wheel drives it (up = bigger, down = smaller) so the user
  // picks the size before clicking; the ghost previews the exact result.
  const [placingScale, setPlacingScale] = useState(1);

  const buttonRefs = useRef<Record<Kind, HTMLButtonElement | null>>({
    sticker: null,
    stamp: null,
  });
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Pointerdown fires BEFORE pointerup, but we want a click-pattern
  // (down + up in same area), so we record the pointerdown coords and
  // only commit the placement on pointerup if movement is small.
  const placeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Locate (and lazily create) the MCM extras host inside Excalidraw's
  // toolbar. Routing through a shared wrapper instead of portalling
  // straight into .App-toolbar keeps our buttons grouped as a single
  // horizontal strip in mobile mode (where .App-toolbar flips to
  // flex-direction: column and each direct child would otherwise be
  // a full-width row). Re-locate on remount (zen mode, layout flip).
  useEffect(() => {
    setToolbarEl(findOrCreateToolbarExtras());
    const obs = new MutationObserver(() => {
      const next = findOrCreateToolbarExtras();
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
  //
  // Stamps differ from stickers in one critical way: when a stamp is
  // dropped on top of an existing image element, it ADHERES to that
  // image — the two share an Excalidraw `groupIds` entry so dragging
  // one moves both. That matches how a physical rubber stamp works
  // (mark on the photo, mark travels with the photo when you move
  // it). The binding uses Excalidraw's native grouping primitive so
  // selection, copy, ungroup all keep working the way the user
  // expects. Stickers stay free-floating; we never bind them.
  //
  // We deliberately skip binding when the underlying element is an
  // MCM-specific anchor (PDF / DXF) — those have their own
  // navigation toolbars and snapshot lifecycles, and inheriting a
  // group with the stamp would entangle the anchor's drag behavior
  // with random user decoration.
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
      const base = scaleDown(placing.width, placing.height, MAX_INSERT);
      // Apply the wheel-chosen scale — this is the size the ghost showed.
      const w = base.w * placingScale;
      const h = base.h * placingScale;
      // `mcm-deco-` prefix marks this as an MCM decoration file so the
      // library's canvas auto-detect skips it (no junk sticker/stamp
      // tiles). Prefix is timing-safe — caught even before the element
      // with `customData.mcmType` is added to the scene.
      const id = `mcm-deco-${newFileId()}`;
      excalidrawAPI.addFiles([
        {
          id: id as FileId,
          dataURL: placing.dataURL as unknown as BinaryFileData["dataURL"],
          mimeType: "image/png" as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);

      // Hit-test: find a target image to stick this stamp to. Only
      // applies for stamps. Scan in REVERSE so the topmost image
      // under the click wins (matches what the user visually sees).
      // Skip anchors (PDF/DXF/translation children/other stamps) so
      // we don't entangle MCM bookkeeping elements.
      let targetImage: ExcalidrawElement | null = null;
      if (placing.kind === "stamp") {
        const sceneElements = excalidrawAPI.getSceneElements();
        for (let i = sceneElements.length - 1; i >= 0; i--) {
          const el = sceneElements[i];
          if (el.type !== "image" || el.isDeleted) {
            continue;
          }
          const mcmType =
            el.customData &&
            typeof (el.customData as Record<string, unknown>).mcmType ===
              "string"
              ? ((el.customData as Record<string, unknown>).mcmType as string)
              : null;
          // Skip MCM anchors AND prior stamps — stamping a stamp is
          // a no-op semantically (you'd just want to delete the old
          // one); and PDF/DXF anchors own their drag behavior.
          if (mcmType && mcmType !== "stamp-target") {
            continue;
          }
          if (
            sceneX >= el.x &&
            sceneX <= el.x + el.width &&
            sceneY >= el.y &&
            sceneY <= el.y + el.height
          ) {
            targetImage = el;
            break;
          }
        }
      }

      // Resolve the groupIds to assign to the new stamp. If the
      // target image is already in a group, the stamp joins that
      // group. If it isn't, we mint a fresh group id and patch the
      // target image to share it — so both elements become a 2-member
      // group as far as Excalidraw is concerned.
      let stampGroupIds: string[] = [];
      let targetImagePatch: ExcalidrawElement | null = null;
      if (targetImage) {
        if (targetImage.groupIds.length > 0) {
          stampGroupIds = [...targetImage.groupIds];
        } else {
          const groupId = `mcm-stamp-group-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          stampGroupIds = [groupId];
          targetImagePatch = newElementWith(targetImage, {
            groupIds: [groupId],
          });
        }
      }

      const element = newImageElement({
        type: "image",
        x: sceneX - w / 2,
        y: sceneY - h / 2,
        width: w,
        height: h,
        fileId: id as FileId,
        status: "saved",
        groupIds: stampGroupIds,
        customData: {
          // Mark this element as an MCM stamp so subsequent
          // stamp placements skip it during hit-testing (stamping
          // a stamp is meaningless).
          mcmType: placing.kind === "stamp" ? "stamp" : "sticker",
          // Cross-reference back to the parent image for debugging
          // and any future "remove stamp from image" UI. Optional.
          ...(targetImage ? { mcmStampParentId: targetImage.id } : {}),
        },
      });
      // syncInvalidIndices assigns a valid fractional index to the
      // freshly-minted element. CRITICAL: pass elements INCLUDING
      // deleted ones so we preserve the full index sequence Excalidraw
      // tracks for tombstones. Without it, dragging the sticker
      // between frames later crashes with InvalidFractionalIndexError
      // and freezes every imported element. (See MeetingLibrary.tsx.)
      const existingElements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const elementsWithPatch = targetImagePatch
        ? existingElements.map((el) =>
            el.id === targetImagePatch!.id ? targetImagePatch! : el,
          )
        : existingElements;
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elementsWithPatch, element]),
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
    [excalidrawAPI, placing, placingScale, collabAPI],
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
        !!container && e.target instanceof Node && container.contains(e.target)
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
    // While placing, the wheel resizes the decoration instead of zooming
    // the canvas. deltaY < 0 (scroll up / away) = bigger, > 0 = smaller.
    // Needs passive:false so we can preventDefault the canvas zoom.
    const onWheel = (e: WheelEvent) => {
      const container = document.querySelector(".excalidraw-container");
      if (
        !container ||
        !(e.target instanceof Node) ||
        !container.contains(e.target)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setPlacingScale((s) => Math.min(6, Math.max(0.12, s * factor)));
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [placing, placeAt]);

  // Open the picker → load the asset bytes → enter placing mode.
  const pickAsset = useCallback(async (kind: Kind, path: string) => {
    try {
      const dataURL = await pathToDataURL(path);
      const dims = await probeDims(dataURL);
      setOpenKind(null);
      setPlacingScale(1); // fresh size each time the user picks an asset
      setPlacing({
        kind,
        path,
        dataURL,
        width: dims.width,
        height: dims.height,
      });
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

  const activeKind = openKind ? KINDS.find((k) => k.kind === openKind) : null;

  // WYSIWYG ghost sizing: the on-canvas scene size (base × wheel scale)
  // rendered at the current zoom, so the floating preview is exactly the
  // size that will land on the canvas when the user clicks.
  const ghostBase = placing
    ? scaleDown(placing.width, placing.height, MAX_INSERT)
    : null;
  const ghostSceneW = ghostBase ? ghostBase.w * placingScale : 0;
  const ghostSceneH = ghostBase ? ghostBase.h * placingScale : 0;
  const ghostZoom = excalidrawAPI?.getAppState().zoom.value ?? 1;

  return (
    <>
      {/* Inject 2 buttons (sticker + stamp) into the Excalidraw toolbar
            via a portal, so they sit next to the shape buttons. */}
      {createPortal(
        <>
          {KINDS.map(({ kind, label, assets, icon }) => {
            const previewSrc = icon ?? assets[0]; // per-kind icon override
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
                Chọn → lăn chuột chỉnh cỡ → click để dán
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
            <img
              src={placing.path}
              alt=""
              draggable={false}
              // WYSIWYG: match the on-canvas size. Override the CSS max so
              // large sizes aren't clamped to the 140px preview cap.
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                width: ghostSceneW * ghostZoom,
                height: ghostSceneH * ghostZoom,
                maxWidth: "none",
                maxHeight: "none",
              }}
            />
            <span className="mcm-placing-ghost__size">
              {Math.round(ghostSceneW)} × {Math.round(ghostSceneH)}
            </span>
          </div>,
          document.body,
        )}
    </>
  );
};

export default StickerPicker;
