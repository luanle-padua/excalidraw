# Canvas M — Participant Guide (web)

An interactive, responsive web tutorial that teaches a **meeting participant** how to
use **Canvas M** (MCM), MAP-GROUP's realtime meeting whiteboard. This is the *web*
deliverable — separate from the print handbook in `docs/handbook/` (do not edit that one).

## Art direction — "Glass-Desk Atelier"

The product itself ships dark-by-default with frosted "Glass-Desk" panels, so the guide
leans into that identity rather than the print monograph's architectural look:

- **Dark-first, frosted glass.** Deep ink canvas (`#0f0f15`) with a soft purple/gold aurora
  backdrop and translucent, `backdrop-filter`-blurred panels — it reads like the app's own UI.
  A one-tap **light theme** (refined cream `#f6f5f2`) is built in and remembered per device.
- **Editorial type pairing.** Fraunces (display serif) for headings gives it an authored,
  documentary feel; Manrope carries the UI; IBM Plex Mono labels parts, shortcuts and captions —
  deliberately *not* the generic Inter/Roboto template aesthetic.
- **On-brand, restrained colour.** Accent purple `#5e5ad8` / `#a8a5ff`; champagne gold
  `#b08d3e` is reserved exclusively for the **"Host-only"** asides so participants instantly
  recognise "not your job". Callouts (tip/note/warning) each have their own tint.
- **Product-honest content.** UI labels are pulled from the real app i18n
  (`excalidraw-app/i18n/mcm/en.ts`) and the real components, so the words in the guide match
  what users actually see (e.g. *"This device has no microphone — listen only"*).

## What's built

| State | Pages |
|-------|-------|
| **Full** | Front page · Ch 1 Signing in · Ch 2 Joining a meeting · Ch 3 Be seen & heard |
| **Scaffolded stubs** | Ch 4–18 (informative "what you'll learn" outline + cross-links) |

Interactive pieces: sticky multi-part sidebar with active-section highlight, smooth scroll,
client-side **search filter** (`/` to focus), **light/dark toggle**, progressive-disclosure
**tabs** (the 3 mic states, the 3 join paths, waiting-room outcomes) and **accordions**
(error messages), numbered **step lists**, **copyable shortcuts**, tip/note/warning + gold
**Host-only** callouts, labelled **screenshot placeholders** (styled frames, never broken
images), and a responsive layout with a slide-in mobile chapter drawer.

## File structure

```
docs/handbook-web/
├── index.html              # Front page (hero + full chapter map)
├── README.md               # this file
├── assets/
│   ├── icon.svg            # Canvas M mark, recoloured on-brand (also the favicon)
│   └── wordmark.svg        # "Canvas M" wordmark (uses currentColor so it themes)
├── css/
│   ├── theme.css           # design tokens, dark/light themes, typography
│   ├── layout.css          # top bar, sticky sidebar, content grid, responsive
│   └── components.css       # callouts, steps, tabs, accordions, frames, cards…
├── js/
│   ├── toc.js              # single source of truth for the 18-chapter TOC (i18n-ready)
│   ├── app.js              # builds the shell + all interactions (no build step)
│   └── gen-stubs.mjs       # dev tool: regenerates Ch 4–18 stubs from toc.js
└── chapters/
    ├── 01-signing-in.html  # full
    ├── 02-joining.html     # full
    ├── 03-seen-heard.html  # full
    └── 04…18-*.html        # stubs (generated)
```

> `js/shot.mjs` / `js/shot2.mjs` are throwaway Playwright capture scripts used during
> development; they can be deleted.

## How to run / preview

It's plain static HTML/CSS/JS — **no build, no dependencies, no install.** Any static
server works (a server is needed only so the fonts and relative paths resolve cleanly;
opening `index.html` from disk also works for everything except the web fonts).

```bash
cd docs/handbook-web

# pick any one:
python -m http.server 8099        # → http://localhost:8099
npx serve .                       # → prints a local URL
```

Then open the printed URL. Theme choice is saved in `localStorage`.

## Adding the real screenshots later

Each placeholder is a `.frame` block: a window chrome bar, a dotted "stage", and a caption.
Replace the `.frame-stage` contents with `<img src="../assets/shots/xxx.png" alt="…">` (and
drop the placeholder label) to swap in a real capture without touching layout.

## Internationalisation

Chapter titles/descriptions live only in `js/toc.js`, and prose is kept in plain readable
HTML, so an EN→VI/KO pass is a localised copy of `toc.js` + the chapter bodies. It's
componentised enough to translate but intentionally not over-abstracted.

## Notes for the maintainer

- **Brand assets:** I recoloured copies of the wordmark/icon into `assets/` because the
  source files in `docs/handbook/assets/` are not present on this branch (they're untracked
  in the main checkout). If you prefer the canonical files, copy them in and re-tint.
- **Open question — depth of stubs:** Ch 4–18 currently ship as outline stubs. If you want
  any of them fully written now (vs. when the product settles), point me at the chapter.
