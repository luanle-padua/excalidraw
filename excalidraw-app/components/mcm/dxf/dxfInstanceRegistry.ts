// Tracks every live <DXFRenderer /> instance so we can enforce the
// hard cap (4 simultaneous WebGL viewers) decided in the DXF plan.
// Going over the cap exhausts Chrome's WebGL context budget (~16
// across the whole page, but conservative reserve for Excalidraw +
// reactions overlay = 4 is the practical ceiling for our use case).
//
// LRU semantics: when a 5th renderer mounts, the registry refuses
// the mount; the renderer falls back to <DXFCapacityPlaceholder />,
// which offers a button to evict the oldest live instance.

import { atom, appJotaiStore } from "../../../app-jotai";

export const DXF_MAX_INSTANCES = 4;

type RegistryEntry = {
  fileId: string;
  /** monotonic — set on (re)mount, used for LRU eviction picks */
  mountedAt: number;
};

// Map of instance UUID → registry entry. We key by instance UUID
// (not fileId) so the same file rendered in multiple modes (e.g.
// inline overlay + split-pane tab) each occupies a slot — they
// each consume a separate WebGL context.
type Registry = Map<string, RegistryEntry>;

export const dxfRegistryAtom = atom<Registry>(new Map());

/** Attempt to claim a slot. Returns true on success, false if at cap. */
export const claimDxfSlot = (instanceId: string, fileId: string): boolean => {
  const current = appJotaiStore.get(dxfRegistryAtom);
  if (current.has(instanceId)) {
    return true; // already claimed (re-mount)
  }
  if (current.size >= DXF_MAX_INSTANCES) {
    return false;
  }
  const next = new Map(current);
  next.set(instanceId, { fileId, mountedAt: Date.now() });
  appJotaiStore.set(dxfRegistryAtom, next);
  return true;
};

/** Release a slot. Safe to call multiple times. */
export const releaseDxfSlot = (instanceId: string): void => {
  const current = appJotaiStore.get(dxfRegistryAtom);
  if (!current.has(instanceId)) {
    return;
  }
  const next = new Map(current);
  next.delete(instanceId);
  appJotaiStore.set(dxfRegistryAtom, next);
};

/** Pick the oldest live instance for eviction. Returns null if empty. */
export const oldestDxfInstance = (): string | null => {
  const current = appJotaiStore.get(dxfRegistryAtom);
  let oldest: { id: string; ts: number } | null = null;
  for (const [id, entry] of current) {
    if (!oldest || entry.mountedAt < oldest.ts) {
      oldest = { id, ts: entry.mountedAt };
    }
  }
  return oldest?.id ?? null;
};

/** Emitter for forced unmount of a specific instance (eviction). The
 *  CADSplitPane / DXFCanvasOverlay subscribe and remove that entry from
 *  their own lists, which unmounts the DXFRenderer and triggers
 *  releaseDxfSlot via its cleanup effect. */
type EvictListener = (instanceId: string) => void;
const evictListeners = new Set<EvictListener>();
export const subscribeDxfEvict = (cb: EvictListener): (() => void) => {
  evictListeners.add(cb);
  return () => evictListeners.delete(cb);
};
export const evictDxfInstance = (instanceId: string): void => {
  for (const cb of evictListeners) {
    cb(instanceId);
  }
};
