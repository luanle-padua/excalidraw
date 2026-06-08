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

import { supabase } from "./supabaseClient";

import type { User } from "@supabase/supabase-js";

export type Session = {
  name: string;
  email: string;
  company?: string;
  branch?: string;
};

export const sessionAtom = atom<Session | null>(null);

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
  const email = user.email ?? "";
  // Prefer the Korean name (사원명, seeded as `name`) for display; fall back to
  // the romanized display_name, then the email local-part.
  const display =
    (typeof md.name === "string" && md.name) ||
    (typeof md.display_name === "string" && md.display_name) ||
    nameFromEmail(email);
  return {
    name: display,
    email,
    company: typeof md.company === "string" ? md.company : undefined,
    branch: typeof md.division === "string" ? md.division : undefined,
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
  };
  void supabase.auth.getSession().then(({ data }) => apply(data.session?.user));
  supabase.auth.onAuthStateChange((_event, session) => apply(session?.user));
};

// Kick off the sync at module load (replaces the old eager localStorage read).
initAuthSync();
