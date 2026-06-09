// Client API for the shared client list (worker /v1/clients). A `client` row is
// a reusable EXTERNAL contact card (client/consultant) that internal staff
// manage once and then pick from when inviting — not a login/identity. All
// calls go through fetchWithAuth (Supabase JWT); the Worker gates create/list/
// delete to internal staff + admins.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type Client = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  note: string | null;
  created_by: string | null;
  created_at: number;
};

/** List all clients (newest first). Internal staff + admins only. */
export const listClients = async (): Promise<Client[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/clients`);
    return res.ok ? (await res.json()).clients ?? [] : [];
  } catch {
    return [];
  }
};

/** Create a client contact card. Returns the created row, or null on failure. */
export const createClient = async (input: {
  name: string;
  company?: string;
  email?: string;
  note?: string;
}): Promise<Client | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/clients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.ok ? (await res.json()).client ?? null : null;
  } catch {
    return null;
  }
};

/** Delete a client contact card. Existing meeting invites are unaffected. */
export const deleteClient = async (id: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/clients/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};
