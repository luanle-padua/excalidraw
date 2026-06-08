// Seed Supabase Auth users for the MAP "Architectural AI R&D Center" team.
//
// Creates each account with email auto-confirmed (so they can log in right
// away) and a shared default password they can change later. Idempotent —
// re-running skips emails that already exist.
//
// Needs admin access → reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
// worker/.dev.vars (gitignored). The service_role key is SECRET (full admin,
// bypasses RLS) — never commit it, never ship it to the client.
//
// Run:  node scripts/seed-supabase-users.mjs
//   (from the excalidraw/ dir; resolves @supabase/supabase-js from node_modules)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- read creds from worker/.dev.vars ----------------------------------
const devVarsPath = join(__dirname, "..", "worker", ".dev.vars");
const env = {};
for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    env[m[1]] = m[2];
  }
}

const SUPABASE_URL = env.SUPABASE_URL;
// New-style secret API key (sb_secret_...) or legacy service_role JWT — both
// work for the admin API.
const SERVICE_ROLE_KEY =
  env.SUPABASE_SERVICE_API_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_API_KEY in worker/.dev.vars.\n" +
      "(Supabase dashboard → Project Settings → API Keys → secret key)",
  );
  process.exit(1);
}

// Shared initial password — change after first login (or change here before
// running). Internal seeding only.
const DEFAULT_PASSWORD = env.SEED_DEFAULT_PASSWORD || "MapMeet@2026";

// ---- the team (CSV: Division = "Architectural AI R&D Center") -----------
const USERS = [
  { email: "hyu@mapgroup.co.kr", name: "유훈", display: "Yu Hun", title: "부사장" },
  { email: "lethanhluan@mapgroup.co.kr", name: "루안", display: "Luan", title: "팀장" },
  { email: "dojin0721@mapgroup.co.kr", name: "장도진", display: "Jang Dojin", title: "실장" },
  { email: "heejini1@mapgroup.co.kr", name: "전희진", display: "Jeon Heejin", title: "부팀장" },
  { email: "jhw0512@mapgroup.co.kr", name: "진효원", display: "Jin Hyowon", title: "4급사원" },
];

const COMPANY = "MAP";
const DIVISION = "Architectural AI R&D Center";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let created = 0;
let skipped = 0;
let failed = 0;

for (const u of USERS) {
  const { data, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: DEFAULT_PASSWORD,
    email_confirm: true,
    user_metadata: {
      name: u.name,
      display_name: u.display,
      title: u.title,
      company: COMPANY,
      division: DIVISION,
    },
  });
  if (error) {
    const msg = String(error.message || error);
    if (/already.*registered|already exists|duplicate/i.test(msg)) {
      console.log(`• skip  ${u.email} (already exists)`);
      skipped++;
    } else {
      console.error(`✗ fail  ${u.email}: ${msg}`);
      failed++;
    }
  } else {
    console.log(`✓ created ${u.email} (${u.display}) id=${data.user?.id}`);
    created++;
  }
}

console.log(
  `\nDone. created=${created} skipped=${skipped} failed=${failed}` +
    `\nDefault password: ${DEFAULT_PASSWORD}  (change after first login)`,
);
