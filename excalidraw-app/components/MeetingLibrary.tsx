import {
  ArrowUpToLine,
  BadgeCheck,
  FolderHeart,
  Link2,
  Lock,
  LockOpen,
  Trash2,
  X,
} from "lucide-react";
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
import { collabAPIAtom, meetingViewOnlyAtom } from "../collab/Collab";
import {
  canDeleteFile,
  canUnlockFile,
  isAudioFile,
  isDxfFile,
  isFileSeen,
  isIfcFile,
  isIfcModelFile,
  isPdfFile,
  isPromotedToProject,
  isVideoFile,
  markFileSeen,
  markMeetingFilePromoted,
  meetingFilesAtom,
  probeImageDimensions,
} from "../data/meetingLibrary";
import { showAppToast } from "../data/appToast";
import { getMeeting } from "../data/projects";
import {
  getProjectFileContent,
  listProjectFilesChecked,
  putProjectFileThumb,
  uploadProjectFile,
  type ProjectFile,
} from "../data/projectFiles";
import { isInternalEmail, sessionAtom } from "../data/session";
import {
  getMyFileContent,
  listMyFiles,
  type UserFile,
  type UserFileKind,
} from "../data/userFiles";
import { useT } from "../i18n/mcm";

import { DXF_ANCHOR_KIND } from "./mcm/dxf/DXFCanvasOverlay";
import { IFC_ANCHOR_KIND } from "./mcm/ifc/ifcAnchor";
import { bakeIfc } from "./mcm/ifc/ifcBake";
import { bakeIfcThumbnail } from "./mcm/ifc/ifcThumbnail";
import { MEDIA_ANCHOR_KIND, type MediaKind } from "./mcm/media/mediaAnchor";
import { PDF_ANCHOR_KIND } from "./mcm/pdf/PDFCanvasOverlay";
import { probePdf } from "./mcm/pdf/pdfRendering";

import "./MeetingLibrary.scss";

import type { MeetingFile } from "../data/meetingLibrary";
import type { McmKey } from "../i18n/mcm";

const newFileId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MAX_INSERT_DIMENSION = 480; // px (logical) — keeps images sane in viewport

// Hard upper bound for an uploaded MEDIA file. Mirrors LIBRARY_FILE_MAX_BYTES
// in collab/Collab.tsx (the R2 per-file cap) — that constant isn't exported,
// so we keep the same value here as the local ingest guard. Files under
// ~256KB ride inline over the socket; larger ones auto-route to R2. Anything
// over this cap can't be stored, so we reject it before reading the bytes
// (with a friendly "compress it" alert) rather than failing mid-upload.
const MEDIA_FILE_MAX_BYTES = 512 * 1024 * 1024;

// Canvas anchor default sizes for media (scene units). Video gets a 16:9-ish
// frame; audio a short, wide control bar (no picture to show).
const VIDEO_DEFAULT_W = 480;
const VIDEO_DEFAULT_H = 300;
const AUDIO_DEFAULT_W = 360;
const AUDIO_DEFAULT_H = 84;

// 1×1 transparent PNG — the universal "nothing yet" poster seed (same inline
// data URL the PDF anchor uses). Excalidraw needs a file under the image
// element's fileId immediately; MediaCanvasOverlay paints the real player on
// top, so the poster only ever shows for the split second before the overlay
// mounts (and underneath the controls thereafter).
const TRANSPARENT_PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

/** Build a dark video poster with a centred play glyph (drawn on a canvas
 *  → PNG dataURL). Used as the IMAGE element's file so a placed video reads
 *  as "a video" on the canvas before/under the live player. Falls back to a
 *  1×1 transparent PNG if canvas 2D isn't available. */
const makeVideoPoster = (): string => {
  if (typeof document === "undefined") {
    return TRANSPARENT_PNG_1PX;
  }
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 300;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return TRANSPARENT_PNG_1PX;
  }
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, 0, c.width, c.height);
  // Play triangle.
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  const cx = c.width / 2;
  const cy = c.height / 2;
  const r = 34;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, cy - r);
  ctx.lineTo(cx - r * 0.5, cy + r);
  ctx.lineTo(cx + r, cy);
  ctx.closePath();
  ctx.fill();
  return c.toDataURL("image/png");
};

/** Build a compact audio-bar poster — a flat strip with a small waveform
 *  hint — so a placed audio anchor isn't a blank box before the player
 *  mounts. */
const makeAudioPoster = (): string => {
  if (typeof document === "undefined") {
    return TRANSPARENT_PNG_1PX;
  }
  const c = document.createElement("canvas");
  c.width = 360;
  c.height = 84;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return TRANSPARENT_PNG_1PX;
  }
  ctx.fillStyle = "#eef1f5";
  ctx.fillRect(0, 0, c.width, c.height);
  // A few bars to read as "audio".
  ctx.fillStyle = "rgba(60,70,90,0.55)";
  const heights = [18, 34, 26, 44, 30, 52, 24, 38, 20, 30];
  const barW = 6;
  const gap = 8;
  let x = 18;
  const baseY = c.height / 2;
  for (const h of heights) {
    ctx.fillRect(x, baseY - h / 2, barW, h);
    x += barW + gap;
  }
  return c.toDataURL("image/png");
};

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

/** Decode a base64 `data:` URL into a Blob without a network round-trip.
 *  Used by the "promote to project files" flow to rebuild a File from a
 *  library entry's `dataURL`. Returns null for a malformed / non-base64
 *  data URL so the caller can fall back to fetching the bytes. */
const dataURLToBlob = (dataURL: string): Blob | null => {
  const comma = dataURL.indexOf(",");
  if (!dataURL.startsWith("data:") || comma < 0) {
    return null;
  }
  const header = dataURL.slice(5, comma);
  const isBase64 = /;base64/i.test(header);
  const mime = header.split(";")[0] || "application/octet-stream";
  const payload = dataURL.slice(comma + 1);
  try {
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
};

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
type FileType = "image" | "dxf" | "pdf" | "ifc" | "video" | "audio" | "other";

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
  // Media checks BEFORE the generic image check: an uploaded media file
  // carries a video/* or audio/* mime (or a recognised extension), so the
  // `image/` test below can't shadow it.
  if (isVideoFile(file)) {
    return "video";
  }
  if (isAudioFile(file)) {
    return "audio";
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
  // Per-anchor media posters (video play-glyph / audio bar) — app-generated
  // placeholders, not user content. Never auto-publish them to the library.
  "media-poster-",
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
  video: "VID",
  audio: "AUD",
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
 *  width of a full ISO string. `justNow` is the localised "<1 min"
 *  label (module-level helper — no hook access). */
const relativeTime = (ts: number, justNow: string): string => {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) {
    return justNow;
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
 *  the i18n key of the user-facing section title (translated at
 *  render). */
const TYPE_SECTION_ORDER: { type: FileType; titleKey: McmKey }[] = [
  { type: "dxf", titleKey: "library.sectionDxf" },
  { type: "ifc", titleKey: "library.sectionIfc" },
  { type: "pdf", titleKey: "library.sectionPdf" },
  { type: "video", titleKey: "library.sectionVideo" },
  { type: "audio", titleKey: "library.sectionAudio" },
  { type: "image", titleKey: "library.sectionImage" },
  { type: "other", titleKey: "library.sectionOther" },
];

/** Fallback mime when the shelf blob arrives untyped — keeps the
 *  reconstructed `File` indistinguishable from a local pick (ingest
 *  detection is name-based for dxf/ifc anyway). */
const SHELF_MIME_FALLBACK: Record<UserFileKind, string> = {
  pdf: "application/pdf",
  dxf: "image/vnd.dxf",
  ifc: "application/octet-stream",
  image: "image/png",
  other: "application/octet-stream",
};

const shelfHumanSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const MeetingLibrary = () => {
  const t = useT();
  const items = useAtomValue(meetingFilesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  // Finished meetings are review-only: block every path that ADDS material
  // (upload button, file input, drop, shelf copy). Inserting an EXISTING
  // library file onto the canvas stays allowed — it only touches the local
  // scene, which review mode already keeps from syncing.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const excalidrawAPI = useExcalidrawAPI();
  const session = useAtomValue(sessionAtom);
  const isInternal = isInternalEmail(session?.email);

  const roomId = extractRoomId(collabAPI?.getActiveRoomLink() ?? null);

  // Parent project of this meeting — resolved from the room once on
  // roomId change. The "Up to project files" action only appears when a
  // projectId exists (ad-hoc rooms with no project can't promote). null =
  // not loaded / no project; a string = the target project's id.
  const [projectId, setProjectId] = useState<string | null>(null);
  // File id currently being promoted — disables its action + shows a
  // spinner label so a double-click can't fire two uploads.
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // "Từ tủ của tôi" — the personal-shelf picker (internal users only).
  // Selecting a file downloads its raw bytes and pushes them through
  // `ingestFiles`, i.e. EXACTLY the local-upload path, so the meeting
  // gets its own baked + encrypted snapshot copy of the document.
  const [shelfOpen, setShelfOpen] = useState(false);
  const [shelfFiles, setShelfFiles] = useState<UserFile[] | null>(null);
  const [shelfCopyingId, setShelfCopyingId] = useState<string | null>(null);

  // "Từ dự án" — the project shared-files picker. Mirrors the shelf picker
  // exactly, but lists the PARENT PROJECT's shared Files (projectFiles.ts)
  // instead of the user's personal shelf, and copies the selected file's
  // bytes through the SAME `ingestFiles` upload path so the meeting gets its
  // own baked + encrypted snapshot. Only meaningful when the meeting belongs
  // to a project (projectId non-null). `null` files = loading / not fetched;
  // an empty array = the project shelf is genuinely empty.
  const [projectPickOpen, setProjectPickOpen] = useState(false);
  const [projectPickFiles, setProjectPickFiles] = useState<
    ProjectFile[] | null
  >(null);
  const [projectCopyingId, setProjectCopyingId] = useState<string | null>(null);

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

  // The single source of truth for EVERYTHING the panel shows — the "All"
  // chip count, the per-kind chip counts, the sections, and the grid all
  // derive from this. Two normalisations happen here, in one place, so the
  // counts can never drift from the rendered tiles:
  //   1) Drop MCM-internal files (IFC/PDF/DXF anchor snapshots + decoration
  //      assets). They live in the same atom as real uploads but are never
  //      shown as tiles, so counting them inflates the total.
  //   2) De-duplicate by id, keeping the first occurrence and preserving
  //      order. The atom upsert already dedups, but the same file can legi-
  //      timately surface from more than one source (persisted shelf copy +
  //      a peer's library broadcast for the same id); without this the raw
  //      `items.length` reads e.g. 6 for 3 unique files while React collapses
  //      the grid to 3 by `key={file.id}`. Counting the unique set keeps the
  //      "All" badge honest.
  const visibleItems = useMemo(() => {
    const seen = new Set<string>();
    const out: MeetingFile[] = [];
    for (const f of items) {
      if (isInternalCanvasFile(f.id, undefined) || seen.has(f.id)) {
        continue;
      }
      seen.add(f.id);
      out.push(f);
    }
    return out;
  }, [items]);

  // Type counts — drive the badge on each filter chip ("DXF · 3") and
  // also tell us which chips should render at all (we hide chips for
  // types that have zero files to keep the toolbar uncluttered).
  const typeCounts = useMemo(() => {
    const counts: Record<FileType, number> = {
      image: 0,
      dxf: 0,
      pdf: 0,
      ifc: 0,
      video: 0,
      audio: 0,
      other: 0,
    };
    // Count over the SAME deduped, internal-stripped population the list
    // renders so the chip totals always match the visible tiles.
    for (const f of visibleItems) {
      counts[fileTypeOf(f)]++;
    }
    return counts;
  }, [visibleItems]);

  /** Files after search / filter / sort, ready to render. Memoised so
   *  re-typing the search query doesn't rerun on every unrelated atom
   *  change. */
  const displayedFiles = useMemo(() => {
    // Start from the deduped, internal-stripped set so search / filter /
    // sort operate on EXACTLY the population the chip counts report —
    // `visibleItems` already hides MCM-internal files (decoration assets +
    // IFC/PDF/DXF anchor snapshots) and collapses any same-id duplicates.
    let list = visibleItems;
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
  }, [visibleItems, filterType, searchQuery, sortBy]);

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

  // Resolve the parent project of this meeting so files can be promoted
  // into the project's shared Files shelf. Runs once per roomId; an
  // ad-hoc room (no project) or a fetch failure leaves projectId null and
  // the promote action simply never renders.
  useEffect(() => {
    if (!roomId) {
      setProjectId(null);
      return undefined;
    }
    let cancelled = false;
    void getMeeting(roomId).then((meeting) => {
      if (!cancelled) {
        setProjectId(meeting?.project_id ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

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
        // Media checks BEFORE image so a video/* upload isn't swallowed by
        // the generic image test. DXF / PDF / IFC are extension-led and
        // never collide with audio/video.
        const isVideo = !isImage && !isDxf && !isPdf && !isIfc && isVideoFile(file);
        const isAudio =
          !isImage && !isDxf && !isPdf && !isIfc && !isVideo && isAudioFile(file);
        if (!isImage && !isDxf && !isPdf && !isIfc && !isVideo && !isAudio) {
          window.alert(t("library.unsupportedType", { name: file.name }));
          continue;
        }
        // SIZE GUARD (media only): an over-cap media file can't be stored
        // (R2 per-file cap) — reject it up front with a friendly
        // "compress it" alert rather than failing mid-upload. Images / DXF /
        // PDF stay on their existing paths; IFC bakes down to a compact GLB
        // so the raw size doesn't apply.
        if ((isVideo || isAudio) && file.size > MEDIA_FILE_MAX_BYTES) {
          window.alert(t("library.mediaTooLarge", { name: file.name }));
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
            window.alert(t("library.ifcProcessFailed", { name: file.name }));
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
          } else if (isVideo || isAudio) {
            // Media (video/audio) — publish the bytes like any other kind.
            // The browser sometimes hands back an empty mime for untyped
            // uploads (drag from a share); pin a sensible default so peers
            // detect the kind the same way. Larger files auto-route to R2
            // inside publishLibraryFile; nothing media-specific to do here.
            const mimeType =
              file.type || (isVideo ? "video/mp4" : "audio/mpeg");
            collabAPI.publishLibraryFile(
              {
                id,
                name: file.name,
                ts: Date.now(),
                author: username,
                mimeType,
                dataURL,
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
    [excalidrawAPI, collabAPI, t],
  );

  const handlePickFiles = () => {
    if (viewOnly) {
      return;
    }
    fileInputRef.current?.click();
  };

  const toggleShelf = () => {
    if (shelfOpen) {
      setShelfOpen(false);
      return;
    }
    setShelfOpen(true);
    setShelfFiles(null); // show the loading hint while we (re)fetch
    void listMyFiles().then(setShelfFiles);
  };

  const handleCopyFromShelf = useCallback(
    async (shelfFile: UserFile) => {
      if (shelfCopyingId || viewOnly) {
        return;
      }
      // Private shelf files ask before becoming meeting-visible — copying
      // puts the document in front of every participant.
      if (
        shelfFile.visibility === "private" &&
        !window.confirm(
          t("myfiles.copyPrivateConfirm", { name: shelfFile.name }),
        )
      ) {
        return;
      }
      setShelfCopyingId(shelfFile.id);
      try {
        const blob = await getMyFileContent(shelfFile.id);
        if (!blob) {
          window.alert(t("myfiles.copyFailed", { name: shelfFile.name }));
          return;
        }
        // Rewrap the bytes as a `File` carrying the ORIGINAL name (ingest
        // detection for DXF/IFC/PDF is extension-based) and feed it through
        // the exact local-upload pipeline — bake, per-meeting encryption and
        // snapshot-copy semantics all come for free.
        // The Worker serves shelf bytes as application/octet-stream, which is
        // truthy — so it must be treated as "untyped" or images never reach
        // the kind fallback and ingest rejects them (image detection is the
        // one mime-based check in ingestFiles).
        const realType =
          blob.type && blob.type !== "application/octet-stream"
            ? blob.type
            : SHELF_MIME_FALLBACK[shelfFile.kind];
        const file = new File([blob], shelfFile.name, { type: realType });
        await ingestFiles([file]);
        setShelfOpen(false);
      } finally {
        setShelfCopyingId(null);
      }
    },
    [shelfCopyingId, viewOnly, ingestFiles, t],
  );

  const toggleProjectPick = () => {
    if (projectPickOpen) {
      setProjectPickOpen(false);
      return;
    }
    if (!projectId) {
      return;
    }
    setProjectPickOpen(true);
    setProjectPickFiles(null); // show the loading hint while we (re)fetch
    void listProjectFilesChecked(projectId).then((res) =>
      // A failed list (network/5xx) reads as an empty shelf here — the picker
      // shows its empty hint rather than a lying spinner; the user can reopen.
      setProjectPickFiles(res.ok ? res.items : []),
    );
  };

  const handleCopyFromProject = useCallback(
    async (projectFile: ProjectFile) => {
      if (!projectId || projectCopyingId || viewOnly) {
        return;
      }
      setProjectCopyingId(projectFile.id);
      try {
        const blob = await getProjectFileContent(projectId, projectFile.id);
        if (!blob) {
          window.alert(t("library.fromProjectCopyFailed", { name: projectFile.name }));
          return;
        }
        // Rewrap the bytes as a `File` carrying the ORIGINAL name (ingest
        // detection for DXF/IFC/PDF is extension-based) and feed it through
        // the exact local-upload pipeline — bake, per-meeting encryption and
        // snapshot-copy semantics all come for free. The Worker may serve the
        // bytes as application/octet-stream (truthy), so treat that as
        // "untyped" and fall back to a mime by kind, exactly like the shelf
        // picker — otherwise images never reach the kind fallback and ingest
        // rejects them (image detection is the one mime-based check).
        const realType =
          blob.type && blob.type !== "application/octet-stream"
            ? blob.type
            : SHELF_MIME_FALLBACK[projectFile.kind];
        const file = new File([blob], projectFile.name, { type: realType });
        await ingestFiles([file]);
        setProjectPickOpen(false);
      } finally {
        setProjectCopyingId(null);
      }
    },
    [projectId, projectCopyingId, viewOnly, ingestFiles, t],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (viewOnly) {
      return;
    }
    if (e.target.files && e.target.files.length > 0) {
      void ingestFiles(e.target.files);
      // reset input so picking the same file again still triggers change
      e.target.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (viewOnly) {
      return;
    }
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

  // Insert a MEDIA (video / audio) anchor. Mirrors insertPdfAt exactly:
  // build an Excalidraw IMAGE element (so the canvas owns its position /
  // size / lock / collab-sync) whose own fileId points at a poster PNG in
  // Excalidraw's file map, and tag customData with the media kind + the
  // library file id so MediaCanvasOverlay can find the bytes and mount the
  // live <video>/<audio> player on top. Audio defaults to a short wide bar
  // (no picture); video to a 16:9-ish frame.
  const insertMediaAt = useCallback(
    (file: MeetingFile, kind: MediaKind, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      // Derive the element id up front so the poster file id is a pure
      // function of it (`media-poster-{elementId}`) — the same pattern PDF
      // uses for its snapshot id, which keeps copy/paste deterministic.
      const anchorElementId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const posterFileId = `media-poster-${anchorElementId}` as FileId;
      const poster = kind === "video" ? makeVideoPoster() : makeAudioPoster();
      excalidrawAPI.addFiles([
        {
          id: posterFileId,
          dataURL: poster as unknown as BinaryFileData["dataURL"],
          mimeType: "image/png" as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      const w = kind === "video" ? VIDEO_DEFAULT_W : AUDIO_DEFAULT_W;
      const h = kind === "video" ? VIDEO_DEFAULT_H : AUDIO_DEFAULT_H;
      const baseAnchor = newImageElement({
        type: "image",
        x: at.sceneX - w / 2,
        y: at.sceneY - h / 2,
        width: w,
        height: h,
        fileId: posterFileId,
        status: "saved",
        customData: {
          mcmType: MEDIA_ANCHOR_KIND,
          mediaFileId: file.id,
          mediaType: kind,
          // Carried explicitly so peers + reload locate the per-anchor
          // poster without inspecting `el.fileId` (mirrors PDF's
          // pdfSnapshotFileId).
          mediaPosterFileId: posterFileId,
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
    const isVideo = !isIfc && !isDxf && !isPdf && isVideoFile(file);
    const isAudio = !isIfc && !isDxf && !isPdf && !isVideo && isAudioFile(file);
    const isMedia = isVideo || isAudio;

    // If this file already lives on the canvas, scroll to it instead
    // of dropping a duplicate. For DXF we look for the matching anchor
    // rectangle (via customData.dxfFileId), for IFC via ifcFileId, for
    // PDF via pdfFileId, for media via the media anchor's mediaFileId, and
    // for images via the image element's fileId.
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
        // IFC/PDF anchors are image elements (snapshot drawn on top);
        // only DXF still anchors on a transparent rectangle.
        return (
          el.type === "image" &&
          data?.mcmType === IFC_ANCHOR_KIND &&
          data?.ifcFileId === file.id
        );
      }
      if (isPdf) {
        return (
          el.type === "image" &&
          data?.mcmType === PDF_ANCHOR_KIND &&
          data?.pdfFileId === file.id
        );
      }
      if (isMedia) {
        return (
          el.type === "image" &&
          data?.mcmType === MEDIA_ANCHOR_KIND &&
          data?.mediaFileId === file.id
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
    if (isMedia) {
      insertMediaAt(file, isVideo ? "video" : "audio", at);
    } else if (isDxf) {
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
      const isVideo = !isIfc && !isDxf && !isPdf && isVideoFile(file);
      const isAudio = !isIfc && !isDxf && !isPdf && !isVideo && isAudioFile(file);
      const isMedia = isVideo || isAudio;
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
          // IFC/PDF anchors are image elements (snapshot drawn on top);
          // only DXF still anchors on a transparent rectangle.
          return (
            el.type === "image" &&
            data?.mcmType === IFC_ANCHOR_KIND &&
            data?.ifcFileId === file.id
          );
        }
        if (isPdf) {
          return (
            el.type === "image" &&
            data?.mcmType === PDF_ANCHOR_KIND &&
            data?.pdfFileId === file.id
          );
        }
        if (isMedia) {
          return (
            el.type === "image" &&
            data?.mcmType === MEDIA_ANCHOR_KIND &&
            data?.mediaFileId === file.id
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
      if (isMedia) {
        insertMediaAt(file, isVideo ? "video" : "audio", at);
      } else if (isDxf) {
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
    insertMediaAt,
  ]);

  const me = collabAPI?.getUsername() || "Local";

  const handleDelete = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    // A promoted file now lives in the project's Files shelf — block its
    // deletion here so it can't be lost out from under other members /
    // meetings. The UI already hides the delete button for these (see
    // renderActions), this is the belt-and-braces guard.
    if (isPromotedToProject(file)) {
      window.alert(t("library.promotedDeleteDisabledTitle"));
      return;
    }
    if (!canDeleteFile(file, me)) {
      window.alert(
        t("library.deleteLockedAlert", { lockedBy: file.lockedBy ?? "" }),
      );
      return;
    }
    if (!window.confirm(t("library.deleteConfirm", { name: file.name }))) {
      return;
    }
    // collabAPI: removes canvas elements + library entry + broadcasts
    collabAPI?.publishLibraryFileDelete(file.id);
  };

  // "Đưa lên Files dự án" — copy a meeting file into the parent project's
  // shared Files shelf. Frontend-only: the bytes are already on the client
  // (the library entry's dataURL, or the canvas file map when offloaded to
  // R2), so we just rebuild a File and reuse uploadProjectFile. Once
  // promoted, the entry is marked (persisted) and can no longer be deleted
  // from the library.
  const handlePromoteToProject = useCallback(
    async (file: MeetingFile, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!projectId || promotingId || isPromotedToProject(file)) {
        return;
      }
      // Resolve the bytes. Prefer the in-atom dataURL; large files keep it
      // empty (offloaded to R2) but their bytes are hydrated into the
      // canvas file map by the time a tile is interactive.
      let dataURL = file.dataURL;
      if (!dataURL && excalidrawAPI) {
        dataURL = (excalidrawAPI.getFiles()[file.id as FileId]
          ?.dataURL ?? "") as string;
      }
      const blob = dataURL ? dataURLToBlob(dataURL) : null;
      if (!blob) {
        showAppToast(t("library.promoteError"));
        return;
      }
      setPromotingId(file.id);
      try {
        // Skip if the project already holds a file with the same name+size
        // — avoids a duplicate entry when two members promote the same
        // document. A failed list (network) doesn't block the upload; the
        // server is the final arbiter.
        const listed = await listProjectFilesChecked(projectId);
        const dup =
          listed.ok &&
          listed.items.find(
            (pf) => pf.name === file.name && pf.size === blob.size,
          );
        if (dup) {
          markMeetingFilePromoted(roomId, file.id, dup.id);
          showAppToast(t("library.promoteSuccess"));
          return;
        }
        const upload = new File([blob], file.name, {
          type: file.mimeType || blob.type || "application/octet-stream",
        });
        const result = await uploadProjectFile(projectId, upload);
        if (!result.ok) {
          showAppToast(
            result.reason === "too-large"
              ? t("library.promoteErrorTooLarge")
              : t("library.promoteError"),
          );
          return;
        }
        // BONUS: non-image kinds carry a baked thumbnail in their meta but
        // uploadProjectFile only auto-thumbs images — push the baked one so
        // the project tile gets a preview. Best-effort; failure self-heals
        // via the project grid's lazy backfill.
        const bakedThumb =
          file.dxfMeta?.thumbnail ??
          file.pdfMeta?.thumbnail ??
          file.ifcMeta?.thumbnail;
        if (bakedThumb && result.file.kind !== "image") {
          const thumbBlob = dataURLToBlob(bakedThumb);
          if (thumbBlob) {
            void putProjectFileThumb(projectId, result.file.id, thumbBlob);
          }
        }
        markMeetingFilePromoted(roomId, file.id, result.file.id);
        showAppToast(t("library.promoteSuccess"));
      } catch {
        showAppToast(t("library.promoteError"));
      } finally {
        setPromotingId(null);
      }
    },
    [projectId, promotingId, roomId, excalidrawAPI, t],
  );

  const handleToggleLock = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (file.lockedBy) {
      // unlock
      if (!canUnlockFile(file, me)) {
        window.alert(
          t("library.unlockDenied", {
            lockedBy: file.lockedBy ?? "",
            author: file.author,
          }),
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
    if (type === "video") {
      return (
        <span
          className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--video"
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
            <rect x="3" y="5" width="14" height="14" rx="2" />
            <path d="M17 9l4-2v10l-4-2z" />
          </svg>
          <span className="MeetingLibrary__item-fallback-label">VIDEO</span>
        </span>
      );
    }
    if (type === "audio") {
      return (
        <span
          className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--audio"
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
            <path d="M9 18V5l10-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="16" cy="16" r="3" />
          </svg>
          <span className="MeetingLibrary__item-fallback-label">AUDIO</span>
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
  const renderAuthorChip = (author: string, lockedBy?: string | null) => (
    <span
      className="MeetingLibrary__author-chip"
      title={`${t("library.authorChipTitle", { author })}${
        lockedBy ? t("library.authorChipLockedSuffix", { lockedBy }) : ""
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

  const renderActions = (file: MeetingFile) => {
    const promoted = isPromotedToProject(file);
    // The promote action only makes sense when the meeting belongs to a
    // project, the file isn't promoted yet, and we're not in review mode.
    const canPromote = !!projectId && !promoted && !viewOnly;
    const isPromoting = promotingId === file.id;
    return (
      <div
        className={`MeetingLibrary__item-actions ${
          file.lockedBy || promoted
            ? "MeetingLibrary__item-actions--persist"
            : ""
        }`}
      >
        <button
          type="button"
          className="MeetingLibrary__item-action"
          aria-label={t("library.linkTextAria")}
          title={t("library.linkTextTitle")}
          onClick={(e) => handleLinkText(file, e)}
        >
          <Link2 size={13} aria-hidden="true" />
        </button>
        {canPromote && (
          <button
            type="button"
            className={`MeetingLibrary__item-action MeetingLibrary__item-action--promote${
              isPromoting ? " MeetingLibrary__item-action--busy" : ""
            }`}
            aria-label={t("library.promoteAria")}
            title={isPromoting ? t("library.promoting") : t("library.promoteTitle")}
            onClick={(e) => void handlePromoteToProject(file, e)}
            disabled={isPromoting}
          >
            <ArrowUpToLine size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={`MeetingLibrary__item-action ${
            file.lockedBy ? "MeetingLibrary__item-action--locked" : ""
          }`}
          aria-label={
            file.lockedBy ? t("library.unlockAria") : t("library.lockAria")
          }
          title={
            file.lockedBy
              ? t("library.lockedByTitle", { lockedBy: file.lockedBy })
              : t("library.lockTitle")
          }
          onClick={(e) => handleToggleLock(file, e)}
        >
          {file.lockedBy ? (
            <Lock size={13} aria-hidden="true" />
          ) : (
            <LockOpen size={13} aria-hidden="true" />
          )}
        </button>
        {promoted ? (
          // Promoted files can't be deleted from the library — they live in
          // the project now. Show an "in project" badge with a hint that
          // deletion happens in the project's Files view.
          <span
            className="MeetingLibrary__in-project-badge"
            title={t("library.promotedDeleteDisabledTitle")}
          >
            <BadgeCheck size={12} aria-hidden="true" />
            {t("library.inProjectBadge")}
          </span>
        ) : (
          <button
            type="button"
            className="MeetingLibrary__item-action MeetingLibrary__item-action--danger"
            aria-label={t("library.deleteAria")}
            title={
              canDeleteFile(file, me)
                ? t("library.deleteTitle")
                : t("library.deleteDisabledTitle", {
                    lockedBy: file.lockedBy ?? "",
                  })
            }
            onClick={(e) => handleDelete(file, e)}
            disabled={!canDeleteFile(file, me)}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const renderGridTile = (file: MeetingFile) => {
    const type = fileTypeOf(file);
    return (
      <div
        key={file.id}
        className={`MeetingLibrary__item MeetingLibrary__item--${type}`}
        onClick={() => handleInsert(file)}
        draggable
        onDragStart={(e) => handleItemDragStart(file, e)}
        title={t("library.itemTitle", { name: file.name })}
      >
        <div className="MeetingLibrary__item-thumb">{renderThumb(file)}</div>
        <span
          className={`MeetingLibrary__type-badge MeetingLibrary__type-badge--${type}`}
        >
          {TYPE_LABEL[type]}
        </span>
        <div className="MeetingLibrary__item-meta">
          <div className="MeetingLibrary__item-name">{file.name}</div>
          {renderAuthorChip(file.author, file.lockedBy)}
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
        title={t("library.itemTitle", { name: file.name })}
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
            {renderAuthorChip(file.author, file.lockedBy)}
            <span className="MeetingLibrary__row-ts">
              {relativeTime(file.ts, t("library.justNow"))}
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
      video: [],
      audio: [],
      image: [],
      other: [],
    };
    for (const f of displayedFiles) {
      byType[fileTypeOf(f)].push(f);
    }
    return TYPE_SECTION_ORDER.filter(({ type }) => byType[type].length > 0).map(
      ({ type, titleKey }) => {
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
              <span className="MeetingLibrary__section-title">
                {t(titleKey)}
              </span>
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
        { key: "all", label: t("library.chipAll"), count: visibleItems.length },
        { key: "dxf", label: "DXF", count: typeCounts.dxf },
        { key: "ifc", label: "IFC", count: typeCounts.ifc },
        { key: "pdf", label: "PDF", count: typeCounts.pdf },
        { key: "video", label: "Video", count: typeCounts.video },
        { key: "audio", label: "Audio", count: typeCounts.audio },
        {
          key: "image",
          label: t("library.chipImage"),
          count: typeCounts.image,
        },
        {
          key: "other",
          label: t("library.chipOther"),
          count: typeCounts.other,
        },
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
          disabled={!excalidrawAPI || viewOnly}
          title={viewOnly ? t("review.uploadDisabled") : undefined}
        >
          {dragOver ? t("library.dropToUpload") : t("library.uploadButton")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.dxf,application/dxf,image/vnd.dxf,.pdf,application/pdf,.ifc,video/*,audio/*"
          multiple
          aria-label={t("library.fileInputAria")}
          className="MeetingLibrary__file-input"
          onChange={handleFileInputChange}
        />
        {(isInternal || projectId) && (
          <div className="MeetingLibrary__source-row">
            {isInternal && (
              <button
                type="button"
                className={`mcm-shelfpick__toggle MeetingLibrary__source-btn${
                  shelfOpen ? " mcm-shelfpick__toggle--open" : ""
                }`}
                onClick={toggleShelf}
                disabled={!excalidrawAPI}
                aria-expanded={shelfOpen ? "true" : "false"}
              >
                <FolderHeart size={14} aria-hidden="true" />
                {t("myfiles.fromShelf")}
              </button>
            )}
            {projectId && (
              <button
                type="button"
                className={`mcm-shelfpick__toggle MeetingLibrary__source-btn${
                  projectPickOpen ? " mcm-shelfpick__toggle--open" : ""
                }`}
                onClick={toggleProjectPick}
                disabled={!excalidrawAPI}
                aria-expanded={projectPickOpen ? "true" : "false"}
              >
                <FolderHeart size={14} aria-hidden="true" />
                {t("library.fromProject")}
              </button>
            )}
          </div>
        )}
        {isInternal && shelfOpen && (
          <div
            className="mcm-shelfpick"
            role="dialog"
            aria-label={t("myfiles.pickerTitle")}
          >
            <div className="mcm-shelfpick__head">
              <span className="mcm-shelfpick__title">
                {t("myfiles.pickerTitle")}
              </span>
              <span className="mcm-shelfpick__hint">
                {t("myfiles.pickerHint")}
              </span>
              <button
                type="button"
                className="mcm-shelfpick__close"
                onClick={() => setShelfOpen(false)}
                title={t("myfiles.close")}
                aria-label={t("myfiles.close")}
              >
                <X size={13} />
              </button>
            </div>
            {shelfFiles === null ? (
              <div className="mcm-shelfpick__empty">…</div>
            ) : shelfFiles.length === 0 ? (
              <div className="mcm-shelfpick__empty">
                {t("myfiles.pickerEmpty")}
              </div>
            ) : (
              <ul className="mcm-shelfpick__list">
                {shelfFiles.map((sf) => (
                  <li key={sf.id}>
                    <button
                      type="button"
                      className="mcm-shelfpick__row"
                      onClick={() => void handleCopyFromShelf(sf)}
                      disabled={!!shelfCopyingId}
                    >
                      <span
                        className={`mcm-shelfpick__kind mcm-shelfpick__kind--${sf.kind}`}
                      >
                        {sf.kind.toUpperCase()}
                      </span>
                      <span className="mcm-shelfpick__name" title={sf.name}>
                        {sf.name}
                      </span>
                      <span
                        className={`mcm-shelfpick__vis mcm-shelfpick__vis--${sf.visibility}`}
                      >
                        {t(
                          sf.visibility === "private"
                            ? "myfiles.visPrivate"
                            : "myfiles.visSharable",
                        )}
                      </span>
                      <span className="mcm-shelfpick__size">
                        {shelfCopyingId === sf.id
                          ? t("myfiles.copying")
                          : shelfHumanSize(sf.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {projectId && projectPickOpen && (
          <div
            className="mcm-shelfpick"
            role="dialog"
            aria-label={t("library.fromProjectPickerTitle")}
          >
            <div className="mcm-shelfpick__head">
              <span className="mcm-shelfpick__title">
                {t("library.fromProjectPickerTitle")}
              </span>
              <span className="mcm-shelfpick__hint">
                {t("library.fromProjectPickerHint")}
              </span>
              <button
                type="button"
                className="mcm-shelfpick__close"
                onClick={() => setProjectPickOpen(false)}
                title={t("myfiles.close")}
                aria-label={t("myfiles.close")}
              >
                <X size={13} />
              </button>
            </div>
            {projectPickFiles === null ? (
              <div className="mcm-shelfpick__empty">…</div>
            ) : projectPickFiles.length === 0 ? (
              <div className="mcm-shelfpick__empty">
                {t("library.fromProjectEmpty")}
              </div>
            ) : (
              <ul className="mcm-shelfpick__list">
                {projectPickFiles.map((pf) => {
                  // Light dedup nicety: mark a project file as "already in
                  // meeting" (and disable its copy) when this meeting's library
                  // already holds a same-named entry, or one explicitly linked
                  // to this exact project file via promote. MeetingFile has no
                  // byte size, so name + promote-link is the available key.
                  const alreadyIn = visibleItems.some(
                    (m) =>
                      m.name === pf.name ||
                      m.promotedToProjectFileId === pf.id,
                  );
                  return (
                    <li key={pf.id}>
                      <button
                        type="button"
                        className={`mcm-shelfpick__row${
                          alreadyIn
                            ? " MeetingLibrary__project-row--in-meeting"
                            : ""
                        }`}
                        onClick={() => void handleCopyFromProject(pf)}
                        disabled={!!projectCopyingId || alreadyIn}
                      >
                        <span
                          className={`mcm-shelfpick__kind mcm-shelfpick__kind--${pf.kind}`}
                        >
                          {pf.kind.toUpperCase()}
                        </span>
                        <span className="mcm-shelfpick__name" title={pf.name}>
                          {pf.name}
                        </span>
                        <span className="mcm-shelfpick__size">
                          {alreadyIn
                            ? t("library.fromProjectInMeeting")
                            : projectCopyingId === pf.id
                            ? t("myfiles.copying")
                            : shelfHumanSize(pf.size)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {visibleItems.length > 0 && (
          <>
            <input
              type="text"
              className="MeetingLibrary__search"
              placeholder={t("library.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={t("library.searchAria")}
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
                aria-label={t("library.sortAria")}
              >
                <option value="newest">{t("library.sortNewest")}</option>
                <option value="oldest">{t("library.sortOldest")}</option>
                <option value="name">{t("library.sortName")}</option>
                <option value="author">{t("library.sortAuthor")}</option>
              </select>
              <div
                className="MeetingLibrary__view-toggle"
                role="radiogroup"
                aria-label={t("library.viewModeAria")}
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
                  title={t("library.viewGridTitle")}
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
                  title={t("library.viewListTitle")}
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
                  title={t("library.groupByTypeTitle")}
                >
                  ⌘
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="MeetingLibrary__body">
        {visibleItems.length === 0 ? (
          <div className="MeetingLibrary__empty">
            {t("library.emptyTitle")}
            <br />
            {t("library.emptyHint")}
          </div>
        ) : displayedFiles.length === 0 ? (
          <div className="MeetingLibrary__empty">
            {t("library.noMatch")}
            <br />
            <button
              type="button"
              className="MeetingLibrary__empty-reset"
              onClick={() => {
                setSearchQuery("");
                setFilterType("all");
              }}
            >
              {t("library.clearFilters")}
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
