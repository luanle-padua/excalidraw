// CAD View triggers — two on-demand routes only:
//
//   1. Toolbar button injected next to the sticker / stamp / frame
//      pickers — click opens a popover listing every DXF in the
//      meeting library; pick one to open as a tab.
//
//   2. Right-click on a DXF anchor on the canvas → context menu
//      with "Open in CAD view". Hit-tests via Excalidraw scene
//      coords (same pattern as the other context menus).
//
// We deliberately do NOT auto-open the pane when a new anchor
// appears: projects often have many DXFs and auto-spawning a tab
// each time was disruptive (request from user).

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAtomValue } from "../../../app-jotai";
import {
  cadViewStateAtom,
  openFileInCadView,
} from "../../../data/cadViewState";
import { isDxfFile, meetingFilesAtom } from "../../../data/meetingLibrary";

import { isDxfAnchorElement } from "../dxf/DXFCanvasOverlay";
import { findOrCreateToolbarExtras } from "../toolbarExtras";

const CADIcon = () => (
  <svg
    viewBox="0 0 20 20"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* Floor-plan / blueprint glyph — instantly reads as "CAD". */}
    <rect x="2.5" y="3" width="15" height="13" rx="1" />
    <path d="M2.5 8h15" />
    <path d="M9 8v8" />
    <path d="M9 12h4" />
    <path d="M13 12v4" />
  </svg>
);

// ---------------------------------------------------------------------
// Toolbar trigger — portal into Excalidraw's App-toolbar
// ---------------------------------------------------------------------
const ToolbarTrigger = ({ toolbarEl }: { toolbarEl: HTMLElement }) => {
  const viewState = useAtomValue(cadViewStateAtom);
  const files = useAtomValue(meetingFilesAtom);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const dxfFiles = useMemo(() => files.filter(isDxfFile), [files]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (popoverRef.current?.contains(t)) {
        return;
      }
      if (buttonRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const popoverPos = useMemo(() => {
    if (!open || !buttonRef.current) {
      return null;
    }
    const r = buttonRef.current.getBoundingClientRect();
    const POPOVER_W = 280;
    const POPOVER_H_GUESS = 320;
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
  }, [open]);

  return (
    <>
      {createPortal(
        <button
          ref={buttonRef}
          type="button"
          className={`ToolIcon ToolIcon_type_button ToolIcon_size_medium ToolIcon--plain mcm-cad-trigger${
            open ? " mcm-cad-trigger--open" : ""
          }${viewState.open ? " mcm-cad-trigger--active" : ""}`}
          aria-label="CAD view"
          title="CAD view — mở DXF trong pane"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="ToolIcon__icon">
            <CADIcon />
          </div>
        </button>,
        toolbarEl,
      )}

      {open &&
        popoverPos &&
        createPortal(
          <div
            ref={popoverRef}
            className="mcm-cad-popover"
            role="dialog"
            aria-label="Chọn DXF để mở"
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: popoverPos.left, top: popoverPos.top }}
          >
            <div className="mcm-cad-popover__header">
              <span className="mcm-cad-popover__title">DXF trên library</span>
              <span className="mcm-cad-popover__hint">
                Chọn để mở trong CAD view
              </span>
            </div>
            <div className="mcm-cad-popover__list">
              {dxfFiles.length === 0 ? (
                <div className="mcm-cad-popover__empty">
                  Chưa có file DXF nào trong library.
                  <br />
                  Upload .dxf qua thanh library bên phải.
                </div>
              ) : (
                dxfFiles.map((f) => {
                  const isOpenTab = viewState.openFileIds.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={`mcm-cad-popover__item${
                        isOpenTab ? " mcm-cad-popover__item--active" : ""
                      }`}
                      onClick={() => {
                        openFileInCadView(f.id);
                        setOpen(false);
                      }}
                    >
                      <span className="mcm-cad-popover__item-icon" aria-hidden>
                        📐
                      </span>
                      <span className="mcm-cad-popover__item-name">
                        {f.name}
                      </span>
                      {isOpenTab && (
                        <span className="mcm-cad-popover__item-tag">
                          đang mở
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

// ---------------------------------------------------------------------
// Right-click handler on DXF anchor elements
// ---------------------------------------------------------------------
type DXFContextMenuState = {
  fileId: string;
  fileName: string;
  clientX: number;
  clientY: number;
};

const RightClickTrigger = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  const [menu, setMenu] = useState<DXFContextMenuState | null>(null);

  // Hit-test a click against every DXF anchor rectangle. Returns the
  // topmost anchor + its library file id, or null.
  const hitTestDxfAnchor = (
    clientX: number,
    clientY: number,
  ): { fileId: string; fileName: string } | null => {
    if (!excalidrawAPI) {
      return null;
    }
    const container = document.querySelector(
      ".excalidraw-container",
    ) as HTMLElement | null;
    if (!container) {
      return null;
    }
    const rect = container.getBoundingClientRect();
    const appState = excalidrawAPI.getAppState();
    const zoom = appState.zoom.value;
    const sceneX = -appState.scrollX + (clientX - rect.left) / zoom;
    const sceneY = -appState.scrollY + (clientY - rect.top) / zoom;
    const elements = excalidrawAPI.getSceneElements();
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (!isDxfAnchorElement(el)) {
        continue;
      }
      if (
        sceneX >= el.x &&
        sceneX <= el.x + el.width &&
        sceneY >= el.y &&
        sceneY <= el.y + el.height
      ) {
        const fileId = el.customData.dxfFileId;
        const file = files.find((f) => f.id === fileId);
        return { fileId, fileName: file?.name ?? "DXF" };
      }
    }
    return null;
  };

  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const onContextMenu = (e: MouseEvent) => {
      const hit = hitTestDxfAnchor(e.clientX, e.clientY);
      if (!hit) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setMenu({
        fileId: hit.fileId,
        fileName: hit.fileName,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
    // hitTestDxfAnchor is closed over but its identity changes on
    // every render — listing it as a dep would force the effect to
    // re-bind the contextmenu listener every render, which is both
    // wasteful and a re-entrancy hazard. The function reads
    // excalidrawAPI + files which ARE listed, so its behaviour is
    // already correct under their changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, files]);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".mcm-cad-context-menu")) {
        return;
      }
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) {
    return null;
  }

  return createPortal(
    <div
      className="mcm-cad-context-menu"
      role="menu"
      // eslint-disable-next-line react/forbid-dom-props
      style={{ left: menu.clientX, top: menu.clientY }}
    >
      <div className="mcm-cad-context-menu__header">{menu.fileName}</div>
      <button
        type="button"
        role="menuitem"
        className="mcm-cad-context-menu__item"
        onClick={() => {
          openFileInCadView(menu.fileId);
          setMenu(null);
        }}
      >
        <span aria-hidden>📐</span>
        <span>Mở trong CAD view</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="mcm-cad-context-menu__item"
        onClick={() => setMenu(null)}
      >
        <span aria-hidden>↩️</span>
        <span>Huỷ</span>
      </button>
    </div>,
    document.body,
  );
};

// Auto-open used to fire here for every new DXF anchor, but with
// multi-file projects that ended up spamming the pane with tabs the
// user didn't ask for. The CAD view is now opened on demand only:
//
//   • toolbar button → file-picker popover → click a DXF
//   • OR right-click an existing DXF anchor on the canvas
//
// Both flows funnel through openFileInCadView() so re-opening an
// already-open file just switches to its tab.

// ---------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------
export const CADViewTriggers = () => {
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Shared MCM extras host inside .App-toolbar — see toolbarExtras.ts
    // for why both pickers route through it instead of portalling
    // directly into .App-toolbar.
    setToolbarEl(findOrCreateToolbarExtras());
    const obs = new MutationObserver(() => {
      const next = findOrCreateToolbarExtras();
      setToolbarEl((prev) => (prev === next ? prev : next));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  return (
    <>
      {toolbarEl && <ToolbarTrigger toolbarEl={toolbarEl} />}
      <RightClickTrigger />
    </>
  );
};

export default CADViewTriggers;
