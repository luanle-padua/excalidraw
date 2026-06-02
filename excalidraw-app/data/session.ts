import { atom, appJotaiStore } from "../app-jotai";

// Demo-grade login identity (account level), distinct from the per-meeting
// `userProfileAtom` (which is broadcast over the room socket). The session
// carries the EMAIL used as the project host key and the creator name, and
// must exist BEFORE any room/collab. When Cloudflare Access SSO lands, this
// is replaced by the verified Access identity with NO data-model churn —
// the host stays keyed on `session.email`.

const STORAGE_KEY = "mcm:session:v1";

export type Session = {
  name: string;
  email: string;
  company?: string;
  branch?: string;
};

export const sessionAtom = atom<Session | null>(null);

export const importSessionFromLocalStorage = (): Session | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const p = JSON.parse(raw);
    if (typeof p?.name !== "string" || typeof p?.email !== "string") {
      return null;
    }
    return {
      name: p.name,
      email: p.email,
      company: typeof p.company === "string" ? p.company : undefined,
      branch: typeof p.branch === "string" ? p.branch : undefined,
    };
  } catch {
    return null;
  }
};

export const setSession = (s: Session): Session => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
  appJotaiStore.set(sessionAtom, s);
  return s;
};

export const clearSession = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  appJotaiStore.set(sessionAtom, null);
};

// Eagerly hydrate at module load so the login gate doesn't flash before
// any effect runs.
appJotaiStore.set(sessionAtom, importSessionFromLocalStorage());
