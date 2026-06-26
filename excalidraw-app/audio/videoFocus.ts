// ORTHOGONAL video-focus state — the layer that answers "who is the ONE
// focused/presenter person right now?" and the two presentation surfaces that
// hang off it (gallery speaker sub-mode, floating presenter PiP).
//
// Deliberately NOT folded into the VideoLayout enum (audio/videoLayout.ts):
// VideoLayout picks the mutually-exclusive SURFACE (minimal / filmstrip /
// gallery), while everything here is an overlay/behaviour that composes WITH
// any surface. Keeping them in separate modules keeps each union honest.
//
// The focused person is a PURE DERIVATION (resolveFocusedId) — there is no new
// persistent identity. Precedence, highest wins:
//   pin > screen-sharer > active-speaker > host > first tile
// Reused by gallery-speaker, the filmstrip ring and the floating PiP so all
// three always agree on the same socketId.

import { atom, appJotaiStore } from "../app-jotai";

// ---------------------------------------------------------------------------
// 1. PIN — explicit, local-only, ephemeral manual focus override.
// ---------------------------------------------------------------------------
// A pin is meaningful ONLY inside the running meeting (like activeSpeaker), so
// it is NOT persisted — a reload clears it. It is also per-viewer (each person
// pins for themselves, mirroring userToFollow / videoLayout being per-user),
// so it is NOT synced over the socket. Clicking any tile toggles it.
export const pinnedSocketIdAtom = atom<string | null>(null);

/** Imperative toggle for non-React callers / event handlers: click an unpinned
 *  id → pin it; click the already-pinned id → unpin (fall back down the
 *  precedence chain). */
export const togglePinnedSocketId = (id: string): void => {
  appJotaiStore.set(pinnedSocketIdAtom, (prev) => (prev === id ? null : id));
};

// ---------------------------------------------------------------------------
// 2. focusedSocketId — a PURE helper, not a stored atom.
// ---------------------------------------------------------------------------
// Computed where the tiles already exist (ParticipantsBar) and passed down, so
// there is zero duplicated presence logic and every surface resolves the same
// person. A pin only counts when that tile still exists (the pinned peer may
// have left) — otherwise it falls through.

/** Minimal shape the resolver needs from a Tile — kept structural so callers
 *  can pass their full Tile[] without an import cycle. */
export type FocusTile = { id: string; isHost?: boolean };

export type FocusInputs = {
  /** Manual pin (pinnedSocketIdAtom). Wins everything when its tile exists. */
  pinned: string | null;
  /** socketId of the Daily active speaker (activeSpeakerAtom). */
  activeSpeaker: string | null;
  /** socketId of the current screen-sharer (first key of screenShareStateAtom),
   *  or null. Auto-focuses the presenter's FACE when no pin is set. */
  sharerId: string | null;
  /** socketId of the elected host (hostSocketIdAtom), if any. */
  hostId: string | null;
};

/** Resolve the single focused socketId with strict precedence:
 *  pin (if its tile still exists) > screen-sharer > active-speaker > host >
 *  first tile. Returns null only when there are no tiles at all. */
export const resolveFocusedId = (
  tiles: readonly FocusTile[],
  { pinned, activeSpeaker, sharerId, hostId }: FocusInputs,
): string | null => {
  if (tiles.length === 0) {
    return null;
  }
  const has = (id: string | null): id is string =>
    !!id && tiles.some((tile) => tile.id === id);
  // Pin is the always-authoritative override (the user deliberately chose a
  // face) — but only while that person is still in the room.
  if (has(pinned)) {
    return pinned;
  }
  // No pin → the screen-sharer's camera tracks automatically so the "presenter"
  // face follows whoever is presenting, without forcing a pin.
  if (has(sharerId)) {
    return sharerId;
  }
  if (has(activeSpeaker)) {
    return activeSpeaker;
  }
  if (has(hostId)) {
    return hostId;
  }
  return tiles[0].id;
};

// ---------------------------------------------------------------------------
// 3. gallerySubModeAtom — grid ↔ speaker ↔ screen split inside the gallery.
// ---------------------------------------------------------------------------
// A per-user VIEW preference (like videoLayout) so it survives reload. Only
// meaningful while videoLayout === "gallery".
//
// "screen" is the Zoom-style "together" layout: the shared SCREEN is the big
// stage and the cameras ride a filmstrip below it (structurally the speaker
// sub-mode with the screen, not a face, as the stage). It is CONTEXTUAL — only
// meaningful while a screen is actually being shared — so unlike grid/speaker
// it is NOT persisted (a reload with no active share would land you on a blank
// "together" view). It is selected at runtime (auto when a share starts, or by
// the user clicking the Screen toggle) and falls back via resolveGallerySubMode.
export type GallerySubMode = "grid" | "speaker" | "screen";

/** The persisted, share-independent preference. "screen" is excluded: it only
 *  makes sense alongside a live share, so we never write it to localStorage. */
export type StickyGallerySubMode = "grid" | "speaker";

const SUBMODE_LS_KEY = "mcm:gallerySubMode";
const DEFAULT_SUBMODE: StickyGallerySubMode = "grid";

const isStickySubMode = (v: unknown): v is StickyGallerySubMode =>
  v === "grid" || v === "speaker";

const guessSubMode = (): GallerySubMode => {
  if (typeof window === "undefined") {
    return DEFAULT_SUBMODE;
  }
  try {
    const raw = window.localStorage.getItem(SUBMODE_LS_KEY);
    return isStickySubMode(raw) ? raw : DEFAULT_SUBMODE;
  } catch {
    return DEFAULT_SUBMODE;
  }
};

const subModeBase = atom<GallerySubMode>(guessSubMode());

export const gallerySubModeAtom = atom<GallerySubMode, [GallerySubMode], void>(
  (get) => get(subModeBase),
  (_get, set, next) => {
    set(subModeBase, next);
    try {
      // Persist only the sticky (share-independent) preference; never store the
      // contextual "screen" together-mode (see type docs above).
      if (isStickySubMode(next)) {
        window.localStorage.setItem(SUBMODE_LS_KEY, next);
      }
    } catch {
      // best-effort
    }
  },
);

/** Effective sub-mode to RENDER, given the raw preference and whether a screen
 *  stream is actually present. "screen" (together) is only honoured while a
 *  share exists; otherwise it degrades to grid so the gallery is never stuck on
 *  an empty stage after a share ends. grid/speaker pass through untouched. */
export const resolveGallerySubMode = (
  subMode: GallerySubMode,
  hasScreen: boolean,
): GallerySubMode =>
  subMode === "screen" && !hasScreen ? DEFAULT_SUBMODE : subMode;

// ---------------------------------------------------------------------------
// 3b. galleryOwnsScreenAtom — "one stream, one mount" coordination flag.
// ---------------------------------------------------------------------------
// The gallery flips this TRUE while it is actively rendering the shared screen
// as its "together"-layout stage. MeetingShell reads it to SUPPRESS the
// redundant floating ScreenSharePane (otherwise the same stream would mount
// twice — once in the gallery stage, once in the corner pane). When the gallery
// is closed or not on the together layout it flips back to false and the
// floating pane returns for the minimal/filmstrip surfaces. Reset on the
// gallery's unmount so a stale `true` never wedges the pane hidden.
export const galleryOwnsScreenAtom = atom<boolean>(false);

// ---------------------------------------------------------------------------
// 4. Floating presenter — an explicit opt-in overlay over the canvas.
// ---------------------------------------------------------------------------
// On/off is an explicit per-session action ("I want to keep watching the
// presenter while I work on the canvas") so it is NOT persisted — defaults off.
export const floatingPresenterAtom = atom<boolean>(false);

// The snap corner IS a stable spatial preference → persisted.
export type FloatingCorner = "tl" | "tr" | "bl" | "br";

const CORNER_LS_KEY = "mcm:floatingPresenterCorner";
const DEFAULT_CORNER: FloatingCorner = "br";

const isCorner = (v: unknown): v is FloatingCorner =>
  v === "tl" || v === "tr" || v === "bl" || v === "br";

const guessCorner = (): FloatingCorner => {
  if (typeof window === "undefined") {
    return DEFAULT_CORNER;
  }
  try {
    const raw = window.localStorage.getItem(CORNER_LS_KEY);
    return isCorner(raw) ? raw : DEFAULT_CORNER;
  } catch {
    return DEFAULT_CORNER;
  }
};

const cornerBase = atom<FloatingCorner>(guessCorner());

export const floatingPresenterCornerAtom = atom<
  FloatingCorner,
  [FloatingCorner],
  void
>(
  (get) => get(cornerBase),
  (_get, set, next) => {
    set(cornerBase, next);
    try {
      window.localStorage.setItem(CORNER_LS_KEY, next);
    } catch {
      // best-effort
    }
  },
);
