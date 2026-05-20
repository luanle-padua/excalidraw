// Lightweight per-user profile shared with peers — username + an
// optional company line + an optional avatar (either a built-in
// library image or a user-uploaded data URL). Lives in localStorage
// (so it survives reloads) and is broadcast over the room socket so
// every participant's avatar tile carries the same info.
//
// The Excalidraw library has its own username field on Collaborator,
// but it doesn't know about company / custom avatar, so we layer
// these on top via a separate WS subtype (USER_PROFILE) and a Jotai
// atom keyed by socketId.

import { atom, appJotaiStore } from "../app-jotai";

const STORAGE_KEY = "mcm:userProfile:v1";

/** Library avatars live in `public/decorations/avatars/NN.png`. We
 *  reference them by their bare filename (e.g. `"42.png"`) so the
 *  stored profile + broadcast payload stay small — peers resolve the
 *  filename against the same public URL. Files 01–105 are the curated
 *  set; the three free-form Gemini/UUID names in the same folder are
 *  intentionally excluded so the gallery stays predictable. */
export const AVATAR_LIBRARY: readonly string[] = Array.from(
  { length: 105 },
  (_, i) => `${String(i + 1).padStart(2, "0")}.png`,
);

/** Resolve a stored avatar value into a URL that an <img> can load.
 *  - "lib:NN.png" → /decorations/avatars/NN.png (built-in gallery)
 *  - "data:image/…" → the data URL itself (user-uploaded)
 *  - null / unrecognised → null (caller falls back to default). */
export const resolveAvatarUrl = (
  avatar: string | null | undefined,
): string | null => {
  if (!avatar) {
    return null;
  }
  if (avatar.startsWith("data:")) {
    return avatar;
  }
  if (avatar.startsWith("lib:")) {
    return `/decorations/avatars/${avatar.slice(4)}`;
  }
  return null;
};

/** Like `resolveAvatarUrl` but ALWAYS returns a usable URL. When the
 *  user hasn't picked an avatar yet (or hasn't set up their profile
 *  at all), we deterministically map a library image from
 *  `fallbackKey` (socketId, username, etc) — that way every avatar
 *  surface in the app (chat, transcript, participant tile, on-canvas
 *  cursor) shows a real "character image" instead of an unstyled
 *  unicode emoji, with the same key resolving to the same picture
 *  everywhere. */
export const resolveAvatarUrlWithDefault = (
  avatar: string | null | undefined,
  fallbackKey: string,
): string => {
  const direct = resolveAvatarUrl(avatar);
  if (direct) {
    return direct;
  }
  let h = 0;
  for (let i = 0; i < fallbackKey.length; i++) {
    h = (h * 31 + fallbackKey.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % AVATAR_LIBRARY.length;
  return `/decorations/avatars/${AVATAR_LIBRARY[idx]}`;
};

export type UserProfile = {
  username: string;
  company?: string;
  /** Either `"lib:NN.png"` (library) or a `data:image/...` URL
   *  (user-uploaded). Absent → tile falls back to the emoji avatar. */
  avatar?: string;
};

/** Local user's own profile, mirrored from localStorage on app boot
 *  and updated when the user edits it via the profile modal. The
 *  collab layer subscribes to this atom and rebroadcasts the new
 *  payload to peers whenever it changes. */
export const userProfileAtom = atom<UserProfile | null>(null);

/** Map of socketId → peer profile, populated as USER_PROFILE socket
 *  messages arrive. ParticipantsBar reads from this for company /
 *  avatar; everyone else stays untouched. The local user's tile
 *  reads `userProfileAtom` directly to avoid waiting for our own
 *  broadcast to round-trip. */
export const peerProfilesAtom = atom<ReadonlyMap<string, UserProfile>>(
  new Map(),
);

/** Load the saved profile (or null if the user has never set one).
 *  Called once during Collab init so the local atom reflects the
 *  last-known values before any peers come online. */
export const importUserProfileFromLocalStorage = (): UserProfile | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed?.username !== "string") {
      return null;
    }
    return {
      username: parsed.username,
      company: typeof parsed.company === "string" ? parsed.company : undefined,
      avatar: typeof parsed.avatar === "string" ? parsed.avatar : undefined,
    };
  } catch (err) {
    console.warn("[userProfile] failed to import", err);
    return null;
  }
};

/** Persist the profile to localStorage AND update the atom. Returns
 *  the saved profile so callers can pipe it straight into a collab
 *  broadcast. */
export const saveUserProfile = (profile: UserProfile): UserProfile => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.warn("[userProfile] failed to persist", err);
  }
  appJotaiStore.set(userProfileAtom, profile);
  return profile;
};

/** Merge an incoming peer profile into the peerProfilesAtom. Called
 *  from the WS handler when a USER_PROFILE message arrives. */
export const upsertPeerProfile = (
  socketId: string,
  profile: UserProfile,
): void => {
  const current = appJotaiStore.get(peerProfilesAtom);
  const existing = current.get(socketId);
  if (
    existing &&
    existing.username === profile.username &&
    existing.company === profile.company &&
    existing.avatar === profile.avatar
  ) {
    return;
  }
  const next = new Map(current);
  next.set(socketId, profile);
  appJotaiStore.set(peerProfilesAtom, next);
};

/** Drop a peer's profile when they leave the room so the avatar tile
 *  doesn't keep their company/avatar around indefinitely. */
export const removePeerProfile = (socketId: string): void => {
  const current = appJotaiStore.get(peerProfilesAtom);
  if (!current.has(socketId)) {
    return;
  }
  const next = new Map(current);
  next.delete(socketId);
  appJotaiStore.set(peerProfilesAtom, next);
};
