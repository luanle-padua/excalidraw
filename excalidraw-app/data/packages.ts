// Client API for the Meeting Package feature (worker /v1/.../packages).
//
// A Package is a curated, server-readable deliverable assembled AFTER a
// meeting finishes: an editable summary + a chosen subset of the meeting's
// files, scoped to an audience. The raw meeting stays E2E (room-key); the
// chosen files are decrypted client-side (we hold the room key) and
// re-uploaded as PLAINTEXT under the package's R2 prefix. See
// docs/plans/meeting-package.md.

import { decompressData } from "@excalidraw/excalidraw/data/encode";

import { fetchWithAuth } from "./fetchWithAuth";

import type { FileId } from "@excalidraw/element/types";

// Same base-URL resolution as projects.ts / storage.ts.
const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");
export const IS_PACKAGES_CONFIGURED =
  import.meta.env.VITE_DEV_TUNNEL === "true" || Boolean(STORAGE_URL);

const json = { "content-type": "application/json" };

export type PackageAudience = "meeting" | "project" | "list";

/** A meeting file row (D1 index) returned by the picker — bytes live in R2
 *  under the room key and are pulled per-file only when packaging. */
export type MeetingFileRow = {
  id: string;
  kind: string | null;
  name: string | null;
  size: number | null;
};

export type MeetingPackage = {
  id: string;
  meeting_id: string;
  project_id: string | null;
  title: string | null;
  summary_text: string | null;
  audience_kind: PackageAudience | null;
  status: "draft" | "published" | null;
  created_by: string | null;
  created_at: number;
  published_at: number | null;
};

/** List a meeting's files for the package builder's picker. */
export const listMeetingFiles = async (
  roomId: string,
): Promise<MeetingFileRow[]> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/files`,
    );
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { files?: MeetingFileRow[] };
    return body.files ?? [];
  } catch {
    return [];
  }
};

/** Create a DRAFT package. Returns the new package id (or null on failure). */
export const createPackage = async (
  roomId: string,
  body: {
    title: string;
    summary_text: string;
    audience_kind: PackageAudience;
    file_ids: string[];
    recipients?: string[];
  },
): Promise<string | null> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/packages`,
      { method: "POST", headers: json, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
};

/** Edit a draft package (title / summary / audience / files / recipients). */
export const updatePackage = async (
  pkgId: string,
  body: {
    title?: string;
    summary_text?: string;
    audience_kind?: PackageAudience;
    file_ids?: string[];
    recipients?: string[];
  },
): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}`,
      { method: "PUT", headers: json, body: JSON.stringify(body) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Upload a DECRYPTED, plaintext file blob into the package. The bytes are
 *  the already-decrypted dataURL re-encoded as raw bytes (server-readable). */
export const uploadPackageFile = async (
  pkgId: string,
  fileId: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(
        pkgId,
      )}/files/${encodeURIComponent(fileId)}`,
      {
        method: "PUT",
        headers: { "content-type": contentType || "application/octet-stream" },
        body: bytes,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Store the rendered recap.html for the package. */
export const uploadPackageRecap = async (
  pkgId: string,
  html: string,
): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/recap`,
      {
        method: "PUT",
        headers: { "content-type": "text/html; charset=utf-8" },
        body: html,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Finalise a draft → published. */
export const publishPackage = async (pkgId: string): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/publish`,
      { method: "POST" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Download the offline bundle (.zip) for a package. */
export const exportPackageZip = async (
  pkgId: string,
): Promise<Blob | null> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/export`,
    );
    if (!res.ok) {
      return null;
    }
    return await res.blob();
  } catch {
    return null;
  }
};

// --- client-side packaging helpers ----------------------------------------

// Decode a `data:<mime>;base64,<payload>` URL into raw bytes + the embedded
// mime. The decrypted meeting-file blob is the UTF-8 of such a data URL (the
// same shape storage.ts `loadFilesFromStorage` decodes to feed the canvas), so
// to store a USABLE offline file we turn it back into the real binary.
// Exported for the unit test (the inverse of the canvas-side data-URL encode).
export const dataUrlToBytes = (
  dataUrl: string,
): { bytes: Uint8Array; mimeType: string } => {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const mimeType = mimeMatch?.[1] || "application/octet-stream";
  if (header.includes(";base64")) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return { bytes, mimeType };
  }
  // Non-base64 (e.g. a URL-encoded SVG) — decode the percent-escapes.
  return {
    bytes: new TextEncoder().encode(decodeURIComponent(payload)),
    mimeType,
  };
};

/** Decrypt one meeting file blob (room-key, compressed) into plaintext bytes
 *  + mime, ready to re-upload as a server-readable package copy. Mirrors the
 *  decode path in storage.ts `loadFilesFromStorage` (which yields a data URL),
 *  then turns that data URL back into the real binary. Returns null on a
 *  missing / undecryptable blob. */
export const decryptMeetingFile = async (
  roomId: string,
  roomKey: string,
  fileId: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/files/${encodeURIComponent(
        roomId,
      )}/${encodeURIComponent(fileId)}`,
    );
    if (!res.ok) {
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) {
      return null;
    }
    const { data, metadata } = await decompressData<{ mimeType?: string }>(
      new Uint8Array(buf),
      { decryptionKey: roomKey },
    );
    const decoded = new TextDecoder().decode(data);
    if (decoded.startsWith("data:")) {
      const { bytes, mimeType } = dataUrlToBytes(decoded);
      return { bytes, mimeType: metadata?.mimeType || mimeType };
    }
    // Not a data URL — treat the decrypted bytes as the file itself.
    return {
      bytes: data,
      mimeType: metadata?.mimeType || "application/octet-stream",
    };
  } catch {
    return null;
  }
};

/** Re-export FileId so callers can type the picker selection without reaching
 *  into the element package. */
export type { FileId };
