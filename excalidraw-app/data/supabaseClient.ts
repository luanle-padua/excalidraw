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

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;
