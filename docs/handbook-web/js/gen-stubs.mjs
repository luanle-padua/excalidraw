/* Build tool (run once): generates stub HTML for chapters that are not
   yet written in full. Reads the same TOC the site uses. Chapters marked
   ready:true are skipped (hand-authored). Run: node js/gen-stubs.mjs
   This file is a dev utility, not shipped to the browser. */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load TOC by evaluating toc.js (it assigns window.MCM_TOC).
const tocSrc = await readFile(join(__dirname, "toc.js"), "utf8");
const window = {};
new Function("window", tocSrc)(window);
const TOC = window.MCM_TOC;

// Flatten with neighbours for prev/next links.
const flat = [];
TOC.forEach((p) => p.chapters.forEach((c) => flat.push({ ...c, part: p.part, partLabel: p.label })));

// Short "what this chapter will cover" bullets per slug (kept here so stubs
// are informative rather than empty).
const outlines = {
  "04-video-layouts": ["The three video modes: Minimal, Filmstrip, Gallery.", "Pinning a speaker as the focus tile.", "Switching layouts from the header."],
  "05-presence": ["The floating presenter window — minimise, hide, reopen.", "Raise hand, send reactions, and follow another person's view.", "Following and being followed across the canvas."],
  "06-backgrounds": ["Blur your background (light / medium / strong) or pick a scene.", "Desktop-only background effects.", "Choosing video quality (Auto / Low / Medium / High) within the admin cap."],
  "07-canvas-basics": ["The toolbar and core drawing tools.", "Panning, zooming, and the navigation minimap.", "Realtime cursors and live edits across the room."],
  "08-stickers": ["Stickers, stamps, and revision clouds.", "Author badges — who drew what.", "Showing and hiding authorship."],
  "09-translate-bot": ["Translating selected text on the canvas.", "Asking the Canvas Bot (MCM Bot) about the design.", "Keeping translations fresh when text changes."],
  "10-screen-share": ["Sharing your screen and stopping.", "Popping the shared view into its own window.", "What happens when someone else is already presenting."],
  "11-library": ["The room file library — upload, search, and sort.", "Locking files and author chips.", "Dropping files onto the canvas."],
  "12-viewers": ["Opening PDFs page-by-page.", "Exploring IFC 3D models — storeys, sections, measure.", "Viewing DXF/CAD drawings with layers."],
  "13-chat": ["Sending messages, replies, and reactions.", "Mentioning a file with @ or the AI with @bot.", "Auto-translating the conversation."],
  "14-captions": ["Live captions while presenting.", "The live transcript / speech-to-text panel.", "Knowing when a meeting is being recorded."],
  "15-dashboard": ["Your home dashboard and project calendar.", "Notifications and meeting invitations.", "Meeting-starting-soon reminders."],
  "16-settings": ["Your profile and avatar.", "Account, security, and password.", "Preferences: language, theme, translation, captions, STT."],
  "17-leaving": ["Leaving the call vs leaving the meeting.", "Reviewing a finished meeting (read-only).", "The meeting log: transcript and AI summary."],
  "18-troubleshooting": ["Sign-in and connection fixes.", "Mic / camera problems.", "Files, viewers, and performance tips."],
};

const head = (title, desc) => `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Canvas M</title>
  <meta name="description" content="${desc}">
  <link rel="icon" href="../assets/icon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,560&family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/theme.css">
  <link rel="stylesheet" href="../css/layout.css">
  <link rel="stylesheet" href="../css/components.css">
</head>`;

function nav(prev, next) {
  const p = prev
    ? `<a href="${prev.slug}.html"><span>← Previous</span><strong>${prev.n} · ${prev.title}</strong></a>`
    : `<a class="disabled" href="#"><span>← Previous</span><strong>Start of the guide</strong></a>`;
  const n = next
    ? `<a class="next" href="${next.slug}.html"><span>Next →</span><strong>${next.n} · ${next.title}</strong></a>`
    : `<a class="next disabled" href="#"><span>Next →</span><strong>End of the guide</strong></a>`;
  return `<nav class="chapter-nav">${p}${n}</nav>`;
}

let written = 0;
for (let i = 0; i < flat.length; i++) {
  const c = flat[i];
  if (c.ready) continue; // hand-authored
  const prev = flat[i - 1];
  const next = flat[i + 1];
  const bullets = (outlines[c.slug] || []).map((b) => `<li>${b}</li>`).join("");
  const title = `${c.n} · ${c.title}`;
  const html = `${head(title, c.desc)}
<body data-page="chapter" data-base=".." data-slug="${c.slug}">

  <div class="shell">
    <main class="content">
      <div class="content-inner">

        <nav class="crumb">
          <a href="../index.html">Guide</a><span class="sep">/</span>
          <span>Part ${c.part} · ${c.partLabel}</span><span class="sep">/</span>
          <span>${String(c.n).padStart(2, "0")}</span>
        </nav>

        <span class="eyebrow">Part ${c.part} · ${c.partLabel}</span>
        <h1>${c.title}</h1>
        <p class="lead">${c.desc}.</p>

        <div class="stub-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          <div><strong>This chapter is being written.</strong> Chapters 1–3 are complete; the rest are filling in. Here's what this one will cover.</div>
        </div>

        <h2>What you'll learn</h2>
        <ul>${bullets || "<li>Coming soon.</li>"}</ul>

        <div class="callout note">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <div class="body">
            <span class="lbl">In the meantime</span>
            <p class="m0">Start with the finished chapters: <a href="01-signing-in.html">Signing in</a>, <a href="02-joining.html">Joining a meeting</a>, and <a href="03-seen-heard.html">Be seen &amp; heard</a>.</p>
          </div>
        </div>

        ${nav(prev, next)}

      </div>
    </main>
  </div>

  <script src="../js/toc.js"></script>
  <script src="../js/app.js"></script>
</body>
</html>
`;
  await writeFile(join(root, "chapters", `${c.slug}.html`), html, "utf8");
  written++;
}
console.log(`Generated ${written} stub chapter pages.`);
