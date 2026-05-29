// HTML overlay that drives every IFC (3D BIM) anchor on the canvas.
// Mirrors PDFCanvasOverlay: each anchor is an Excalidraw IMAGE element
// with `customData.mcmType === "ifc-anchor"` — Excalidraw owns its
// position / size / lock / collab-sync AND paints the baked 3D snapshot
// (kept in its binary-file map under `ifcSnapshotFileId`) natively on
// the canvas, so pen strokes / shapes / text the user adds AFTER the
// model stack on top of it via regular element-order semantics.
//
// PASSIVE anchors render NOTHING in this overlay — the Excalidraw image
// element shows the seeded thumbnail / last-baked snapshot directly.
// 3D is HEAVY (the renderer slot cap is 2), so passive anchors NEVER
// mount a live renderer. Only the FOCUSED anchor mounts a live
// <IFCRenderer interactive/> on top (for orbit / zoom / storeys /
// section / measure …). On focus exit it bakes the live view
// (exportPng → the anchor's snapshot file in Excalidraw's file map) and
// persists the camera view back to customData, then bumps the image
// element so the canvas repaints with the fresh snapshot.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../../../app-jotai";
import { meetingFilesAtom, isIfcModelFile } from "../../../data/meetingLibrary";
import { openFileInIfcView } from "../../../data/ifcViewState";
import { useT } from "../../../i18n/mcm";

import { IFCRenderer } from "./IFCRenderer";
import { isIfcAnchorElement } from "./ifcAnchor";

import "./ifc-overlay.scss";

import type { IFCRendererControls, IFCViewState } from "./IFCRenderer";
import type { IfcElementMeta, IfcStorey } from "./ifcTypes";

/** Parse the `ifcView` field on an anchor's customData into a typed view
 *  state, defensively rejecting partial payloads from older versions or
 *  malformed peer broadcasts. */
const viewFor = (el: ExcalidrawElement): IFCViewState | null => {
  const raw = (el.customData as Record<string, unknown> | undefined)
    ?.ifcView as { pos?: unknown; target?: unknown } | undefined;
  const isVec3 = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
  if (!raw || !isVec3(raw.pos) || !isVec3(raw.target)) {
    return null;
  }
  return { pos: raw.pos, target: raw.target };
};

type AnchorPosition = {
  /** Excalidraw element id — stable React key + cross-frame identity */
  elementId: string;
  fileId: string;
  /** viewport px from the canvas-wrap top-left */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Persisted camera view from customData.ifcView (null = default fit).
   *  Restored onto the live renderer when the anchor is focused. */
  view: IFCViewState | null;
  /** Snapshot file id (in Excalidraw's binary-file map) this anchor's
   *  image displays. Mirrors customData.ifcSnapshotFileId. Null only on
   *  malformed anchors missing the field. */
  snapshotFileId: string | null;
};

type ContextMenuState = {
  /** anchor elementId the menu targets */
  elementId: string;
  /** viewport px where the menu pops up (= the right-click point) */
  clientX: number;
  clientY: number;
};

/** Convert a Blob to a data URL — used to turn exportPng's PNG blob into
 *  a dataURL we can store in Excalidraw's binary-file map. */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });

/** Bypass Excalidraw's `addMissingFiles` "skip if id present" guard so
 *  the supplied snapshot REPLACES (not coexists with) whatever bytes
 *  currently live under `fileId`. `getFiles()` hands back the internal
 *  `this.files` reference, so deleting on it actually evicts the entry,
 *  and the next `addFiles` treats the id as fresh, clears the image-shape
 *  cache, and forces the canvas to repaint. Mirrors PDFCanvasOverlay's
 *  writePdfSnapshotToFileMap. */
const writeIfcSnapshotToFileMap = (
  excalidrawAPI: ReturnType<typeof useExcalidrawAPI>,
  snapshotFileId: string,
  dataUrl: string,
): void => {
  if (!excalidrawAPI) {
    return;
  }
  const filesMap = excalidrawAPI.getFiles() as Record<
    string,
    BinaryFileData | undefined
  >;
  if (filesMap[snapshotFileId]) {
    delete filesMap[snapshotFileId];
  }
  excalidrawAPI.addFiles([
    {
      id: snapshotFileId as FileId,
      dataURL: dataUrl as unknown as BinaryFileData["dataURL"],
      mimeType: "image/png" as BinaryFileData["mimeType"],
      created: Date.now(),
    },
  ]);
};

/** Section axis labels for the focus-toolbar button + popover. */
const SECTION_LABEL: Record<"x" | "y" | "z", string> = {
  x: "X",
  y: "Y",
  z: "Z",
};

/** Render styles offered by the engine, with i18n key suffixes for their
 *  label + tooltip. Order = the segmented-control order in the view-style
 *  popover. Resolved through `t()` at render time. `as const` keeps each
 *  key as its string-literal type so it satisfies `t()`'s key param. */
type ViewStyle = "shaded" | "clay" | "wireframe";
const VIEW_STYLES = [
  {
    id: "shaded",
    labelKey: "ifc.viewStyle.shaded",
    titleKey: "ifc.viewStyle.shadedTitle",
  },
  {
    id: "clay",
    labelKey: "ifc.viewStyle.clay",
    titleKey: "ifc.viewStyle.clayTitle",
  },
  {
    id: "wireframe",
    labelKey: "ifc.viewStyle.wireframe",
    titleKey: "ifc.viewStyle.wireframeTitle",
  },
] as const satisfies ReadonlyArray<{
  id: ViewStyle;
  labelKey: string;
  titleKey: string;
}>;

export const IFCCanvasOverlay = () => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const files = useAtomValue(meetingFilesAtom);

  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);
  // anchorsRef mirrors state for synchronous access inside the global
  // dblclick / contextmenu listeners (avoid re-binding per render).
  const anchorsRef = useRef<AnchorPosition[]>([]);
  anchorsRef.current = anchors;

  // Right-click → small context menu → enters focus mode for that
  // anchor. While focused, the live IFCRenderer receives pointer events
  // (orbit / zoom / pick) and a focus toolbar overlays the corner.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusedAnchorId, setFocusedAnchorId] = useState<string | null>(null);

  // Per-anchor imperative controls returned by the renderer's onReady.
  // Only the focused anchor ever has one (we only mount one live
  // renderer at a time). Keyed by elementId.
  const controlsRef = useRef<Map<string, IFCRendererControls>>(new Map());

  // Ref-callback that wires the renderer's `mcm-ifc-measure` CustomEvent
  // (which bubbles up to the frame) to the distance readout. React's
  // synthetic event system doesn't see custom DOM events, so we attach a
  // native listener to the focused frame element and tear it down when
  // the node is detached / focus changes.
  const measureCleanupRef = useRef<(() => void) | null>(null);
  const measureFrameRef = (node: HTMLDivElement | null) => {
    measureCleanupRef.current?.();
    measureCleanupRef.current = null;
    if (!node) {
      return;
    }
    const onMeasure = (e: Event) => {
      const detail = (e as CustomEvent<{ distance: number }>).detail;
      if (detail && typeof detail.distance === "number") {
        setMeasureDist(detail.distance);
      }
    };
    node.addEventListener("mcm-ifc-measure", onMeasure as EventListener);
    measureCleanupRef.current = () =>
      node.removeEventListener("mcm-ifc-measure", onMeasure as EventListener);
  };

  // Focus-mode transient UI state (all scoped to the focused anchor):
  const [storeyPanelOpen, setStoreyPanelOpen] = useState(false);
  const [storeys, setStoreys] = useState<IfcStorey[]>([]);
  const [isolatedStoreyId, setIsolatedStoreyId] = useState<string | null>(null);
  const [sectionAxis, setSectionAxis] = useState<"x" | "y" | "z" | null>(null);
  const [sectionPanelOpen, setSectionPanelOpen] = useState(false);
  const [measureOn, setMeasureOn] = useState(false);
  const [measureDist, setMeasureDist] = useState<number | null>(null);
  const [ghostOn, setGhostOn] = useState(false);
  const [viewStyle, setViewStyle] = useState<ViewStyle>("shaded");
  const [viewStylePanelOpen, setViewStylePanelOpen] = useState(false);
  const [selected, setSelected] = useState<IfcElementMeta | null>(null);

  const fileById = useMemo(() => {
    const m = new Map<string, typeof files[number]>();
    for (const f of files) {
      m.set(f.id, f);
    }
    return m;
  }, [files]);

  // Quick lookup whether an anchor's file is an IFC model in the library
  // — peers might race the anchor element broadcast vs the file
  // broadcast; show a "waiting" state until the file arrives.
  const knownIfcFileIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (isIfcModelFile(f)) {
        s.add(f.id);
      }
    }
    return s;
  }, [files]);

  /** Bake the live 3D view into the anchor's snapshot file (so the
   *  Excalidraw image element repaints with it) AND persist the camera
   *  view to customData. Run on focus exit so the passive anchor's image
   *  shows the user's last orbit.
   *
   *  Ordering mirrors PDFCanvasOverlay: exportPng + getView are captured
   *  BEFORE any updateScene, because updateScene triggers a re-render
   *  that drops focus → the live renderer unmounts (and a later exportPng
   *  would read a blank framebuffer). We then (a) write the fresh PNG
   *  into the file map under the anchor's snapshotFileId — deleting the
   *  existing entry first so addFiles doesn't skip it as already-present
   *  — and (b) bump the image element via newElementWith (so Excalidraw
   *  drops its cached shape for the now-replaced file and repaints)
   *  together with the persisted ifcView, in a single updateScene that
   *  Excalidraw's onChange broadcasts to peers + round-trips on reload. */
  const captureAndPersistView = async (anchor: AnchorPosition) => {
    if (!excalidrawAPI) {
      return;
    }
    const controls = controlsRef.current.get(anchor.elementId);
    if (!controls) {
      return;
    }
    const view = controls.getView();
    let dataUrl: string | null = null;
    try {
      const blob = await controls.exportPng();
      if (blob) {
        dataUrl = await blobToDataUrl(blob);
      }
    } catch (err) {
      console.warn("[IFCCanvasOverlay] view snapshot failed", err);
    }
    // Replace the snapshot bytes BEFORE the version bump so the repaint
    // reads the fresh PNG.
    if (dataUrl && anchor.snapshotFileId) {
      writeIfcSnapshotToFileMap(excalidrawAPI, anchor.snapshotFileId, dataUrl);
    }
    // Single updateScene carrying both the element version bump (so the
    // canvas image drops its cached shape + repaints with the now-
    // replaced file bytes) and the persisted camera view. We always pass
    // a fresh `customData` object so newElementWith is guaranteed to bump
    // the version even when only the snapshot changed (view unchanged).
    const bakedSnapshot = dataUrl !== null;
    if (!bakedSnapshot && !view) {
      return;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      if (el.id !== anchor.elementId || !isIfcAnchorElement(el)) {
        return el;
      }
      return newElementWith(el, {
        customData: {
          ...el.customData,
          ...(view ? { ifcView: { pos: view.pos, target: view.target } } : {}),
        },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  };

  // exitFocus must be reachable from synchronous handlers that close
  // over fresh state. Mirror it onto a ref so handlers can `void` it
  // without React re-binding every listener each render.
  const exitFocusRef = useRef<((newId: string | null) => Promise<void>) | null>(
    null,
  );
  exitFocusRef.current = async (newId) => {
    const oldId = focusedAnchorId;
    if (oldId && oldId !== newId) {
      const anchor = anchors.find((a) => a.elementId === oldId);
      if (anchor) {
        // Await capture so the renderer stays mounted long enough for
        // exportPng's toBlob to read the live framebuffer — setting
        // focus first would unmount it and the snapshot would be blank.
        await captureAndPersistView(anchor);
      }
      controlsRef.current.delete(oldId);
    }
    setFocusedAnchorId(newId);
    // Reset transient focus UI for the (new or absent) focus target.
    setStoreyPanelOpen(false);
    setStoreys([]);
    setIsolatedStoreyId(null);
    setSectionAxis(null);
    setSectionPanelOpen(false);
    setMeasureOn(false);
    setMeasureDist(null);
    setGhostOn(false);
    setViewStyle("shaded");
    setViewStylePanelOpen(false);
    setSelected(null);
  };

  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }

    const recompute = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      const next: AnchorPosition[] = [];
      const zoom = appState.zoom.value;
      for (const el of elements) {
        if (!isIfcAnchorElement(el)) {
          continue;
        }
        const viewportX = (el.x + appState.scrollX) * zoom;
        const viewportY = (el.y + appState.scrollY) * zoom;
        const view = viewFor(el);
        next.push({
          elementId: el.id,
          fileId: el.customData.ifcFileId,
          left: viewportX,
          top: viewportY,
          width: el.width * zoom,
          height: el.height * zoom,
          view,
          snapshotFileId:
            typeof el.customData.ifcSnapshotFileId === "string"
              ? el.customData.ifcSnapshotFileId
              : null,
        });
      }
      setAnchors((prev) => {
        if (prev.length === next.length) {
          const same = prev.every(
            (p, i) =>
              p.elementId === next[i].elementId &&
              p.fileId === next[i].fileId &&
              p.left === next[i].left &&
              p.top === next[i].top &&
              p.width === next[i].width &&
              p.height === next[i].height &&
              p.snapshotFileId === next[i].snapshotFileId,
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
  }, [excalidrawAPI]);

  // For any anchor whose snapshot file is missing in Excalidraw's file
  // map, seed it from the library-baked 3D thumbnail (or a 1×1
  // transparent PNG when the model didn't bake one). This is what makes
  // PASSIVE anchors show the model immediately — the Excalidraw image
  // element needs a file under its fileId BEFORE focus has ever baked a
  // snapshot — and it prevents the missing-image placeholder for peers
  // receiving a fresh anchor before its snapshot lands. Mirrors
  // PDFCanvasOverlay's seed effect. NB: this is a passive SEED only —
  // there is no on-canvas auto-bake / hidden renderer.
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const existingFiles = excalidrawAPI.getFiles();
    const additions: BinaryFileData[] = [];
    for (const a of anchors) {
      if (!a.snapshotFileId) {
        continue;
      }
      if (existingFiles[a.snapshotFileId]) {
        continue;
      }
      const libFile = files.find((f) => f.id === a.fileId);
      const seed =
        libFile?.ifcMeta?.thumbnail ??
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
      additions.push({
        id: a.snapshotFileId as FileId,
        dataURL: seed as unknown as BinaryFileData["dataURL"],
        mimeType: "image/png" as BinaryFileData["mimeType"],
        created: Date.now(),
      });
    }
    if (additions.length > 0) {
      excalidrawAPI.addFiles(additions);
    }
  }, [anchors, files, excalidrawAPI]);

  // When the user copies an anchor (Ctrl+D / clone-paste / paste from
  // another scene), Excalidraw deep-clones the element but shallow-clones
  // customData, so the duplicate inherits the ORIGINAL's
  // ifcSnapshotFileId. Both anchors then point at the same file map
  // entry and a bake on one rewrites the snapshot for both.
  //
  // We fix it deterministically: every anchor's snapshotFileId should
  // equal `ifc-snap-{element.id}` (insertion enforces this). Any anchor
  // where the invariant is broken is, by definition, a copy whose
  // customData drifted away from its new element id, so we re-key it. The
  // rule is purely a function of the element id, which means every peer
  // running this effect produces the same migration → no concurrent-
  // write races. Mirrors PDFCanvasOverlay's duplicate re-key effect.
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const migrations: Array<{
      elementId: string;
      newSnapshotFileId: string;
      oldSnapshotFileId: string;
    }> = [];
    for (const a of anchors) {
      if (!a.snapshotFileId) {
        continue;
      }
      const expected = `ifc-snap-${a.elementId}`;
      if (a.snapshotFileId === expected) {
        continue;
      }
      migrations.push({
        elementId: a.elementId,
        newSnapshotFileId: expected,
        oldSnapshotFileId: a.snapshotFileId,
      });
    }
    if (migrations.length === 0) {
      return;
    }
    // Seed the new fileIds from the originals so the copy doesn't flash a
    // missing-image placeholder during the re-key.
    const filesMap = excalidrawAPI.getFiles() as Record<
      string,
      BinaryFileData | undefined
    >;
    const additions: BinaryFileData[] = [];
    for (const m of migrations) {
      const oldFile = filesMap[m.oldSnapshotFileId];
      if (oldFile) {
        additions.push({
          ...oldFile,
          id: m.newSnapshotFileId as FileId,
          created: Date.now(),
        });
      }
    }
    if (additions.length > 0) {
      excalidrawAPI.addFiles(additions);
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    const next = all.map((el) => {
      const m = migrations.find((mig) => mig.elementId === el.id);
      if (!m || !isIfcAnchorElement(el) || el.type !== "image") {
        return el;
      }
      return newElementWith(el, {
        // Image element's own fileId mirrors customData so Excalidraw
        // renders the right file.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileId: m.newSnapshotFileId as any,
        customData: {
          ...el.customData,
          ifcSnapshotFileId: m.newSnapshotFileId,
        },
      });
    });
    excalidrawAPI.updateScene({ elements: next });
  }, [anchors, excalidrawAPI]);

  // Block Excalidraw's default double-click-to-edit-text on the image
  // anchor — typing a text label inside the 3D frame is never what the
  // user wants. Capture-phase listener runs BEFORE Excalidraw's React
  // handlers; if the dblclick lands over an anchor we swallow it.
  // Hit-testing is in canvas-wrap-local coords (anchor positions are
  // stored that way; e.clientX/Y are viewport → subtract the wrap rect).
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const wrap = document.querySelector(
      ".mcm-shell__canvas-wrap",
    ) as HTMLElement | null;
    if (!wrap) {
      return undefined;
    }
    const onDblClick = (e: MouseEvent) => {
      if (anchorsRef.current.length === 0) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      for (const a of anchorsRef.current) {
        if (
          localX >= a.left &&
          localX <= a.left + a.width &&
          localY >= a.top &&
          localY <= a.top + a.height
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
      }
    };
    window.addEventListener("dblclick", onDblClick, true);
    return () => window.removeEventListener("dblclick", onDblClick, true);
  }, [excalidrawAPI]);

  // Right-click on an IFC anchor → show our context menu. Capture phase
  // so Excalidraw's own right-click handler doesn't also fire.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const wrap = document.querySelector(
      ".mcm-shell__canvas-wrap",
    ) as HTMLElement | null;
    if (!wrap) {
      return undefined;
    }
    const onContextMenu = (e: MouseEvent) => {
      if (anchorsRef.current.length === 0) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      for (const a of anchorsRef.current) {
        if (
          localX >= a.left &&
          localX <= a.left + a.width &&
          localY >= a.top &&
          localY <= a.top + a.height
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setContextMenu({
            elementId: a.elementId,
            clientX: e.clientX,
            clientY: e.clientY,
          });
          return;
        }
      }
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [excalidrawAPI]);

  // Dismiss context menu on outside click / ESC; also exit focus on ESC.
  useEffect(() => {
    if (!contextMenu && !focusedAnchorId) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest(".mcm-ifc-context-menu")) {
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
      }
      // Outside-click (not on our overlay UI) exits focus mode too.
      if (focusedAnchorId && !(t && t.closest(".mcm-ifc-layer__anchor"))) {
        void exitFocusRef.current?.(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
      }
      if (focusedAnchorId) {
        // Route through exitFocusRef so the user's orbit is captured +
        // persisted before the renderer unmounts.
        void exitFocusRef.current?.(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, focusedAnchorId]);

  if (anchors.length === 0) {
    return null;
  }

  // Opaque background for the FOCUSED frame so the live 3D renderer fully
  // hides the static thumbnail (the Excalidraw image element) sitting
  // behind it while the user orbits. Matching the canvas background makes
  // the renderer's transparent areas blend seamlessly with the canvas.
  const viewBg =
    excalidrawAPI?.getAppState().viewBackgroundColor ?? "#ffffff";

  return (
    <div className="mcm-ifc-layer">
      {anchors.map((a) => {
        const file = fileById.get(a.fileId);
        const known = knownIfcFileIds.has(a.fileId);
        const focused = focusedAnchorId === a.elementId;

        // PASSIVE anchors: the Excalidraw IMAGE element already paints
        // the baked 3D snapshot natively on the canvas (so pen strokes /
        // shapes the user draws AFTER the model stack on top of it via
        // normal element z-order). We render ONLY a non-interactive frame
        // + label here so the anchor's bounds + name are visible on the
        // canvas — NO live renderer (3D is heavy; the slot cap is 2, and a
        // renderer would paint over every drawing). The frame is
        // pointer-events:none so clicks / drawing pass straight through to
        // the canvas image underneath. Only the FOCUSED anchor mounts the
        // live interactive <IFCRenderer> below.
        if (!focused) {
          return (
            <div
              key={a.elementId}
              className="mcm-ifc-layer__anchor mcm-ifc-layer__anchor--passive"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: a.left,
                top: a.top,
                width: a.width,
                height: a.height,
              }}
              data-anchor-id={a.elementId}
              data-file-id={a.fileId}
            >
              <div className="mcm-ifc-layer__label">
                <span className="mcm-ifc-layer__label-type">IFC</span>
                <span className="mcm-ifc-layer__label-name">
                  {file?.name ?? "IFC"}
                </span>
              </div>
              <div className="mcm-ifc-layer__frame mcm-ifc-layer__frame--passive" />
            </div>
          );
        }

        return (
          <div
            key={a.elementId}
            className="mcm-ifc-layer__anchor mcm-ifc-layer__anchor--focused"
            // eslint-disable-next-line react/forbid-dom-props
            style={{
              left: a.left,
              top: a.top,
              width: a.width,
              height: a.height,
            }}
            data-anchor-id={a.elementId}
            data-file-id={a.fileId}
          >
            {/* Label sits OUTSIDE the renderer (above the frame) so it
                never obscures the 3D content. */}
            <div className="mcm-ifc-layer__label">
              <span className="mcm-ifc-layer__label-type">IFC</span>
              <span className="mcm-ifc-layer__label-name">
                {file?.name ?? "IFC"}
              </span>
            </div>
            {/* Clipping frame so 3D content can never paint outside the
                anchor's bounds. The focused frame attaches a listener
                for the renderer's `mcm-ifc-measure` CustomEvent (it
                bubbles, so React's synthetic system won't catch it). */}
            <div
              className="mcm-ifc-layer__frame"
              ref={measureFrameRef}
              // Opaque bg hides the static thumbnail behind the live orbit.
              // eslint-disable-next-line react/forbid-dom-props
              style={{ background: viewBg }}
            >
              {!known ? (
                <div className="mcm-ifc-layer__waiting">
                  {t("ifc.status.waitingPeer")}
                </div>
              ) : file && file.ifcMeta ? (
                <IFCRenderer
                  glbUrl={file.dataURL}
                  metadata={file.ifcMeta.metadata}
                  fileId={a.fileId}
                  width={a.width}
                  height={a.height}
                  instanceId={`inline-${a.elementId}`}
                  interactive
                  onSelect={(el) => setSelected(el)}
                  onReady={(controls) => {
                    controlsRef.current.set(a.elementId, controls);
                    // Populate the storey list for the popover.
                    try {
                      setStoreys(controls.getStoreys());
                    } catch (err) {
                      console.warn("[IFCCanvasOverlay] getStoreys failed", err);
                    }
                    // Restore the user's saved orbit so the renderer
                    // mounts at the view they left it at (across focus
                    // cycles + reloads). Without this it would sit at
                    // the default fit-to-model the renderer applies.
                    if (a.view) {
                      try {
                        controls.setView(a.view);
                      } catch (err) {
                        console.warn("[IFCCanvasOverlay] setView failed", err);
                      }
                    }
                  }}
                  onError={(err) =>
                    console.warn("[IFCCanvasOverlay] renderer error", err)
                  }
                />
              ) : null}

              {/* Measure distance readout — only while focused + on. */}
              {focused && measureOn && measureDist !== null && (
                <div className="mcm-ifc-layer__measure-readout">
                  📏 {measureDist.toFixed(2)}
                </div>
              )}

              {/* Storey isolation popover — overlays the focused frame. */}
              {focused && storeyPanelOpen && (
                <div
                  className="mcm-ifc-layer__storey-panel"
                  role="dialog"
                  aria-label={t("ifc.storey.panelAria")}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mcm-ifc-layer__storey-panel-header">
                    <span className="mcm-ifc-layer__storey-panel-title">
                      {t("ifc.storey.title", { count: storeys.length })}
                    </span>
                  </div>
                  <div className="mcm-ifc-layer__storey-list">
                    <button
                      type="button"
                      className={`mcm-ifc-layer__storey-row${
                        isolatedStoreyId === null
                          ? " mcm-ifc-layer__storey-row--active"
                          : ""
                      }`}
                      onClick={() => {
                        controlsRef.current
                          .get(a.elementId)
                          ?.isolateStorey(null);
                        setIsolatedStoreyId(null);
                      }}
                    >
                      <span className="mcm-ifc-layer__storey-name">
                        {t("ifc.storey.all")}
                      </span>
                    </button>
                    {storeys.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`mcm-ifc-layer__storey-row${
                          isolatedStoreyId === s.id
                            ? " mcm-ifc-layer__storey-row--active"
                            : ""
                        }`}
                        onClick={() => {
                          controlsRef.current
                            .get(a.elementId)
                            ?.isolateStorey(s.id);
                          setIsolatedStoreyId(s.id);
                        }}
                        title={s.name}
                      >
                        <span className="mcm-ifc-layer__storey-name">
                          {s.name || s.id}
                        </span>
                        <span className="mcm-ifc-layer__storey-elev">
                          {s.elevation.toFixed(1)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Properties panel — shows the picked element's details. */}
              {focused && selected && (
                <div
                  className="mcm-ifc-layer__props"
                  role="dialog"
                  aria-label={t("ifc.props.panelAria")}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mcm-ifc-layer__props-header">
                    <span className="mcm-ifc-layer__props-name">
                      {selected.name || selected.globalId}
                    </span>
                    <span className="mcm-ifc-layer__props-type">
                      {selected.type}
                    </span>
                  </div>
                  <div className="mcm-ifc-layer__props-list">
                    {selected.category && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          {t("ifc.props.category")}
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.category}
                        </span>
                      </div>
                    )}
                    {selected.family && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          {t("ifc.props.family")}
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.family}
                        </span>
                      </div>
                    )}
                    {selected.typeName && (
                      <div className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label">
                          {t("ifc.props.type")}
                        </span>
                        <span className="mcm-ifc-layer__props-value">
                          {selected.typeName}
                        </span>
                      </div>
                    )}
                    {Object.entries(selected.props).map(([k, v]) => (
                      <div key={k} className="mcm-ifc-layer__props-row">
                        <span className="mcm-ifc-layer__props-label" title={k}>
                          {k}
                        </span>
                        <span className="mcm-ifc-layer__props-value">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {focused && (
              <div className="mcm-ifc-layer__focus-toolbar">
                <button
                  type="button"
                  className="mcm-ifc-layer__tool"
                  onClick={(e) => {
                    e.stopPropagation();
                    controlsRef.current.get(a.elementId)?.fitToModel();
                  }}
                  title={t("ifc.toolbar.fitInlineTitle")}
                >
                  ↻ {t("ifc.toolbar.fitInline")}
                </button>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    storeyPanelOpen ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStoreyPanelOpen((p) => !p);
                  }}
                  disabled={storeys.length === 0}
                  title={
                    storeys.length === 0
                      ? t("ifc.toolbar.storeysNoneTitle")
                      : t("ifc.toolbar.storeysCountTitle", {
                          count: storeys.length,
                        })
                  }
                >
                  🏢 {t("ifc.toolbar.storeys")}
                </button>
                <div className="mcm-ifc-layer__tool-wrap">
                  <button
                    type="button"
                    className={`mcm-ifc-layer__tool${
                      sectionAxis !== null || sectionPanelOpen
                        ? " mcm-ifc-layer__tool--active"
                        : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewStylePanelOpen(false);
                      setSectionPanelOpen((p) => !p);
                    }}
                    title={t("ifc.section.buttonTitle")}
                  >
                    ✂️ {t("ifc.section.button")}
                    {sectionAxis ? ` ${SECTION_LABEL[sectionAxis]}` : ""}
                  </button>
                  {sectionPanelOpen && (
                    <div
                      className="mcm-ifc-layer__menu mcm-ifc-layer__menu--section"
                      role="dialog"
                      aria-label={t("ifc.section.popoverAria")}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="mcm-ifc-layer__menu-row">
                        {(["x", "y", "z"] as const).map((axis) => (
                          <button
                            key={axis}
                            type="button"
                            className={`mcm-ifc-layer__seg${
                              sectionAxis === axis
                                ? " mcm-ifc-layer__seg--active"
                                : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              controlsRef.current
                                .get(a.elementId)
                                ?.setSection(axis);
                              setSectionAxis(axis);
                            }}
                            title={t("ifc.section.axisCutTitle", {
                              axis: SECTION_LABEL[axis],
                            })}
                          >
                            {SECTION_LABEL[axis]}
                          </button>
                        ))}
                      </div>
                      <div className="mcm-ifc-layer__menu-row">
                        <button
                          type="button"
                          className="mcm-ifc-layer__menu-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            controlsRef.current.get(a.elementId)?.flipSection();
                          }}
                          disabled={sectionAxis === null}
                          title={t("ifc.section.flipTitle")}
                        >
                          ⇄ {t("ifc.section.flip")}
                        </button>
                        <button
                          type="button"
                          className="mcm-ifc-layer__menu-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            controlsRef.current
                              .get(a.elementId)
                              ?.setSection(null);
                            setSectionAxis(null);
                          }}
                          disabled={sectionAxis === null}
                          title={t("ifc.section.offTitle")}
                        >
                          {t("ifc.section.off")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    measureOn ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !measureOn;
                    controlsRef.current.get(a.elementId)?.toggleMeasure(next);
                    setMeasureOn(next);
                    if (!next) {
                      setMeasureDist(null);
                    }
                  }}
                  title={t("ifc.toolbar.measureTitle")}
                >
                  📏 {t("ifc.toolbar.measure")}
                </button>
                <div className="mcm-ifc-layer__tool-wrap">
                  <button
                    type="button"
                    className={`mcm-ifc-layer__tool${
                      viewStylePanelOpen ? " mcm-ifc-layer__tool--active" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSectionPanelOpen(false);
                      setViewStylePanelOpen((p) => !p);
                    }}
                    title={t("ifc.toolbar.styleTitle")}
                  >
                    🎨 {t("ifc.toolbar.style")}
                  </button>
                  {viewStylePanelOpen && (
                    <div
                      className="mcm-ifc-layer__menu mcm-ifc-layer__menu--style"
                      role="dialog"
                      aria-label={t("ifc.viewStyle.groupAria")}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="mcm-ifc-layer__menu-row">
                        {VIEW_STYLES.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className={`mcm-ifc-layer__seg${
                              viewStyle === s.id
                                ? " mcm-ifc-layer__seg--active"
                                : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              controlsRef.current
                                .get(a.elementId)
                                ?.setViewStyle(s.id);
                              setViewStyle(s.id);
                            }}
                            title={t(s.titleKey)}
                          >
                            {t(s.labelKey)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`mcm-ifc-layer__tool${
                    ghostOn ? " mcm-ifc-layer__tool--active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !ghostOn;
                    controlsRef.current.get(a.elementId)?.setGhost(next);
                    setGhostOn(next);
                  }}
                  title={t("ifc.toolbar.ghostTitle")}
                >
                  👻 {t("ifc.toolbar.ghost")}
                </button>
                <button
                  type="button"
                  className="mcm-ifc-layer__exit"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exitFocusRef.current?.(null);
                  }}
                  title={t("ifc.toolbar.exitTitle")}
                >
                  × {t("ifc.toolbar.exit")}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Context menu — pops up at the right-click position. */}
      {contextMenu &&
        (() => {
          const target = anchors.find(
            (a) => a.elementId === contextMenu.elementId,
          );
          if (!target) {
            return null;
          }
          return (
            <div
              className="mcm-ifc-context-menu"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: contextMenu.clientX,
                top: contextMenu.clientY,
              }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  // Route through exitFocusRef so any previously-focused
                  // anchor captures its view before focus moves here.
                  void exitFocusRef.current?.(contextMenu.elementId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">🧊</span>
                <span>{t("ifc.menu.edit3d")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  openFileInIfcView(target.fileId);
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">🗔</span>
                <span>{t("ifc.menu.openInPane")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => {
                  controlsRef.current.get(contextMenu.elementId)?.fitToModel();
                  setContextMenu(null);
                }}
              >
                <span aria-hidden="true">↻</span>
                <span>{t("ifc.menu.resetView")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mcm-ifc-context-menu__item"
                onClick={() => setContextMenu(null)}
              >
                <span aria-hidden="true">↩️</span>
                <span>{t("ifc.menu.cancel")}</span>
              </button>
            </div>
          );
        })()}
    </div>
  );
};

export default IFCCanvasOverlay;
