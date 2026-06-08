// Grant the `admin` role to one or more users by setting Supabase
// app_metadata.role = "admin". app_metadata is SERVER-controlled (the user
// can't change it) and is included in the access-token JWT, so the Worker can
// gate /v1/admin/* on `payload.app_metadata.role === "admin"`.
//
// NOTE: an existing logged-in user must re-login (or refresh their token) to
// pick up the new role — the change only lands in a freshly issued JWT.
//
// Run:  node scripts/set-admin.mjs            (defaults to the host, Luan)
//       node scripts/set-admin.mjs a@x.com b@y.com

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

const emails = process.argv.slice(2);
if (emails.length === 0) {
  console.error("Usage: node scripts/set-admin.mjs <email> [email2 ...]");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Find users by email (paginate through the list).
const wanted = new Set(emails.map((e) => e.toLowerCase()));
const found = new Map();
for (let page = 1; page <= 20 && found.size < wanted.size; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) {
    console.error("listUsers failed:", error.message);
    process.exit(1);
  }
  for (const u of data.users) {
    if (u.email && wanted.has(u.email.toLowerCase())) {
      found.set(u.email.toLowerCase(), u);
    }
  }
  if (data.users.length < 200) {
    break;
  }
}

let ok = 0;
for (const email of wanted) {
  const u = found.get(email);
  if (!u) {
    console.error(`✗ not found: ${email}`);
    continue;
  }
  const { error } = await admin.auth.admin.updateUserById(u.id, {
    app_metadata: { ...(u.app_metadata ?? {}), role: "admin" },
  });
  if (error) {
    console.error(`✗ ${email}: ${error.message}`);
  } else {
    console.log(`✓ admin granted: ${email}`);
    ok++;
  }
}
console.log(`\nDone. ${ok}/${wanted.size} updated. (Re-login to refresh the JWT.)`);
