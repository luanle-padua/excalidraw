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
};

/** Server caps uploads at 50MB (413 above) — we pre-check client-side so
 *  the user gets a friendly message instead of a cryptic network error. */
export const MAX_USER_FILE_BYTES = 50 * 1024 * 1024;

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

/** List my shelf files (metadata only). Internal users only — the Worker
 *  rejects others; we degrade to an empty list. */
export const listMyFiles = async (): Promise<UserFile[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/files`);
    return res.ok ? (await res.json()).files ?? [] : [];
  } catch {
    return [];
  }
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
