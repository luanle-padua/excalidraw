// Client API for provisioning a GUEST login account (worker POST /v1/guests).
// Lets an internal host (or admin) create a Supabase account for an EXTERNAL
// invitee — auto-confirmed, with a server-generated temp password — so the
// guest can sign in WITHOUT any email delivery. The host then manually shares
// email + password + meeting link. Goes through fetchWithAuth (Supabase JWT);
// the worker enforces who may create guests and that the email is external.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type CreateGuestResult =
  /** Account created — `password` is shown to the host ONCE (never stored). */
  | { ok: true; existed: false; email: string; password: string }
  /** Account already existed — no password (can't be recovered). */
  | { ok: true; existed: true; email: string }
  /** Worker refused or failed; `status` distinguishes 400/403 from network. */
  | { ok: false; status: number | null };

/** Create (or detect) a guest login account for an external email. */
export const createGuest = async (
  email: string,
  name?: string,
): Promise<CreateGuestResult> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/guests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const data = (await res.json()) as {
      ok: boolean;
      existed?: boolean;
      email?: string;
      password?: string;
    };
    if (!data.ok || !data.email) {
      return { ok: false, status: res.status };
    }
    if (data.existed) {
      return { ok: true, existed: true, email: data.email };
    }
    return {
      ok: true,
      existed: false,
      email: data.email,
      password: data.password ?? "",
    };
  } catch {
    return { ok: false, status: null };
  }
};

/** Email a guest their meeting link (+ optional login password) via the
 *  worker's Resend integration. Best-effort: returns ok:false if Resend isn't
 *  configured or the send fails — the host can always copy/paste manually. */
export const sendGuestInvite = async (
  to: string,
  link: string,
  opts?: { meetingTitle?: string; password?: string },
): Promise<{ ok: boolean }> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/guests/send-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, link, ...opts }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
};
