// Client API for the Meeting Package feature (worker /v1/.../packages).
//
// A Package is a curated, server-readable deliverable assembled AFTER a
// meeting finishes: an editable summary + a chosen subset of the meeting's
// files, scoped to an audience. The raw meeting stays E2E (room-key); the
// chosen files are decrypted client-side (we hold the room key) and
// re-uploaded as PLAINTEXT under the package's R2 prefix. See
// docs/plans/meeting-package.md.

import { exportToBlob } from "@excalidraw/excalidraw";
import { decompressData } from "@excalidraw/excalidraw/data/encode";

import { fetchWithAuth } from "./fetchWithAuth";
import {
  loadChatFromStorage,
  loadFilesFromStorage,
  loadFromStorage,
} from "./storage";

import type {
  FileId,
  InitializedExcalidrawImageElement,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

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

/** Compact package row from the LIST endpoints (no summary/recap body). */
export type MeetingPackageListItem = {
  id: string;
  meeting_id: string;
  project_id: string | null;
  title: string | null;
  audience_kind: PackageAudience | null;
  status: "draft" | "published" | null;
  created_by: string | null;
  created_at: number;
  published_at: number | null;
  file_count: number;
};

/** Full package payload returned by GET /v1/packages/:id (metadata + the
 *  curated file list + the server-stored recap HTML). */
export type PackageDetail = {
  package: MeetingPackage;
  files: MeetingFileRow[];
  recap_html: string | null;
};

/** List the packages of a meeting the caller can see. The curator (host /
 *  project authority / admin) gets drafts + published; the audience gets only
 *  PUBLISHED packages they pass the server's audience gate for. Empty on any
 *  failure (a non-visible meeting / no packages both read as "nothing to show").
 */
export const listMeetingPackages = async (
  roomId: string,
): Promise<MeetingPackageListItem[]> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/packages`,
    );
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { packages?: MeetingPackageListItem[] };
    return body.packages ?? [];
  } catch {
    return [];
  }
};

/** Published packages addressed to the current user across meetings ("Shared
 *  with me"). Empty on failure. */
export const listMyPackages = async (): Promise<MeetingPackageListItem[]> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/packages`);
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { packages?: MeetingPackageListItem[] };
    return body.packages ?? [];
  } catch {
    return [];
  }
};

/** Read one package (metadata + files + recap_html), audience-gated server
 *  side. Returns null on a missing / forbidden package. */
export const getPackage = async (
  pkgId: string,
): Promise<PackageDetail | null> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}`,
    );
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as PackageDetail;
  } catch {
    return null;
  }
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

/** Mint a stable, collision-proof id for a package-owned attachment (a local
 *  file the curator adds, e.g. a biên bản PDF). The `attach-` prefix is the
 *  server's signal to create a backing `file` row (see PUT .../files/:fileId),
 *  and keeps it clear of meeting file ids and the reserved `__board__` asset. */
export const newAttachmentId = (): string =>
  `attach-${
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  }`;

/** Upload one package-OWNED attachment (already plaintext local bytes) under an
 *  `attach-…` id, carrying its display name in `x-name`. Mirrors
 *  uploadPackageFile but adds the name header so the server records a usable
 *  `file.name` (the recap list / zip / viewer all read it). */
export const uploadPackageAttachment = async (
  pkgId: string,
  fileId: string,
  bytes: ArrayBuffer,
  contentType: string,
  name: string,
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
        headers: {
          "content-type": contentType || "application/octet-stream",
          // RFC-2047-free: header values must be latin1, so URL-encode the
          // (possibly Unicode) filename and decode it server-side is overkill —
          // the server stores it verbatim and it only feeds a display label /
          // zip entry name. Encode to keep the header transport-safe.
          "x-name": encodeURIComponent(name),
        },
        body: bytes,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Store the exported board PNG as a package asset (so the offline zip ships a
 *  standalone board image alongside the in-recap data URL). Re-uses the same
 *  per-file upload route under the package prefix, keyed by a reserved id. */
export const PACKAGE_BOARD_FILE_ID = "__board__";
export const uploadPackageBoard = async (
  pkgId: string,
  png: ArrayBuffer,
): Promise<boolean> =>
  uploadPackageFile(pkgId, PACKAGE_BOARD_FILE_ID, png, "image/png");

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
export const exportPackageZip = async (pkgId: string): Promise<Blob | null> => {
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

// === Meeting Package MANAGEMENT (0034) ====================================
// Curator-facing management of an existing/shared package. All routes are
// editor-gated server-side (canEditMeeting via the package's meeting). Per
// "revoke != delete": unpublish flips status back to draft, delete is a SOFT
// delete (rows + R2 kept), recipient revoke/restore flips a status flag.

/** A named recipient row of an audience='list' package (for the manage UI).
 *  Revoked recipients stay in the list as the audit trail. */
export type PackageRecipient = {
  email: string;
  status: "active" | "revoked";
  added_at: number;
};

/** Unshare a published package (published -> draft). The audience stops seeing
 *  it; the editor can re-publish later. */
export const unpublishPackage = async (pkgId: string): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/unpublish`,
      { method: "POST" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Soft-delete a package (sets deleted_at server-side; rows + R2 kept for
 *  provenance). It disappears from every list/read but can be restored. */
export const deletePackage = async (pkgId: string): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Restore a soft-deleted package (clears deleted_at). */
export const restorePackage = async (pkgId: string): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/restore`,
      { method: "POST" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** List a package's named recipients (audience='list'), active + revoked, for
 *  the manage UI. Editor-gated; empty on failure. */
export const listPackageRecipients = async (
  pkgId: string,
): Promise<PackageRecipient[]> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(pkgId)}/recipients`,
    );
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { recipients?: PackageRecipient[] };
    return body.recipients ?? [];
  } catch {
    return [];
  }
};

/** Revoke a recipient (flip to status='revoked'; row stays — revoke != delete). */
export const revokeRecipient = async (
  pkgId: string,
  email: string,
): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(
        pkgId,
      )}/recipients/revoke`,
      { method: "POST", headers: json, body: JSON.stringify({ email }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Restore a revoked recipient (flip back to status='active'). */
export const restoreRecipient = async (
  pkgId: string,
  email: string,
): Promise<boolean> => {
  if (!IS_PACKAGES_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/packages/${encodeURIComponent(
        pkgId,
      )}/recipients/restore`,
      { method: "POST", headers: json, body: JSON.stringify({ email }) },
    );
    return res.ok;
  } catch {
    return false;
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

// --- recap board image + chat ---------------------------------------------

/** One persisted chat line, as stored in the E2E `chats/<roomId>/current`
 *  blob (the recap only needs sender + text + timestamp). */
export type RecapChatMessage = { username: string; text: string; ts: number };

/** Decrypt the meeting's chat log (room-key, E2E) into the minimal shape the
 *  recap renders. Fail-soft: returns [] on a missing / undecryptable blob so a
 *  chat hiccup never blocks publishing. */
export const decryptMeetingChat = async (
  roomId: string,
  roomKey: string | null,
): Promise<RecapChatMessage[]> => {
  if (!IS_PACKAGES_CONFIGURED || !roomKey) {
    return [];
  }
  try {
    const history = await loadChatFromStorage<{
      username?: string;
      text?: string;
      ts?: number;
    }>(roomId, roomKey);
    if (!history?.length) {
      return [];
    }
    return history
      .filter((m) => typeof m?.text === "string" && m.text.length > 0)
      .map((m) => ({
        username: m.username || "",
        text: m.text || "",
        ts: typeof m.ts === "number" ? m.ts : 0,
      }));
  } catch {
    return [];
  }
};

/** Headlessly export the whole meeting board (decrypted scene elements +
 *  placed file snapshots) to a PNG. Returns the bytes + a data URL (the recap
 *  embeds the data URL because it renders in a no-network sandboxed iframe).
 *  Caps the longest side so the recap stays a sane size. Fail-soft: returns
 *  null on any decrypt / export failure (recap still publishes without the
 *  board image). */
const BOARD_MAX_SIDE_PX = 2000;
// The live meeting canvas is DARK (app theme defaults to dark; see
// useHandleAppTheme + the PWA theme-color / --mcm-bg). The recap board image
// must look like the dark board users actually saw, not an inverted white
// sheet — so we export on this canvas-dark background with dark-mode element
// rendering. Matches #121212 used for --mcm-bg and the PWA theme-color.
const BOARD_DARK_BG = "#121212";
export const exportMeetingBoardPng = async (
  roomId: string,
  roomKey: string | null,
): Promise<{ bytes: ArrayBuffer; dataUrl: string } | null> => {
  if (!IS_PACKAGES_CONFIGURED || !roomKey) {
    return null;
  }
  try {
    // Decrypt the stored scene (deleted elements already dropped). `null`
    // socket => no version-cache side effects.
    const elements = await loadFromStorage(roomId, roomKey, null);
    if (!elements || !elements.length) {
      return null;
    }
    // Pull the bytes for every image element so placed file-snapshots render.
    const fileIds = elements
      .filter((el) => el.type === "image" && !el.isDeleted)
      .map((el) => (el as InitializedExcalidrawImageElement).fileId)
      .filter((id): id is FileId => Boolean(id));
    let files: BinaryFiles = {};
    if (fileIds.length) {
      const { loadedFiles } = await loadFilesFromStorage(
        `files/rooms/${roomId}`,
        roomKey,
        fileIds,
      );
      files = Object.fromEntries(loadedFiles.map((f) => [f.id, f]));
    }
    const blob = await exportToBlob({
      elements: elements as Parameters<typeof exportToBlob>[0]["elements"],
      files,
      mimeType: "image/png",
      // DARK board background + dark-mode element rendering so the capture
      // matches the dark canvas users saw. Cap the longest side so the recap
      // stays small.
      appState: {
        exportBackground: true,
        exportWithDarkMode: true,
        viewBackgroundColor: BOARD_DARK_BG,
      },
      maxWidthOrHeight: BOARD_MAX_SIDE_PX,
    });
    const bytes = await blob.arrayBuffer();
    // Encode to a base64 data URL (the sandboxed recap iframe can't fetch).
    const u8 = new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < u8.length; i++) {
      binary += String.fromCharCode(u8[i]);
    }
    const dataUrl = `data:image/png;base64,${btoa(binary)}`;
    return { bytes, dataUrl };
  } catch {
    return null;
  }
};

/** Re-export FileId so callers can type the picker selection without reaching
 *  into the element package. */
export type { FileId };
