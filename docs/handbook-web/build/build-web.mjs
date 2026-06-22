// build-web.mjs — generate the web handbook from the SAME content source as the
// PDF (docs/handbook/content/*.json). One authoring source → both outputs.
//   node docs/handbook-web/build/build-web.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // handbook-web/build
const HB = resolve(SCRIPT_DIR, "../../handbook"); // canonical content lives here
const WEB = resolve(SCRIPT_DIR, ".."); // handbook-web

const book = JSON.parse(readFileSync(`${HB}/content/book.json`, "utf8"));
const str = JSON.parse(readFileSync(`${HB}/content/strings/en.json`, "utf8"));
try { Object.assign(str, JSON.parse(readFileSync(`${HB}/content/strings/en-extra.json`, "utf8"))); } catch {}
const fig = JSON.parse(readFileSync(`${HB}/content/figures.json`, "utf8"));
// Per-figure crop rectangles (kept in one durable file so re-assembles don't wipe them).
try {
  const crops = JSON.parse(readFileSync(`${HB}/content/figure-crops.json`, "utf8"));
  for (const [k, c] of Object.entries(crops)) if (fig[k] && Array.isArray(c)) fig[k].crop = c;
} catch {}

const pad2 = (n) => String(n).padStart(2, "0");
// slug = chapter number + kebab'd title, derived dynamically so any chapter count works
const kebab = (s) => String(s || "").toLowerCase().replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chapter";
const slugFor = (n) => `${pad2(n)}-${kebab((str[`ch${n}-open`] || {}).title)}`;
const partOf = (ch) => book.parts.find((p) => p.id === ch.part);
const partIx = (id) => book.parts.findIndex((p) => p.id === id) + 1;

// flat ordered chapter list (for prev/next + sidebar)
const FLAT = [];
for (const p of book.parts) for (const cid of p.chapters) FLAT.push(book.chapters[cid]);

// ---------- shared HTML pieces ----------
const ICON = {
  info: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  host: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4Z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>',
};
const escAttr = (s) => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function frameWeb(figId) {
  const f = fig[figId] || {};
  const cap = `<div class="frame-cap">${f.ref ? `<b>Fig ${f.ref}</b> ` : ""}${f.placeholder || ""}</div>`;
  let stage;
  if (f.shot) {
    const src = `../assets/captures/${f.shot}.png`;
    const alt = escAttr(f.placeholder || "Canvas M screenshot");
    if (Array.isArray(f.crop) && f.crop.length === 4) {
      // crop = [x, y, w, h] in % of the source image (captures are 2880×1800 = 1.6:1).
      // Show exactly that sub-rectangle, zoomed to fill the frame — so each figure
      // focuses on the region its caption is about instead of a tiny full desktop.
      const [x, y, w, h] = f.crop;
      const ar = ((1.6 * w) / h).toFixed(4);
      const sizeX = (10000 / w).toFixed(2);
      const posX = w >= 100 ? "50" : ((x / (100 - w)) * 100).toFixed(2);
      const posY = h >= 100 ? "50" : ((y / (100 - h)) * 100).toFixed(2);
      stage = `<div class="frame-stage shot crop" role="img" aria-label="${alt}" style="aspect-ratio:${ar};background-image:url(${src});background-size:${sizeX}%;background-position:${posX}% ${posY}%"></div>`;
    } else {
      stage = `<div class="frame-stage shot"><img src="${src}" alt="${alt}" loading="lazy"></div>`;
    }
  } else {
    stage = `<div class="frame-stage"><div class="ph-label"><b>${f.placeholder || figId}</b><small>screenshot pending</small></div></div>`;
  }
  return `<figure class="frame">${stage}${cap}</figure>`;
}
const norm = (n) => !n ? null : typeof n === "string" ? { tag: "Note", html: n } : { tag: n.tag || n.lead || n.label || "Note", html: n.html || n.text || n.body || "", variant: n.variant };
const callout = (raw) => { const n = norm(raw); if (!n || !n.html) return ""; return `<div class="callout ${n.variant === "warn" ? "warn" : "note"}">${n.variant === "warn" ? ICON.warn : ICON.info}<div class="body"><span class="lbl">${n.tag}</span><p class="m0">${n.html}</p></div></div>`; };
const hostCallout = (raw) => { const h = norm(raw); if (!h || !h.html) return ""; return `<div class="callout host">${ICON.host}<div class="body"><span class="lbl">${typeof raw === "string" ? "Host-only" : h.tag}</span><p class="m0">${h.html}</p></div></div>`; };

// ---------- block → section ----------
const SECT = {
  prose: (b, s) => `<section id="${b.id}"><h2>${s.heading}</h2>
    <p class="lead">${s.lead}</p>${s.body ? `<p>${s.body}</p>` : ""}
    ${s.pull ? `<blockquote class="pull">${s.pull}</blockquote>` : ""}
    ${b.diagram && s.diagram ? `<div class="diagram"><span class="dl">${s.diagram.label || ""}</span> ${s.diagram.cap || ""}</div>` : ""}
    ${callout(s.note)}</section>`,
  ai: (b, s) => SECT.prose(b, s),
  steps: (b, s) => `<section id="${b.id}"><h2>${s.heading}</h2>
    <ol class="steps">${s.steps.map((x) => `<li>${x}</li>`).join("")}</ol>
    ${s.outcome ? `<p class="outcome">→ ${s.outcome}</p>` : ""}
    ${callout(s.note)}${b.figure ? frameWeb(b.figure) : ""}${hostCallout(s.host)}</section>`,
  gallery: (b, s) => `<section id="${b.id}"><h2>${s.heading}</h2>
    <div class="tabs"><div class="tablist" role="tablist">${(s.tiles || []).map((t, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${t.state}</button>`).join("")}</div>
    ${(s.tiles || []).map((t, i) => `<div class="tabpanel" role="tabpanel"${i ? " hidden" : ""}><p>${t.cap}</p>${(b.figures || [])[i] ? frameWeb(b.figures[i]) : ""}</div>`).join("")}</div>
    ${s.useWhen ? `<p class="outcome">${s.useWhen}</p>` : ""}</section>`,
  plate: (b, s) => `<section id="${b.id}">${s.eyebrow ? `<span class="eyebrow">${s.eyebrow}</span>` : ""}${frameWeb(b.figure)}
    ${s.legend ? `<ol class="legend">${s.legend.map((l) => `<li><b>${l.n}</b> ${l.text}</li>`).join("")}</ol>` : ""}</section>`,
  troubleshoot: (b, s) => `<section id="${b.id}"><h2>${s.heading}</h2>
    <div class="accordion">${s.rows.map((r) => `<details><summary>${r.sym} — <em>${r.cause}</em>${ICON.chev}</summary><div class="acc-body"><p>${r.fix} <span class="ref">→ ${r.ref}</span></p></div></details>`).join("")}</div>${callout(s.note)}</section>`,
  reftable: (b, s) => `<section id="${b.id}"><h2>${s.heading}</h2>
    <table class="ref"><thead><tr>${(s.cols || []).map((c) => `<th>${c}</th>`).join("")}</tr></thead>
    <tbody>${(s.rows || []).map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="k"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>${callout(s.note)}${hostCallout(s.host)}</section>`,
};
const ALIAS = { ai: "ai", viewer: "plate", figure: "plate", "reference-table": "reftable" };
const sectFor = (t) => SECT[t] || SECT[ALIAS[t]];

// ---------- page ----------
function chapterPage(ch, idx) {
  const slug = slugFor(ch.number);
  const open = str[`ch${ch.number}-open`] || {};
  const part = partOf(ch);
  const sections = ch.blocks.filter((b) => b.type !== "opener").map((b) => {
    const fn = sectFor(b.type);
    return fn ? fn(b, str[b.id] || {}) : "";
  }).join("\n");
  const prev = FLAT[idx - 1], next = FLAT[idx + 1];
  const navLink = (c, dir) => c ? `<a${dir === "next" ? ' class="next"' : ""} href="${slugFor(c.number)}.html"><span>${dir === "next" ? "Next →" : "← Previous"}</span><strong>${c.number} · ${(str[`ch${c.number}-open`] || {}).title || ""}</strong></a>` : "<span></span>";
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ch.number} · ${open.title} — Canvas M</title>
<link rel="icon" href="../assets/icon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,560&family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/theme.css"><link rel="stylesheet" href="../css/layout.css"><link rel="stylesheet" href="../css/components.css">
</head>
<body data-page="chapter" data-base=".." data-slug="${slug}">
<!-- GENERATED by build/build-web.mjs from docs/handbook/content — do not hand-edit -->
<div class="shell"><main class="content"><div class="content-inner">
<nav class="crumb"><a href="../index.html">Guide</a><span class="sep">/</span><span>Part ${partIx(part.id)} · ${part.title}</span><span class="sep">/</span><span>${pad2(ch.number)}</span></nav>
<span class="eyebrow">Part ${partIx(part.id)} · ${part.title}</span>
<h1>${open.title}</h1>
<p class="lead">${open.standfirst || ""}</p>
${sections}
<nav class="chapter-nav">${navLink(prev, "prev")}${navLink(next, "next")}</nav>
</div></main></div>
<script src="../js/toc.js"></script><script src="../js/app.js"></script>
</body></html>`;
}

// ---------- toc.js ----------
function buildToc() {
  const parts = book.parts.map((p) => {
    const chapters = p.chapters.map((cid) => {
      const ch = book.chapters[cid];
      const o = str[`ch${ch.number}-open`] || {};
      const desc = (o.standfirst || "").replace(/<[^>]+>/g, "").split(/[—.]/)[0].trim().slice(0, 48);
      return `      { n: ${ch.number}, slug: "${slugFor(ch.number)}", title: ${JSON.stringify(o.title || "")}, desc: ${JSON.stringify(desc)}, ready: true },`;
    }).join("\n");
    return `  {\n    part: ${partIx(p.id)}, label: ${JSON.stringify(p.title)},\n    chapters: [\n${chapters}\n    ],\n  },`;
  }).join("\n");
  return `/* GENERATED by build/build-web.mjs from docs/handbook/content/book.json. */\nwindow.MCM_TOC = [\n${parts}\n];\n`;
}

// ---------- run ----------
// 1. back up the hand-authored chapters once
const bespoke = `${WEB}/chapters-bespoke`;
if (!existsSync(bespoke)) {
  mkdirSync(bespoke, { recursive: true });
  for (const f of readdirSync(`${WEB}/chapters`)) if (f.endsWith(".html")) cpSync(`${WEB}/chapters/${f}`, `${bespoke}/${f}`);
  console.log("backed up bespoke chapters → chapters-bespoke/");
}
// 2. copy real captures into the web (self-contained)
if (existsSync(`${HB}/assets/captures`)) {
  cpSync(`${HB}/assets/captures`, `${WEB}/assets/captures`, { recursive: true });
  console.log("copied captures → web/assets/captures");
}
// 3. toc + chapters
writeFileSync(`${WEB}/js/toc.js`, buildToc());
mkdirSync(`${WEB}/chapters`, { recursive: true });
// clear stale chapter html (slugs change when chapters are re-titled/re-ordered)
for (const f of readdirSync(`${WEB}/chapters`)) if (f.endsWith(".html")) rmSync(`${WEB}/chapters/${f}`);
FLAT.forEach((ch, i) => writeFileSync(`${WEB}/chapters/${slugFor(ch.number)}.html`, chapterPage(ch, i)));
console.log(`generated toc.js + ${FLAT.length} chapter pages`);
console.log("DONE");
