# MCM dev-team backlog — canonical task queue

Single source of truth for the standing dev team (see `docs/handbook/dev-team.md`).
Run the loop with `/team` (picks the top unblocked item) or `/team <id|topic>`.
Statuses: ☐ todo · ◐ in progress · ☑ done · ⏸ blocked/decision-needed.

> Last updated: 2026-06-24. Repo: `D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw`.
> Mirror of the in-session harness task list (IDs match).

| # | Item | Status | Lead role | Key files |
|---|------|--------|-----------|-----------|
| 1 | Stand up dev-team structure (this doc + charter + `/team`) | ◐ | Lead | `docs/handbook/dev-team.md`, `.claude/commands/team.md` |
| 2 | Free R2 storage on project delete (orphan cleanup) | ☑ code+review (pending worker deploy) | Backend | `worker/src/index.ts` |
| 3 | Make `trash/` actually free storage | ☑ via hard-delete (trash lifecycle = dashboard TODO, ops) | Backend | `worker/wrangler.jsonc`, `worker/src/index.ts` |
| 4 | Recording: allow no-mic + capture screen-share audio | ☑ (typecheck clean; manual audio verify pending) | Debugger+FE | `clientRecording.ts`, `DailyScreenShare.ts`, `screenShareState.ts`, `CloudRecordingControls.tsx` |
| 5 | Manage-projects STATUS pills overlap | ☑ | Frontend | `ProjectManager.scss` |
| 6 | Consent/entry UX + always-expanded right chat panel | ☑ participants auto-open removed + chat default-open + consent fade-on-canvas | Frontend+UX | `MeetingShell.tsx`, `AppSidebar.tsx`, `MeetingConsentGate.tsx` |
| 7 | Subtle chat notification for new messages | ☑ (typecheck clean) | Frontend | `AppSidebar.tsx/.scss`, i18n |
| 8 | Clearer client-admit (waiting-room) notification | ☑ deployed (`dce7e542`) | Frontend+UX | `KnockBanner.tsx/.scss`, `ParticipantsBar.tsx` |
| 9 | Rebuild Canvas Replay as native in-canvas player | ☑ deployed (Pages `dce7e542` + Worker `685191a9`) | FE+Debugger | `CanvasReplay*`, `MeetingLogModal`, `Collab`, `data/canvasHistory.ts`, `worker` |
| 10 | Clean up stale agent worktrees (manual, Windows-safe) | ☐ | Lead (manual) | `.claude/worktrees/` |
| 13 | Responsive overhaul tablet+phone (P1 meeting · P2 dashboard · P3 admin/portal/modals) | ☑ deployed (`c76c713f`) | FE | `MeetingShell.scss`, `ProjectManager.scss`, `AdminConsole.scss`, `ChatPanel.scss`, `AppSidebar.*`, `screenshare/*`, `LiveCaptionDock.scss` |
| 14 | Recording logs + replay/player UX (standalone Replay btn · clip-list · modal tab-aware footer) | ☑ deployed (`c76c713f`) | FE | `MeetingHeader`, `MeetingLogModal`, `RecordingsSection.*`, `CanvasReplay*` |
| 15 | Blocking bugs: record-frozen · consent re-prompt · chat re-entry | ☑ deployed (`32fb5b27`) | FE | `CloudRecordingControls`, `MeetingConsentGate`, `AppSidebar` |
| 16 | Meeting UI overlaps + z-index scale | ☑ deployed (`401fe244`) | FE | `MeetingShell.scss`, `ConnectionBanner.scss`, `KnockBanner.scss`, `LiveCaptionDock.scss` |
| 12 | Client REC indicator + late-join sync + analytics removal + status colors | ☑ deployed (`dce7e542`) | FE | `RecordingIndicator`/`MeetingShell.scss`, `CloudRecordingControls`, `index.html`, `ProjectManager.scss` |
| 17 | Consent gate leaking onto dashboard — must render ONLY on meeting join (owner saw it pop on dashboard) | ☑ committed `9147c9b6` (chờ deploy) | FE+Debugger | `MeetingConsentGate.tsx` (gate on `isCollaboratingAtom`) |
| 18 | Consent copy rewrite — smart/light/persuasive so users click OK instantly (not a dry explicit notice) | ☑ committed `9147c9b6` (chờ deploy) | UX+FE | `MeetingConsentGate.tsx`, i18n `en/ko/vi` |
| 19 | Replay entry: clicking "Tua lại" shows the player control bar at the bottom directly — drop the intermediate menu + extra click | ☑ committed `9147c9b6` (chờ deploy) | FE | `MeetingHeader.tsx`, `CanvasReplayPlayer/Timeline.tsx`, `CanvasReplay.scss` |
| 20 | JOIN flow optimization (-2~4s): merge `getMeeting` calls into 1 cached fetch + run `getMeetingChecked` parallel to socket | ◐ dedupe DONE `9147c9b6` (chờ deploy); socket+gate parallelize HOÃN (rủi ro rò presence) | FE | `data/projects.ts`, `Collab.tsx` |

## Findings already established (so the team doesn't re-investigate)

### #2 + #3 — why Cloudflare storage doesn't drop after delete
Root cause = **both** (confirmed by audit):
- **Soft-delete to `trash/`, never expired.** `cleanupMeetingBlobs` (worker `~7007`) and `trashR2Prefix` (`~6249`) *copy* each blob to `trash/<ts>/<key>` then delete the original → bytes only relocate. **No R2 lifecycle rule** (`wrangler.jsonc` `r2_buckets` has none) and the `scheduled()` cron (`~9326`) only dumps D1 to `backups/` — nothing purges `trash/`.
- **Orphan prefixes never touched on project delete:**
  - `packages/<pkgId>/*` (recap.html, bundle.zip, files/*) — `meetingDeleteStatements` deletes the D1 rows but not the R2 blobs.
  - `project-files/<projectId>/*` (+ thumbs) — `project_file` rows + blobs not in the cascade at all.
  - `guest-logos/<guestId>` — `project_guest` rows + logo blobs not deleted.
- Admin storage display (`/v1/admin/storage` `~7399`) only sums the `file` table → its number can drop while real R2 doesn't.

**DECIDED 06-24 — hard-delete.** Admin project-delete removes the R2 blobs immediately (storage frees at once; not recoverable; the Archive download is the pre-delete backup). So on project delete: hard-delete `cleanupMeetingBlobs` prefixes + the orphan prefixes (`packages/*`, `project-files/*`, `guest-logos/*`) instead of moving to `trash/`, and delete the `project_file` / `project_guest` rows. The `trash/` lifecycle rule is still worth adding for the OTHER soft-delete paths (guest revoke etc.).

### #4 — recording audio
- No-mic blocks recording today; should record with mic optional.
- `getDisplayMedia` audio track (tab/system audio of the shared window) is not mixed into the recording. Fix in `excalidraw-app/audio/clientRecording.ts` + the canvas-compositor capture path. (VP8/Opus codec fix already shipped 06-23.)

### #9 — Canvas Replay (reverted `93e27e7c`, original `b1e1649a`)
- Capture side is **clean and still on master**: `excalidraw-app/data/canvasHistory.ts` (3s delta snapshots, hook in `Collab.syncElements` after broadcast; worker `/v1/canvas-history/:roomId`, E2E). Reuse `reconstructSceneAt(entries, t)` + `historyTimeline(entries)`.
- The **player was the problem** (a 2nd standalone `<Excalidraw>` → phantom guests + reload loop). Rebuild to drive the existing review canvas via `excalidrawAPI.updateScene({elements})`. Hook the API via `useExcalidrawAPI()` (used in `MeetingLogModal.tsx ~189`). Mount the scrubber/play UI natively in review mode, design-synced.

### #5 — STATUS pills (DONE)
Base `.mcm-segmented__btn` is a fixed 28px icon square; text labels collapsed. Fixed by overriding `.mcm-segmented--status .mcm-segmented__btn` to `width:auto` + padding in `ProjectManager.scss`.

## Client feedback — CANVAS M external (received 2026-06-24)
Reviewer hasn't seen all current features. Verdicts below from a 4-agent code audit (status vs the ask):

1. **Đa ngữ đồng thời, không buffer** — ◐ PARTIAL. Mỗi người tự transcribe mic của mình (Deepgram Nova-3 **mono**), ngôn ngữ **cố định/người/buổi**; nhiều người nói cùng lúc = nhiều stream độc lập → KHÔNG nghẽn (đã hơn Teams ở điểm này). Chưa làm: 1 người trộn nhiều tiếng trong 1 stream (cần per-utterance auto-detect / Nova-3 multilingual). Caption translate batch debounce 300ms/≤12 → burst nhiều final có thể trễ. Files: `sttProviders.ts`, `transcription.ts`, `captionBatch.ts`.
2. **Guide / video-manual cho khách khi gửi link** — ☐ NOT-STARTED. Khách mở link chỉ thấy login + marketing chung; email mời chỉ có nút "Vào phòng", không kèm hướng dẫn; `MCMAssistant.tsx` mới là stub "coming soon". Cần: welcome screen pre-meeting + link video 2–3′ trong email mời/portal. Files: `LoginScreen.tsx`, `worker/src/email.ts`.
3. **Chatbot hỏi "30 phút trước bàn gì"** — ◐ PARTIAL (nhiều hơn tưởng). ĐÃ có `/chatbot` trả lời TRONG buổi về context hiện tại (transcript/chat/canvas) — `worker/src/ai.ts:684`; auto-summary cuối buổi đã có. CHƯA: hỏi xuyên các buổi của dự án (Phase 1 "Hỏi dự án" trong `ai-project-knowledge-strategy.md`, ~2–3 ngày) + running summary trực tiếp.
4. **Test tải đồng thời nhiều người** — ☐ NOT-STARTED (ops, không phải code feature). Realtime trên Durable Object, fan-out O(N)/message, cap mặc định 500/phòng (`ROOM_WS_CAP` ở `worker/src/index.ts`), KHÔNG có harness load-test. Rủi ro plan đã tự ghi: full-scene re-broadcast mỗi 20s × N người = N×(N-1) burst chưa đo (`durable-objects-migration.md` §9.3). Cần: chạy k6/Node pool N=100 trong 30′, đo P99 + CPU/mem DO → quyết có chunk fanout không.
