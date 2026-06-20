// build-web.mjs — generate the web handbook from the SAME content source as the
// PDF (docs/handbook/content/*.json). One authoring source → both outputs.
//   node docs/handbook-web/build/build-web.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "fs";

const HB = "C:/LUAN/19.CanvasMeet/docs/handbook"; // canonical content lives here
const WEB = "C:/LUAN/19.CanvasMeet/docs/handbook-web";

const book = JSON.parse(readFileSync(`${HB}/content/book.json`, "utf8"));
const str = JSON.parse(readFileSync(`${HB}/content/strings/en.json`, "utf8"));
try { Object.assign(str, JSON.parse(readFileSync(`${HB}/content/strings/en-extra.json`, "utf8"))); } catch {}
const fig = JSON.parse(readFileSync(`${HB}/content/figures.json`, "utf8"));

const SLUG = {
  1: "01-signing-in", 2: "02-joining", 3: "03-seen-heard", 4: "04-video-layouts",
  5: "05-presence", 6: "06-backgrounds", 7: "07-canvas-basics", 8: "08-stickers",
  9: "09-translate-bot", 10: "10-screen-share", 11: "11-library", 12: "12-viewers",
  13: "13-chat", 14: "14-captions", 15: "15-dashboard", 16: "16-settings",
  17: "17-leaving", 18: "18-troubleshooting", 19: "19-projects", 20: "20-scheduling",
  21: "21-inviting-clients", 22: "22-hosting",
};
const pad2 = (n) => String(n).padStart(2, "0");
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
function frameWeb(figId) {
  const f = fig[figId] || {};
  const cap = `<div class="frame-cap">${f.ref ? `<b>Fig ${f.ref}</b> ` : ""}${f.placeholder || ""}</div>`;
  const stage = f.shot
    ? `<div class="frame-stage"><img src="../assets/captures/${f.shot}.png" alt="" loading="lazy"></div>`
    : `<div class="frame-stage"><div class="ph-label"><b>${f.placeholder || figId}</b><small>screenshot pending</small></div></div>`;
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
  const slug = SLUG[ch.number];
  const open = str[`ch${ch.number}-open`] || {};
  const part = partOf(ch);
  const sections = ch.blocks.filter((b) => b.type !== "opener").map((b) => {
    const fn = sectFor(b.type);
    return fn ? fn(b, str[b.id] || {}) : "";
  }).join("\n");
  const prev = FLAT[idx - 1], next = FLAT[idx + 1];
  const navLink = (c, dir) => c ? `<a${dir === "next" ? ' class="next"' : ""} href="${SLUG[c.number]}.html"><span>${dir === "next" ? "Next →" : "← Previous"}</span><strong>${c.number} · ${(str[`ch${c.number}-open`] || {}).title || ""}</strong></a>` : "<span></span>";
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
      return `      { n: ${ch.number}, slug: "${SLUG[ch.number]}", title: ${JSON.stringify(o.title || "")}, desc: ${JSON.stringify(desc)}, ready: true },`;
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
FLAT.forEach((ch, i) => writeFileSync(`${WEB}/chapters/${SLUG[ch.number]}.html`, chapterPage(ch, i)));
console.log(`generated toc.js + ${FLAT.length} chapter pages`);
console.log("DONE");
