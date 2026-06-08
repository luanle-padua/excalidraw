// Single chokepoint for calling the Worker API with the user's Supabase JWT.
// Every `/v1/...` fetch in storage.ts / projects.ts goes through here so the
// `Authorization: Bearer <token>` header is attached consistently. The token
// is read fresh from the live session each call (Supabase auto-refreshes it),
// so we never ship a stale/expired token.

import { supabase } from "./supabaseClient";

export const fetchWithAuth = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (supabase && !headers.has("Authorization")) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    } catch {
      // no session → request goes out unauthenticated; the Worker 401s.
    }
  }
  return fetch(input, { ...init, headers });
};
