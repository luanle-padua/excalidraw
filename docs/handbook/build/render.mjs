// render.mjs — single content source → print HTML. Node stdlib only.
//   node docs/handbook/build/render.mjs
// Emits docs/handbook/dist/en/index.html with automatic page numbers,
// running feet, and a generated table of contents.
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const DIR = "C:/LUAN/19.CanvasMeet/docs/handbook";
const book = JSON.parse(readFileSync(`${DIR}/content/book.json`, "utf8"));
const str = JSON.parse(readFileSync(`${DIR}/content/strings/en.json`, "utf8"));
try {
  Object.assign(str, JSON.parse(readFileSync(`${DIR}/content/strings/en-extra.json`, "utf8")));
} catch {}
const fig = JSON.parse(readFileSync(`${DIR}/content/figures.json`, "utf8"));

const pad2 = (n) => String(n).padStart(2, "0");
const partOf = (ch) => book.parts.find((p) => p.id === ch.part);
const partIndex = (id) => book.parts.findIndex((p) => p.id === id) + 1;
const partSlug = (ch) => {
  const p = partOf(ch);
  return `${partIndex(p.id)} / ${p.title}`;
};

const tierOf = (id) => (fig[id] || {}).tier || "column";
function frame(figId, knockout = false) {
  const f = fig[figId] || {};
  const cls = knockout ? "pin pin--knockout" : "pin";
  const pins = (f.pins || [])
    .map((p) => `<span class="${cls}" style="left:${p.x}%;top:${p.y}%">${p.n}</span>`)
    .join("");
  // real screenshots: no pin overlay (placeholder pin coords don't match the
  // real image; the rail/annotation legend carries the numbers)
  if (f.shot)
    return `<div class="frame frame--shot"><img src="../../assets/captures/${f.shot}.png" alt=""></div>`;
  return `<div class="frame" data-placeholder="${f.placeholder || figId}">${pins}</div>`;
}
// notes/asides may arrive as a {tag,html,variant} object OR a bare string —
// normalise both so nothing renders "undefined".
const norm = (n) =>
  !n ? null : typeof n === "string"
    ? { tag: "Note", html: n }
    : { tag: n.tag || n.lead || n.label || "Note", html: n.html || n.text || n.body || "", variant: n.variant };
const note = (raw) => {
  const n = norm(raw);
  if (!n || !n.html) return "";
  return `<div class="note${n.variant === "warn" ? " note--warn" : ""}"><span class="note__tag">${n.tag}</span><p>${n.html}</p></div>`;
};
const hostAside = (raw) => {
  const h = norm(raw);
  if (!h || !h.html) return "";
  return `<div class="sidenote sidenote--host"><span class="sidenote__lbl">${typeof raw === "string" ? "Host-only" : h.tag}</span>${h.html}</div>`;
};

// full-width visual helpers — single-column layout, no marginalia rail, so the
// content uses the whole text area and asides/figures stack below.
const bigFig = (b, s) => {
  if (!b.figure) return "";
  const f = fig[b.figure] || {};
  return `<figure class="fig fig--wide">${frame(b.figure)}<figcaption class="fig__cap"><span class="fig__lbl">Fig ${f.ref || ""}</span> ${s.figcap || f.placeholder || ""}</figcaption></figure>`;
};
const diagramBlock = (b, s) => !b.diagram ? "" : `<div class="diagram diagram--wide">${(s.diagram || {}).label || ""}<span class="cap">${(s.diagram || {}).cap || ""}</span></div>`;
const hostNote = (raw) => {
  const h = norm(raw);
  if (!h || !h.html) return "";
  return `<div class="note note--host"><span class="note__tag">${typeof raw === "string" ? "Host-only" : h.tag}</span><p>${h.html}</p></div>`;
};

// ---- partials: type → inner HTML (single column; visuals + notes flow below)
const T = {
  opener: (b, s, ch) => `<div class="opener">
      <p class="kicker">${s.eyebrow || ""}</p>
      <span class="numeral">${pad2(ch.number)}</span>
      <h1 class="title">${s.title}</h1>
      <div class="rule"></div>
      <p class="standfirst">${s.standfirst || ""}</p>
      <div class="titleblock">
        <div><span class="k">Audience</span><span class="v">${ch.audience || book.meta.audience}</span></div>
        <div><span class="k">Edition</span><span class="v">${book.meta.rev}</span></div>
      </div></div>`,

  steps: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}
      <h2>${s.heading}</h2>
      <ol class="steps">${s.steps.map((x) => `<li>${x}</li>`).join("")}</ol>
      ${s.outcome ? `<p class="outcome">${s.outcome}</p>` : ""}
      ${note(s.note)}${hostNote(s.host)}${bigFig(b, s)}`,

  prose: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}
      <h2>${s.heading}</h2>
      <p class="lead-in">${s.lead}</p>${s.body ? `<p>${s.body}</p>` : ""}
      ${s.pull ? `<blockquote class="pull">${s.pull}</blockquote>` : ""}
      ${b.diagram ? diagramBlock(b, s) : bigFig(b, s)}${note(s.note)}${hostNote(s.host)}`,

  plate: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}
      <figure class="fig fig--wide">${frame(b.figure)}${s.cap ? `<figcaption class="fig__cap"><span class="fig__lbl">Fig ${(fig[b.figure] || {}).ref || ""}</span> ${s.cap}</figcaption>` : ""}</figure>
      ${s.legend ? `<ol class="legend-row">${(s.legend || []).map((l) => `<li><span class="n">${l.n}</span><span>${l.text}</span></li>`).join("")}</ol>` : ""}`,

  gallery: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}<h2>${s.heading}</h2>
      <div class="gallery" style="--cols:${b.cols || 3}">
        ${(s.tiles || []).map((t, i) => `<figure class="fig">${frame((b.figures || [])[i] || "")}<figcaption class="fig__cap"><span class="state">${t.state}</span><br>${t.cap}</figcaption></figure>`).join("")}
      </div>
      ${s.useWhen ? `<p class="use-when">${s.useWhen}</p>` : ""}`,

  troubleshoot: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}
      <h2>${s.heading}</h2>
      <table><thead><tr><th>Symptom</th><th>Likely cause</th><th>Fix</th><th>See</th></tr></thead>
      <tbody>${s.rows.map((r) => `<tr><td class="sym">${r.sym}</td><td>${r.cause}</td><td>${r.fix}</td><td class="ref">→ ${r.ref}</td></tr>`).join("")}</tbody></table>
      ${note(s.note)}${hostNote(s.host)}`,

  // generic hairline reference table: { cols:[...], rows:[[...]] }
  reftable: (b, s) => `${b.kicker ? `<p class="h-eyebrow">${s.eyebrow || ""}</p>` : ""}
      <h2>${s.heading}</h2>
      <table><thead><tr>${(s.cols || []).map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${(s.rows || []).map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="sym"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>
      ${note(s.note)}${hostNote(s.host)}`,
};

// type aliases → reuse an existing partial + layout
const ALIAS = { ai: "prose", viewer: "plate", figure: "plate", "reference-table": "reftable" };
const partial = (type) => T[type] || T[ALIAS[type]];

// ---- front-matter + divider HTML (each a full-page .sheet) ----
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const coverHtml = () => {
  const s = str.cover;
  return `<div class="cover">
    <img class="cover__mark" src="../../assets/wordmark.svg" alt="${book.meta.title}">
    <p class="cover__kicker">${s.kicker}</p>
    <h1 class="cover__title">${s.title}</h1>
    <p class="cover__sub">${s.sub}</p>
    <p class="cover__foot">${s.foot}</p></div>`;
};
const tocHtml = () => {
  const rows = book.parts.map((p) => {
    const head = `<li class="toc-part"><span>${partIndex(p.id)} · ${p.title}</span></li>`;
    const items = p.chapters.map((cid) => {
      const ch = book.chapters[cid];
      const t = (str[`${cid}-open`] || {}).title || cid;
      return `<li class="toc-item"><a href="#ch${ch.number}"><span class="t">${pad2(ch.number)}&nbsp;&nbsp;${t}</span></a></li>`;
    }).join("");
    return head + items;
  }).join("");
  return `<p class="h-eyebrow">Canvas M · ${book.meta.subtitle}</p><h2>${(str.toc || {}).heading || "Contents"}</h2><ul class="toc-list">${rows}</ul>`;
};
const cardHtml = (block) => {
  const s = str[block.id];
  return `<p class="h-eyebrow">${s.eyebrow}</p><h2>${s.heading}</h2><p class="card__lead">${s.lead}</p>
    <div class="card" style="--cells:${block.cells || 3}">
      ${s.cells.map((c) => `<section><h3 class="card__h">${c.h}</h3><ul>${c.items.map((it) => `<li><span class="k">${it.k}</span><span>${it.html}</span></li>`).join("")}</ul></section>`).join("")}
    </div>`;
};
const dividerHtml = (p) => {
  const items = p.chapters.map((cid) => {
    const ch = book.chapters[cid];
    const t = (str[`${cid}-open`] || {}).title || cid;
    return `<li><span class="cn">${pad2(ch.number)}</span><span>${t}</span></li>`;
  }).join("");
  return `<div class="divider"><span class="numeral numeral--ghost">${partIndex(p.id)}</span>
    <p class="part-label">${p.label}</p><h2 class="part-title">${p.title}</h2>
    <ul class="chapter-list">${items}</ul></div>`;
};

// ---- assemble the FLOWING body (Paged.js paginates it) ----
const LIMIT = +(process.env.LIMIT || 0); // 0 = all chapters; >0 = first N (testing)
let body = `<section class="sheet sheet--cover layout--plate is-cover">${coverHtml()}</section>\n`;
body += `<section class="sheet toc-sheet layout--table">${tocHtml()}</section>\n`;
for (const fm of book.frontmatter) if (fm.type === "card") body += `<section class="sheet layout--card">${cardHtml(fm)}</section>\n`;

for (const part of book.parts) {
  const chs = part.chapters.map((c) => book.chapters[c]).filter((ch) => !LIMIT || ch.number <= LIMIT);
  if (!chs.length) continue;
  body += `<section class="sheet layout--divider" data-rh="${esc(part.title)}">${dividerHtml(part)}</section>\n`;
  for (const ch of chs) {
    const title = (str[`ch${ch.number}-open`] || {}).title || `ch${ch.number}`;
    const op = ch.blocks.find((b) => b.type === "opener") || { id: `ch${ch.number}-open` };
    body += `<section class="sheet layout--opener" id="ch${ch.number}" data-rh="${esc(title)}">${T.opener(op, str[op.id] || {}, ch)}</section>\n`;
    let firstContent = true;
    for (const b of ch.blocks) {
      if (b.type === "opener") continue;
      const fn = partial(b.type);
      if (!fn) continue;
      if (firstContent) { b.kicker = true; firstContent = false; } // cap kickers at 1/chapter
      body += `<section class="block layout--${b.layout}" data-rh="${esc(title)}">${fn(b, str[b.id] || {}, ch)}</section>\n`;
    }
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${book.meta.title} — ${book.meta.subtitle}</title>
<link rel="icon" type="image/svg+xml" href="../../assets/icon2.svg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..500&family=Manrope:wght@300..800&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+KR:wght@300..700&family=Noto+Serif+KR:wght@300..600&display=swap">
<link rel="stylesheet" href="book-flat.css">
<link rel="stylesheet" href="../../styles/print-paged.css">
</head>
<body>
<!-- GENERATED by build/render.mjs (Paged.js flowing) — do not hand-edit -->
<div class="book">
${body}
</div>
<script>window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };</script>
<script src="../../assets/pagedjs/paged.polyfill.js"></script>
</body>
</html>`;

mkdirSync(`${DIR}/dist/en`, { recursive: true });
// Paged.js's CSS parser doesn't grok @layer / @import layer() — flatten the
// layered partials into one plain stylesheet for the paged document.
const CSS_ORDER = [
  "1-tokens.css", "2-base.css", "3-objects.css",
  "4-layouts/layout--opener.css", "4-layouts/layout--divider.css", "4-layouts/layout--prose.css",
  "4-layouts/layout--steps.css", "4-layouts/layout--plate.css", "4-layouts/layout--gallery.css",
  "4-layouts/layout--table.css", "4-layouts/layout--card.css", "5-blocks.css",
];
writeFileSync(`${DIR}/dist/en/book-flat.css`, CSS_ORDER.map((f) => readFileSync(`${DIR}/styles/${f}`, "utf8")).join("\n"));
writeFileSync(`${DIR}/dist/en/index.html`, html);
const blockCount = (body.match(/class="block /g) || []).length;
console.log(`rendered flowing doc${LIMIT ? ` (LIMIT ${LIMIT})` : ""}: ${blockCount} content blocks → dist/en/index.html`);
