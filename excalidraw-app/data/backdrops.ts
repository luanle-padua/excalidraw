// Client API for the admin-managed CLIENT-PAGE BACKDROPS (worker
// /v1/portal/backdrops + /v1/admin/backdrops). These are the images the client
// portal + guest waiting room crossfade (PortalBackdrop.tsx). The admin CRUD
// calls hit /v1/admin/* (Worker re-verifies the "admin" role); the read call
// hits /v1/portal/backdrops which ANY authenticated user may read.
//
// The image route is auth-gated, so a bare <img src> / CSS url() can't carry
// the JWT. We therefore fetch each image's bytes via fetchWithAuth and hand the
// portal an object URL (same trick as data/userFiles.ts getMyFileContent).

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** A backdrop as the ADMIN console sees it (full row). */
export type AdminBackdrop = {
  id: string;
  title: string | null;
  r2_key: string;
  sort_order: number;
  created_at: number;
};

/** A backdrop as the PORTAL sees it: id, title, and a relative image URL. */
export type PortalBackdrop = {
  id: string;
  title: string | null;
  url: string;
};

/** What the portal actually renders: a ready-to-use (object) image URL. */
export type PortalBackdropImage = {
  id: string;
  title: string | null;
  /** Blob object URL — revoke when no longer needed. */
  src: string;
};

// ---- Portal read (any authenticated user) -------------------------------

/** List the backdrops + fetch each image as an object URL the portal can paint.
 *  Returns [] on any failure so the caller falls back to bundled defaults. The
 *  caller owns revoking the returned object URLs. */
export const listPortalBackdrops = async (): Promise<PortalBackdropImage[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/portal/backdrops`);
    if (!res.ok) {
      return [];
    }
    const list = ((await res.json()).backdrops ?? []) as PortalBackdrop[];
    const out: PortalBackdropImage[] = [];
    for (const b of list) {
      const imgRes = await fetchWithAuth(`${STORAGE_URL}${b.url}`);
      if (!imgRes.ok) {
        continue;
      }
      const blob = await imgRes.blob();
      out.push({ id: b.id, title: b.title, src: URL.createObjectURL(blob) });
    }
    return out;
  } catch {
    return [];
  }
};

// ---- Admin CRUD (admin role re-verified server-side) --------------------

export const listAdminBackdrops = async (): Promise<AdminBackdrop[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/backdrops`);
    return res.ok ? (await res.json()).backdrops ?? [] : [];
  } catch {
    return [];
  }
};

/** Build the auth-gated image URL for an admin thumbnail (used with an object
 *  URL the same way the portal does). */
export const adminBackdropImageUrl = (id: string): string =>
  `${STORAGE_URL}/v1/portal/backdrops/${encodeURIComponent(id)}/image`;

/** Fetch a single backdrop image as an object URL (admin thumbnails). */
export const fetchBackdropImage = async (
  id: string,
): Promise<string | null> => {
  try {
    const res = await fetchWithAuth(adminBackdropImageUrl(id));
    if (!res.ok) {
      return null;
    }
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
};

export const uploadBackdrop = async (
  file: File,
  title?: string,
): Promise<AdminBackdrop | null> => {
  try {
    const form = new FormData();
    form.append("file", file);
    if (title?.trim()) {
      form.append("title", title.trim());
    }
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/backdrops`, {
      method: "POST",
      body: form,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

export const updateBackdrop = async (
  id: string,
  patch: { title?: string; sort_order?: number },
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/backdrops/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const deleteBackdrop = async (id: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/backdrops/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};
