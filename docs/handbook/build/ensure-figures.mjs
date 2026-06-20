// Give every content block a figure slot so the book is image-rich. Steps and
// prose/ai blocks that lack a figure (and prose without a diagram) get a
// registered placeholder in figures.json — addressable so real screenshots can
// be dropped in later by setting `shot`.
import { readFileSync, writeFileSync } from "fs";
const HB = "C:/LUAN/19.CanvasMeet/docs/handbook";
const book = JSON.parse(readFileSync(`${HB}/content/book.json`, "utf8"));
const str = JSON.parse(readFileSync(`${HB}/content/strings/en.json`, "utf8"));
const fig = JSON.parse(readFileSync(`${HB}/content/figures.json`, "utf8"));

let added = 0;
for (const ch of Object.values(book.chapters)) {
  let sub = 0;
  for (const b of ch.blocks) {
    const wantsFig = b.type === "steps" || ((b.type === "prose" || b.type === "ai") && !b.diagram);
    if (!wantsFig || b.figure) continue;
    const id = `${b.id}-img`;
    b.figure = id;
    sub++;
    const s = str[b.id] || {};
    if (!fig[id]) {
      fig[id] = { ref: `${ch.number}.${sub}`, placeholder: (s.heading || s.title || "screenshot").replace(/<[^>]+>/g, "").slice(0, 40) };
      added++;
    }
  }
}
writeFileSync(`${HB}/content/book.json`, JSON.stringify(book, null, 2) + "\n");
writeFileSync(`${HB}/content/figures.json`, JSON.stringify(fig, null, 2) + "\n");
const total = Object.values(book.chapters).reduce((n, c) => n + c.blocks.filter((b) => b.figure).length, 0);
console.log(`added ${added} figure slots; total figures referenced by blocks: ${total}`);
