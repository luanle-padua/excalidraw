// Tracks every live <IFCRenderer /> instance so we can enforce the
// hard cap on simultaneous WebGL viewers. 3D IFC scenes are much
// heavier than the 2D DXF ones (large merged geometry + DataTextures
// + shadow-free lit material), so we cap at 2 — going over exhausts
// the GPU/context budget and tanks framerate across the whole page.
//
// LRU semantics: when a 3rd renderer mounts, the registry refuses the
// mount; the renderer falls back to a capacity placeholder which can
// evict the oldest live instance.
//
// Mirrors dxfInstanceRegistry — kept structurally identical so the
// overlay / split-pane wiring is the same for both viewers.

import { atom, appJotaiStore } from "../../../app-jotai";

export const IFC_MAX_INSTANCES = 2;

type RegistryEntry = {
  fileId: string;
  /** monotonic — set on (re)mount, used for LRU eviction picks */
  mountedAt: number;
};

// Map of instance UUID → registry entry. We key by instance UUID
// (not fileId) so the same file rendered in multiple modes (e.g.
// inline overlay + split-pane tab) each occupies a slot — they each
// consume a separate WebGL context.
type Registry = Map<string, RegistryEntry>;

export const ifcRegistryAtom = atom<Registry>(new Map());

/** Attempt to claim a slot. Returns true on success, false if at cap. */
export const claimIfcSlot = (instanceId: string, fileId: string): boolean => {
  const current = appJotaiStore.get(ifcRegistryAtom);
  if (current.has(instanceId)) {
    return true; // already claimed (re-mount)
  }
  if (current.size >= IFC_MAX_INSTANCES) {
    return false;
  }
  const next = new Map(current);
  next.set(instanceId, { fileId, mountedAt: Date.now() });
  appJotaiStore.set(ifcRegistryAtom, next);
  return true;
};

/** Release a slot. Safe to call multiple times. */
export const releaseIfcSlot = (instanceId: string): void => {
  const current = appJotaiStore.get(ifcRegistryAtom);
  if (!current.has(instanceId)) {
    return;
  }
  const next = new Map(current);
  next.delete(instanceId);
  appJotaiStore.set(ifcRegistryAtom, next);
};

/** Pick the oldest live instance for eviction. Returns null if empty. */
export const oldestIfcInstance = (): string | null => {
  const current = appJotaiStore.get(ifcRegistryAtom);
  let oldest: { id: string; ts: number } | null = null;
  for (const [id, entry] of current) {
    if (!oldest || entry.mountedAt < oldest.ts) {
      oldest = { id, ts: entry.mountedAt };
    }
  }
  return oldest?.id ?? null;
};

/** Emitter for forced unmount of a specific instance (eviction). The
 *  overlay / split-pane subscribe and remove that entry from their own
 *  lists, which unmounts the IFCRenderer and triggers releaseIfcSlot
 *  via its cleanup effect. */
type EvictListener = (instanceId: string) => void;
const evictListeners = new Set<EvictListener>();
export const subscribeIfcEvict = (cb: EvictListener): (() => void) => {
  evictListeners.add(cb);
  return () => evictListeners.delete(cb);
};
export const evictIfcInstance = (instanceId: string): void => {
  for (const cb of evictListeners) {
    cb(instanceId);
  }
};
