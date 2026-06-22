// Personal document shelf ("Tài liệu của tôi") — INTERNAL users upload
// documents once on the dashboard and later COPY them into any meeting via
// the normal library ingest pipeline (snapshot semantics: deleting a shelf
// file never affects meetings that already copied it).
//
// Storage model: the Worker keeps RAW bytes (NOT encrypted — the personal
// shelf is server-readable by design, unlike per-meeting blobs) under
// /v1/me/files, owner-scoped via the Supabase JWT that fetchWithAuth
// attaches. The shelf is metadata-only on list; content is fetched lazily
// when the user actually copies a file into a meeting.

import { fetchWithAuth } from "./fetchWithAuth";

import type { ListResult } from "./projects";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type UserFileKind = "pdf" | "dxf" | "ifc" | "image" | "other";

export type UserFileVisibility = "private" | "sharable";

export type UserFile = {
  id: string;
  name: string;
  kind: UserFileKind;
  size: number;
  /** Free-form "a,b,c" tag string; null when untagged. */
  tags: string | null;
  /** 'private' files ask for confirmation before copying into a meeting. */
  visibility: UserFileVisibility;
  created_at: number;
  /** Server has a stored small thumb at …/thumb. false ⇒ the grid backfills
   *  (fetch original once → bake → upload thumb) on first view. */
  has_thumb: boolean;
};

/** Server caps uploads at 50MB (413 above) — we pre-check client-side so
 *  the user gets a friendly message instead of a cryptic network error. */
export const MAX_USER_FILE_BYTES = 50 * 1024 * 1024;

/** Longest-edge (px) the baked grid thumbnail is downscaled to. ~tens of KB
 *  as WebP — the whole point of the bandwidth fix. */
export const USER_FILE_THUMB_MAX_EDGE = 384;

/** Pure: given a source image's natural size, compute the downscaled thumb
 *  dimensions (never upscales; never below 1px). Extracted so it's unit-
 *  testable without a DOM. */
export const thumbDimensions = (
  naturalWidth: number,
  naturalHeight: number,
  maxEdge: number = USER_FILE_THUMB_MAX_EDGE,
): { width: number; height: number } => {
  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1;
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
};

/** Bake a small WebP thumbnail from an image blob via a downscale canvas
 *  (mirrors UserProfileModal's technique, WebP @ 0.7 instead of PNG). Returns
 *  null on any failure (decode error, no 2d ctx, toBlob null) — a thumb is
 *  best-effort and must NEVER block the upload it accompanies. */
export const bakeImageThumb = async (file: Blob): Promise<Blob | null> => {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = thumbDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.7);
    });
  } catch {
    return null;
  }
};

/** Best-effort PUT of a baked thumb blob to the server. Returns whether it
 *  stored (so the caller can optimistically mark has_thumb). */
export const putMyFileThumb = async (
  id: string,
  thumbBlob: Blob,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}/thumb`,
      {
        method: "PUT",
        headers: { "content-type": "image/webp" },
        body: thumbBlob,
        signal,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Classify a file for the shelf — mirrors the kinds the in-meeting
 *  library understands (pdf/dxf/ifc/image) plus a catch-all. */
export const inferUserFileKind = (file: {
  name?: string;
  type?: string;
}): UserFileKind => {
  const name = (file.name ?? "").toLowerCase();
  if (name.endsWith(".pdf")) {
    return "pdf";
  }
  if (name.endsWith(".dxf")) {
    return "dxf";
  }
  if (name.endsWith(".ifc")) {
    return "ifc";
  }
  if ((file.type ?? "").startsWith("image/")) {
    return "image";
  }
  return "other";
};

export type UploadMyFileResult =
  | { ok: true; file: UserFile }
  | { ok: false; reason: "too-large" | "failed" };

/** List my shelf files (metadata only). Internal users only — a 401/403
 *  (not internal / not allowed) is a TRUE empty shelf for this viewer, but
 *  a network error or 5xx is `ok: false` so the panel can show a retry
 *  instead of a lying empty state. */
export const listMyFilesChecked = async (): Promise<ListResult<UserFile>> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/files`);
    if (res.ok) {
      // D1 sends has_thumb as 0|1 (or undefined on a pre-0031 worker) — coerce
      // to a real boolean so the grid can branch thumb-route vs backfill.
      const items: UserFile[] = ((await res.json()).files ?? []).map(
        (f: UserFile & { has_thumb?: unknown }) => ({
          ...f,
          has_thumb: !!f.has_thumb,
        }),
      );
      return { ok: true, items };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: true, items: [] };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
};

export const listMyFiles = async (): Promise<UserFile[]> => {
  const r = await listMyFilesChecked();
  return r.ok ? r.items : [];
};

/** Upload one file to my shelf. Raw bytes, id minted client-side; the
 *  name travels in an ASCII-safe header (Vietnamese names survive via
 *  encodeURIComponent — the Worker decodes). */
export const uploadMyFile = async (file: File): Promise<UploadMyFileResult> => {
  if (file.size > MAX_USER_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const kind = inferUserFileKind(file);
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-name": encodeURIComponent(file.name),
          "x-kind": kind,
          // Shelf metadata defaults: untagged + private (the cautious
          // default — copying into a meeting asks for confirmation).
          "x-tags": "",
          "x-visibility": "private",
        },
        body: file,
      },
    );
    if (res.status === 413) {
      return { ok: false, reason: "too-large" };
    }
    if (!res.ok) {
      return { ok: false, reason: "failed" };
    }
    // Bake + store a small thumb for images so the grid never pulls the
    // original. Best-effort: done AFTER the original is stored (the thumb route
    // needs the owning row to exist), and any failure just leaves the image to
    // self-heal via the grid's lazy backfill. Never blocks the upload result.
    let hasThumb = false;
    if (kind === "image") {
      const thumb = await bakeImageThumb(file);
      if (thumb) {
        hasThumb = await putMyFileThumb(id, thumb);
      }
    }
    return {
      ok: true,
      file: {
        id,
        name: file.name,
        kind,
        size: file.size,
        tags: null,
        visibility: "private",
        created_at: Date.now(),
        has_thumb: hasThumb,
      },
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
};

/** Edit shelf metadata (tags / visibility / rename) without re-uploading
 *  bytes. Owner-scoped server-side like DELETE. */
export const updateMyFile = async (
  id: string,
  patch: {
    tags?: string | null;
    visibility?: UserFileVisibility;
    name?: string;
  },
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Fetch a shelf file's raw bytes — used to wrap them back into a `File`
 *  and feed the in-meeting ingest pipeline (the copy step). */
export const getMyFileContent = async (id: string): Promise<Blob | null> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}/content`,
    );
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
};

/** Fetch a shelf image's SMALL stored thumbnail as an object URL for an
 *  `<img>`. Bandwidth-optimal: the grid loads the tens-of-KB WebP thumb, never
 *  the full-resolution original.
 *
 *  Two paths, by `hasThumb` (from the list's has_thumb flag):
 *   - hasThumb → GET …/thumb (cheap, immutable-cached). A 404 here is a rare
 *     race (row says present but blob gone) → null → icon fallback.
 *   - !hasThumb → BACKFILL ONCE: the only time we pull the original. GET
 *     …/content, bake a thumb, fire-and-forget PUT …/thumb (so future list
 *     loads take the cheap path), and build the object URL from the BAKED thumb
 *     (drop the heavy original) so even this first view renders small.
 *
 *  The route is JWT-gated, so a bare `<img src>` would 401 — we go through
 *  fetchWithAuth → blob → URL.createObjectURL like fetchGuestLogo. Caller MUST
 *  URL.revokeObjectURL the returned URL when done. Returns null on any failure
 *  (incl. aborted) so the grid can fall back to the kind icon (no broken
 *  image). Pass an AbortSignal to cancel the in-flight request (e.g. the panel
 *  unmounts or the file scrolls out / leaves the list before bytes arrive).
 *  Repeated-backfill safety is the caller's: MyFilesPanel fetches each id at
 *  most once for the life of the panel, and a successful backfill flips
 *  has_thumb server-side so subsequent panel loads take the cheap path. */
export const fetchMyFileThumb = async (
  id: string,
  hasThumb: boolean,
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    if (hasThumb) {
      const res = await fetchWithAuth(
        `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}/thumb`,
        { signal },
      );
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    }
    // Backfill: pull the original ONCE, bake, store, render the small thumb.
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}/content`,
      { signal },
    );
    if (!res.ok) {
      return null;
    }
    const original = await res.blob();
    const thumb = await bakeImageThumb(original);
    if (!thumb) {
      // Couldn't bake (e.g. exotic format) — no thumb this view; icon shows.
      return null;
    }
    // Persist for next time (best-effort, don't block the render on it).
    void putMyFileThumb(id, thumb, signal);
    return URL.createObjectURL(thumb);
  } catch {
    // AbortError lands here too — treated as "no thumb" (icon fallback).
    return null;
  }
};

/** Delete a shelf file. Meetings that already copied it are unaffected
 *  (snapshot semantics). */
export const deleteMyFile = async (id: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/files/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};
