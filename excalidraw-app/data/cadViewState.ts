// CAD View pane state — per-user (not synced). The pane docks
// vertically on the right side of the canvas area and renders a
// full-control DxfViewer for each open DXF library file. Each tab
// is keyed by the library file id (NOT a per-anchor instance), so
// opening the same DXF twice from different anchors reuses the
// existing tab.

import { atom, appJotaiStore } from "../app-jotai";

const LS_KEY = "mcm:cadViewState";

export type CADViewState = {
  /** Pane visible or hidden. */
  open: boolean;
  /** Order of open tabs (library DXF file ids). */
  openFileIds: string[];
  /** Currently active tab (null if pane is closed). */
  activeFileId: string | null;
  /** Pane width in viewport px. */
  width: number;
};

const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 280;
const MAX_WIDTH_FRAC = 0.7;

const guessInitial = (): CADViewState => {
  const defaults: CADViewState = {
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
    const parsed = JSON.parse(raw) as Partial<CADViewState>;
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

export const cadViewStateAtom = atom<CADViewState>(guessInitial());

const persist = (state: CADViewState) => {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
};

const update = (mut: (s: CADViewState) => CADViewState) => {
  const current = appJotaiStore.get(cadViewStateAtom);
  const next = mut(current);
  if (next === current) {
    return;
  }
  appJotaiStore.set(cadViewStateAtom, next);
  persist(next);
};

/** Open a DXF in the CAD view. Idempotent — opening an already-open
 *  file just switches to its tab. */
export const openFileInCadView = (fileId: string): void => {
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

export const closeCadFileTab = (fileId: string): void => {
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

export const setActiveCadTab = (fileId: string): void => {
  update((s) =>
    s.activeFileId === fileId ? s : { ...s, activeFileId: fileId },
  );
};

export const closeCadViewPane = (): void => {
  update((s) => ({ ...s, open: false }));
};

export const toggleCadViewPane = (): void => {
  update((s) => ({ ...s, open: !s.open }));
};

export const setCadViewWidth = (width: number): void => {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const clamped = Math.max(
    MIN_WIDTH,
    Math.min(Math.floor(vw * MAX_WIDTH_FRAC), width),
  );
  update((s) => (s.width === clamped ? s : { ...s, width: clamped }));
};
