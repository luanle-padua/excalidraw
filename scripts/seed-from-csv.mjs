// Seed ALL employees from user.csv into Supabase with full org metadata
// (name, title 직급, department 부서, division, company 소속, emp_no). Idempotent:
// existing accounts get their metadata UPDATED (app_metadata/role preserved),
// new ones are created with the default password. Run a preview first:
//
//   node scripts/seed-from-csv.mjs --dry     (parse + show counts, no writes)
//   node scripts/seed-from-csv.mjs           (create/update for real)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const DEFAULT_PASSWORD = "MapMeet@2026";

// --- creds (worker/.dev.vars) ---
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

// --- parse user.csv (repo root, one level above excalidraw) ---
const csv = readFileSync(join(__dirname, "..", "..", "user.csv"), "utf8");
const rows = [];
for (const line of csv.split(/\r?\n/)) {
  const f = line.split(",").map((s) => s.trim());
  if (f.length < 7) {
    continue;
  }
  const [empNo, name, company, department, division, title] = f;
  const email = f[f.length - 1];
  if (!email.includes("@") || empNo === "순 번" || empNo === "순번") {
    continue; // header / malformed
  }
  rows.push({ empNo, name, company, department, division, title, email: email.toLowerCase() });
}

// de-dup by email (keep first)
const byEmail = new Map();
for (const r of rows) {
  if (!byEmail.has(r.email)) {
    byEmail.set(r.email, r);
  }
}
// SCOPE (dev phase): only the Design wing — Architectural Design Div. 1/2 +
// Architectural AI R&D Center (the 5 R&D users live here). Full org seed later.
const KEEP = /Architectural (Design|AI R&D)/i;
const people = [...byEmail.values()].filter((p) => KEEP.test(p.division));
console.log(
  `Parsed ${rows.length} rows → ${byEmail.size} unique → ${people.length} in scope (Architectural Design + AI R&D).`,
);
console.log("Sample:", people.slice(0, 3).map((p) => `${p.name}/${p.title}/${p.division}`).join("  |  "));
const divisions = [...new Set(people.map((p) => p.division))];
console.log(`Divisions (${divisions.length}):`, divisions.join(", "));

if (DRY) {
  console.log("\n[dry run] no writes. Re-run without --dry to seed.");
  process.exit(0);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- map existing users by email ---
const existing = new Map();
for (let page = 1; page <= 50; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) {
    console.error("listUsers failed:", error.message);
    process.exit(1);
  }
  for (const u of data.users) {
    if (u.email) {
      existing.set(u.email.toLowerCase(), u);
    }
  }
  if (data.users.length < 1000) {
    break;
  }
}
console.log(`Existing Supabase users: ${existing.size}`);

const meta = (p) => ({
  name: p.name,
  display_name: p.name,
  title: p.title,
  division: p.division,
  department: p.department,
  company: p.company,
  emp_no: p.empNo,
});

let created = 0,
  updated = 0,
  failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < people.length; i++) {
  const p = people[i];
  const ex = existing.get(p.email);
  try {
    if (ex) {
      const { error } = await admin.auth.admin.updateUserById(ex.id, {
        user_metadata: { ...(ex.user_metadata ?? {}), ...meta(p) },
      });
      if (error) {
        throw error;
      }
      updated++;
    } else {
      const { error } = await admin.auth.admin.createUser({
        email: p.email,
        password: DEFAULT_PASSWORD,
        email_confirm: true,
        user_metadata: meta(p),
      });
      if (error) {
        throw error;
      }
      created++;
    }
  } catch (e) {
    failed++;
    console.error(`✗ ${p.email}: ${e.message ?? e}`);
  }
  if ((i + 1) % 25 === 0) {
    console.log(`… ${i + 1}/${people.length} (created ${created}, updated ${updated}, failed ${failed})`);
  }
  await sleep(80);
}

console.log(`\nDone. created=${created} updated=${updated} failed=${failed} total=${people.length}`);
console.log(`Default password for new accounts: ${DEFAULT_PASSWORD}`);
