#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Strip `^` and `~` prefixes from version ranges in every package.json
 * across the repo so `yarn install` (and any tooling that reads
 * package.json) can never pick a newer version of a dependency than
 * what is already pinned. yarn.lock + frozen-lockfile is the second
 * line of defence; this is the first.
 *
 * Leaves untouched:
 *   - workspace / file / git / link / portal protocols
 *   - tags ("latest", "next", etc.)
 *   - tarball URLs
 *   - already-exact versions
 *
 * Usage:
 *   node scripts/lock-versions.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function isLockable(version) {
  if (typeof version !== "string") {
    return false;
  }
  return /^[~^]\d/.test(version); // starts with ^ or ~ followed by a digit
}

function lockVersion(version) {
  return version.replace(/^[~^]/, "");
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === ".git"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name === "package.json") {
      out.push(full);
    }
  }
  return out;
}

function processFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  let changed = 0;

  for (const section of SECTIONS) {
    if (!pkg[section] || typeof pkg[section] !== "object") {
      continue;
    }
    for (const [name, version] of Object.entries(pkg[section])) {
      if (isLockable(version)) {
        pkg[section][name] = lockVersion(version);
        changed++;
      }
    }
  }

  if (changed > 0) {
    // Preserve trailing newline behaviour
    const trailingNL = raw.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + trailingNL);
  }
  return changed;
}

let total = 0;
const files = walk(ROOT);
for (const f of files) {
  const n = processFile(f);
  if (n > 0) {
    console.log(`  ${path.relative(ROOT, f)} — locked ${n} version(s)`);
    total += n;
  }
}

console.log(
  `\nLocked ${total} version range(s) across ${files.length} package.json file(s).`,
);
