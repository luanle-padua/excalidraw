// Project Files ("Tài liệu dự án") — a PER-PROJECT SHARED document shelf.
// Distinct from the personal "My Files" shelf (userFiles.ts): ANY member of a
// project uploads here and EVERY member sees the files. Same storage model —
// the Worker keeps RAW bytes (server-readable, NOT room-key encrypted) under
// project-files/<projectId>/<fileId>, gated to project members via the Supabase
// JWT that fetchWithAuth attaches. Metadata-only on list; content/thumb fetched
// lazily. Mirrors userFiles.ts but keyed by the project (no per-file tags or
// private/sharable visibility — a shared shelf is shared by definition).

import {
  bakeImageThumb,
  inferUserFileKind,
  MAX_USER_FILE_BYTES,
  type UserFileKind,
} from "./userFiles";

import { fetchWithAuth } from "./fetchWithAuth";

import type { ListResult } from "./projects";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

// A project file's kind classification reuses My Files' (pdf/dxf/ifc/image/other).
export type ProjectFileKind = UserFileKind;

export type ProjectFile = {
  id: string;
  name: string;
  kind: ProjectFileKind;
  size: number;
  /** Lower-case email of the member who uploaded it (shown so teammates know
   *  who shared a file; also gates delete client-side as a hint). */
  uploaded_by: string;
  created_at: number;
  /** Server has a stored small thumb at …/thumb. false ⇒ the grid backfills
   *  (fetch original once → bake → upload thumb) on first view. */
  has_thumb: boolean;
};

/** Server caps uploads at 50MB (413 above) — mirror My Files' cap so the
 *  client pre-check matches the Worker. */
export const MAX_PROJECT_FILE_BYTES = MAX_USER_FILE_BYTES;

const filesBase = (projectId: string) =>
  `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/files`;

/** Best-effort PUT of a baked thumb blob. Returns whether it stored (so the
 *  caller can optimistically mark has_thumb). */
export const putProjectFileThumb = async (
  projectId: string,
  id: string,
  thumbBlob: Blob,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${filesBase(projectId)}/${encodeURIComponent(id)}/thumb`,
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

export type UploadProjectFileResult =
  | { ok: true; file: ProjectFile }
  | { ok: false; reason: "too-large" | "failed" };

/** List a project's shared files (metadata only). A 401/403 (not a member) is a
 *  TRUE empty shelf for this viewer; a network error / 5xx is `ok: false` so the
 *  panel can show a retry instead of a lying empty state. */
export const listProjectFilesChecked = async (
  projectId: string,
): Promise<ListResult<ProjectFile>> => {
  try {
    const res = await fetchWithAuth(filesBase(projectId));
    if (res.ok) {
      // D1 sends has_thumb as 0|1 — coerce to a real boolean.
      const items: ProjectFile[] = ((await res.json()).files ?? []).map(
        (f: ProjectFile & { has_thumb?: unknown }) => ({
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

/** Upload one file to a project's shared shelf. Raw bytes, id minted client-
 *  side; the name travels ASCII-safe (Vietnamese names survive via
 *  encodeURIComponent — the Worker decodes). */
export const uploadProjectFile = async (
  projectId: string,
  file: File,
): Promise<UploadProjectFileResult> => {
  if (file.size > MAX_PROJECT_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const kind = inferUserFileKind(file);
  try {
    const res = await fetchWithAuth(
      `${filesBase(projectId)}/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-name": encodeURIComponent(file.name),
          "x-kind": kind,
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
    // Bake + store a small thumb for images (best-effort, after the original is
    // stored so the owning row exists). Any failure self-heals via lazy backfill.
    let hasThumb = false;
    if (kind === "image") {
      const thumb = await bakeImageThumb(file);
      if (thumb) {
        hasThumb = await putProjectFileThumb(projectId, id, thumb);
      }
    }
    return {
      ok: true,
      file: {
        id,
        name: file.name,
        kind,
        size: file.size,
        uploaded_by: "",
        created_at: Date.now(),
        has_thumb: hasThumb,
      },
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
};

/** Fetch a shared file's raw bytes — used to wrap them back into a `File` and
 *  feed the in-meeting ingest pipeline (the copy step). */
export const getProjectFileContent = async (
  projectId: string,
  id: string,
): Promise<Blob | null> => {
  try {
    const res = await fetchWithAuth(
      `${filesBase(projectId)}/${encodeURIComponent(id)}/content`,
    );
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
};

/** Fetch a shared image's SMALL stored thumbnail as an object URL for an
 *  `<img>`. Same two-path (thumb vs backfill) bandwidth strategy as My Files —
 *  see fetchMyFileThumb for the full rationale. Caller MUST URL.revokeObjectURL
 *  the returned URL when done. Returns null on any failure (incl. aborted). */
export const fetchProjectFileThumb = async (
  projectId: string,
  id: string,
  hasThumb: boolean,
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    if (hasThumb) {
      const res = await fetchWithAuth(
        `${filesBase(projectId)}/${encodeURIComponent(id)}/thumb`,
        { signal },
      );
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    }
    // Backfill: pull the original ONCE, bake, store, render the small thumb.
    const res = await fetchWithAuth(
      `${filesBase(projectId)}/${encodeURIComponent(id)}/content`,
      { signal },
    );
    if (!res.ok) {
      return null;
    }
    const original = await res.blob();
    const thumb = await bakeImageThumb(original);
    if (!thumb) {
      return null;
    }
    void putProjectFileThumb(projectId, id, thumb, signal);
    return URL.createObjectURL(thumb);
  } catch {
    return null;
  }
};

/** Delete a shared file. Server-gated to the uploader OR a project manager;
 *  meetings that already copied it are unaffected (snapshot semantics). */
export const deleteProjectFile = async (
  projectId: string,
  id: string,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${filesBase(projectId)}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};
