# Canvas M — Real screenshot captures

Real screenshots from the published app (https://map-canvasm.pages.dev/),
captured **dark theme, English UI, host account 루안**. Scope: the whole app
**except admin** — project management, dashboard & meetings, in-meeting canvas,
client invites.

## Naming convention

```
captures/<NN-area>/<screen>[--<state>].png
```

- `NN-area` — a two-digit-ordered area folder, so the set reads as a tour.
- `screen` — kebab-case screen name.
- `--state` — optional variant (e.g. `--empty`, `--open`).
- Capture profile: 1440×900, deviceScaleFactor 2 (≈2880px wide), dark, EN.

To **re-capture or edit**: replace the PNG in place (keep the path). The
handbook wires figures by this path via the `shot` field in
`content/figures.json` (`"shot": "06-meeting/shell"` → this file). No code change
needed to swap an image.

## Index

| Area | File | Screen | → handbook figure | Notes |
|---|---|---|---|---|
| 01 auth | `01-auth/login.png` | Sign-in screen | `ch1-login` | |
| 02 dashboard | `02-dashboard/home.png` | Meeting list + calendar | `ch15-dashboard` | the lobby |
| | `02-dashboard/new-meeting.png` | New-meeting form | *(host)* | title/agenda/roles/waiting-room |
| | `02-dashboard/invited-upcoming.png` | Invited / upcoming | *(host)* | |
| 03 projects | `03-projects/manage.png` | Manage projects | *(host)* | project admin |
| | `03-projects/project-detail.png` | Project detail | *(host)* | |
| 04 files | `04-files/my-files.png` | My Files (personal shelf) | `ch11-library` | |
| 05 client | `05-client/guest-manager.png` | Guest manager — invite client | *(host)* | name/email/company/country → Issue guest |
| 06 meeting | `06-meeting/shell.png` | In-meeting canvas (anatomy) | `ch7-toolbar`, `ch7-anatomy` | the establishing shot |
| | `06-meeting/transcript.png` | Live transcript | `ch14-panel` | |
| | `06-meeting/video-layout.png` | Video layout control | *(ch4)* | |
| 07 canvas | `07-canvas/toolbar.png` | Toolbar (cropped) | *(ch7)* | |
| | `07-canvas/stickers.png` | Stickers panel | `ch8-sticker` | |
| | `07-canvas/stamps.png` | Stamps panel | *(ch8)* | |
| | `07-canvas/bot.png` | Ask MCM Bot | `ch9-bot` | |
| | `07-canvas/cad-view.png` | CAD / DXF view | `ch12-dxf` | **empty state** — upload a .dxf to re-shoot with a model |
| | `07-canvas/3d-view.png` | IFC 3D view | `ch12-ifc` | **empty state** — upload an .ifc to re-shoot with a model |
| 08 settings | `08-settings/profile.png` | Profile / settings | `ch16-settings`, `ch16-profile` | |

## Known gaps (for a later pass)

- **Viewers are empty-state** (no .ifc/.dxf/.pdf in the room yet). Upload sample
  files to re-shoot `cad-view`, `3d-view`, and add a `pdf` viewer shot.
- **Multi-participant shots** not captured (need a 2nd peer joined): video
  gallery, active-speaker, raised hand, reactions, screen-share, chat.
- **Chat panel** button wasn't found by name — locate and add `06-meeting/chat.png`.
- Pins on full-page/spread figures are **off** for now (placeholder coords).
  Real per-image pin coordinates can be authored against these screenshots later.
- Two demo meetings ("Handbook capture", "Handbook capture 2") were created on
  the 루안 account during capture — safe to delete.
