// Durable meeting persistence — Cloudflare-backed (R2 blobs + D1 metadata)
// via the `worker/` Worker. Replaces the disabled Firebase path; the
// public surface mirrors the old firebase.ts so call sites (and the
// collab test) are unchanged — `firebase.ts` is now a thin shim that
// re-exports these under the legacy names.
//
// E2E is preserved for save & reopen via the room link: the scene is
// encrypted client-side with the room key (which lives in the URL hash,
// never sent to the server) before upload; the server stores only
// ciphertext. (The managed-key path needed for the "open any meeting in
// a project folder" UX is added separately, with the meeting registry.)
//
// Configure with VITE_APP_STORAGE_URL (e.g. http://localhost:8787 for
// local `wrangler dev`, or the deployed workers.dev URL). When unset,
// every function no-ops so the app still runs without persistence.

import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

const STORAGE_URL = (import.meta.env.VITE_APP_STORAGE_URL || "").replace(
  /\/$/,
  "",
);
export const IS_STORAGE_CONFIGURED = Boolean(STORAGE_URL);

// Copy any Uint8Array (possibly a view with an offset / shared buffer)
// into a fresh standalone ArrayBuffer — a clean `BodyInit` for fetch,
// sidestepping TS's strict typed-array generics.
const toArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
};

// --- scene encryption (identical to the former firebase path) ------------

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decoded = new TextDecoder("utf-8").decode(new Uint8Array(decrypted));
  return JSON.parse(decoded);
};

// Scene blob wire format (single R2 object):
//   [u32 BE sceneVersion][u8 ivLength][iv bytes][ciphertext bytes]
const packScene = (
  sceneVersion: number,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array => {
  const out = new Uint8Array(5 + iv.length + ciphertext.length);
  new DataView(out.buffer).setUint32(0, sceneVersion, false);
  out[4] = iv.length;
  out.set(iv, 5);
  out.set(ciphertext, 5 + iv.length);
  return out;
};

const unpackScene = (
  buffer: ArrayBuffer,
): { iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> } => {
  const u8 = new Uint8Array(buffer);
  const ivLen = u8[4];
  return { iv: u8.slice(5, 5 + ivLen), ciphertext: u8.slice(5 + ivLen) };
};

// Per-socket version cache so we don't re-PUT an unchanged scene.
class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => SceneVersionCache.cache.set(socket, getSceneVersion(elements));
}

export const isSavedToStorage = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (!IS_STORAGE_CONFIGURED) {
    // pretend it's saved so the app doesn't keep retrying / block unload
    return true;
  }
  if (portal.socket && portal.roomId && portal.roomKey) {
    return SceneVersionCache.get(portal.socket) === getSceneVersion(elements);
  }
  return true;
};

// GET + decrypt the currently-stored scene (no side effects). 404 / empty
// → null. Throws on other HTTP errors.
const fetchStoredElements = async (
  roomId: string,
  roomKey: string,
  // load → drop deleted (clean canvas); reconcile-on-save → keep tombstones
  // so deletions still win against an older stored element.
  deleteInvisibleElements = false,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const res = await fetch(
    `${STORAGE_URL}/v1/scenes/${encodeURIComponent(roomId)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`load scene failed: ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) {
    return null;
  }
  const { iv, ciphertext } = unpackScene(buffer);
  return getSyncableElements(
    restoreElements(await decryptElements(iv, ciphertext, roomKey), null, {
      deleteInvisibleElements,
    }),
  );
};

export const saveToStorage = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
): Promise<RemoteExcalidrawElement[] | null> => {
  if (!IS_STORAGE_CONFIGURED) {
    return null;
  }
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToStorage(portal, elements)) {
    return null;
  }

  // CRITICAL: reconcile with the currently-stored scene before writing, so a
  // transient/partial local scene — e.g. right after reopen + resetScene,
  // before loadFromStorage finishes — can NEVER overwrite good stored
  // content with an empty/older one. (Mirrors the old Firebase transaction;
  // dropping it caused real data loss.)
  let toStore: readonly SyncableExcalidrawElement[] = elements;
  try {
    const stored = await fetchStoredElements(roomId, roomKey);
    if (stored && stored.length) {
      toStore = getSyncableElements(
        reconcileElements(
          elements,
          stored as readonly OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }
  } catch {
    // Couldn't read the stored scene — fall back to writing local, but
    // never write a completely empty scene (the data-loss case).
    if (elements.length === 0) {
      return null;
    }
  }

  // A truly empty scene only comes from a reset/init (a user-cleared canvas
  // keeps deletion tombstones), so refuse to persist it.
  if (toStore.length === 0) {
    return null;
  }

  const { ciphertext, iv } = await encryptElements(roomKey, toStore);
  const blob = packScene(getSceneVersion(toStore), iv, new Uint8Array(ciphertext));
  const res = await fetch(
    `${STORAGE_URL}/v1/scenes/${encodeURIComponent(roomId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: toArrayBuffer(blob),
    },
  );
  if (!res.ok) {
    throw new Error(`saveToStorage failed: ${res.status}`);
  }
  SceneVersionCache.set(socket, toStore);
  // Only hand the scene back to Collab when reconcile actually RECOVERED
  // content that wasn't in the local scene. In the common case (local ===
  // stored) returning it would trigger a needless handleRemoteSceneUpdate
  // → image re-load on EVERY save (404 noise + lag for files not yet in
  // storage). Compare versions to detect a real recovery.
  if (getSceneVersion(toStore) === getSceneVersion(elements)) {
    return null;
  }
  return toBrandedType<RemoteExcalidrawElement[]>(
    toStore as unknown as RemoteExcalidrawElement[],
  );
};

export const loadFromStorage = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  if (!IS_STORAGE_CONFIGURED) {
    return null;
  }
  const elements = await fetchStoredElements(roomId, roomKey, true);
  if (elements && socket) {
    SceneVersionCache.set(socket, elements);
  }
  return elements;
};

// --- library files --------------------------------------------------------
// `buffer` is already compressed + encrypted upstream (compressData with
// the room key); we just move opaque bytes, and decompress on the way back.

const roomIdFromPrefix = (prefix: string): string =>
  prefix.replace(/\/$/, "").split("/").pop() || prefix;

export const saveFilesToStorage = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];
  if (!IS_STORAGE_CONFIGURED) {
    return { savedFiles, erroredFiles };
  }
  const roomId = roomIdFromPrefix(prefix);
  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const res = await fetch(
          `${STORAGE_URL}/v1/files/${encodeURIComponent(
            roomId,
          )}/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: toArrayBuffer(buffer),
          },
        );
        if (!res.ok) {
          throw new Error(String(res.status));
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );
  return { savedFiles, erroredFiles };
};

export const loadFilesFromStorage = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  if (!IS_STORAGE_CONFIGURED) {
    return { loadedFiles, erroredFiles };
  }
  const roomId = roomIdFromPrefix(prefix);

  // Fetch one file, retrying ONLY transient failures — a network error
  // (worker mid-restart / connection refused) or a 5xx — with short
  // backoff. A genuine 404 (the object isn't in R2) is NOT retried: it's
  // terminal, so we don't waste time on files that legitimately live only
  // on a peer. This rescues the common "image errored because the worker
  // was briefly down" case without slowing the truly-missing path.
  const fetchFileWithRetry = async (id: FileId): Promise<Response | null> => {
    const url = `${STORAGE_URL}/v1/files/${encodeURIComponent(
      roomId,
    )}/${encodeURIComponent(id)}`;
    const backoffsMs = [250, 750];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status >= 500 && attempt < backoffsMs.length) {
          await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
          continue;
        }
        return res;
      } catch (error) {
        if (attempt < backoffsMs.length) {
          await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
          continue;
        }
        throw error;
      }
    }
  };

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const res = await fetchFileWithRetry(id);
        if (res && res.status < 400) {
          const arrayBuffer = await res.arrayBuffer();
          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            { decryptionKey },
          );
          const dataURL = new TextDecoder().decode(data) as DataURL;
          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );
  return { loadedFiles, erroredFiles };
};
