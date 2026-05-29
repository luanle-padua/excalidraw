// IFC 3D View triggers — two on-demand routes only (mirrors
// CADViewTriggers):
//
//   1. Toolbar button injected via the shared MCM extras host — click
//      opens a popover listing every IFC model in the meeting library;
//      pick one to open as a 3D-view tab.
//
//   2. Right-click on an IFC anchor on the canvas → context menu with
//      "Mở trong 3D view". Hit-tests via Excalidraw scene coords (same
//      math as the CAD trigger).
//
// We deliberately do NOT auto-open the pane when a new anchor appears —
// both flows funnel through openFileInIfcView() so re-opening an already
// open model just switches to its tab.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAtomValue } from "../../../app-jotai";
import {
  ifcViewStateAtom,
  openFileInIfcView,
} from "../../../data/ifcViewState";
import { isIfcModelFile, meetingFilesAtom } from "../../../data/meetingLibrary";
import { useT } from "../../../i18n/mcm";

import { findOrCreateToolbarExtras } from "../toolbarExtras";

import { isIfcAnchorElement } from "./ifcAnchor";

import "./ifc-pane.scss";

const IFCIcon = () => (
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
    {/* Isometric 3D cube — instantly reads as "3D model". */}
    <path d="M10 2.5 17 6.25v7.5L10 17.5 3 13.75v-7.5z" />
    <path d="M10 2.5 17 6.25 10 10 3 6.25z" />
    <path d="M10 10v7.5" />
  </svg>
);

// ---------------------------------------------------------------------
// Toolbar trigger — portal into Excalidraw's App-toolbar
// ---------------------------------------------------------------------
const ToolbarTrigger = ({ toolbarEl }: { toolbarEl: HTMLElement }) => {
  const t = useT();
  const viewState = useAtomValue(ifcViewStateAtom);
  const files = useAtomValue(meetingFilesAtom);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const ifcFiles = useMemo(() => files.filter(isIfcModelFile), [files]);

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
          className={`ToolIcon ToolIcon_type_button ToolIcon_size_medium ToolIcon--plain mcm-ifc-trigger${
            open ? " mcm-ifc-trigger--open" : ""
          }${viewState.open ? " mcm-ifc-trigger--active" : ""}`}
          aria-label={t("ifc.trigger.aria")}
          title={t("ifc.trigger.title")}
          onClick={() => setOpen((v) => !v)}
        >
          <div className="ToolIcon__icon">
            <IFCIcon />
          </div>
        </button>,
        toolbarEl,
      )}

      {open &&
        popoverPos &&
        createPortal(
          <div
            ref={popoverRef}
            className="mcm-ifc-popover"
            role="dialog"
            aria-label={t("ifc.popover.aria")}
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: popoverPos.left, top: popoverPos.top }}
          >
            <div className="mcm-ifc-popover__header">
              <span className="mcm-ifc-popover__title">
                {t("ifc.popover.title")}
              </span>
              <span className="mcm-ifc-popover__hint">
                {t("ifc.popover.hint")}
              </span>
            </div>
            <div className="mcm-ifc-popover__list">
              {ifcFiles.length === 0 ? (
                <div className="mcm-ifc-popover__empty">
                  {t("ifc.popover.emptyTitle")}
                  <br />
                  {t("ifc.popover.emptyHint")}
                </div>
              ) : (
                ifcFiles.map((f) => {
                  const isOpenTab = viewState.openFileIds.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={`mcm-ifc-popover__item${
                        isOpenTab ? " mcm-ifc-popover__item--active" : ""
                      }`}
                      onClick={() => {
                        openFileInIfcView(f.id);
                        setOpen(false);
                      }}
                    >
                      <span className="mcm-ifc-popover__item-icon" aria-hidden>
                        🧊
                      </span>
                      <span className="mcm-ifc-popover__item-name">
                        {f.name}
                      </span>
                      {isOpenTab && (
                        <span className="mcm-ifc-popover__item-tag">
                          {t("ifc.popover.openTag")}
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
// Right-click handler on IFC anchor elements
// ---------------------------------------------------------------------
type IFCContextMenuState = {
  fileId: string;
  fileName: string;
  clientX: number;
  clientY: number;
};

const RightClickTrigger = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);
  const [menu, setMenu] = useState<IFCContextMenuState | null>(null);

  // Hit-test a click against every IFC anchor rectangle. Returns the
  // topmost anchor + its library file id, or null.
  const hitTestIfcAnchor = (
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
      if (!isIfcAnchorElement(el)) {
        continue;
      }
      if (
        sceneX >= el.x &&
        sceneX <= el.x + el.width &&
        sceneY >= el.y &&
        sceneY <= el.y + el.height
      ) {
        const fileId = el.customData.ifcFileId;
        const file = files.find((f) => f.id === fileId);
        return { fileId, fileName: file?.name ?? "IFC" };
      }
    }
    return null;
  };

  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const onContextMenu = (e: MouseEvent) => {
      const hit = hitTestIfcAnchor(e.clientX, e.clientY);
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
    // hitTestIfcAnchor is closed over but its identity changes every
    // render; it reads excalidrawAPI + files which ARE listed, so its
    // behaviour is already correct under their changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, files]);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".mcm-ifc-context-menu")) {
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
      className="mcm-ifc-context-menu"
      role="menu"
      // eslint-disable-next-line react/forbid-dom-props
      style={{ left: menu.clientX, top: menu.clientY }}
    >
      <div className="mcm-ifc-context-menu__header">{menu.fileName}</div>
      <button
        type="button"
        role="menuitem"
        className="mcm-ifc-context-menu__item"
        onClick={() => {
          openFileInIfcView(menu.fileId);
          setMenu(null);
        }}
      >
        <span aria-hidden>🗔</span>
        <span>{t("ifc.menu.openInPane")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="mcm-ifc-context-menu__item"
        onClick={() => setMenu(null)}
      >
        <span aria-hidden>↩️</span>
        <span>{t("ifc.menu.cancel")}</span>
      </button>
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------
export const IFC3DViewTriggers = () => {
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Shared MCM extras host inside .App-toolbar — see toolbarExtras.ts.
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

export default IFC3DViewTriggers;
