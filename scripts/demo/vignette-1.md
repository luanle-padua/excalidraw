# Vignette 1 — "Cùng làm việc trên cùng một bản vẽ"

**Duration:** ~2:00 · **Cast:** Luân (host, VN) · Dojin (KR) · Elon (EN)

> Showcases: revision cloud + reference image · 3 DXF copies w/ per-anchor zoom · PDF anchor + note · image + stamp adhesion. No audio — VO added in post.

---

## Pre-shoot setup (one-time, before any take)

Run once via MCP, leave the browser tabs open:

1. **Open 3 tabs** in one Playwright browser window.
2. **Tab order** (always left → right):
   - **Tab L** — Luân, VN locale, host
   - **Tab D** — Dojin, KR locale
   - **Tab E** — Elon, EN locale
3. **Profiles** — inject via `userProfileAtom` per tab (skip the modal):
   - Tab L: `{ username: "Luân", company: "MAP Architects", avatar: "lib:23.png" }`
   - Tab D: `{ username: "Dojin", company: "Seoul Office", avatar: "lib:48.png" }`
   - Tab E: `{ username: "Elon", company: "Riverside Devs", avatar: "lib:71.png" }`
4. **localStorage hygiene** — on Tab D and E, delete `mcm:hostClaim:v1` after navigation so Tab L wins host election.
5. **Room** — Tab L clicks Invite → grabs URL → opens it in Tab D and Tab E.
6. **Library seed** — Tab L uploads:
   - `floorplan.dxf` (Villa Riverside)
   - `architecture-spec.pdf` (2 pages)
   - `master-bedroom-ref.jpg` (interior reference photo of a master bedroom)
7. **Verify** — Tab L's avatar tile shows the host crown; Tab D/E tiles don't.
8. **Canvas zoom** — all 3 tabs set to 50% (Ctrl+0 from Excalidraw doesn't help here; use the floating nav widget's `−` to land everyone on a comparable viewport).

> Setup typically takes ~20s of dead time before the first take. Run it once and shoot all of Vignette 1 + 2 + 3 against the same browser session if possible.

---

## Beat 1a — Khoanh vùng + kéo hình tham khảo (0:00 – 0:25)

**Active tab(s):** Tab L (foreground) · Tabs D + E watch

| t | Tab | Action | Implementation |
|---|---|---|---|
| 0:00 | L | Drag `floorplan.dxf` from library onto canvas centre | `MeetingLibrary` drag → drop API: simulate pointer drag from the library tile to canvas centre |
| 0:03 | — | DXF anchor renders, layer panel auto-appears | wait for `.mcm-dxf-anchor` to mount; pause ~1.5s |
| 0:05 | L | Switch to rectangle tool (press `R`) | `browser_press_key` `r` |
| 0:06 | L | Draw rectangle around the **master bedroom** (right-side large room on the plan) | pointerdown → move → pointerup over scene coords matching the bedroom bbox |
| 0:09 | L | Right-click the rectangle → pick "Convert to revision cloud" | `browser_evaluate` to dispatch contextmenu, then click menu item |
| 0:11 | L | Drag `master-bedroom-ref.jpg` from library next to the cloud (right side) | library drag → drop at scene next to the cloud |
| 0:14 | L | Press `A` (arrow tool) → draw arrow from cloud to image | pointerdown at cloud edge → pointerup at image edge |
| 0:18 | E | Click Luân's avatar in participants strip → follow-mode | `browser_evaluate` click on Tab E |
| 0:20 | E | Viewport snaps to Luân's view — wide shot showing cloud + image + arrow | hold camera |
| 0:24 | E | Press Esc to release follow | `browser_press_key` `Escape` |
| **Cut** | | | |

**Camera note:** keep Tab L full-frame for 0:00–0:18, then split-screen briefly to show Tab E mirroring at 0:20.

---

## Beat 1b — 3 copy, 3 chi tiết, 3 ghi chú (0:25 – 1:15)

**Active tab(s):** all 3

| t | Tab | Action | Implementation |
|---|---|---|---|
| 0:25 | L | Select the DXF anchor | click on anchor centre |
| 0:27 | L | Ctrl+D twice → 3 copies appear | `browser_press_key` `Control+d` ×2 |
| 0:29 | L | Drag copies into 3 horizontal slots (left/centre/right) | drag each copy to scene coords (200,800), (700,800), (1200,800) |
| 0:34 | L | Click copy #1 → use DXF anchor zoom UI to focus on **master bedroom** (right side of plan) | call `setDxfView({ zoom: 2.5, pan: ... })` via `customData.dxfView` patch |
| 0:37 | D | Click copy #2 → focus on **bathroom** (top-middle of plan) | same API, view = bathroom region |
| 0:40 | E | Click copy #3 → focus on **kitchen** (top-left of plan) | same API, view = kitchen region |
| 0:43 | L | Press `T`, click on copy #1, type `"Phòng ngủ cần thêm cửa sổ"` | text tool + scripted typing |
| 0:48 | D | Press `T` on copy #2, type `"화장실 출입구 위치 변경"` | same |
| 0:53 | E | Press `T` on copy #3, type `"Add a kitchen island here?"` | same |
| 0:58 | L | Press `R`, draw revision cloud around the bedroom window-wall on copy #1 (rectangle→cloud) | scripted |
| 1:03 | D | Same on copy #2 around the bathroom door | scripted |
| 1:07 | E | Same on copy #3 in the centre of the kitchen | scripted |
| 1:11 | — | Wide shot: 3 anchors side by side, each with a cloud + a note in 3 languages | hold camera 3s |
| **Cut** | | | |

**Camera note:** this is the killer "3 people in parallel" moment. Keep the wide shot from 1:11 for ~3s before cutting.

---

## Beat 1c — PDF + ghi chú trên PDF (1:15 – 1:45)

**Active tab(s):** Tab D (acts) · Tab E (translates)

| t | Tab | Action | Implementation |
|---|---|---|---|
| 1:15 | D | Drag `architecture-spec.pdf` from library to canvas (below the DXFs) | library drag → drop at scene (700,1200) |
| 1:18 | — | PDF page-1 renders | wait for `.mcm-pdf-anchor` |
| 1:20 | D | Click anchor → focus toolbar appears → click Next | scripted |
| 1:23 | — | Page 2 (elevation diagram) renders | wait |
| 1:25 | D | Press `T`, click above the tower in page 2, type `"타워 높이 18m 맞나요?"` | scripted typing |
| 1:32 | E | Click Dojin's note to select it → translate widget appears → click "Dịch" | scripted |
| 1:38 | — | Translation text appears below note: `"Is the tower height correct at 18m?"` | wait for child element to render |
| 1:42 | — | Wide shot: PDF + Korean note + English translation underneath | hold 3s |
| **Cut** | | | |

---

## Beat 1d — Hình + stamp dính lên hình (1:45 – 2:10)

**Active tab(s):** Tab L (drives) · Tabs D + E watch

| t | Tab | Action | Implementation |
|---|---|---|---|
| 1:45 | L | Drag `master-bedroom-ref.jpg` from library (a second copy, separate from the one in 1a) | library drag → drop at scene (300,1500) |
| 1:48 | — | Image renders | wait |
| 1:50 | L | Click the stamp button in the toolbar (4th icon in the extras row) | `browser_evaluate` to click `.mcm-deco-trigger--stamp` |
| 1:52 | L | Stamp popover opens → pick a chibi stamp (`/decorations/stamps/01-12.png`) | scripted click on the grid item |
| 1:54 | L | Click directly on the bedroom image → stamp drops on top | pointer click at scene coords matching the image centre |
| 1:57 | — | Stamp adheres — both elements now share a groupId | verify via `excalidrawAPI.getSceneElements()` that both share a groupId |
| 1:59 | L | Press `V` (selection), click the bedroom image → group selection rect wraps BOTH | scripted |
| 2:01 | L | Drag the group to a new position (~150px right) | pointer drag |
| 2:05 | — | Camera: stamp visibly moves WITH the bedroom image — the "ADHESION" moment | hold 3s |
| 2:08 | E | (Wide shot) Tab R (Elon or Dojin) shows the same move propagated | hold 2s |
| **Cut. End of Vignette 1.** | | | |

**Camera note:** beat 1d is short but it's the ONLY moment that proves the new stamp behavior. Linger on the drag at 2:01–2:05 — that's the punchline.

---

## Re-shoot anchors

If a take fails partway, restart from the closest anchor below — each is a clean canvas state we can rebuild deterministically:

- **R0** — empty canvas, library has 3 files. Setup script gets us here in ~5s.
- **R1** — after 1a: cloud + reference image on canvas. Setup R0 + execute 1a programmatically (no typing pauses) to fast-forward.
- **R2** — after 1b: 3 zoomed DXF anchors. Setup R1 + execute 1b programmatically.
- **R3** — after 1c: PDF + KR note + EN translation. Setup R2 + execute 1c programmatically.

Anchors live in `scripts/demo/scene-fast-forward.ts` (TBD — written alongside the shoot, not before, since the exact element placements get tuned on first take).

---

## Setup locked

| | |
|---|---|
| **Asset folder** | `excalidraw-app/test-fixtures/demo/` — `floorplan.dxf` · `architecture-spec.pdf` · `master-bedroom-ref.jpg` |
| **Stamps** | Chibi-animals — `/decorations/stamps/01.png` → `12.png` (built-in) |
| **Avatars** | Luân `lib:48.png` · Dojin `lib:27.png` · Elon `lib:71.png` |
| **Layout** | 2 Chrome windows side-by-side, ~960×1080 each. Window L = Luân (fixed). Window R = Dojin or Elon, swapped by Alt+Tab between beats. |
| **Translation** | `GEMINI_API_KEY` configured in `room/.env` — `/translate` + `/translate-batch` live. |
| **Recording** | OBS or OS recorder captures the full screen with both windows visible. |
