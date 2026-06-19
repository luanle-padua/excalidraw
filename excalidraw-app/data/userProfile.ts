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

import { fetchWithAuth } from "./fetchWithAuth";
import { isInternalEmail } from "./session";
import { supabase } from "./supabaseClient";

const STORAGE_KEY = "mcm:userProfile:v1";

/** Base URL of the mcm-storage Worker that serves uploaded avatars
 *  (`GET /v1/me/avatar/:key`) and accepts uploads (`PUT /v1/me/avatar`).
 *  Mirrors the resolution used in admin.ts / session.ts: empty string in
 *  dev-tunnel mode (same-origin) and the configured Worker origin otherwise.
 *  Kept module-local so the avatar resolver can build absolute serve URLs
 *  without every call site re-deriving the base. */
const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

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

/** THE single avatar resolver. Every avatar surface in the app — participant
 *  bar, transcript, caption, chat, rosters, AND the on-canvas collaborator
 *  cursor/icon (via `resolveAvatarUrlWithDefault` in Collab.tsx) — turns a
 *  stored avatar VALUE into a loadable `<img>` src through here, so there is
 *  exactly one place that knows the avatar value-format. The value of record
 *  is the account's Supabase `user_metadata.avatar`; the same value travels
 *  the USER_PROFILE WS payload so peers resolve identically.
 *
 *  Recognised value forms (kept deliberately small so they fit user_metadata
 *  and the WS payload — we NEVER store/broadcast a heavy data-URL once an
 *  upload has roamed to R2):
 *    - "lib:NN.png"        → /decorations/avatars/NN.png (built-in gallery)
 *    - "data:image/…"      → the data URL itself. Transient only: a freshly
 *                            uploaded picture before `syncAvatarToAccount` has
 *                            swapped it for the R2 reference. Resolving it lets
 *                            the local preview show instantly.
 *    - "http(s)://…"       → an absolute serve URL (the Worker may return one
 *                            from PUT /v1/me/avatar) → used as-is.
 *    - any other non-empty → an R2 reference/key → served by the Worker at
 *                            `{STORAGE_URL}/v1/me/avatar/<key>` so the uploaded
 *                            avatar roams across devices.
 *    - null / empty        → null (caller falls back to the default face). */
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
  // Absolute URL (e.g. a fully-qualified R2 serve URL) — load directly.
  if (avatar.startsWith("http://") || avatar.startsWith("https://")) {
    return avatar;
  }
  // Otherwise it's an R2 reference/key the Worker serves. Strip any leading
  // slash so the join with the base never doubles up, and avoid re-prefixing
  // a value that already carries the route (defensive — keeps callers honest
  // whether they pass "abc123" or "/v1/me/avatar/abc123").
  const key = avatar.replace(/^\/+/, "");
  if (key.startsWith("v1/me/avatar/")) {
    return `${STORAGE_URL}/${key}`;
  }
  return `${STORAGE_URL}/v1/me/avatar/${key}`;
};

/** Like `resolveAvatarUrl` but ALWAYS returns a usable URL. When the
 *  user hasn't picked an avatar yet (or hasn't set up their profile
 *  at all), we deterministically map a library image from
 *  `fallbackKey` — that way every avatar surface in the app (chat,
 *  transcript, participant tile, on-canvas cursor) shows a real
 *  "character image" instead of an unstyled unicode emoji, with the
 *  same key resolving to the same picture everywhere.
 *
 *  `fallbackKey` should be the user's EMAIL whenever it is known —
 *  it's the stable login identity, so the same person gets the same
 *  default face across sessions, devices, and every surface. Fall
 *  back to socketId ONLY for anonymous link-join peers who carry no
 *  email (their default face is then per-session, which is the best
 *  we can do without an identity). */
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
  /** Authenticated email (from the session). Broadcast so peers can tell who
   *  is INTERNAL — drives the acting-host election. Absent for anon link-joins. */
  email?: string;
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

/** A peer's audio state (in the call + muted), populated from AUDIO_STATE
 *  broadcasts. Lets every participant render the same mic on/off/idle icon —
 *  including self-mute — in real time. */
export type PeerAudio = { inCall: boolean; muted: boolean };
export const peerAudioAtom = atom<ReadonlyMap<string, PeerAudio>>(new Map());

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

/** The meeting's CREATOR (its `created_by` display name from the registry),
 *  set on join. LEGACY tie-breaker only — meetings now carry host/organizer
 *  EMAILS and the election matches those first (names collide; emails are the
 *  verified login identity). Null for ad-hoc rooms with no registry entry. */
export const meetingCreatorAtom = atom<string | null>(null);

/** The meeting's rightful host IDENTITY from the registry — `host_email`
 *  (current host, defaults to the organizer) with `organizer_email` as the
 *  fallback. Lower-cased email. This is the PRIMARY input to the host
 *  election: identity = verified login email, never a display name. Null for
 *  legacy/ad-hoc rows that predate Phase 4.5. */
export const meetingHostEmailAtom = atom<string | null>(null);

/** Server-computed: the VIEWER holds host-level authority over this meeting by
 *  virtue of the project — the project LEADER or the leading-division HEAD (also
 *  admin / organizer / host). It OVERRIDES socket host-election for surfacing
 *  host controls (End / kick / mute), so a division head always has full
 *  meeting control even if election landed on someone else (anh Luân 06-15).
 *  Reset between rooms. */
export const meetingViewerAuthorityAtom = atom<boolean>(false);

/** Socket id of the current MCM "host" — the live referee for host-only
 *  controls (End-for-all, kick, mute, recording, folder).
 *
 *  Election order (docs/specs/host-and-scheduling.md):
 *  1. The participant whose EMAIL matches the registry host/organizer —
 *     deterministic for every client, and the reason the real host
 *     automatically reclaims control the moment they join.
 *  2. Legacy: match the creator's display NAME (rows predating host_email).
 *  3. ACTING HOST: first INTERNAL participant by join order — the meeting is
 *     never stuck waiting for an absent host, and a guest never runs it.
 *  4. Smallest joinedAt — ONLY when no participant carries any email at all
 *     (dev/tests without auth). In a real room a guests-only floor stays
 *     HOSTLESS (controls locked) until an internal user arrives; the old
 *     unconditional fallback let an early-joining guest grab kick/mute/End.
 *
 *  Returns null when there's no active room (or a hostless guests-only one)
 *  so callers render the inert/locked state. Lexicographic socketId breaks
 *  joinedAt ties deterministically. */
export const hostSocketIdAtom = atom<string | null>((get) => {
  const mySocketId = get(mySocketIdAtom);
  const myProfile = get(userProfileAtom);
  const peerProfiles = get(peerProfilesAtom);

  // 1) Primary: host = the participant whose verified email matches the
  //    registry host/organizer email.
  const hostEmail = get(meetingHostEmailAtom);
  if (hostEmail) {
    if (mySocketId && myProfile?.email?.toLowerCase() === hostEmail) {
      return mySocketId;
    }
    for (const [socketId, profile] of peerProfiles) {
      if (profile.email?.toLowerCase() === hostEmail) {
        return socketId;
      }
    }
    // Host not present → acting-host election below.
  }

  // 2) Legacy: meetings registered before host_email existed — match the
  //    creator's display name. Skipped when an email match was possible.
  const creator = get(meetingCreatorAtom);
  if (!hostEmail && creator) {
    if (mySocketId && myProfile?.username === creator) {
      return mySocketId;
    }
    for (const [socketId, profile] of peerProfiles) {
      if (profile.username === creator) {
        return socketId;
      }
    }
  }

  // 3) Acting host: rightful host absent → the first INTERNAL (@mapgroup)
  //    participant by join order takes over; control returns automatically
  //    when the real host joins (rule 1 outranks this).
  const joined = get(peerJoinedAtAtom);
  type Candidate = { socketId: string; joinedAt: number };
  const internal: Candidate[] = [];
  let anyEmailKnown = false;
  if (mySocketId && MY_JOINED_AT != null) {
    if (myProfile?.email) {
      anyEmailKnown = true;
    }
    if (isInternalEmail(myProfile?.email)) {
      internal.push({ socketId: mySocketId, joinedAt: MY_JOINED_AT });
    }
  }
  for (const [socketId, profile] of peerProfiles) {
    if (profile.email) {
      anyEmailKnown = true;
    }
    if (isInternalEmail(profile.email)) {
      internal.push({ socketId, joinedAt: joined.get(socketId) ?? Infinity });
    }
  }
  if (internal.length > 0) {
    internal.sort((a, b) =>
      a.joinedAt !== b.joinedAt
        ? a.joinedAt - b.joinedAt
        : a.socketId < b.socketId
        ? -1
        : 1,
    );
    return internal[0].socketId;
  }

  // Guests-only room: identities are known and none is internal → HOSTLESS.
  // A guest must never hold host controls (host-and-scheduling.md).
  if (anyEmailKnown) {
    return null;
  }

  // 4) No identity info at all (auth-less dev/tests) — smallest joinedAt
  //    (link-sharer heuristic) so host-gated features stay usable there.
  const candidates: Candidate[] = [];
  for (const [socketId, joinedAt] of joined) {
    candidates.push({ socketId, joinedAt });
  }
  if (mySocketId && MY_JOINED_AT != null) {
    candidates.push({ socketId: mySocketId, joinedAt: MY_JOINED_AT });
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
      // Carry email through so the acting-host election can tell we're internal
      // on boot, before the session effect re-saves the profile.
      email: typeof parsed.email === "string" ? parsed.email : undefined,
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

/** Replace the data-URL avatar currently sitting in the LOCAL profile (atom +
 *  localStorage) with the lightweight R2 reference once the upload roams. The
 *  modal saves the data-URL synchronously for an instant preview; this swap
 *  happens after the async upload so the value we BROADCAST over WS and persist
 *  is the small reference, never the ~100KB data-URL. Guarded on identity so a
 *  stale upload (user changed avatar again mid-flight) doesn't clobber a newer
 *  pick. */
const replaceLocalAvatar = (from: string, to: string): void => {
  const current = appJotaiStore.get(userProfileAtom);
  if (!current || current.avatar !== from) {
    return; // profile changed under us — leave the newer value alone
  }
  saveUserProfile({ ...current, avatar: to });
};

/** Push the chosen avatar to the ACCOUNT — Supabase `user_metadata.avatar` —
 *  so it follows the LOGIN across browsers/devices. localStorage stays the
 *  offline cache, but the account is the system of record: without this,
 *  every account that logs in on the same machine inherits whatever avatar
 *  the previous user left in the shared `mcm:userProfile:v1` key (the
 *  "everyone has the same avatar" bug; docs/specs/user-data-model.md).
 *
 *  user_metadata must stay SMALL, so we never store a data-URL there:
 *  - `"lib:NN.png"`  → stored as-is (a few bytes);
 *  - `"data:image…"` → UPLOADED to R2 via the Worker (`PUT /v1/me/avatar`).
 *    The Worker writes the bytes, sets `user_metadata.avatar` to the returned
 *    R2 reference, and we swap the local profile's data-URL for that reference
 *    so the uploaded avatar ROAMS to every device (and the WS broadcast carries
 *    the light reference, not the heavy bytes). Worker contract:
 *      `PUT /v1/me/avatar` (raw image bytes) → `{ avatar: "<r2-reference>" }`.
 *  - `undefined`     → clears the account avatar (user pressed "clear").
 *
 *  No-op when auth isn't configured or nobody is signed in (anonymous
 *  link-join keeps its purely-local profile). Fire-and-forget at the call
 *  site: a failure only means the avatar doesn't roam — the local save (data
 *  URL) already happened, so the user still sees their pick on this device. */
export const syncAvatarToAccount = async (
  avatar: string | undefined,
): Promise<void> => {
  if (!supabase) {
    return;
  }
  try {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      return;
    }

    // Uploaded picture → ship the bytes to R2 and store the returned reference
    // (NOT the data-URL) at the account, so it roams without bloating the JWT.
    if (avatar?.startsWith("data:")) {
      const blob = dataUrlToBlob(avatar);
      if (!blob) {
        return; // unparseable data-URL — keep it local-only rather than 400
      }
      const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/avatar`, {
        method: "PUT",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      if (!res.ok) {
        // Upload failed — leave the local data-URL in place (still shows here).
        console.warn(
          "[userProfile] avatar upload failed",
          res.status,
          res.statusText,
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        avatar?: unknown;
      } | null;
      const reference =
        body && typeof body.avatar === "string" ? body.avatar : null;
      if (!reference) {
        console.warn("[userProfile] avatar upload returned no reference");
        return;
      }
      // The Worker already set user_metadata.avatar = reference, but mirror it
      // through updateUser too so the local Supabase session cache refreshes
      // (and we stay correct even if the Worker stops setting it server-side).
      await supabase.auth.updateUser({ data: { avatar: reference } });
      // Swap the local + broadcast value from the data-URL to the reference.
      replaceLocalAvatar(avatar, reference);
      return;
    }

    // Library pick / clear → store the tiny ref (or null) directly.
    const current = (user.user_metadata as Record<string, unknown> | undefined)
      ?.avatar;
    const next = avatar ?? null;
    if ((typeof current === "string" ? current : null) === next) {
      return; // already in sync — skip the USER_UPDATED round-trip
    }
    await supabase.auth.updateUser({ data: { avatar: next } });
  } catch (err) {
    console.warn("[userProfile] failed to sync avatar to account", err);
  }
};

/** Parse a `data:[mime][;base64],<payload>` URL into a Blob for upload. We send
 *  raw bytes (not the data-URL string) so the Worker can stream them straight
 *  to R2. Returns null for anything that isn't a well-formed data-URL. */
const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) {
    return null;
  }
  const header = dataUrl.slice(5, comma); // between "data:" and ","
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, "") || "application/octet-stream";
  try {
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
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
    existing.avatar === profile.avatar &&
    existing.email === profile.email
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

export const upsertPeerAudio = (socketId: string, audio: PeerAudio): void => {
  const current = appJotaiStore.get(peerAudioAtom);
  const existing = current.get(socketId);
  if (
    existing &&
    existing.inCall === audio.inCall &&
    existing.muted === audio.muted
  ) {
    return;
  }
  const next = new Map(current);
  next.set(socketId, audio);
  appJotaiStore.set(peerAudioAtom, next);
};

export const removePeerAudio = (socketId: string): void => {
  const current = appJotaiStore.get(peerAudioAtom);
  if (!current.has(socketId)) {
    return;
  }
  const next = new Map(current);
  next.delete(socketId);
  appJotaiStore.set(peerAudioAtom, next);
};
