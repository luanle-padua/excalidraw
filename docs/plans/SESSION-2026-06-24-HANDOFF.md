# Session handoff — 2026-06-24

Resume from any account: read this + `docs/logs/2026-06-24.md` (full shipped list) + `docs/plans/TEAM-BACKLOG.md` (live queue). All deploy commands run from `D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw`.

## ▶ Resume
- Same machine (`MAP1756`): `claude --resume 505fba12-3899-4c30-a07d-aa829d290490` (this conversation, full context).
- The project runs as a **standing dev team / overseer loop** — `docs/handbook/dev-team.md` (roles→agents), `docs/plans/TEAM-BACKLOG.md` (queue), command `/team`. Just say a task or `/team`.

## Prod state
- **Pages `map-canvasm` = `8ced77e5`** (https://map-canvasm.pages.dev) · **Worker `mcm-storage` = `685191a9`** · D1 migrations 0036. Batch 06-24 đã safety-commit vào git: **`cba369b5`** (code) + docs commit theo sau.
- Deploy = MANUAL: `yarn build` → `npx wrangler pages deploy excalidraw-app/build --project-name=map-canvasm --branch=main --commit-dirty=true`; worker `cd worker && npx wrangler deploy`. PWA caches hard → test in **incognito**.

## Done today (see daily log for details + files)
Recording (no-mic + screen audio, clip-list UX, frozen-button fix), Canvas Replay (native, standalone "Tua lại" button), Storage hard-delete on project delete, Consent+chat UX (+ localStorage cache so re-entry doesn't re-prompt), client REC indicator + late-join, admit banner, status colors, full responsive overhaul (tablet+phone, 3 phases), Pica console-error quieted, UI pills.

## In-flight / next
- **JOIN flow optimization (-2~4s)** — NOT STARTED (prior session crashed before starting). Merge the 3 `getMeeting` calls into one cached atom + run `getMeetingChecked` in parallel with the socket connect (non-blocking). Target: `Collab.tsx`.
- **#16 Overlap + z-index fixes** — a team is fixing the top-center banner collision, toast/drawer z-index, caption vs people-bar phone clearance, gallery/presenter, + a documented z-index scale. Deploy after it lands.
- **#10** clean stale `.claude/worktrees/` (MANUAL — Windows junction footgun: never `rm -rf`, `git worktree remove` only; don't run from inside an active session).
- **TODO ops (Luân):** R2 dashboard lifecycle rule to expire the `trash/` prefix (remaining soft-delete paths: guest revoke / logo remove).
- **Follow-ups:** shared SCSS breakpoint mixin; real header overflow "More" menu (TSX) instead of CSS-only scroll; confirm `me` lowercasing in the worker consent read (latent, harmless for lowercase emails); raise canvas-history cap if longer-than-60min meetings need finer early-scrub.

## Verify checklist (incognito)
Record (no mic, share or not — button no longer freezes after stop) · enter meeting twice (chat re-opens both times, consent only once, no re-prompt) · review meeting → "Tua lại" plays canvas evolution + Recordings clip-list · delete a test project (R2 storage drops) · DevTools device mode 768/480 across meeting + dashboard + admin + modals.
