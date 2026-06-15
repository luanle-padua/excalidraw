// Client API for PROJECT-SCOPED guest identities (new guest-access model,
// 06-15). Guest access is independent per project — strict confidentiality
// BETWEEN departments. A host (a member/owner of the project) or admin issues
// a SYNTHETIC Supabase login (never the guest's real email) + temp password
// scoped to ONE project; the guest follows that project across all its
// meetings. The worker enforces who may manage a project's guests (admin OR a
// member/owner); admin has full power everywhere. Goes through fetchWithAuth.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** CRM-style contact details for a guest — all optional/free-text, stored in
 *  D1 next to the synthetic login (never part of the Supabase auth identity).
 *  `label` is the representative / contact person's name. */
export type GuestContact = {
  label: string | null; // đại diện / contact person
  real_email: string | null; // email
  company: string | null; // công ty
  phone: string | null; // số điện thoại
  address: string | null; // địa chỉ
};

/** What the host can submit when issuing or editing a guest's contact card. */
export type GuestContactInput = {
  label: string;
  real_email?: string;
  company?: string;
  phone?: string;
  address?: string;
};

/** One project guest as returned by the list endpoint. */
export type ProjectGuest = GuestContact & {
  id: string;
  login: string;
  created_by: string | null;
  created_at: number;
  status: string;
};

/** One project guest in the CENTRALIZED manager — carries the owning project's
 *  id + name so the UI can group across projects. The server scopes the list to
 *  the caller's project memberships (admin sees all). */
export type MyProjectGuest = GuestContact & {
  id: string;
  project_id: string;
  project_name: string;
  login: string;
  status: string;
  created_at: number;
};

/** Credentials shown to the host ONCE — never recoverable afterwards. */
export type IssuedGuest = {
  id: string;
  login: string;
  password: string;
  label: string;
};

/** List the project's active guests (admin or a project member/owner). */
export const listProjectGuests = async (
  projectId: string,
): Promise<ProjectGuest[]> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/guests`,
    );
    if (!res.ok) {
      return [];
    }
    return (await res.json()).guests ?? [];
  } catch {
    return [];
  }
};

/** CENTRALIZED list — every active guest the caller may manage, across all
 *  their projects (admin: across all projects). Scoped SERVER-SIDE to project
 *  membership; the worker never trusts a client-supplied project list. */
export const listMyProjectGuests = async (): Promise<MyProjectGuest[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/project-guests`);
    if (!res.ok) {
      return [];
    }
    return (await res.json()).guests ?? [];
  } catch {
    return [];
  }
};

/** Issue a guest ID for the project — returns login + password ONCE. The
 *  contact card (label/email/company/phone/address) is persisted in D1. */
export const issueProjectGuest = async (
  projectId: string,
  contact: GuestContactInput,
): Promise<IssuedGuest | null> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/guests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: contact.label,
          real_email: contact.real_email,
          company: contact.company,
          phone: contact.phone,
          address: contact.address,
        }),
      },
    );
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as {
      ok?: boolean;
      id?: string;
      login?: string;
      password?: string;
      label?: string;
    };
    if (!d.ok || !d.login || !d.password || !d.id) {
      return null;
    }
    return {
      id: d.id,
      login: d.login,
      password: d.password,
      label: d.label ?? contact.label,
    };
  } catch {
    return null;
  }
};

/** Edit a guest's CONTACT card (label/email/company/phone/address). Pure D1
 *  metadata update — never touches the synthetic login. Returns whether it
 *  succeeded. */
export const updateProjectGuest = async (
  projectId: string,
  id: string,
  contact: GuestContactInput,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/guests/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: contact.label,
          real_email: contact.real_email,
          company: contact.company,
          phone: contact.phone,
          address: contact.address,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Reset a guest's password — returns the new password ONCE. */
export const resetProjectGuest = async (
  projectId: string,
  id: string,
): Promise<{ login: string; password: string } | null> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/guests/${encodeURIComponent(id)}/reset`,
      { method: "POST" },
    );
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as {
      ok?: boolean;
      login?: string;
      password?: string;
    };
    if (!d.ok || !d.login || !d.password) {
      return null;
    }
    return { login: d.login, password: d.password };
  } catch {
    return null;
  }
};

/** Revoke ONE guest — deletes the Supabase user + the row. */
export const revokeProjectGuest = async (
  projectId: string,
  id: string,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/guests/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Clean ALL guests of the project — the "done with the project" action. */
export const cleanProjectGuests = async (
  projectId: string,
): Promise<{ ok: boolean; removed: number }> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/guests/clean`,
      { method: "POST" },
    );
    if (!res.ok) {
      return { ok: false, removed: 0 };
    }
    const d = (await res.json()) as { ok?: boolean; removed?: number };
    return { ok: !!d.ok, removed: d.removed ?? 0 };
  } catch {
    return { ok: false, removed: 0 };
  }
};
