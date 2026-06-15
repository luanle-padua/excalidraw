// Account-level login identity, distinct from the per-meeting
// `userProfileAtom` (broadcast over the room socket). The session carries the
// EMAIL used as the project host key + the creator name, and must exist BEFORE
// any room/collab.
//
// Backed by Supabase Auth: `sessionAtom` MIRRORS the live Supabase session
// (synced via onAuthStateChange). Supabase persists its own session in
// localStorage, so identity survives reloads; we just derive our small Session
// shape from the authenticated user. The shape is unchanged from the old demo
// login, so every consumer of `sessionAtom` keeps working.

import { atom, appJotaiStore } from "../app-jotai";

import { fetchWithAuth } from "./fetchWithAuth";
import { supabase } from "./supabaseClient";

import type { User } from "@supabase/supabase-js";

export type Session = {
  name: string;
  email: string;
  company?: string;
  branch?: string;
  /** Account-level avatar from Supabase `user_metadata.avatar`. ONLY
   *  `"lib:NN.png"` library refs live at the account (kept tiny on purpose —
   *  uploaded data-URL avatars stay browser-local; see
   *  `syncAvatarToAccount` in userProfile.ts). This is what makes the avatar
   *  follow the LOGIN across browsers/devices instead of leaking between
   *  accounts that share one machine's localStorage. */
  avatar?: string;
  /** true when app_metadata.role === "admin" — gates the admin console.
   *  (The Worker independently re-checks the role on /v1/admin/*.) */
  isAdmin: boolean;
  /** Verified `app_metadata.role` from the Supabase JWT ("admin" | "guest" |
   *  undefined for ordinary staff). The Worker sets `role: "guest"` on the
   *  synthetic project-guest login; carry it through so the UI can branch on
   *  the VERIFIED role rather than sniffing the email domain. */
  role?: string;
  /** `app_metadata.project_id` — the single project a guest is scoped to
   *  (set by the Worker alongside `role: "guest"`). Undefined for staff. */
  projectId?: string;
  /** true when the verified JWT role is "guest" (falls back to the
   *  `@guest.canvasm.app` email domain when the role claim is missing). A
   *  project-scoped guest gets the minimal ClientPortal, never the staff
   *  dashboard. UX-only — every data gate is independently enforced by the
   *  Worker. */
  isGuest: boolean;
};

export const sessionAtom = atom<Session | null>(null);

/** Internal organisation email domains. Members on these domains are "internal"
 *  (auto-admit, can become acting host); everyone else is an external guest.
 *  Seeded with the hardcoded fallback, then REPLACED in place with the live
 *  admin-editable `internal_domains` setting (worker /v1/config) on login —
 *  display-side mirror of the server's authz list. */
export const INTERNAL_DOMAINS = ["mapgroup.co.kr"];
export const isInternalEmail = (email?: string | null): boolean =>
  !!email &&
  INTERNAL_DOMAINS.some((d) => email.toLowerCase().endsWith(`@${d}`));

/** Synthetic project-guest logins live on this fixed domain — the Worker mints
 *  `pg-<hex>@guest.canvasm.app` for every external client. Mirrors
 *  `isInternalEmail`. Used as the FALLBACK guest signal when the verified JWT
 *  role claim is missing; the role claim is authoritative when present. */
export const GUEST_EMAIL_DOMAIN = "guest.canvasm.app";
export const isGuestEmail = (email?: string | null): boolean =>
  !!email && email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

let domainsSynced = false;
const syncInternalDomains = (): void => {
  if (domainsSynced) {
    return;
  }
  domainsSynced = true;
  void fetchWithAuth(`${STORAGE_URL}/v1/config`)
    .then((res) => (res.ok ? res.json() : null))
    .then((cfg: { internal_domains?: string[] } | null) => {
      const list = (cfg?.internal_domains ?? [])
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean);
      if (list.length) {
        // Mutate in place — every importer of INTERNAL_DOMAINS sees the update.
        INTERNAL_DOMAINS.splice(0, INTERNAL_DOMAINS.length, ...list);
      }
    })
    .catch(() => {
      domainsSynced = false; // offline — retry on the next auth event
    });
};

/** false until the first Supabase session check resolves — the login gate
 *  waits on this so it doesn't flash the login screen for an already
 *  authenticated user mid-check. */
export const authReadyAtom = atom(false);

/** Derive a display name from an email local-part: "le.anh" → "Le Anh". */
const nameFromEmail = (email: string): string => {
  const local = email.split("@")[0] || email;
  return (
    local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
    email
  );
};

/** Map a Supabase user → our Session shape (uses the user_metadata we seed:
 *  display_name / name / company / division). */
export const deriveSession = (user: User): Session => {
  const md = (user.user_metadata ?? {}) as Record<string, unknown>;
  const appMd = (user.app_metadata ?? {}) as Record<string, unknown>;
  const email = user.email ?? "";
  // Prefer the Korean name (사원명, seeded as `name`) for display; fall back to
  // the romanized display_name, then the email local-part.
  const display =
    (typeof md.name === "string" && md.name) ||
    (typeof md.display_name === "string" && md.display_name) ||
    nameFromEmail(email);
  // Only accept "lib:NN.png" library refs from the account — anything else
  // (junk, an accidentally-synced data URL) is ignored so a corrupt
  // user_metadata value can never break every avatar surface at once.
  const avatar =
    typeof md.avatar === "string" && md.avatar.startsWith("lib:")
      ? md.avatar
      : undefined;
  // Carry the verified role + project scope from app_metadata (the Worker sets
  // `role: "guest"` + `project_id` on the synthetic guest login). These were
  // previously dropped, forcing isGuest to sniff the email domain.
  const role = typeof appMd.role === "string" ? appMd.role : undefined;
  const projectId =
    typeof appMd.project_id === "string" ? appMd.project_id : undefined;
  return {
    name: display,
    email,
    company: typeof md.company === "string" ? md.company : undefined,
    branch: typeof md.division === "string" ? md.division : undefined,
    avatar,
    isAdmin: role === "admin",
    role,
    projectId,
    // Verified JWT role is authoritative; domain match is the fallback for a
    // guest login whose role claim hasn't been stamped yet.
    isGuest: role === "guest" || (role === undefined && isGuestEmail(email)),
  };
};

export const setSession = (s: Session): Session => {
  appJotaiStore.set(sessionAtom, s);
  return s;
};

export const clearSession = (): void => {
  appJotaiStore.set(sessionAtom, null);
};

/** Sign out of Supabase (clears its persisted session) + our atom. */
export const signOut = async (): Promise<void> => {
  if (supabase) {
    await supabase.auth.signOut().catch(() => undefined);
  }
  clearSession();
};

// ---- bootstrap: keep sessionAtom in sync with Supabase auth --------------
let inited = false;
export const initAuthSync = (): void => {
  if (inited) {
    return;
  }
  inited = true;
  if (!supabase) {
    // Auth not configured (dev without creds) — mark ready so the app still
    // runs; the login gate can decide how to handle a null session.
    appJotaiStore.set(authReadyAtom, true);
    return;
  }
  const apply = (user: User | null | undefined) => {
    appJotaiStore.set(sessionAtom, user ? deriveSession(user) : null);
    appJotaiStore.set(authReadyAtom, true);
    if (user) {
      syncInternalDomains();
    }
  };
  void supabase.auth.getSession().then(({ data }) => apply(data.session?.user));
  supabase.auth.onAuthStateChange((_event, session) => apply(session?.user));
};

// Kick off the sync at module load (replaces the old eager localStorage read).
initAuthSync();
