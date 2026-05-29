// IFC 3D View pane state — per-user (not synced). Docks vertically on
// the right of the canvas area and renders a full-control IFCRenderer
// for each open IFC model. Each tab is keyed by the library file id, so
// opening the same model twice from different anchors reuses the tab.
// Mirrors cadViewState.ts.

import { atom, appJotaiStore } from "../app-jotai";

const LS_KEY = "mcm:ifcViewState";

export type IfcViewState = {
  /** Pane visible or hidden. */
  open: boolean;
  /** Order of open tabs (library IFC model file ids). */
  openFileIds: string[];
  /** Currently active tab (null if pane is closed). */
  activeFileId: string | null;
  /** Pane width in viewport px. */
  width: number;
};

const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 320;
const MAX_WIDTH_FRAC = 0.7;

export const getMaxIfcViewWidth = (): number => {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  return Math.floor(vw * MAX_WIDTH_FRAC);
};

export const getMinIfcViewWidth = (): number => MIN_WIDTH;

const guessInitial = (): IfcViewState => {
  const defaults: IfcViewState = {
    open: false,
    openFileIds: [],
    activeFileId: null,
    width: DEFAULT_WIDTH,
  };
  if (typeof window === "undefined") {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<IfcViewState>;
    return {
      open: !!parsed.open,
      openFileIds: Array.isArray(parsed.openFileIds)
        ? parsed.openFileIds.filter((x): x is string => typeof x === "string")
        : [],
      activeFileId:
        typeof parsed.activeFileId === "string" ? parsed.activeFileId : null,
      width:
        typeof parsed.width === "number"
          ? Math.max(MIN_WIDTH, parsed.width)
          : DEFAULT_WIDTH,
    };
  } catch {
    return defaults;
  }
};

export const ifcViewStateAtom = atom<IfcViewState>(guessInitial());

const persist = (state: IfcViewState) => {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
};

const update = (mut: (s: IfcViewState) => IfcViewState) => {
  const current = appJotaiStore.get(ifcViewStateAtom);
  const next = mut(current);
  if (next === current) {
    return;
  }
  appJotaiStore.set(ifcViewStateAtom, next);
  persist(next);
};

/** Open an IFC model in the 3D view. Idempotent — opening an
 *  already-open file just switches to its tab. */
export const openFileInIfcView = (fileId: string): void => {
  update((s) => {
    const alreadyOpen = s.openFileIds.includes(fileId);
    return {
      ...s,
      open: true,
      openFileIds: alreadyOpen ? s.openFileIds : [...s.openFileIds, fileId],
      activeFileId: fileId,
    };
  });
};

export const closeIfcFileTab = (fileId: string): void => {
  update((s) => {
    const next = s.openFileIds.filter((id) => id !== fileId);
    if (next.length === s.openFileIds.length) {
      return s;
    }
    let activeId = s.activeFileId;
    if (activeId === fileId) {
      const closedIdx = s.openFileIds.indexOf(fileId);
      activeId = next[closedIdx] ?? next[closedIdx - 1] ?? next[0] ?? null;
    }
    return {
      ...s,
      openFileIds: next,
      activeFileId: activeId,
      open: next.length > 0 ? s.open : false,
    };
  });
};

export const setActiveIfcTab = (fileId: string): void => {
  update((s) =>
    s.activeFileId === fileId ? s : { ...s, activeFileId: fileId },
  );
};

export const closeIfcViewPane = (): void => {
  update((s) => ({ ...s, open: false }));
};

export const toggleIfcViewPane = (): void => {
  update((s) => ({ ...s, open: !s.open }));
};

export const setIfcViewWidth = (width: number): void => {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const clamped = Math.max(
    MIN_WIDTH,
    Math.min(Math.floor(vw * MAX_WIDTH_FRAC), width),
  );
  update((s) => (s.width === clamped ? s : { ...s, width: clamped }));
};
