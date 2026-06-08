// Create a DEDICATED admin account (separate from meeting users — no meeting
// host is an admin). Sets app_metadata.role = "admin" (server-controlled, in
// the JWT) so the Worker can gate /v1/admin/* on it. Email-confirmed so it can
// log in immediately.
//
// Run:  node scripts/create-admin.mjs
//   override: ADMIN_EMAIL=x@y.com ADMIN_PASSWORD=... node scripts/create-admin.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(
  join(__dirname, "..", "worker", ".dev.vars"),
  "utf8",
).split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    env[m[1]] = m[2];
  }
}

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY =
  env.SUPABASE_SERVICE_API_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_API_KEY in worker/.dev.vars");
  process.exit(1);
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@mapgroup.co.kr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "MapAdmin@2026";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await admin.auth.admin.createUser({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  email_confirm: true,
  app_metadata: { role: "admin" },
  user_metadata: { display_name: "System Admin", name: "관리자" },
});

if (error) {
  if (/already.*registered|already exists/i.test(String(error.message))) {
    // Already exists → just ensure the admin role is set.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
    const u = list.users.find(
      (x) => x.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
    );
    if (u) {
      await admin.auth.admin.updateUserById(u.id, {
        app_metadata: { ...(u.app_metadata ?? {}), role: "admin" },
      });
      console.log(`• ${ADMIN_EMAIL} already existed → admin role ensured.`);
    } else {
      console.error("createUser said exists but user not found:", error.message);
      process.exit(1);
    }
  } else {
    console.error("createUser failed:", error.message);
    process.exit(1);
  }
} else {
  console.log(`✓ admin created: ${ADMIN_EMAIL} id=${data.user?.id}`);
}
console.log(`\nLogin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}  (change after first login)`);
