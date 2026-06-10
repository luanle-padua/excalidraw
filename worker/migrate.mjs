// MCM — D1 migration runner (SSOT: worker/schema/000N_*.sql, tracked in the
// schema_version table). The SAME script serves local and remote, so the two
// environments can never drift structurally (production-data-plan.md §1.1/§4).
//
//   node migrate.mjs            # apply pending migrations to LOCAL D1
//   node migrate.mjs --remote   # apply to the real D1 (needs wrangler login)
//   node migrate.mjs --status   # list applied/pending, change nothing
//
// Never run `wrangler d1 execute --file` by hand anymore — it bypasses
// tracking and the next `migrate` run can't tell what's applied.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "schema");
const DB = "mcm-db";

const remote = process.argv.includes("--remote");
const statusOnly = process.argv.includes("--status");
const target = remote ? "--remote" : "--local";

// On Windows npx is a .cmd, which needs shell:true — and with a shell, every
// argument containing spaces must be quoted by hand or yargs sees word salad.
const q = (a) => (/[\s()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const wrangler = (...args) =>
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", DB, target, ...args].map(q),
    { cwd: here, encoding: "utf8", shell: process.platform === "win32" },
  );

// 1) Bootstrap the tracking table (idempotent) so --status works on a fresh DB.
wrangler(
  "--command",
  "CREATE TABLE IF NOT EXISTS schema_version (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
);

// 2) What's already applied?
const appliedJson = wrangler(
  "--command",
  "SELECT version FROM schema_version ORDER BY version",
  "--json",
);
const applied = new Set(
  JSON.parse(appliedJson.slice(appliedJson.indexOf("[")))[0].results.map(
    (r) => r.version,
  ),
);

// 3) Apply every pending file in name order, recording each.
const files = readdirSync(schemaDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
let ran = 0;
for (const f of files) {
  const version = f.replace(/\.sql$/, "");
  if (applied.has(version)) {
    console.log(`  = ${version} (applied)`);
    continue;
  }
  if (statusOnly) {
    console.log(`  > ${version} PENDING`);
    continue;
  }
  console.log(`  + ${version} ...`);
  wrangler("--file", join("schema", f));
  wrangler(
    "--command",
    `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES ('${version}', ${Date.now()})`,
  );
  ran++;
}
console.log(
  statusOnly
    ? `status: ${applied.size} applied / ${files.length} total (${remote ? "remote" : "local"})`
    : `done: ${ran} migration(s) applied (${remote ? "remote" : "local"})`,
);
