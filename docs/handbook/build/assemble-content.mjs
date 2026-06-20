// Merge the per-chapter draft JSONs (content/draft/chN.json) produced by the
// deep-content workflow into the canonical book.json + strings/en.json + figures.json.
//   node docs/handbook/build/assemble-content.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";

const HB = "C:/LUAN/19.CanvasMeet/docs/handbook";
const book = JSON.parse(readFileSync(`${HB}/content/book.json`, "utf8"));
const strings = JSON.parse(readFileSync(`${HB}/content/strings/en.json`, "utf8"));
const figures = JSON.parse(readFileSync(`${HB}/content/figures.json`, "utf8"));

let ok = 0;
const missing = [];
const SUPPORTED = new Set(["opener", "prose", "steps", "gallery", "plate", "troubleshoot", "reference-table", "ai", "viewer", "figure", "card"]);

for (const ch of Object.values(book.chapters)) {
  const f = `${HB}/content/draft/ch${ch.number}.json`;
  if (!existsSync(f)) { missing.push(ch.number); continue; }
  let d;
  try { d = JSON.parse(readFileSync(f, "utf8")); }
  catch (e) { missing.push(`${ch.number}(bad json)`); continue; }

  if (Array.isArray(d.blocks) && d.blocks.length) {
    // keep only supported block types; keep first opener
    const blocks = d.blocks.filter((b) => SUPPORTED.has(b.type));
    if (!blocks.some((b) => b.type === "opener")) blocks.unshift({ id: `ch${ch.number}-open`, type: "opener", layout: "opener" });
    ch.blocks = blocks;
  }
  if (d.strings && typeof d.strings === "object") Object.assign(strings, d.strings);
  if (d.figures && typeof d.figures === "object") Object.assign(figures, d.figures);
  ok++;
}

writeFileSync(`${HB}/content/book.json`, JSON.stringify(book, null, 2) + "\n");
writeFileSync(`${HB}/content/strings/en.json`, JSON.stringify(strings, null, 2) + "\n");
writeFileSync(`${HB}/content/figures.json`, JSON.stringify(figures, null, 2) + "\n");
console.log(`assembled ${ok}/22 chapters; missing/bad: ${missing.join(", ") || "none"}`);
console.log(`book blocks total: ${Object.values(book.chapters).reduce((n, c) => n + c.blocks.length, 0)}`);
