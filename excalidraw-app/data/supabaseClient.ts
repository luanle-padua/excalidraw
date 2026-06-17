// Supabase client for auth. The anon key is public by design (it only allows
// what Row-Level-Security permits); real authorization happens server-side in
// the Worker, which verifies the user's access-token JWT. `detectSessionInUrl`
// is on so magic-link / OTP redirects (used for external client guests) land
// the session automatically.

import { createClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const IS_SUPABASE_CONFIGURED = Boolean(url && anonKey);

// Route Supabase AUTH calls through our Cloudflare Worker (the same edge the app
// already loaded from) instead of straight to *.supabase.co. Some networks (e.g.
// certain Vietnamese home ISPs) DNS/SNI-block supabase.co while Cloudflare stays
// reachable — symptom: the app loads but login fails on WiFi yet works on 4G
// (06-18). The Worker proxies /auth/v1/* (see worker/src/index.ts). We swap ONLY
// the network hop; supabaseUrl stays supabase.co, so the session storage key and
// the OTP/magic-link redirect base are unchanged, and GoTrue still stamps the JWT
// `iss` from its own external URL → the Worker's JWKS verification is untouched.
// Dev-tunnel mode (same-origin) and a missing storage URL fall back to a direct
// call (no rewrite), so local/dev keeps working.
const authProxyBase = (
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL as string | undefined) || ""
).replace(/\/$/, "");

const authProxyFetch: typeof fetch = (input, init) => {
  const reqUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url && authProxyBase && reqUrl.startsWith(`${url}/auth/v1`)) {
    return fetch(authProxyBase + reqUrl.slice(url.length), init);
  }
  return fetch(input, init);
};

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        global: { fetch: authProxyFetch },
      })
    : null;
