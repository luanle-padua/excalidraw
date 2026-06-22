# Handbook-Web — Redesign Progress Tracker

> **Crash-safe work log.** Update this file as steps complete so any session (or any teammate) can resume without re-deriving state. Last updated: **2026-06-22**.

## What this work is

Migrating `docs/handbook-web/` (the participant + host web guide, 22 chapters) to:

1. **One content source** — pages are GENERATED from `docs/handbook/content/*.json` (the SAME source as the print PDF) via `build/build-web.mjs`. Do not hand-edit `chapters/*.html`; edit the content JSON and rebuild.
2. **Editorial / Müller-Brockmann redesign** — light "paper" default (dark is a variant), Swiss 12-column modular grid, Fraunces/Manrope/IBM Plex Mono, flat accent purple, gold reserved for Host-only. A toggleable grid overlay (`G` key).

## Build / preview

```bash
cd docs/handbook-web
node build/build-web.mjs                 # regenerate toc.js + 22 chapters from content JSON
python -m http.server 8099               # preview → http://localhost:8099
```

## Status board

| # | Task | State | Notes |
| --- | --- | --- | --- |
| 1 | Editorial palette + grid tokens in `theme.css` | ✅ done | light-paper default + dark variant |
| 2 | `grid.css` — `.doc`/`.band`/`.col-*`/`.guides` overlay + toggle | ✅ done | reads the same `:root` vars as content |
| 3 | `app.js` — grid toggle, `G` key, numbered column guides, scroll-spy, tabs | ✅ done |  |
| 4 | **Wire grid into templates** (link `grid.css`, emit `.doc`+`.guides`, col classes) | ✅ done | was the INTERRUPTED step; finished 06-22 |
| 5 | Content-integrity check: generated vs `chapters-bespoke/` backup | ✅ done | 100% word parity on all 22 chapters — no regression |
| 6 | Grid renders + overlay aligns (Playwright, ch01 dark) | ✅ done | columns + baseline align; toggle works |
| 7 | CSS audit — breakpoint mismatches, orphaned classes, contrast | ✅ done | Team A — findings triaged below; P0+P1 fixed |
| 8 | `README.md` rewrite to match redesigned reality | ✅ done | Team B — new art direction + single-source pipeline + 22 ch |
| 9 | Per-chapter render QA (empty sections, missing figures, unknown block types) | ✅ done | Team C — found the reference-table width bug (now fixed) |
| 10 | Visual QA: light theme + wide-figure chapter + mobile breakpoint | ✅ done | dark overlay, light ch12, 1150px band, 390px mobile all pass |
| 11 | Home page `index.html` grid alignment | ✅ decided | LEFT AS-IS — landing hero is intentionally not on `.doc`; looks right |

## Audit fixes applied (06-22)

- **P1 (self-inflicted): reference tables rendered narrow.** `WIDE` set tested the raw block type but tables use raw type `reference-table` (alias key), not `reftable`. → added `reference-table` to `WIDE`. All 24 ref tables now `col-wide` (was 0).
- **P0: 940–1200px measure cramp.** Grid collapsed at 1080 but sidebar at 940, leaving an over-narrow 8-col measure beside the 300px sidebar. → grid.css collapse breakpoint raised to **1200px**. Verified at 1150px: `.col-main` now full-width (755px), sidebar present.
- **P1: contrast.** `--ink-faint` `#8b9097`→`#6b7077` (AA on paper); added `--gold-ink` (`#7a5e1f` light / `#d8b873` dark) used for Host-only label TEXT, keeping `--gold` for borders/icons. (callout-label tint contrast was borderline — left as P2, body text is `--ink`.)
- **P2 hygiene:** removed duplicate `--accent-soft`; removed dead `--measure` var.

## Print PDF (06-22, second pass)

The print handbook (`docs/handbook/`) is a **separate sibling design** (its own ITCSS CSS in `handbook/styles/`, 12-col + 4mm-baseline grid, A4 page furniture) — shared brand DNA with the web, intentionally not pixel-identical. Decision: keep as siblings. PDF built via `node build/render.mjs && node build/print-paged.mjs` (needs the `playwright` npm pkg + chromium, now installed). Output: `handbook/dist/CanvasM-Handbook.pdf` (200 pp).

Fixes this pass:

- **Cover redesign** — was top-clustered with an empty lower half (auto-margins had no page height to work against). Now `.is-cover` fills the full sheet as a 3-zone flex column: masthead (wordmark + kicker over a hairline) pinned top, title block centred, colophon pinned to the foot over a gold rule. (`styles/4-layouts/layout--plate.css`)
- **`&amp;` double-escape** — ch9/ch14 titles were stored pre-escaped in the source while all others used raw `&`; `render.mjs esc()` then double-escaped them. Fixed the source titles (raw `&`) in `content/strings/en.json` + `content/draft/ch{9,14}.json`. Fixes both web and print. Rebuilt both.

## Known / deferred (optional, non-blocking)

- Orphaned `.band` / `.col-rail` / `.col-figure` in grid.css are unused by the generated markup (kept as future rail capability; safe to delete if you want lean CSS).
- Callout label tints (`--note`/`--warn`/`--tip` small mono caps on their soft fills) are borderline AA — body text is fine. Darken those hue vars if strict AA on labels is required.

## Key facts / gotchas (so a fresh session doesn't relearn)

- `chapters-bespoke/` is a **one-time backup** of the original hand-authored chapters. `build-web.mjs` only creates it if absent, then always regenerates `chapters/`. It is the safety net — never deleted by the build.
- Generated pages link CSS in this order: `theme → layout → grid → components`.
- Section block types map to grid width: prose/steps/ai/troubleshoot → `col-main` (8-col measure); plate/figure/gallery/reftable/viewer → `col-wide` (full type area). See `WIDE` set + `.replace("<section ", ...)` in `build-web.mjs`.
- Responsive: `grid.css` collapses columns at ≤1080px; `layout.css` collapses the sidebar shell at ≤940px. (Flagged for the CSS audit — possible seam between 940–1080px.)
- `build/build-web.mjs` references an optional `content/strings/en-extra.json` (wrapped in try/catch) — absent today, harmless.

## Resume checklist

If you're picking this up cold: read this table top-to-bottom, run the build + server above, open ch01, press `G` to confirm the grid still aligns, then take the first `⏳ todo`/`in progress` row.
