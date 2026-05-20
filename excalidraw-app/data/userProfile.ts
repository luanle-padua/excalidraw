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

/** Local user's session start timestamp. Captured once when Collab
 *  hydrates and broadcast inside every USER_PROFILE payload so peers
 *  can rank participants by join order. Module-scope variable rather
 *  than an atom because it never changes within a session and
 *  doesn't need to drive React re-renders directly. */
let MY_JOINED_AT: number | null = null;

export const ensureMyJoinedAt = (): number => {
  if (MY_JOINED_AT == null) {
    MY_JOINED_AT = Date.now();
  }
  return MY_JOINED_AT;
};

export const getMyJoinedAt = (): number | null => MY_JOINED_AT;

export const resetMyJoinedAt = (): void => {
  MY_JOINED_AT = null;
};

/** Force MY_JOINED_AT to a sentinel value smaller than any real
 *  timestamp can produce, so we deterministically win every host
 *  election. Wired to the "first-in-room" socket event the room
 *  server emits to whoever is alone when they join — i.e. the
 *  link-sharer. Without this, the host election was based purely on
 *  Date.now() at the moment broadcastUserProfileSnapshot fired,
 *  which made network jitter / browser warm-up timing decide who
 *  was host instead of "who shared the link". */
export const markMeAsFirstInRoom = (): void => {
  // 1, not 0 — keeps `typeof joinedAt === "number"` and
  // `Number.isFinite(joinedAt)` checks honest while still beating any
  // real Date.now() value (epoch starts at 0; today is ~1.7e12).
  MY_JOINED_AT = 1;
};

// -------------------- host-claim persistence --------------------
// Without this, A creates a room, shares the link, B joins, A
// reloads — A's MY_JOINED_AT resets to Date.now() while B keeps the
// earlier value, so B silently becomes host. That breaks the
// "người share link là host" invariant. By writing a per-room claim
// to localStorage at first-in-room time and restoring it on every
// reconnect to the SAME room, the link-sharer keeps host through
// reloads. The claim is per-roomId so it doesn't carry over into a
// different meeting.

const HOST_CLAIM_KEY = "mcm:hostClaim:v1";

type HostClaim = { roomId: string };

const readHostClaim = (): HostClaim | null => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(HOST_CLAIM_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<HostClaim>;
    if (typeof parsed?.roomId !== "string") {
      return null;
    }
    return { roomId: parsed.roomId };
  } catch {
    return null;
  }
};

export const persistHostClaimForRoom = (roomId: string | null): void => {
  if (!roomId || typeof window === "undefined") {
    return;
  }
  try {
    const claim: HostClaim = { roomId };
    window.localStorage.setItem(HOST_CLAIM_KEY, JSON.stringify(claim));
  } catch {
    // best-effort — quota or privacy mode
  }
};

/** If we previously claimed host for THIS roomId, re-apply the
 *  sentinel joinedAt before the first broadcast so reconnects stay
 *  host. Returns true when the claim was restored. */
export const restoreHostClaimForRoom = (roomId: string | null): boolean => {
  if (!roomId) {
    return false;
  }
  const claim = readHostClaim();
  if (!claim || claim.roomId !== roomId) {
    return false;
  }
  MY_JOINED_AT = 1;
  return true;
};

export const clearHostClaim = (): void => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(HOST_CLAIM_KEY);
  } catch {
    // best-effort
  }
};

/** Map of socketId → that peer's reported joinedAt. Populated from the
 *  USER_PROFILE wire payload alongside the profile fields. Kept as a
 *  separate atom (not folded into peerProfilesAtom / UserProfile) so
 *  it doesn't pollute the persisted localStorage profile — joinedAt
 *  is per-SESSION, not per-user. */
export const peerJoinedAtAtom = atom<ReadonlyMap<string, number>>(new Map());

export const upsertPeerJoinedAt = (
  socketId: string,
  joinedAt: number,
): void => {
  const current = appJotaiStore.get(peerJoinedAtAtom);
  if (current.get(socketId) === joinedAt) {
    return;
  }
  const next = new Map(current);
  next.set(socketId, joinedAt);
  appJotaiStore.set(peerJoinedAtAtom, next);
};

export const removePeerJoinedAt = (socketId: string): void => {
  const current = appJotaiStore.get(peerJoinedAtAtom);
  if (!current.has(socketId)) {
    return;
  }
  const next = new Map(current);
  next.delete(socketId);
  appJotaiStore.set(peerJoinedAtAtom, next);
};

/** Socket id of the current MCM "host" — the participant with the
 *  smallest joinedAt across the local user + every peer. Tied
 *  joinedAts (rare — would require ms-identical broadcasts) break by
 *  lexicographic socketId so every peer agrees deterministically.
 *
 *  This is the SINGLE source of truth used by recording, future
 *  host-only controls, and the recording indicator banner. Consumers
 *  compare against their own socket id to decide whether to render
 *  the host-only UI.
 *
 *  Returns null when there's no active room (no peers + no joinedAt
 *  captured yet) so callers can render the inert "Join a room to
 *  enable recording" state. */
export const hostSocketIdAtom = atom<string | null>((get) => {
  const peers = get(peerJoinedAtAtom);
  const mySocketId = get(mySocketIdAtom);
  const myJoinedAt = MY_JOINED_AT;
  type Candidate = { socketId: string; joinedAt: number };
  const candidates: Candidate[] = [];
  for (const [socketId, joinedAt] of peers) {
    candidates.push({ socketId, joinedAt });
  }
  if (mySocketId && myJoinedAt != null) {
    candidates.push({ socketId: mySocketId, joinedAt: myJoinedAt });
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) {
      return a.joinedAt - b.joinedAt;
    }
    return a.socketId < b.socketId ? -1 : 1;
  });
  return candidates[0].socketId;
});

/** Local user's socket id, lifted into a Jotai atom so derived atoms
 *  like hostSocketIdAtom can include the local participant without
 *  needing direct access to the Collab instance. Set by Collab on
 *  connect / disconnect. */
export const mySocketIdAtom = atom<string | null>(null);

export const setMySocketId = (socketId: string | null): void => {
  appJotaiStore.set(mySocketIdAtom, socketId);
};

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
