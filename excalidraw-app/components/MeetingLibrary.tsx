import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  newElement,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../app-jotai";
import { collabAPIAtom } from "../collab/Collab";
import {
  canDeleteFile,
  canUnlockFile,
  isDxfFile,
  isFileSeen,
  isIfcFile,
  isIfcModelFile,
  isPdfFile,
  markFileSeen,
  meetingFilesAtom,
  probeImageDimensions,
} from "../data/meetingLibrary";

import { DXF_ANCHOR_KIND } from "./mcm/dxf/DXFCanvasOverlay";
import { IFC_ANCHOR_KIND } from "./mcm/ifc/ifcAnchor";
import { bakeIfc } from "./mcm/ifc/ifcBake";
import { bakeIfcThumbnail } from "./mcm/ifc/ifcThumbnail";
import { PDF_ANCHOR_KIND } from "./mcm/pdf/PDFCanvasOverlay";
import { probePdf } from "./mcm/pdf/pdfRendering";

import "./MeetingLibrary.scss";

import type { MeetingFile } from "../data/meetingLibrary";

const newFileId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MAX_INSERT_DIMENSION = 480; // px (logical) — keeps images sane in viewport

// Custom MIME used when the user drags a library item onto the canvas.
// The browser would otherwise treat the dragged <img> as a generic image
// drop, and Excalidraw would re-ingest it with a fresh hash-based fileId,
// triggering the auto-detect onChange → publishLibraryFile loop that
// added a duplicate library entry (the original bug). We instead carry
// just the library file id; our capture-phase drop listener intercepts,
// reuses the existing fileId, and inserts at the drop coordinates.
const MCM_LIBRARY_DRAG_MIME = "application/x-mcm-library-file-id";

const readAsDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const readAsArrayBuffer = (file: File) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

// Wrap an ArrayBuffer in a Blob of the given mime and read it back as a
// data: URL — used to stash the baked GLB into the library file's
// `dataURL` so peers/reload can reconstruct the model without re-baking.
const blobToDataURL = (buf: ArrayBuffer, mime: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buf], { type: mime }));
  });

const extractRoomId = (link: string | null | undefined): string | null => {
  if (!link) {
    return null;
  }
  const m = link.match(/#room=([a-zA-Z0-9_-]+),/);
  return m ? m[1] : null;
};

// File-type classification — drives the type chip, filter chips, and
// (later) section grouping. We treat the "other" bucket as a catch-all
// so future formats (docx, xlsx…) still render without code changes.
type FileType = "image" | "dxf" | "pdf" | "ifc" | "other";

const fileTypeOf = (file: MeetingFile): FileType => {
  // IFC must be checked FIRST: a baked IFC's mime is "model/gltf-binary",
  // which would otherwise fall through to "other". `ifcMeta` presence is
  // the authoritative marker.
  if (isIfcModelFile(file)) {
    return "ifc";
  }
  if (isDxfFile(file)) {
    return "dxf";
  }
  if (file.mimeType === "application/pdf") {
    return "pdf";
  }
  if (file.mimeType.startsWith("image/")) {
    return "image";
  }
  return "other";
};

// MCM-internal canvas files that must NEVER be auto-published to the
// library: decoration assets (stickers/stamps, `mcm-deco-…`) and the
// baked snapshot images that back IFC / PDF / DXF anchors
// (`ifc-snap-…`, `pdf-snap-…`, `dxf-snap-…`). They're app-generated
// bookkeeping, not user content — auto-publishing them clutters the
// library with duplicate "canvas-ifc-snap" / stamp tiles. Real uploads
// arrive through `ingestFiles` (the explicit picker/drop path), not the
// canvas auto-detect, so they stay unaffected.
const INTERNAL_FILE_ID_PREFIXES = [
  "ifc-snap-",
  "pdf-snap-",
  "dxf-snap-",
  "mcm-deco-",
];
const isInternalCanvasFile = (
  fileId: string,
  owningElement: { customData?: Record<string, unknown> | null } | undefined,
): boolean => {
  if (INTERNAL_FILE_ID_PREFIXES.some((p) => fileId.startsWith(p))) {
    return true;
  }
  // Fallback for decoration/anchor elements that already carry an MCM
  // marker (any non-empty `mcmType` means it's app-managed, not user
  // content). The prefix check above is the timing-safe primary guard.
  const mcmType = owningElement?.customData?.mcmType;
  return typeof mcmType === "string" && mcmType.length > 0;
};

/** Human label for the type chip rendered on each library tile. */
const TYPE_LABEL: Record<FileType, string> = {
  image: "IMG",
  dxf: "DXF",
  pdf: "PDF",
  ifc: "IFC",
  other: "FILE",
};

/** Deterministic accent colour for a username — mirrors the algorithm
 *  in SpeechToTextPanel/ParticipantsBar so the same person reads as
 *  the same colour everywhere in the meeting UI. */
const AUTHOR_PALETTE = [
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#60a5fa",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#84cc16",
];
const authorColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return AUTHOR_PALETTE[Math.abs(h) % AUTHOR_PALETTE.length];
};
const authorInitial = (name: string): string => {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : "?";
};

/** Short relative timestamp ("2m", "3h", "yesterday", "5 Mar") used in
 *  the list view so each row can show recency without consuming the
 *  width of a full ISO string. */
const relativeTime = (ts: number): string => {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const days = Math.floor(hr / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

type SortBy = "newest" | "oldest" | "name" | "author";
type ViewMode = "grid" | "list";

/** Order in which sections appear when group-by-type is enabled, plus
 *  the user-facing section title. */
const TYPE_SECTION_ORDER: { type: FileType; title: string }[] = [
  { type: "dxf", title: "CAD drawings" },
  { type: "ifc", title: "IFC models" },
  { type: "pdf", title: "PDF documents" },
  { type: "image", title: "Images" },
  { type: "other", title: "Other files" },
];

export const MeetingLibrary = () => {
  const items = useAtomValue(meetingFilesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const excalidrawAPI = useExcalidrawAPI();

  const roomId = extractRoomId(collabAPI?.getActiveRoomLink() ?? null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Toolbar state — search query, type filter chip, sort key, grid vs
  // list view, optional group-by-type sectioning. All session-scoped
  // (intentionally not persisted) so a peer joining a meeting starts
  // fresh rather than inheriting whatever the previous tab had.
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<FileType | "all">("all");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [groupByType, setGroupByType] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<FileType>>(
    new Set(),
  );

  // Type counts — drive the badge on each filter chip ("DXF · 3") and
  // also tell us which chips should render at all (we hide chips for
  // types that have zero files to keep the toolbar uncluttered).
  const typeCounts = useMemo(() => {
    const counts: Record<FileType, number> = {
      image: 0,
      dxf: 0,
      pdf: 0,
      ifc: 0,
      other: 0,
    };
    for (const f of items) {
      counts[fileTypeOf(f)]++;
    }
    return counts;
  }, [items]);

  /** Files after search / filter / sort, ready to render. Memoised so
   *  re-typing the search query doesn't rerun on every unrelated atom
   *  change. */
  const displayedFiles = useMemo(() => {
    // Hide MCM-internal files (decoration assets + IFC/PDF/DXF anchor
    // snapshots). The auto-publish guard stops new ones, and this also
    // hides any junk already synced into a room's library from before
    // the guard existed — without the destructive tile-delete (which
    // would also remove the live model/stamp from the canvas).
    let list = items.filter((f) => !isInternalCanvasFile(f.id, undefined));
    if (filterType !== "all") {
      list = list.filter((f) => fileTypeOf(f) === filterType);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.author.toLowerCase().includes(q),
      );
    }
    // Always work on a copy before sorting — `items` comes from the
    // atom and mutating it would corrupt every other subscriber's
    // view of the library.
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case "oldest":
          return a.ts - b.ts;
        case "name":
          return a.name.localeCompare(b.name);
        case "author":
          return a.author.localeCompare(b.author) || b.ts - a.ts;
        case "newest":
        default:
          return b.ts - a.ts;
      }
    });
  }, [items, filterType, searchQuery, sortBy]);

  const toggleSection = (type: FileType) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // NB: hydrate is OWNED BY MeetingShell — it runs as soon as the
  // shell mounts so the canvas overlays (which depend on
  // meetingFilesAtom) don't show "waiting for peer" placeholders
  // until the user happens to open the library tab. Don't duplicate
  // the call here, or hydrate would race with itself across mounts.

  // observe canvas: when a file the user pasted/dropped onto canvas is
  // available, publish it through the collab API so peers also receive it
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const username = collabAPI?.getUsername() || "Local";
    const handle = (
      _elements: any,
      _appState: any,
      files: Record<string, BinaryFileData>,
    ) => {
      // Map each fileId → its owning element so we can tell user content
      // apart from MCM-internal files (decorations + anchor snapshots).
      const elementByFileId = new Map<string, any>();
      for (const el of (_elements as any[]) || []) {
        if (el && !el.isDeleted && el.fileId) {
          elementByFileId.set(el.fileId, el);
        }
      }
      for (const [fileId, file] of Object.entries(files || {})) {
        if (isFileSeen(fileId)) {
          continue;
        }
        // Skip stickers/stamps + IFC/PDF/DXF anchor snapshots — they're
        // app-generated, not user uploads, and would clutter the library.
        if (isInternalCanvasFile(fileId, elementByFileId.get(fileId))) {
          markFileSeen(fileId);
          continue;
        }
        markFileSeen(fileId);
        const next: MeetingFile = {
          id: fileId,
          name: `canvas-${fileId.slice(0, 8)}`,
          ts: Date.now(),
          author: username,
          mimeType: file.mimeType,
          dataURL: file.dataURL as unknown as string,
        };
        const finalize = (extra: { width?: number; height?: number } = {}) => {
          const enriched = { ...next, ...extra };
          // collabAPI handles upsert + (when in a room) broadcast to peers
          if (collabAPI) {
            collabAPI.publishLibraryFile(enriched);
          }
        };
        if (file.mimeType?.startsWith("image/")) {
          probeImageDimensions(file.dataURL as unknown as string).then((d) =>
            finalize(d ?? {}),
          );
        } else {
          finalize();
        }
      }
    };
    const unsub = excalidrawAPI.onChange(handle);
    return unsub;
  }, [excalidrawAPI, collabAPI, roomId]);

  const ingestFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!excalidrawAPI || !collabAPI) {
        return;
      }
      const username = collabAPI.getUsername() || "Local";
      const list = Array.from(fileList);
      for (const file of list) {
        const isImage = file.type.startsWith("image/");
        const isDxf = isDxfFile(file);
        const isPdf = isPdfFile(file);
        const isIfc = isIfcFile(file);
        if (!isImage && !isDxf && !isPdf && !isIfc) {
          window.alert(
            `Tạm thời chỉ hỗ trợ ảnh, DXF, PDF và IFC. Bỏ qua: ${file.name}`,
          );
          continue;
        }
        if (isIfc) {
          // IFC files are baked into a compact GLB + metadata in a web
          // worker (web-ifc WASM). This can take many seconds for large
          // models — that's expected; we just await it. The baked GLB
          // becomes the library file's `dataURL` (mime "model/gltf-binary")
          // and `ifcMeta` marks the entry as an IFC model. On any bake
          // failure we surface a message naming the file and skip it.
          try {
            const buf = await readAsArrayBuffer(file);
            const { glb, metadata, elementCount } = await bakeIfc(buf);
            const glbDataURL = await blobToDataURL(glb, "model/gltf-binary");
            // Bake a static preview now so a placed IFC shows its model
            // immediately. Failure is non-fatal — fall back to no thumbnail.
            const thumbnail = await bakeIfcThumbnail(glb).catch(() => null);
            const id = newFileId();
            collabAPI.publishLibraryFile(
              {
                id,
                name: file.name,
                ts: Date.now(),
                author: username,
                mimeType: "model/gltf-binary",
                dataURL: glbDataURL,
                ifcMeta: {
                  metadata,
                  elementCount,
                  thumbnail: thumbnail ?? undefined,
                },
              },
              { allowContentDup: true },
            );
          } catch (error: any) {
            console.error("[meetingLibrary] failed to bake IFC", error);
            window.alert(`Không thể xử lý file IFC: ${file.name}`);
          }
          continue;
        }
        try {
          const dataURL = await readAsDataURL(file);
          const id = newFileId();
          // Explicit upload — the user picked this file deliberately, so
          // even if the byte payload exactly matches an existing library
          // entry (e.g. they copied `plan.dxf` to `plan-copy.dxf` and
          // imported the copy) we honour the upload and create a new
          // entry. The auto-detect path that watches canvas paste/drop
          // events leaves `allowContentDup` unset, so the duplicate-image
          // collapse still works there.
          if (isDxf) {
            // DXF metadata (layers, bounds, thumbnail) is parsed
            // lazily when the file first renders — keep upload fast.
            // The browser sometimes hands DXF as octet-stream; we
            // pin it to a stable mimeType so peers detect it the
            // same way locally.
            collabAPI.publishLibraryFile(
              {
                id,
                name: file.name,
                ts: Date.now(),
                author: username,
                mimeType: "image/vnd.dxf",
                dataURL,
              },
              { allowContentDup: true },
            );
          } else if (isPdf) {
            // Probe pdfjs once on ingest so the library tile has a
            // proper page-1 thumbnail + page-count badge without
            // re-parsing every time the tab is shown. Probe failures
            // (corrupt PDFs, encrypted docs) downgrade to a no-meta
            // upload — the user still gets the entry; viewing will
            // fail loudly inside the renderer if the file is truly
            // unreadable.
            const meta = await probePdf(dataURL);
            collabAPI.publishLibraryFile(
              {
                id,
                name: file.name,
                ts: Date.now(),
                author: username,
                mimeType: "application/pdf",
                dataURL,
                pdfMeta: meta
                  ? {
                      pageCount: meta.pageCount,
                      thumbnail: meta.thumbnail || undefined,
                    }
                  : undefined,
              },
              { allowContentDup: true },
            );
          } else {
            const dims = await probeImageDimensions(dataURL);
            collabAPI.publishLibraryFile(
              {
                id,
                name: file.name,
                ts: Date.now(),
                author: username,
                mimeType: file.type,
                dataURL,
                width: dims?.width,
                height: dims?.height,
              },
              { allowContentDup: true },
            );
          }
        } catch (error: any) {
          console.error("[meetingLibrary] failed to ingest file", error);
        }
      }
    },
    [excalidrawAPI, collabAPI],
  );

  const handlePickFiles = () => fileInputRef.current?.click();

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void ingestFiles(e.target.files);
      // reset input so picking the same file again still triggers change
      e.target.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void ingestFiles(e.dataTransfer.files);
    }
  };

  // Insert a DXF anchor at the given scene-space CENTER. We use a
  // plain rectangle element (transparent stroke + fill) with a
  // marker on customData — the <DXFCanvasOverlay /> picks these up
  // and paints the actual DXF on top. Default size matches a
  // landscape A4 ratio (480×320) which fits most floor plans; the
  // user resizes via Excalidraw's normal selection handles after.
  const DXF_DEFAULT_W = 480;
  const DXF_DEFAULT_H = 320;
  const insertDxfAt = useCallback(
    (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      // Use INCLUDING DELETED so we preserve the full fractional-index
      // sequence Excalidraw maintains for tombstoned elements. Passing
      // only the live subset to updateScene confused the later index
      // re-order pass (e.g. when the user moves the new element between
      // frames) and crashed with InvalidFractionalIndexError, freezing
      // every imported element. See packages/element/src/Scene.ts.
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const anchor = newElement({
        type: "rectangle",
        x: at.sceneX - DXF_DEFAULT_W / 2,
        y: at.sceneY - DXF_DEFAULT_H / 2,
        width: DXF_DEFAULT_W,
        height: DXF_DEFAULT_H,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        roundness: null,
        customData: {
          mcmType: DXF_ANCHOR_KIND,
          dxfFileId: file.id,
        },
      });
      // syncInvalidIndices fills in valid fractional indices for newly
      // added elements (newElement returns one with index=null). Without
      // this, Excalidraw's later index-reorder pass (triggered when the
      // user moves the element between frames) sees `null` and throws
      // InvalidFractionalIndexError, freezing the whole scene.
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, anchor]),
      });
    },
    [excalidrawAPI],
  );

  // IFC anchors mirror PDF anchors structurally (NOT DXF) — an
  // Excalidraw IMAGE element that renders a baked 3D snapshot directly
  // on the canvas, so pen strokes / shapes / stickers the user adds
  // AFTER the model sit on top of it via the regular "Bring to Front" /
  // element-order semantics. The old transparent-rectangle + HTML
  // overlay version always painted above every canvas drawing, blocking
  // that flow. Landscape default 480×360 since 3D models are wider than
  // tall (unlike PDF's portrait page shape); the user resizes via
  // Excalidraw's selection handles.
  const IFC_DEFAULT_W = 480;
  const IFC_DEFAULT_H = 360;
  const insertIfcAt = useCallback(
    async (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      // Build the anchor as an Excalidraw IMAGE element (mirrors
      // insertPdfAt, NOT insertDxfAt). The image renders the baked 3D
      // snapshot natively on the canvas so pen strokes / shapes / text
      // the user adds AFTER the model sit on top of it via the regular
      // element-order / "Bring to Front" semantics — the old transparent
      // rectangle + HTML overlay version always painted above every
      // canvas drawing, blocking that flow.
      //
      // The image carries its OWN file id (`ifc-snap-<elementId>`)
      // pointing at a snapshot PNG kept in Excalidraw's file map;
      // IFCCanvasOverlay rewrites that file on focus exit (exportPng of
      // the live view) so the canvas image reflects the user's last
      // orbit. We derive the snapshot fileId from the element id so that
      // when Excalidraw clones the element (Ctrl+D, paste) and assigns
      // the clone a new element id, the duplicate-snapshotFileId
      // migration in IFCCanvasOverlay can deterministically re-key it to
      // `ifc-snap-{newElementId}` on EVERY peer with the same result —
      // no race, no out-of-sync ids.
      const anchorElementId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotFileId = `ifc-snap-${anchorElementId}` as FileId;
      // Seed the image with a REAL 3D thumbnail so the model shows
      // immediately on drop — never a blank rectangle. Prefer the
      // upload-baked ifcMeta.thumbnail; if the file predates that feature
      // (no thumbnail), bake one now from the GLB. bakeIfcThumbnail reuses
      // the same engine the 3D pane uses, so a drop-time bake is as
      // reliable as the live viewer. The 1×1 transparent PNG is only a
      // last resort if a bake genuinely fails.
      let seed: string | null = file.ifcMeta?.thumbnail ?? null;
      if (!seed) {
        try {
          const res = await fetch(file.dataURL);
          const glb = await res.arrayBuffer();
          seed = await bakeIfcThumbnail(glb);
        } catch {
          seed = null;
        }
      }
      const seedUrl =
        seed ??
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
      // Re-read the scene AFTER the await so a concurrent edit isn't lost.
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      excalidrawAPI.addFiles([
        {
          id: snapshotFileId,
          dataURL: seedUrl as unknown as BinaryFileData["dataURL"],
          mimeType: "image/png" as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      // newImageElement's typed opts intentionally omit `id` (the
      // factory mints a random one), so we override after the fact.
      // Pinning the element id to the value we used to derive
      // snapshotFileId keeps `snapshotFileId === ifc-snap-{element.id}`
      // true on insertion — the invariant the duplicate-detection
      // migration in IFCCanvasOverlay relies on.
      const baseAnchor = newImageElement({
        type: "image",
        x: at.sceneX - IFC_DEFAULT_W / 2,
        y: at.sceneY - IFC_DEFAULT_H / 2,
        width: IFC_DEFAULT_W,
        height: IFC_DEFAULT_H,
        fileId: snapshotFileId,
        status: "saved",
        customData: {
          mcmType: IFC_ANCHOR_KIND,
          ifcFileId: file.id,
          // Snapshot file id carried explicitly so peers + reload can
          // find the per-anchor file in Excalidraw's map without having
          // to inspect `el.fileId`.
          ifcSnapshotFileId: snapshotFileId,
        },
      });
      const anchor = { ...baseAnchor, id: anchorElementId };
      // syncInvalidIndices fills in valid fractional indices — see the
      // explanation in insertDxfAt.
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, anchor]),
      });
    },
    [excalidrawAPI],
  );

  // PDF anchors mirror DXF anchors structurally — invisible rectangle
  // with a custom-data marker so PDFCanvasOverlay can paint the page
  // on top. Portrait default (3:4 = 360×480) since most PDFs are
  // page-shaped rather than landscape like floor plans.
  const PDF_DEFAULT_W = 360;
  const PDF_DEFAULT_H = 480;
  const insertPdfAt = useCallback(
    (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      // Build the anchor as an Excalidraw IMAGE element instead of a
      // transparent rectangle with an HTML overlay. Image elements
      // render directly on the canvas, so a pen stroke or sticker the
      // user adds AFTER the PDF can sit on top of it via the regular
      // "Bring to Front" / element-order semantics — the rectangle +
      // HTML overlay version was always painted above every canvas
      // drawing, blocking that flow.
      //
      // The image carries its OWN file id (`pdf-snap-<elementId>`)
      // pointing at a snapshot PNG kept in Excalidraw's file map;
      // PDFCanvasOverlay rewrites that file every time the user
      // navigates pages so the canvas image always matches
      // customData.pdfPage. We derive the snapshot fileId from the
      // element id so that when Excalidraw clones the element
      // (Ctrl+D, paste, multi-copy) and assigns the clone a new
      // element id, the duplicate-snapshotFileId migration in
      // PDFCanvasOverlay can deterministically re-key it to
      // `pdf-snap-{newElementId}` on EVERY peer with the same
      // result — no race, no out-of-sync ids.
      const anchorElementId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotFileId = `pdf-snap-${anchorElementId}` as FileId;
      const seed =
        file.pdfMeta?.thumbnail ??
        // Tiny 1×1 transparent PNG — keeps Excalidraw happy until the
        // real snapshot lands. Inline so we don't need an asset file.
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
      excalidrawAPI.addFiles([
        {
          id: snapshotFileId,
          dataURL: seed as unknown as BinaryFileData["dataURL"],
          mimeType: "image/png" as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      // newImageElement's typed opts intentionally omit `id` (the
      // factory mints a random one), so we override after the fact.
      // Pinning the element id to the value we used to derive
      // snapshotFileId keeps `snapshotFileId === pdf-snap-{element.id}`
      // true on insertion, which is the invariant the duplicate-
      // detection migration in PDFCanvasOverlay relies on to leave
      // originals alone and only re-key copies that drift away from
      // it after Ctrl+D / paste.
      const baseAnchor = newImageElement({
        type: "image",
        x: at.sceneX - PDF_DEFAULT_W / 2,
        y: at.sceneY - PDF_DEFAULT_H / 2,
        width: PDF_DEFAULT_W,
        height: PDF_DEFAULT_H,
        fileId: snapshotFileId,
        status: "saved",
        customData: {
          mcmType: PDF_ANCHOR_KIND,
          pdfFileId: file.id,
          // Start on page 1; the user advances via the focus toolbar
          // and the selected page is persisted back into customData.
          pdfPage: 1,
          // Snapshot file id carried explicitly so peers + reload can
          // find the per-anchor file in Excalidraw's map without
          // having to inspect `el.fileId`.
          pdfSnapshotFileId: snapshotFileId,
        },
      });
      const anchor = { ...baseAnchor, id: anchorElementId };
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, anchor]),
      });
    },
    [excalidrawAPI],
  );

  // Shared insert helper. `at` is the scene-space CENTER of the new
  // image; callers pick whether that's the viewport centre (click) or
  // the drop position (drag-from-library). Reusing this guarantees
  // both paths funnel through the SAME fileId — so the auto-detect
  // onChange handler always finds the file already-seen and never
  // creates a duplicate library entry.
  // Same INCLUDING-DELETED rationale as insertDxfAt — see the comment
  // there. Without it, freshly-inserted images crash the scene the
  // moment the user drags them across a frame boundary.
  const insertImageAt = useCallback(
    (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      // make sure the file is in the canvas's file map (re-add — addFiles
      // is idempotent for identical ids)
      excalidrawAPI.addFiles([
        {
          id: file.id as FileId,
          dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
          mimeType: file.mimeType as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);

      let w = file.width ?? 320;
      let h = file.height ?? 320;
      if (w > MAX_INSERT_DIMENSION || h > MAX_INSERT_DIMENSION) {
        const scale = MAX_INSERT_DIMENSION / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      const img = newImageElement({
        type: "image",
        x: at.sceneX - w / 2,
        y: at.sceneY - h / 2,
        width: w,
        height: h,
        fileId: file.id as FileId,
        status: "saved",
      });

      // syncInvalidIndices assigns a valid fractional index to the
      // freshly-minted image — see the explanation in insertDxfAt.
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, img]),
      });
    },
    [excalidrawAPI],
  );

  const handleInsert = (file: MeetingFile) => {
    if (!excalidrawAPI) {
      return;
    }
    const elements = excalidrawAPI.getSceneElements();
    const isDxf = isDxfFile(file);
    const isPdf = isPdfFile(file);
    const isIfc = isIfcModelFile(file);

    // If this file already lives on the canvas, scroll to it instead
    // of dropping a duplicate. For DXF we look for the matching anchor
    // rectangle (via customData.dxfFileId), for IFC via ifcFileId, for
    // PDF via pdfFileId, and for images via the image element's fileId.
    const existing = elements.find((el) => {
      const data = el.customData as Record<string, unknown> | undefined;
      if (isDxf) {
        return (
          el.type === "rectangle" &&
          data?.mcmType === DXF_ANCHOR_KIND &&
          data?.dxfFileId === file.id
        );
      }
      if (isIfc) {
        return (
          el.type === "rectangle" &&
          data?.mcmType === IFC_ANCHOR_KIND &&
          data?.ifcFileId === file.id
        );
      }
      if (isPdf) {
        return (
          el.type === "rectangle" &&
          data?.mcmType === PDF_ANCHOR_KIND &&
          data?.pdfFileId === file.id
        );
      }
      return el.type === "image" && (el as any).fileId === file.id;
    });
    if (existing) {
      excalidrawAPI.scrollToContent(existing, {
        animate: true,
        fitToContent: true,
      });
      return;
    }

    // Click-to-insert lands at the viewport centre.
    const appState = excalidrawAPI.getAppState();
    const at = {
      sceneX: -appState.scrollX + appState.width / 2 / appState.zoom.value,
      sceneY: -appState.scrollY + appState.height / 2 / appState.zoom.value,
    };
    if (isDxf) {
      insertDxfAt(file, at);
    } else if (isIfc) {
      void insertIfcAt(file, at);
    } else if (isPdf) {
      insertPdfAt(file, at);
    } else {
      insertImageAt(file, at);
    }
  };

  // Drag-start on a library item: serialise just the file id. The
  // browser-default img drag is suppressed via `draggable={false}` on
  // the thumbnail so it can't compete.
  const handleItemDragStart = (
    file: MeetingFile,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    if (!e.dataTransfer) {
      return;
    }
    e.dataTransfer.setData(MCM_LIBRARY_DRAG_MIME, file.id);
    e.dataTransfer.setData("text/plain", file.name);
    e.dataTransfer.effectAllowed = "copy";
  };

  // Drop interceptor on the Excalidraw container. Registered in the
  // CAPTURE phase so it runs BEFORE Excalidraw's React onDrop handler;
  // when our custom MIME is present we stopPropagation + preventDefault
  // so Excalidraw never sees the event and never auto-ingests a new
  // file. Without our MIME we no-op and let Excalidraw handle normally
  // (paste/drop from outside the app still works as before).
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const container = document.querySelector(
      ".excalidraw-container",
    ) as HTMLElement | null;
    if (!container) {
      return undefined;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(MCM_LIBRARY_DRAG_MIME)) {
        // Tell the browser we accept this drop (otherwise the drop
        // event never fires on some platforms).
        e.preventDefault();
      }
    };

    const onDrop = (e: DragEvent) => {
      const id = e.dataTransfer?.getData(MCM_LIBRARY_DRAG_MIME);
      if (!id) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const file = items.find((f) => f.id === id);
      if (!file) {
        return;
      }
      const isDxf = isDxfFile(file);
      const isPdf = isPdfFile(file);
      const isIfc = isIfcModelFile(file);
      // Jump to existing canvas instance instead of duplicating.
      const elements = excalidrawAPI.getSceneElements();
      const existing = elements.find((el) => {
        const data = el.customData as Record<string, unknown> | undefined;
        if (isDxf) {
          return (
            el.type === "rectangle" &&
            data?.mcmType === DXF_ANCHOR_KIND &&
            data?.dxfFileId === file.id
          );
        }
        if (isIfc) {
          return (
            el.type === "rectangle" &&
            data?.mcmType === IFC_ANCHOR_KIND &&
            data?.ifcFileId === file.id
          );
        }
        if (isPdf) {
          return (
            el.type === "rectangle" &&
            data?.mcmType === PDF_ANCHOR_KIND &&
            data?.pdfFileId === file.id
          );
        }
        return el.type === "image" && (el as any).fileId === file.id;
      });
      if (existing) {
        excalidrawAPI.scrollToContent(existing, {
          animate: true,
          fitToContent: true,
        });
        return;
      }
      const rect = container.getBoundingClientRect();
      const appState = excalidrawAPI.getAppState();
      const at = {
        sceneX:
          -appState.scrollX + (e.clientX - rect.left) / appState.zoom.value,
        sceneY:
          -appState.scrollY + (e.clientY - rect.top) / appState.zoom.value,
      };
      if (isDxf) {
        insertDxfAt(file, at);
      } else if (isIfc) {
        void insertIfcAt(file, at);
      } else if (isPdf) {
        insertPdfAt(file, at);
      } else {
        insertImageAt(file, at);
      }
    };

    container.addEventListener("dragover", onDragOver, true);
    container.addEventListener("drop", onDrop, true);
    return () => {
      container.removeEventListener("dragover", onDragOver, true);
      container.removeEventListener("drop", onDrop, true);
    };
  }, [
    excalidrawAPI,
    items,
    insertImageAt,
    insertDxfAt,
    insertIfcAt,
    insertPdfAt,
  ]);

  const me = collabAPI?.getUsername() || "Local";

  const handleDelete = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDeleteFile(file, me)) {
      window.alert(
        `File này đang bị khoá bởi ${file.lockedBy}. Yêu cầu họ mở khoá trước.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Xoá "${file.name}" khỏi thư viện phòng?\n\nMọi ảnh dùng file này trên canvas cũng bị xoá (cho cả người khác).`,
      )
    ) {
      return;
    }
    // collabAPI: removes canvas elements + library entry + broadcasts
    collabAPI?.publishLibraryFileDelete(file.id);
  };

  const handleToggleLock = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (file.lockedBy) {
      // unlock
      if (!canUnlockFile(file, me)) {
        window.alert(
          `Chỉ ${file.lockedBy} (người khoá) hoặc ${file.author} (người tải lên) có thể mở khoá.`,
        );
        return;
      }
      collabAPI?.publishLibraryFileLock(file.id, null);
    } else {
      collabAPI?.publishLibraryFileLock(file.id, me);
    }
  };

  const handleLinkText = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    collabAPI?.linkTextToFile(file);
  };

  // ---------------- Render helpers ----------------------------------
  // Both grid tiles and list rows share the same thumbnail rendering,
  // type chip, author chip, and action cluster — factor those out so
  // the two layouts stay visually consistent and we don't drift.

  const renderThumb = (file: MeetingFile) => {
    const type = fileTypeOf(file);
    if (type === "dxf" && file.dxfMeta?.thumbnail) {
      return (
        <img
          src={file.dxfMeta.thumbnail}
          alt={file.name}
          loading="lazy"
          draggable={false}
        />
      );
    }
    if (type === "dxf") {
      return (
        <span
          className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--dxf"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 4h12l4 4v12H4z" />
            <path d="M16 4v4h4" />
            <path d="M7 12h10M7 15h6M7 18h8" />
          </svg>
          <span className="MeetingLibrary__item-fallback-label">DXF</span>
        </span>
      );
    }
    if (type === "ifc" && file.ifcMeta?.thumbnail) {
      return (
        <img
          src={file.ifcMeta.thumbnail}
          alt={file.name}
          loading="lazy"
          draggable={false}
        />
      );
    }
    if (type === "ifc") {
      // No baked thumbnail yet — show a cube glyph so IFC model tiles
      // still read as 3D models at a glance.
      return (
        <span
          className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--ifc"
          aria-hidden="true"
        >
          <span className="MeetingLibrary__item-fallback-glyph">🧊</span>
          <span className="MeetingLibrary__item-fallback-label">IFC</span>
        </span>
      );
    }
    if (type === "pdf") {
      // PDF library support is a follow-up; until pdfjs renders a
      // baked thumbnail we draw a recognisable doc glyph so PDF
      // tiles still stand out.
      return (
        <span
          className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--pdf"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
            <path d="M14 2v6h6" />
            <path d="M9 13h6M9 17h4" />
          </svg>
          <span className="MeetingLibrary__item-fallback-label">PDF</span>
        </span>
      );
    }
    if (type === "image") {
      return (
        <img
          src={file.dataURL}
          alt={file.name}
          loading="lazy"
          draggable={false}
        />
      );
    }
    return (
      <span className="MeetingLibrary__item-fallback">
        {file.mimeType.split("/")[1] || "file"}
      </span>
    );
  };

  /** Coloured-initial badge — same algorithm as the participants bar,
   *  so the same uploader reads as the same swatch wherever it shows
   *  up in the meeting UI. */
  const renderAuthorChip = (author: string, locked?: boolean) => (
    <span
      className="MeetingLibrary__author-chip"
      title={`Tải lên bởi ${author}${
        locked ? ` · đang khoá bởi ${locked}` : ""
      }`}
    >
      <span
        className="MeetingLibrary__author-avatar"
        // colour is data-driven from the author hash — inline style
        // is the only practical option here.
        // eslint-disable-next-line react/forbid-dom-props
        style={{ background: authorColor(author) }}
        aria-hidden
      >
        {authorInitial(author)}
      </span>
      <span className="MeetingLibrary__author-name">{author}</span>
    </span>
  );

  const renderActions = (file: MeetingFile) => (
    <div
      className={`MeetingLibrary__item-actions ${
        file.lockedBy ? "MeetingLibrary__item-actions--persist" : ""
      }`}
    >
      <button
        type="button"
        className="MeetingLibrary__item-action"
        aria-label="Link tới text element đang chọn"
        title="Link tới text element đang chọn (mention từ canvas)"
        onClick={(e) => handleLinkText(file, e)}
      >
        🔗
      </button>
      <button
        type="button"
        className={`MeetingLibrary__item-action ${
          file.lockedBy ? "MeetingLibrary__item-action--locked" : ""
        }`}
        aria-label={file.lockedBy ? "Mở khoá" : "Khoá file"}
        title={
          file.lockedBy
            ? `Khoá bởi ${file.lockedBy}. Bấm để mở khoá.`
            : "Khoá file (chặn người khác xoá)"
        }
        onClick={(e) => handleToggleLock(file, e)}
      >
        {file.lockedBy ? "🔒" : "🔓"}
      </button>
      <button
        type="button"
        className="MeetingLibrary__item-action MeetingLibrary__item-action--danger"
        aria-label="Xoá"
        title={
          canDeleteFile(file, me)
            ? "Xoá khỏi thư viện và canvas"
            : `File đang bị khoá bởi ${file.lockedBy}`
        }
        onClick={(e) => handleDelete(file, e)}
        disabled={!canDeleteFile(file, me)}
      >
        ✕
      </button>
    </div>
  );

  const renderGridTile = (file: MeetingFile) => {
    const type = fileTypeOf(file);
    return (
      <div
        key={file.id}
        className={`MeetingLibrary__item MeetingLibrary__item--${type}`}
        onClick={() => handleInsert(file)}
        draggable
        onDragStart={(e) => handleItemDragStart(file, e)}
        title={`${file.name} — bấm hoặc kéo vào canvas`}
      >
        <div className="MeetingLibrary__item-thumb">{renderThumb(file)}</div>
        <span
          className={`MeetingLibrary__type-badge MeetingLibrary__type-badge--${type}`}
        >
          {TYPE_LABEL[type]}
        </span>
        <div className="MeetingLibrary__item-meta">
          <div className="MeetingLibrary__item-name">{file.name}</div>
          {renderAuthorChip(file.author, !!file.lockedBy)}
        </div>
        {renderActions(file)}
      </div>
    );
  };

  const renderListRow = (file: MeetingFile) => {
    const type = fileTypeOf(file);
    return (
      <div
        key={file.id}
        className={`MeetingLibrary__row MeetingLibrary__row--${type}`}
        onClick={() => handleInsert(file)}
        draggable
        onDragStart={(e) => handleItemDragStart(file, e)}
        title={`${file.name} — bấm hoặc kéo vào canvas`}
      >
        <div className="MeetingLibrary__row-thumb">{renderThumb(file)}</div>
        <div className="MeetingLibrary__row-main">
          <div className="MeetingLibrary__row-name">
            {file.name}
            <span
              className={`MeetingLibrary__type-badge MeetingLibrary__type-badge--${type} MeetingLibrary__type-badge--inline`}
            >
              {TYPE_LABEL[type]}
            </span>
          </div>
          <div className="MeetingLibrary__row-sub">
            {renderAuthorChip(file.author, !!file.lockedBy)}
            <span className="MeetingLibrary__row-ts">
              {relativeTime(file.ts)}
            </span>
            {file.lockedBy && (
              <span className="MeetingLibrary__row-lock">
                🔒 {file.lockedBy}
              </span>
            )}
          </div>
        </div>
        {renderActions(file)}
      </div>
    );
  };

  /** Render a flat list of files in the current view mode. Used for
   *  both the ungrouped layout and inside each section header when
   *  group-by-type is on. */
  const renderItems = (files: MeetingFile[]) =>
    viewMode === "grid" ? (
      <div className="MeetingLibrary__grid">{files.map(renderGridTile)}</div>
    ) : (
      <div className="MeetingLibrary__list">{files.map(renderListRow)}</div>
    );

  /** Bucket the displayedFiles by type and render in the canonical
   *  section order (DXF first, then PDF, then images, then misc). */
  const renderGrouped = () => {
    const byType: Record<FileType, MeetingFile[]> = {
      dxf: [],
      ifc: [],
      pdf: [],
      image: [],
      other: [],
    };
    for (const f of displayedFiles) {
      byType[fileTypeOf(f)].push(f);
    }
    return TYPE_SECTION_ORDER.filter(({ type }) => byType[type].length > 0).map(
      ({ type, title }) => {
        const isCollapsed = collapsedSections.has(type);
        const sectionFiles = byType[type];
        return (
          <div key={type} className="MeetingLibrary__section">
            <button
              type="button"
              className="MeetingLibrary__section-header"
              onClick={() => toggleSection(type)}
              aria-expanded={isCollapsed ? "false" : "true"}
            >
              <span className="MeetingLibrary__section-caret" aria-hidden>
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="MeetingLibrary__section-title">{title}</span>
              <span className="MeetingLibrary__section-count">
                {sectionFiles.length}
              </span>
            </button>
            {!isCollapsed && renderItems(sectionFiles)}
          </div>
        );
      },
    );
  };

  // Filter chips we offer in the toolbar. Hidden when the underlying
  // file count is zero so the toolbar stays uncluttered for small
  // libraries. The "All" chip is always shown.
  const filterChips: { key: FileType | "all"; label: string; count: number }[] =
    (
      [
        { key: "all", label: "All", count: items.length },
        { key: "dxf", label: "DXF", count: typeCounts.dxf },
        { key: "ifc", label: "IFC", count: typeCounts.ifc },
        { key: "pdf", label: "PDF", count: typeCounts.pdf },
        { key: "image", label: "Image", count: typeCounts.image },
        { key: "other", label: "Other", count: typeCounts.other },
      ] as const
    )
      .filter((c) => c.key === "all" || c.count > 0)
      .map((c) => ({ key: c.key, label: c.label, count: c.count }));

  return (
    <div
      className="MeetingLibrary"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="MeetingLibrary__toolbar">
        <button
          type="button"
          className={`MeetingLibrary__upload ${
            dragOver ? "MeetingLibrary__upload--dragover" : ""
          }`}
          onClick={handlePickFiles}
          disabled={!excalidrawAPI}
        >
          {dragOver
            ? "Thả file để tải lên"
            : "+ Tải ảnh / DXF / PDF / IFC lên · hoặc kéo thả"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.dxf,application/dxf,image/vnd.dxf,.pdf,application/pdf,.ifc"
          multiple
          aria-label="Chọn ảnh, DXF, PDF hoặc IFC để tải lên thư viện phòng"
          className="MeetingLibrary__file-input"
          onChange={handleFileInputChange}
        />
        {items.length > 0 && (
          <>
            <input
              type="text"
              className="MeetingLibrary__search"
              placeholder="Tìm theo tên hoặc người tải…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Tìm kiếm trong thư viện"
            />
            <div className="MeetingLibrary__filters">
              {filterChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className={`MeetingLibrary__filter-chip${
                    filterType === chip.key
                      ? " MeetingLibrary__filter-chip--active"
                      : ""
                  }`}
                  onClick={() => setFilterType(chip.key)}
                >
                  {chip.label}
                  <span className="MeetingLibrary__filter-chip-count">
                    {chip.count}
                  </span>
                </button>
              ))}
            </div>
            <div className="MeetingLibrary__view-row">
              <select
                className="MeetingLibrary__sort"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                aria-label="Sắp xếp"
              >
                <option value="newest">Mới nhất</option>
                <option value="oldest">Cũ nhất</option>
                <option value="name">Tên A-Z</option>
                <option value="author">Người tải</option>
              </select>
              <div
                className="MeetingLibrary__view-toggle"
                role="radiogroup"
                aria-label="Chế độ xem"
              >
                <button
                  type="button"
                  className={`MeetingLibrary__view-btn${
                    viewMode === "grid"
                      ? " MeetingLibrary__view-btn--active"
                      : ""
                  }`}
                  onClick={() => setViewMode("grid")}
                  aria-pressed={viewMode === "grid" ? "true" : "false"}
                  title="Hiển thị dạng lưới"
                >
                  ▦
                </button>
                <button
                  type="button"
                  className={`MeetingLibrary__view-btn${
                    viewMode === "list"
                      ? " MeetingLibrary__view-btn--active"
                      : ""
                  }`}
                  onClick={() => setViewMode("list")}
                  aria-pressed={viewMode === "list" ? "true" : "false"}
                  title="Hiển thị dạng danh sách"
                >
                  ☰
                </button>
                <button
                  type="button"
                  className={`MeetingLibrary__view-btn${
                    groupByType ? " MeetingLibrary__view-btn--active" : ""
                  }`}
                  onClick={() => setGroupByType((v) => !v)}
                  aria-pressed={groupByType ? "true" : "false"}
                  title="Gom nhóm theo loại file"
                >
                  ⌘
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="MeetingLibrary__body">
        {items.length === 0 ? (
          <div className="MeetingLibrary__empty">
            Chưa có file nào trong phòng này.
            <br />
            Kéo ảnh vào đây hoặc paste/kéo lên canvas để bắt đầu.
          </div>
        ) : displayedFiles.length === 0 ? (
          <div className="MeetingLibrary__empty">
            Không có file nào khớp với bộ lọc.
            <br />
            <button
              type="button"
              className="MeetingLibrary__empty-reset"
              onClick={() => {
                setSearchQuery("");
                setFilterType("all");
              }}
            >
              Xoá bộ lọc
            </button>
          </div>
        ) : groupByType ? (
          renderGrouped()
        ) : (
          renderItems(displayedFiles)
        )}
      </div>
    </div>
  );
};

export default MeetingLibrary;
