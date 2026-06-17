// One-off: provision the Canvas M OWNER account (developer super-admin tier,
// spec docs/specs/chairman-account.md §1.4). DO NOT run blindly — this mutates
// the REAL Supabase Auth project configured in worker/.dev.vars. The main
// thread runs it after review; it is intentionally NOT executed by the agent.
//
// What it does (idempotent):
//   1. Look up the target email in Supabase Auth.
//   2. If absent → create it (email auto-confirmed) with a password.
//   3. ALWAYS (create OR existing) set app_metadata.role = "owner".
//      The role MUST be set EXPLICITLY: the target is an EXTERNAL gmail, so the
//      internal-domain auto-admit/role logic never applies to it — only this
//      explicit app_metadata grant makes it an owner. The Worker reads
//      app_metadata.role from the verified JWT (index.ts ~c.set("role", ...))
//      and `isAdminish("owner")` gives it every admin power, while the
//      owner-only role-grant guard + /v1/owner/* gate are reserved to it.
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_API_KEY (or legacy _SERVICE_ROLE_KEY)
// from worker/.dev.vars — the SECRET service key (full admin). Never commit it.
//
// Run (from the excalidraw/ repo root, AFTER review):
//   OWNER_EMAIL=arch.leluan@gmail.com \
//   OWNER_PASSWORD='<choose-a-strong-password>' \
//   node worker/scripts/provision-owner.mjs
//
// Then have the owner sign in once (password above) — or send a magic link from
// the Supabase dashboard / a password-reset email so they set their own.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- read creds from worker/.dev.vars -----------------------------------
const devVarsPath = join(__dirname, "..", ".dev.vars");
const env = {};
for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    env[m[1]] = m[2];
  }
}

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE_KEY =
  env.SUPABASE_SERVICE_API_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_API_KEY in worker/.dev.vars.",
  );
  process.exit(1);
}

const OWNER_EMAIL = (process.env.OWNER_EMAIL || "arch.leluan@gmail.com")
  .trim()
  .toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD; // required only for a fresh create

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 1) Find existing user by email (paginate defensively).
async function findByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      throw new Error(`listUsers failed: ${error.message}`);
    }
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) {
      return hit;
    }
    if (data.users.length < 200) {
      break;
    }
  }
  return null;
}

const existing = await findByEmail(OWNER_EMAIL);

let userId;
if (existing) {
  console.log(
    `• exists ${OWNER_EMAIL} id=${existing.id} — will set role=owner`,
  );
  userId = existing.id;
} else {
  if (!OWNER_PASSWORD) {
    console.error(
      `User ${OWNER_EMAIL} not found and OWNER_PASSWORD is unset.\n` +
        "Set OWNER_PASSWORD=... to create the account, or create it in the " +
        "Supabase dashboard first then re-run to stamp the role.",
    );
    process.exit(1);
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    app_metadata: { role: "owner" },
    user_metadata: { display_name: "Owner", name: "Owner" },
  });
  if (error) {
    console.error(`✗ create failed: ${error.message}`);
    process.exit(1);
  }
  userId = data.user.id;
  console.log(`✓ created ${OWNER_EMAIL} id=${userId} role=owner`);
}

// 3) ALWAYS ensure app_metadata.role = "owner" (covers the existing-user path
//    and re-confirms it on the freshly-created one).
const { data: updated, error: updErr } = await admin.auth.admin.updateUserById(
  userId,
  { app_metadata: { role: "owner" } },
);
if (updErr) {
  console.error(`✗ set role failed: ${updErr.message}`);
  process.exit(1);
}
console.log(
  `✓ role set: ${OWNER_EMAIL} app_metadata.role=` +
    `${updated.user?.app_metadata?.role}`,
);
console.log(
  "\nNote: the owner must sign in AGAIN (or refresh) to pick up the new JWT " +
    "claim — app_metadata changes only land in a freshly minted token.",
);
