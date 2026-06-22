# Print Handbook — Art Direction: "The Drawing Set"

> Crash-safe spec + progress tracker for the PDF redesign. Last updated 2026-06-22. Chosen direction (approved by Luân): **The Drawing Set**. The handbook is drafted like an architectural/engineering construction-document set — fitting because Canvas M is the tool for live BIM/CAD/IFC design reviews.

## Why this direction

The previous PDF read as the templated "AI editorial" default (warm cream + high-contrast serif + hairline broadsheet rules). "The Drawing Set" is grounded in Canvas M's real world and elevates assets already in the file (crop marks, titleblock, ghost numerals, blueprint placeholder grids). Sibling to the web guide (shared content + Fraunces/Manrope/ IBM Plex Mono + purple accent), NOT a twin.

## Token system

**Colour** — cool drafting palette, one technical accent + the gold signature:

- `--paper` neutral drafting white (NOT cream) · `--paper-2` cool trace-grey for diagram fields
- `--ink` cool graphite/charcoal (drawing lead)
- `--accent` brand purple `#5e5ad8` — links, live markers, sheet numbers, section coordinates
- `--blueprint` desaturated navy `#2f4a6b` — drawn linework, dimension lines, leaders
- `--gold` `#a8842f` — the ONE signature: chapter numeral only

**Type** (keep the 3 brand families; re-role mono as the structural voice):

- Display **Fraunces** — cover line, chapter/part titles, ghost numerals (the one expressive voice)
- Body **Manrope** — reading text
- Mono **IBM Plex Mono** — the drawing-annotation voice: sheet numbers, titleblocks, dimension labels, section coordinates, kickers, captions, table keys

**Layout** — the 12-col grid is the drawing field:

- Text in cols 1–8 (`--main`); cols 9–12 = the **annotation rail** (`--rail`): mono sidenotes, host-asides, drawn diagrams, figure legends — separated by a vertical hairline (rail line).
- Sections divided by **dimension lines** (hairline + end ticks + mono measure label).
- Each chapter = a **sheet** with a sheet number; opener carries a full **titleblock**.

**Signature** — the drawing **titleblock + sheet-number system + dimensioned annotation rail**. The whole book reads as a measured drawing. The cover's titleblock band + the recurring sheet stamp is the memorable mark.

**Risk taken** — committing the entire body to the annotation-rail grid + dimension-line section dividers (a strongly technical, non-editorial move).

## Build / preview

```bash
cd docs/handbook
node build/render.mjs            # content → dist/en/index.html + book-flat.css
node build/print-paged.mjs       # → dist/CanvasM-Handbook.pdf  (+ dist/_pg-NN.png previews)
```

`LIMIT=2 node build/render.mjs` renders only the first 2 chapters (fast iteration).

## Status board

| # | Step | State |
| --- | --- | --- |
| 1 | Tokens — cool palette + `--blueprint` + sheet tokens | ✅ |
| 2 | Objects — `.dimline`, `.sheetno`, `.coord`, `.col-side` rail spine, `.titleblock--full` | ✅ |
| 3 | render.mjs — wire `.grid`/`.col-main`/`.col-side` annotation rail (146 rails, 376 notes) | ✅ |
| 4 | Cover — title sheet (masthead + sheet stamp + dimension line + titleblock foot) | ✅ |
| 5 | Opener — drawing sheet (CHAPTER n / SHEET p.cc head + gold numeral + 6-cell titleblock) | ✅ |
| 6 | Divider — part drawing-index sheet (ghost numeral + SHEET INDEX + sheet-numbered list) | ✅ |
| 7 | Build + screenshot critique (cover, divider, opener, rail spread) | ✅ all pass |
| 8 | Body text → flush-left ragged-right (Müller-Brockmann; kills justify rivers) | ✅ |

**Pass 1 shipped 2026-06-22** — full 198-page PDF at `dist/CanvasM-Handbook.pdf`. Possible later refinements (not blocking): hand-drawn orthographic diagrams in the rail (replace placeholder frames), per-section `.coord` before each h2, leader lines from figure callouts to the rail legend.

## Notes

- Doing this as a focused solo build with screenshot critique, not parallel agents: art direction must stay coherent; the files (tokens→objects→layouts→render) are tightly coupled and taste-driven, so coherence beats parallelism here.
- Sibling web guide lives in `docs/handbook-web/` — do not regress it; shared content source is `docs/handbook/content/`.
