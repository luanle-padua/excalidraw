import { get as idbGet, set as idbSet } from "idb-keyval";

import { atom, appJotaiStore } from "../app-jotai";

export type MeetingFile = {
  /** matches Excalidraw FileId so we can reuse the canvas's file map */
  id: string;
  name: string;
  ts: number;
  author: string;
  mimeType: string;
  /** data: URL with the file content; small files only — large files should
   *  be moved to a backend later */
  dataURL: string;
  /** for images */
  width?: number;
  height?: number;
  /** username of the participant that locked this file. When set, only the
   *  locker (or the original author) can unlock or delete it. */
  lockedBy?: string | null;
};

const STORAGE_PREFIX = "meeting-canvas:files:";
const DELETED_PREFIX = "meeting-canvas:deleted:";
const storageKey = (roomId: string | null) =>
  `${STORAGE_PREFIX}${roomId ?? "_local"}`;
const deletedKey = (roomId: string | null) =>
  `${DELETED_PREFIX}${roomId ?? "_local"}`;

export const meetingFilesAtom = atom<MeetingFile[]>([]);

/** Tracks fileIds we have already processed (locally added, received from a
 *  peer, or auto-detected from the canvas) so the bidirectional sync between
 *  Excalidraw onChange events and socket broadcasts doesn't loop. Once a
 *  file is here, it is *never* re-added by auto-detect — including after
 *  explicit deletion (which is the whole point: deleted files must not come
 *  back via onChange while their binary still lingers in the scene's file
 *  map). */
const seenFileIds = new Set<string>();
/** Subset of seenFileIds that the user has explicitly deleted. Persisted so
 *  the deletion survives reloads. */
const deletedFileIds = new Set<string>();

export const isFileSeen = (id: string) => seenFileIds.has(id);
export const markFileSeen = (id: string) => seenFileIds.add(id);
export const unmarkFileSeen = (id: string) => seenFileIds.delete(id);
export const resetSeenFiles = () => {
  seenFileIds.clear();
  deletedFileIds.clear();
};

const persistDeleted = async (roomId: string | null) => {
  try {
    await idbSet(deletedKey(roomId), Array.from(deletedFileIds));
  } catch (error: any) {
    console.error("[meetingLibrary] failed to persist deleted set", error);
  }
};

export const hydrateMeetingFiles = async (roomId: string | null) => {
  resetSeenFiles();
  try {
    const [stored, deleted] = await Promise.all([
      idbGet(storageKey(roomId)) as Promise<MeetingFile[] | undefined>,
      idbGet(deletedKey(roomId)) as Promise<string[] | undefined>,
    ]);
    const items = stored ?? [];
    for (const f of items) {
      seenFileIds.add(f.id);
    }
    for (const id of deleted ?? []) {
      seenFileIds.add(id);
      deletedFileIds.add(id);
    }
    appJotaiStore.set(meetingFilesAtom, items);
  } catch (error: any) {
    console.error("[meetingLibrary] failed to hydrate", error);
    appJotaiStore.set(meetingFilesAtom, []);
  }
};

const persist = async (roomId: string | null, items: MeetingFile[]) => {
  try {
    await idbSet(storageKey(roomId), items);
  } catch (error: any) {
    console.error("[meetingLibrary] failed to persist", error);
  }
};

/** Quick fingerprint for content-based de-duplication. Comparing full
 *  multi-megabyte dataURLs on every upsert is too slow, but length plus the
 *  first and last 64 chars is enough to distinguish real images. */
const fingerprintOf = (dataURL: string) =>
  `${dataURL.length}:${dataURL.slice(0, 64)}:${dataURL.slice(-64)}`;

/** Add or update a file by id (idempotent). Marks the file as seen so
 *  follow-up onChange events for the same id don't re-trigger insertion. */
export const upsertMeetingFile = (roomId: string | null, file: MeetingFile) => {
  // Refuse to resurrect explicitly-deleted files even if a stale broadcast
  // from a peer that hasn't seen the deletion yet tries to push it back.
  if (deletedFileIds.has(file.id)) {
    return false;
  }
  const current = appJotaiStore.get(meetingFilesAtom);
  // dedup by id (most common case — Excalidraw onChange re-firing for a
  // file we just added)
  if (current.some((f) => f.id === file.id)) {
    seenFileIds.add(file.id);
    return false;
  }
  // dedup by content. If two ingestion paths happen to mint different ids
  // for the same image (UUID from library upload vs Excalidraw's
  // hash-based id for paste-on-canvas, or a peer broadcast racing a local
  // auto-detect), this catches the second occurrence and aliases the
  // new id to the existing entry's id so future references resolve.
  const fp = fingerprintOf(file.dataURL);
  const dup = current.find((f) => fingerprintOf(f.dataURL) === fp);
  if (dup) {
    seenFileIds.add(file.id);
    return false;
  }
  seenFileIds.add(file.id);
  const next = [file, ...current];
  appJotaiStore.set(meetingFilesAtom, next);
  void persist(roomId, next);
  return true;
};

export const removeMeetingFile = (roomId: string | null, fileId: string) => {
  const current = appJotaiStore.get(meetingFilesAtom);
  if (!current.some((f) => f.id === fileId)) {
    return false;
  }
  const next = current.filter((f) => f.id !== fileId);
  appJotaiStore.set(meetingFilesAtom, next);
  // Keep the id in seenFileIds AND mark as explicitly deleted so neither the
  // auto-detect onChange (the file may still be in scene's files map) nor a
  // later remote LIBRARY_FILE broadcast can resurrect this entry.
  deletedFileIds.add(fileId);
  void persist(roomId, next);
  void persistDeleted(roomId);
  return true;
};

export const setMeetingFileLock = (
  roomId: string | null,
  fileId: string,
  lockedBy: string | null,
) => {
  const current = appJotaiStore.get(meetingFilesAtom);
  let changed = false;
  const next = current.map((f) => {
    if (f.id !== fileId) {
      return f;
    }
    if ((f.lockedBy ?? null) === lockedBy) {
      return f;
    }
    changed = true;
    return { ...f, lockedBy };
  });
  if (!changed) {
    return false;
  }
  appJotaiStore.set(meetingFilesAtom, next);
  void persist(roomId, next);
  return true;
};

/** Permission check: a file can be deleted by anyone if it is unlocked, or
 *  by its locker / original author when locked. */
export const canDeleteFile = (file: MeetingFile, username: string): boolean => {
  if (!file.lockedBy) {
    return true;
  }
  return file.lockedBy === username || file.author === username;
};

/** Permission check: only the locker or the original author may unlock. */
export const canUnlockFile = (file: MeetingFile, username: string): boolean => {
  if (!file.lockedBy) {
    return false;
  }
  return file.lockedBy === username || file.author === username;
};

/** Probe an image dataURL to read intrinsic width/height. */
export const probeImageDimensions = (
  dataURL: string,
): Promise<{ width: number; height: number } | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
