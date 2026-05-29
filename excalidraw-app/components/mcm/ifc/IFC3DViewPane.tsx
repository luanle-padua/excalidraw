// Right-docked vertical IFC (3D BIM) viewer pane. Each tab corresponds to
// a baked IFC model in the library and renders an interactive IFCRenderer
// (full orbit + element picking). Only the active tab is mounted at a time
// — switching re-mounts the renderer (keyed by activeFileId), keeping the
// WebGL slot budget tight + avoiding ResizeObserver firing on a hidden 0×0
// inactive panel. Structurally mirrors CADViewPane.tsx.
//
// Polish features:
//   • Body is sized via ResizeObserver so the 3D canvas fills the pane.
//   • Toolbar below the tabs: ↻ Fit, 🏢 Tầng (storey isolation), 🗂 Đối
//     tượng (object browser tree), view-style segmented control, X/Y/Z
//     section toggles + Lật flip, 📏 Đo (two-click measure), 👻 Ghost. All
//     drive the renderer's imperative controls.
//   • Storey dropdown, object browser + element-properties panel are
//     overlays inside the body — keeps the 3D area maximised when closed.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "../../../app-jotai";
import {
  closeIfcFileTab,
  closeIfcViewPane,
  getMaxIfcViewWidth,
  getMinIfcViewWidth,
  ifcViewStateAtom,
  setActiveIfcTab,
  setIfcViewWidth,
} from "../../../data/ifcViewState";
import { isIfcModelFile, meetingFilesAtom } from "../../../data/meetingLibrary";

import { IFCRenderer } from "./IFCRenderer";

import "./ifc-pane.scss";

import type { IFCRendererControls } from "./IFCRenderer";
import type {
  IfcElementMeta,
  IfcMetadataPayload,
  IfcStorey,
} from "./ifcTypes";

// A single section axis is active at a time (or none). Clicking the active
// axis again clears it; the engine shows a draggable plane while active.
type SectionAxis = "x" | "y" | "z";

// Render styles offered by the segmented control. Ghost is orthogonal and
// kept as a separate toggle.
type ViewStyle = "shaded" | "clay" | "wireframe";
const VIEW_STYLES: { id: ViewStyle; label: string }[] = [
  { id: "shaded", label: "Tô bóng" },
  { id: "clay", label: "Đất sét" },
  { id: "wireframe", label: "Khung dây" },
];

const SECTION_AXES: SectionAxis[] = ["x", "y", "z"];
const SECTION_LABEL: Record<SectionAxis, string> = {
  x: "X",
  y: "Y",
  z: "Z",
};

const NO_STOREY_KEY = "__no_storey__";
const NO_STOREY_LABEL = "(Không thuộc tầng)";
const UNCATEGORISED_LABEL = "(Không phân loại)";

// ----- Object-browser tree model ----------------------------------
// Built once per active model from the metadata. Grouped storey →
// category → element leaves. Storeys sorted by elevation, with a trailing
// "(Không thuộc tầng)" bucket for unplaced elements.
type TreeLeaf = {
  globalId: string;
  label: string;
};
type TreeCategory = {
  key: string; // unique within the storey: `${storeyKey}::${category}`
  label: string;
  leaves: TreeLeaf[];
};
type TreeStorey = {
  key: string; // storey GlobalId, or NO_STOREY_KEY
  storeyId: string | null; // real storey id for isolateStorey (null bucket)
  label: string;
  elementCount: number;
  categories: TreeCategory[];
};

const leafLabel = (el: IfcElementMeta): string =>
  el.name || el.type || el.globalId;

const buildTree = (metadata: IfcMetadataPayload): TreeStorey[] => {
  const storeyOrder = [...metadata.storeys].sort(
    (a, b) => a.elevation - b.elevation,
  );
  const storeyMeta = new Map<string, IfcStorey>();
  for (const s of storeyOrder) {
    storeyMeta.set(s.id, s);
  }

  // storeyKey → (categoryLabel → leaves)
  const grouped = new Map<string, Map<string, TreeLeaf[]>>();
  const ensureStorey = (key: string) => {
    let cats = grouped.get(key);
    if (!cats) {
      cats = new Map();
      grouped.set(key, cats);
    }
    return cats;
  };

  for (const el of Object.values(metadata.elements)) {
    const storeyKey = el.storeyId ?? NO_STOREY_KEY;
    const catLabel = el.category || el.type || UNCATEGORISED_LABEL;
    const cats = ensureStorey(storeyKey);
    let leaves = cats.get(catLabel);
    if (!leaves) {
      leaves = [];
      cats.set(catLabel, leaves);
    }
    leaves.push({ globalId: el.globalId, label: leafLabel(el) });
  }

  const toStorey = (
    key: string,
    storeyId: string | null,
    label: string,
  ): TreeStorey | null => {
    const cats = grouped.get(key);
    if (!cats) {
      return null;
    }
    const categories: TreeCategory[] = [...cats.entries()]
      .map(([catLabel, leaves]) => ({
        key: `${key}::${catLabel}`,
        label: catLabel,
        leaves: leaves
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const elementCount = categories.reduce(
      (n, c) => n + c.leaves.length,
      0,
    );
    return { key, storeyId, label, elementCount, categories };
  };

  const result: TreeStorey[] = [];
  for (const s of storeyOrder) {
    const node = toStorey(s.id, s.id, s.name || s.id);
    if (node) {
      result.push(node);
    }
  }
  const noStorey = toStorey(NO_STOREY_KEY, null, NO_STOREY_LABEL);
  if (noStorey) {
    result.push(noStorey);
  }
  return result;
};

export const IFC3DViewPane = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const state = useAtomValue(ifcViewStateAtom);
  const files = useAtomValue(meetingFilesAtom);

  // The persisted openFileIds list is keyed by user, not by meeting —
  // joining a different room can resurrect tabs whose file id only existed
  // in the previous room's library. We only ever render tabs whose file id
  // resolves to a real IFC model in the current meeting's library; the
  // effect below prunes stale ids from the persisted state once.
  const knownIfcIds = useMemo(
    () =>
      new Set(files.filter((f) => isIfcModelFile(f)).map((f) => f.id)),
    [files],
  );
  const visibleFileIds = useMemo(
    () => state.openFileIds.filter((id) => knownIfcIds.has(id)),
    [state.openFileIds, knownIfcIds],
  );

  useEffect(() => {
    // Wait until the library has populated before pruning — otherwise the
    // first (pre-hydration) render would wipe every valid tab as unknown.
    if (files.length === 0) {
      return;
    }
    for (const id of state.openFileIds) {
      if (!knownIfcIds.has(id)) {
        closeIfcFileTab(id);
      }
    }
  }, [files.length, state.openFileIds, knownIfcIds]);

  const fileMap = useMemo(() => {
    const map = new Map<string, (typeof files)[number]>();
    for (const f of files) {
      if (visibleFileIds.includes(f.id)) {
        map.set(f.id, f);
      }
    }
    return map;
  }, [files, visibleFileIds]);

  // ----- Resize (left edge — drag LEFT to grow) --------------------
  const resizeRef = useRef<{ startX: number; baseW: number } | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, baseW: state.width };
    setLiveWidth(state.width);
    setIsResizing(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    const dx = e.clientX - resizeRef.current.startX;
    // Clamp to BOTH min and max during drag — without the max clamp,
    // overshooting the cap would snap the pane back on release.
    const proposed = resizeRef.current.baseW - dx;
    const clamped = Math.max(
      getMinIfcViewWidth(),
      Math.min(getMaxIfcViewWidth(), proposed),
    );
    setLiveWidth(clamped);
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (liveWidth !== null) {
      setIfcViewWidth(liveWidth);
    }
    resizeRef.current = null;
    setLiveWidth(null);
    setIsResizing(false);
  };

  // ----- Body size (callback ref + ResizeObserver) -----------------
  // Drive IFCRenderer's width/height from the REAL body dimensions. We
  // start with null and gate the renderer mount on having measured first,
  // so the model fits to the true pane size (see CADViewPane for the full
  // rationale — same callback-ref-over-useEffect reasoning across the
  // open/close cycles where the pane returns null).
  const roRef = useRef<ResizeObserver | null>(null);
  const [bodySize, setBodySize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const handleBodyRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setBodySize(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setBodySize({
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      });
    }
    roRef.current = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) {
        return;
      }
      const w = Math.floor(e.contentRect.width);
      const h = Math.floor(e.contentRect.height);
      if (w > 0 && h > 0) {
        setBodySize({ width: w, height: h });
      }
    });
    roRef.current.observe(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Renderer controls + tool state ----------------------------
  // controls per active tab — captured via IFCRenderer.onReady.
  const controlsRef = useRef<IFCRendererControls | null>(null);
  const [ready, setReady] = useState(false);
  const [storeys, setStoreys] = useState<IfcStorey[]>([]);
  const [storeyPanelOpen, setStoreyPanelOpen] = useState(false);
  const [activeStoreyId, setActiveStoreyId] = useState<string | null>(null);
  const [sectionAxis, setSectionAxis] = useState<SectionAxis | null>(null);
  const [viewStyle, setViewStyle] = useState<ViewStyle>("shaded");
  const [measureOn, setMeasureOn] = useState(false);
  const [measureDist, setMeasureDist] = useState<number | null>(null);
  const [ghostOn, setGhostOn] = useState(false);
  const [selected, setSelected] = useState<IfcElementMeta | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ----- Object browser state ------------------------------------
  const [browserOpen, setBrowserOpen] = useState(false);
  // Hidden element GlobalIds (eye toggles). Maintained here; the full set
  // is pushed to the renderer via setHidden on each change.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  // Which storey / category branches are expanded. Categories collapse by
  // default so a 10k-element model never renders all leaves eagerly.
  const [expandedStoreys, setExpandedStoreys] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedCats, setExpandedCats] = useState<Set<string>>(
    () => new Set(),
  );

  // Body element ref captured separately for the measure-event listener
  // (the renderer dispatches "mcm-ifc-measure" which bubbles up to it).
  const bodyElRef = useRef<HTMLDivElement | null>(null);
  const setBodyEl = useCallback(
    (el: HTMLDivElement | null) => {
      bodyElRef.current = el;
      handleBodyRef(el);
    },
    [handleBodyRef],
  );

  const handleRendererReady = (controls: IFCRendererControls) => {
    controlsRef.current = controls;
    setReady(true);
    try {
      setStoreys(controls.getStoreys());
    } catch (err) {
      console.warn("[IFCView] getStoreys failed", err);
    }
  };

  const handleSelect = (el: IfcElementMeta | null) => {
    setSelected(el);
    setSelectedId(el?.globalId ?? null);
  };

  const handleFit = () => {
    controlsRef.current?.fitToModel();
  };

  const isolateStorey = (id: string | null) => {
    controlsRef.current?.isolateStorey(id);
    setActiveStoreyId(id);
  };

  // Select an element from the browser tree, framing the camera on it.
  const selectFromTree = (globalId: string) => {
    controlsRef.current?.select(globalId, { focus: true });
    setSelectedId(globalId);
    setSelected(controlsRef.current?.getSelected() ?? null);
  };

  // Toggle element visibility from the eye button. The renderer takes the
  // full hidden set each time, so we recompute then push.
  const toggleHidden = (globalId: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(globalId)) {
        next.delete(globalId);
      } else {
        next.add(globalId);
      }
      controlsRef.current?.setHidden([...next]);
      return next;
    });
  };

  const toggleStoreyExpanded = (key: string) => {
    setExpandedStoreys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleCatExpanded = (key: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectViewStyle = (style: ViewStyle) => {
    setViewStyle(style);
    controlsRef.current?.setViewStyle(style);
  };

  // X / Y / Z toggles — only one active at a time. Clicking the active
  // axis clears the section; the engine shows a draggable plane otherwise.
  const toggleSection = (axis: SectionAxis) => {
    if (sectionAxis === axis) {
      setSectionAxis(null);
      controlsRef.current?.setSection(null);
    } else {
      setSectionAxis(axis);
      controlsRef.current?.setSection(axis);
    }
  };

  const flipSection = () => {
    controlsRef.current?.flipSection();
  };

  const toggleMeasure = () => {
    const next = !measureOn;
    setMeasureOn(next);
    controlsRef.current?.toggleMeasure(next);
    if (!next) {
      setMeasureDist(null);
    }
  };

  const toggleGhost = () => {
    const next = !ghostOn;
    setGhostOn(next);
    controlsRef.current?.setGhost(next);
  };

  // Reset all per-tab control state when the tab switches (renderer
  // re-mounts via key prop). Wait for the new mount's onReady.
  useEffect(() => {
    controlsRef.current = null;
    setReady(false);
    setStoreys([]);
    setStoreyPanelOpen(false);
    setActiveStoreyId(null);
    setSectionAxis(null);
    setViewStyle("shaded");
    setMeasureOn(false);
    setMeasureDist(null);
    setGhostOn(false);
    setSelected(null);
    setSelectedId(null);
    setBrowserOpen(false);
    setHiddenIds(new Set());
    setExpandedStoreys(new Set());
    setExpandedCats(new Set());
  }, [state.activeFileId]);

  // Listen for completed measurements dispatched by the renderer. The
  // event bubbles from the renderer's container up to the body element.
  useEffect(() => {
    const el = bodyElRef.current;
    if (!el) {
      return undefined;
    }
    const onMeasure = (ev: Event) => {
      const detail = (ev as CustomEvent<{ distance: number }>).detail;
      if (detail && typeof detail.distance === "number") {
        setMeasureDist(detail.distance);
      }
    };
    el.addEventListener("mcm-ifc-measure", onMeasure as EventListener);
    return () =>
      el.removeEventListener("mcm-ifc-measure", onMeasure as EventListener);
    // bodySize re-attaches the listener after the body (re)mounts.
  }, [bodySize, state.activeFileId]);

  // Outside-click + Esc close the storey panel.
  useEffect(() => {
    if (!storeyPanelOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".mcm-ifc-view__storey-panel")) {
        return;
      }
      if (t?.closest(".mcm-ifc-view__tool--storeys")) {
        return;
      }
      setStoreyPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setStoreyPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [storeyPanelOpen]);

  // Outside-click + Esc close the object browser panel.
  useEffect(() => {
    if (!browserOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".mcm-ifc-view__browser-panel")) {
        return;
      }
      if (t?.closest(".mcm-ifc-view__tool--browser")) {
        return;
      }
      setBrowserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBrowserOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [browserOpen]);

  // Prefer the persisted active id if it survived the visibility filter,
  // otherwise fall back to the first visible tab. Computed before the
  // early return so the tree memo below can read the active model's
  // metadata without breaking the Rules of Hooks.
  const activeFileId = visibleFileIds.includes(state.activeFileId ?? "")
    ? state.activeFileId
    : visibleFileIds[0];
  const activeFile = activeFileId ? fileMap.get(activeFileId) : undefined;

  // Object-browser tree, rebuilt only when the active model changes. Keyed
  // by fileId so a tab switch produces a fresh tree (cheap; lazy-rendered).
  const tree = useMemo(
    () =>
      activeFile?.ifcMeta
        ? buildTree(activeFile.ifcMeta.metadata)
        : [],
    [activeFile?.ifcMeta],
  );

  if (!excalidrawAPI || !state.open || visibleFileIds.length === 0) {
    return null;
  }

  const effectiveWidth = liveWidth ?? state.width;

  return (
    <aside
      className={`mcm-ifc-view${isResizing ? " mcm-ifc-view--resizing" : ""}`}
      aria-label="IFC 3D view"
      // width is data-driven (user-resizable).
      // eslint-disable-next-line react/forbid-dom-props
      style={{ width: effectiveWidth }}
    >
      <div
        className={`mcm-ifc-view__resize-handle${
          isResizing ? " mcm-ifc-view__resize-handle--dragging" : ""
        }`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize IFC 3D view"
      />
      <div className="mcm-ifc-view__header">
        <div className="mcm-ifc-view__tabs">
          {visibleFileIds.map((fid) => {
            const isActive = fid === activeFileId;
            const name = fileMap.get(fid)?.name ?? "IFC";
            return (
              <div
                key={fid}
                className={`mcm-ifc-view__tab${
                  isActive ? " mcm-ifc-view__tab--active" : ""
                }`}
              >
                <button
                  type="button"
                  className="mcm-ifc-view__tab-label"
                  onClick={() => setActiveIfcTab(fid)}
                  title={name}
                >
                  🧊 {name}
                </button>
                <button
                  type="button"
                  className="mcm-ifc-view__tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeIfcFileTab(fid);
                  }}
                  aria-label={`Đóng tab ${name}`}
                  title="Đóng tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="mcm-ifc-view__close"
          onClick={() => closeIfcViewPane()}
          aria-label="Đóng IFC 3D view"
          title="Đóng"
        >
          ×
        </button>
      </div>

      {/* Toolbar row — actions that operate on the active model. */}
      <div className="mcm-ifc-view__toolbar">
        <button
          type="button"
          className="mcm-ifc-view__tool"
          onClick={handleFit}
          disabled={!ready}
          title="Fit mô hình vào pane (reset view)"
        >
          <span aria-hidden>↻</span>
          <span>Fit</span>
        </button>
        <button
          type="button"
          className={`mcm-ifc-view__tool mcm-ifc-view__tool--storeys${
            storeyPanelOpen ? " mcm-ifc-view__tool--active" : ""
          }`}
          onClick={() => setStoreyPanelOpen((v) => !v)}
          disabled={!ready || storeys.length === 0}
          title={
            storeys.length === 0
              ? "Không có tầng nào"
              : `${storeys.length} tầng — bấm để cô lập`
          }
        >
          <span aria-hidden>🏢</span>
          <span>Tầng</span>
          {storeys.length > 0 && (
            <span className="mcm-ifc-view__tool-badge">{storeys.length}</span>
          )}
        </button>
        <button
          type="button"
          className={`mcm-ifc-view__tool mcm-ifc-view__tool--browser${
            browserOpen ? " mcm-ifc-view__tool--active" : ""
          }`}
          onClick={() => setBrowserOpen((v) => !v)}
          disabled={!ready || tree.length === 0}
          title={
            tree.length === 0
              ? "Không có đối tượng nào"
              : "Cây đối tượng — duyệt, chọn, ẩn/hiện"
          }
        >
          <span aria-hidden>🗂</span>
          <span>Đối tượng</span>
        </button>
        {/* View-style segmented control — orthogonal to the Ghost toggle. */}
        <div
          className="mcm-ifc-view__segmented"
          role="group"
          aria-label="Kiểu hiển thị"
        >
          {VIEW_STYLES.map((vs) => (
            <button
              key={vs.id}
              type="button"
              className={`mcm-ifc-view__segment${
                viewStyle === vs.id ? " mcm-ifc-view__segment--active" : ""
              }`}
              onClick={() => selectViewStyle(vs.id)}
              disabled={!ready}
              aria-pressed={viewStyle === vs.id}
              title={`Kiểu hiển thị: ${vs.label}`}
            >
              {vs.label}
            </button>
          ))}
        </div>
        {/* Section controls — X / Y / Z axis toggles + Lật flip. One axis
            at a time; the plane is dragged in the 3D view via a gizmo. */}
        <div
          className="mcm-ifc-view__section-group"
          role="group"
          aria-label="Mặt cắt"
        >
          <span className="mcm-ifc-view__section-label" aria-hidden>
            ✂️
          </span>
          {SECTION_AXES.map((axis) => (
            <button
              key={axis}
              type="button"
              className={`mcm-ifc-view__segment${
                sectionAxis === axis ? " mcm-ifc-view__segment--active" : ""
              }`}
              onClick={() => toggleSection(axis)}
              disabled={!ready}
              aria-pressed={sectionAxis === axis}
              title={`Mặt cắt trục ${SECTION_LABEL[axis]} — kéo mặt phẳng trong khung 3D để di chuyển`}
            >
              {SECTION_LABEL[axis]}
            </button>
          ))}
          <button
            type="button"
            className="mcm-ifc-view__tool mcm-ifc-view__tool--flip"
            onClick={flipSection}
            disabled={!ready || sectionAxis === null}
            title="Lật mặt cắt — đổi nửa không gian giữ lại"
          >
            <span aria-hidden>🔁</span>
            <span>Lật</span>
          </button>
        </div>
        <button
          type="button"
          className={`mcm-ifc-view__tool${
            measureOn ? " mcm-ifc-view__tool--active" : ""
          }`}
          onClick={toggleMeasure}
          disabled={!ready}
          title="Đo khoảng cách — bấm 2 điểm trên mô hình"
        >
          <span aria-hidden>📏</span>
          <span>Đo</span>
        </button>
        <button
          type="button"
          className={`mcm-ifc-view__tool${
            ghostOn ? " mcm-ifc-view__tool--active" : ""
          }`}
          onClick={toggleGhost}
          disabled={!ready}
          title="Ghost — làm mờ mọi thứ trừ phần đang chọn"
        >
          <span aria-hidden>👻</span>
          <span>Ghost</span>
        </button>
        {measureOn && measureDist !== null && (
          <span className="mcm-ifc-view__measure-readout" aria-live="polite">
            📏 {measureDist.toFixed(2)}
          </span>
        )}
        {sectionAxis !== null && (
          <span className="mcm-ifc-view__section-hint" aria-live="polite">
            Kéo mặt phẳng cắt trong khung 3D để di chuyển.
          </span>
        )}
      </div>

      <div ref={setBodyEl} className="mcm-ifc-view__body">
        {/* keyed by activeFileId so a tab-switch fully re-mounts the
            renderer — cleanest way to swap WebGL contexts safely. Wait
            for the real body measurement before mounting. */}
        {activeFileId && activeFile?.ifcMeta && bodySize && (
          <IFCRenderer
            key={activeFileId}
            fileId={activeFileId}
            glbUrl={activeFile.dataURL}
            metadata={activeFile.ifcMeta.metadata}
            width={bodySize.width}
            height={bodySize.height}
            instanceId={`ifc-pane-${activeFileId}`}
            interactive
            onReady={handleRendererReady}
            onSelect={handleSelect}
          />
        )}

        {storeyPanelOpen && storeys.length > 0 && (
          <div
            className="mcm-ifc-view__storey-panel"
            role="dialog"
            aria-label="Tầng IFC"
          >
            <div className="mcm-ifc-view__storey-panel-header">
              <span className="mcm-ifc-view__storey-panel-title">
                Tầng ({storeys.length})
              </span>
            </div>
            <div className="mcm-ifc-view__storey-list">
              <button
                type="button"
                className={`mcm-ifc-view__storey-row${
                  activeStoreyId === null
                    ? " mcm-ifc-view__storey-row--active"
                    : ""
                }`}
                onClick={() => isolateStorey(null)}
                title="Hiện tất cả tầng"
              >
                <span className="mcm-ifc-view__storey-name">Tất cả</span>
              </button>
              {storeys.map((s) => {
                const isActive = activeStoreyId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`mcm-ifc-view__storey-row${
                      isActive ? " mcm-ifc-view__storey-row--active" : ""
                    }`}
                    onClick={() => isolateStorey(s.id)}
                    title={s.name}
                  >
                    <span className="mcm-ifc-view__storey-name">
                      {s.name || s.id}
                    </span>
                    <span className="mcm-ifc-view__storey-elev">
                      {s.elevation.toFixed(1)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {browserOpen && tree.length > 0 && (
          <div
            className="mcm-ifc-view__browser-panel"
            role="dialog"
            aria-label="Cây đối tượng IFC"
          >
            <div className="mcm-ifc-view__browser-header">
              <span className="mcm-ifc-view__browser-title">Đối tượng</span>
              <button
                type="button"
                className="mcm-ifc-view__props-close"
                onClick={() => isolateStorey(null)}
                title="Hiện tất cả tầng (bỏ cô lập)"
              >
                Hiện tất cả tầng
              </button>
            </div>
            <div className="mcm-ifc-view__browser-tree">
              {tree.map((storey) => {
                const storeyExpanded = expandedStoreys.has(storey.key);
                const isIsolated =
                  storey.storeyId !== null &&
                  activeStoreyId === storey.storeyId;
                return (
                  <div
                    key={storey.key}
                    className="mcm-ifc-view__tree-storey"
                  >
                    <div className="mcm-ifc-view__tree-row mcm-ifc-view__tree-row--storey">
                      <button
                        type="button"
                        className="mcm-ifc-view__tree-twisty"
                        onClick={() => toggleStoreyExpanded(storey.key)}
                        aria-expanded={storeyExpanded}
                        title={storeyExpanded ? "Thu gọn" : "Mở rộng"}
                      >
                        {storeyExpanded ? "▾" : "▸"}
                      </button>
                      <span
                        className="mcm-ifc-view__tree-name"
                        title={storey.label}
                      >
                        {storey.label}
                      </span>
                      <span className="mcm-ifc-view__tree-count">
                        {storey.elementCount}
                      </span>
                      {storey.storeyId !== null && (
                        <button
                          type="button"
                          className={`mcm-ifc-view__tree-isolate${
                            isIsolated
                              ? " mcm-ifc-view__tree-isolate--active"
                              : ""
                          }`}
                          onClick={() =>
                            isolateStorey(
                              isIsolated ? null : storey.storeyId,
                            )
                          }
                          title={
                            isIsolated
                              ? "Bỏ cô lập tầng"
                              : "Cô lập tầng này"
                          }
                        >
                          Cô lập
                        </button>
                      )}
                    </div>
                    {storeyExpanded &&
                      storey.categories.map((cat) => {
                        const catExpanded = expandedCats.has(cat.key);
                        return (
                          <div
                            key={cat.key}
                            className="mcm-ifc-view__tree-cat"
                          >
                            <div className="mcm-ifc-view__tree-row mcm-ifc-view__tree-row--cat">
                              <button
                                type="button"
                                className="mcm-ifc-view__tree-twisty"
                                onClick={() => toggleCatExpanded(cat.key)}
                                aria-expanded={catExpanded}
                                title={catExpanded ? "Thu gọn" : "Mở rộng"}
                              >
                                {catExpanded ? "▾" : "▸"}
                              </button>
                              <span
                                className="mcm-ifc-view__tree-name"
                                title={cat.label}
                              >
                                {cat.label}
                              </span>
                              <span className="mcm-ifc-view__tree-count">
                                {cat.leaves.length}
                              </span>
                            </div>
                            {catExpanded &&
                              cat.leaves.map((leaf) => {
                                const isSel = selectedId === leaf.globalId;
                                const isHidden = hiddenIds.has(leaf.globalId);
                                return (
                                  <div
                                    key={leaf.globalId}
                                    className={`mcm-ifc-view__tree-row mcm-ifc-view__tree-row--leaf${
                                      isSel
                                        ? " mcm-ifc-view__tree-row--selected"
                                        : ""
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      className="mcm-ifc-view__tree-leaf-label"
                                      onClick={() =>
                                        selectFromTree(leaf.globalId)
                                      }
                                      title={leaf.label}
                                    >
                                      {leaf.label}
                                    </button>
                                    <button
                                      type="button"
                                      className="mcm-ifc-view__tree-eye"
                                      onClick={() =>
                                        toggleHidden(leaf.globalId)
                                      }
                                      aria-pressed={isHidden}
                                      title={
                                        isHidden
                                          ? "Hiện đối tượng"
                                          : "Ẩn đối tượng"
                                      }
                                    >
                                      {isHidden ? "🚫" : "👁"}
                                    </button>
                                  </div>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selected && (
          <div
            className="mcm-ifc-view__props-panel"
            role="dialog"
            aria-label="Thuộc tính phần tử"
          >
            <div className="mcm-ifc-view__props-header">
              <span
                className="mcm-ifc-view__props-title"
                title={selected.name || selected.type}
              >
                {selected.name || selected.type}
              </span>
              <button
                type="button"
                className="mcm-ifc-view__props-close"
                onClick={() => {
                  controlsRef.current?.clearSelection();
                  setSelected(null);
                  setSelectedId(null);
                }}
                aria-label="Bỏ chọn"
                title="Bỏ chọn"
              >
                ×
              </button>
            </div>
            <div className="mcm-ifc-view__props-body">
              <div className="mcm-ifc-view__props-section-label">Tổng quan</div>
              <div className="mcm-ifc-view__props-row">
                <span className="mcm-ifc-view__props-key">Tên</span>
                <span className="mcm-ifc-view__props-val">
                  {selected.name || "—"}
                </span>
              </div>
              <div className="mcm-ifc-view__props-row">
                <span className="mcm-ifc-view__props-key">Loại</span>
                <span className="mcm-ifc-view__props-val">{selected.type}</span>
              </div>
              <div className="mcm-ifc-view__props-row">
                <span className="mcm-ifc-view__props-key">Danh mục</span>
                <span className="mcm-ifc-view__props-val">
                  {selected.category || "—"}
                </span>
              </div>
              <div className="mcm-ifc-view__props-row">
                <span className="mcm-ifc-view__props-key">Họ</span>
                <span className="mcm-ifc-view__props-val">
                  {selected.family || "—"}
                </span>
              </div>
              <div className="mcm-ifc-view__props-row">
                <span className="mcm-ifc-view__props-key">Kiểu</span>
                <span className="mcm-ifc-view__props-val">
                  {selected.typeName || "—"}
                </span>
              </div>

              {Object.keys(selected.props).length > 0 && (
                <>
                  <div className="mcm-ifc-view__props-section-label">
                    Thuộc tính
                  </div>
                  {Object.entries(selected.props).map(([k, v]) => (
                    <div key={k} className="mcm-ifc-view__props-row">
                      <span className="mcm-ifc-view__props-key" title={k}>
                        {k}
                      </span>
                      <span className="mcm-ifc-view__props-val">{v}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

export default IFC3DViewPane;
