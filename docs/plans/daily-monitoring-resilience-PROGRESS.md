# Daily Monitoring & Resilience — PROGRESS / RECOVERY

_Last updated: 2026-06-22_

## Mục đích

Đây là tài liệu theo dõi tiến độ & phục hồi cho việc thực thi kế hoạch `docs/plans/daily-monitoring-resilience.md` (Daily.co monitoring & resilience hardening, 8 phase). Công việc được điều phối bởi một background orchestrator Workflow chạy **tuần tự** từng phase, mỗi phase theo vòng lặp implement → verify (`yarn test:typecheck` + vitest) → review → fix, và **chỉ qua phase kế tiếp khi typecheck sạch**. Nếu máy tắt đột ngột giữa chừng, mở tài liệu này để biết ngay: cái gì đã xong, cái gì đang dở, cái gì còn lại, và cách resume chính xác.

## STATUS TABLE

| Phase | Trạng thái | Ghi chú |
| --- | --- | --- |
| Phase 0 — Media processing conformance | ✅ DONE & VERIFIED | Typecheck sạch, unit tests pass, review 0 blocking. Files: `excalidraw-app/audio/videoBg.ts`, `audioTypes.ts`, `DailyAudio.ts`, `AudioRoomController.tsx`, `i18n/mcm/{vi,ko,en}.ts`, file mới `excalidraw-app/audio/videoBg.test.ts`. Đã làm: repoint preset virtual-bg `.webp` không hợp lệ → `.png`; chuyển support detection sang `Daily.supportedBrowser().supportsVideoProcessing`; wire `nonfatal-error` + `input-settings-updated` để reconcile `video-processor-error`. |
| Phase 1 — Network resilience | ✅ DONE & VERIFIED | Typecheck sạch, 10 unit tests pass, review 0 blocking. Files mới: `excalidraw-app/audio/connectionState.ts` (+ `.test.ts`), `excalidraw-app/components/mcm/ConnectionBanner.tsx` (+ `.scss`). Đã đổi: `audioTypes.ts`, `DailyAudio.ts`, `AudioRoomController.tsx`, `MeetingShell.tsx`, `i18n`. Đã làm: wire `network-connection` (banner reconnecting/unstable) + `network-quality-change` (quality chip). |
| Phase 2 — Device & error events | 🔄 IN PROGRESS | Bị ngắt bởi shutdown, **đã resume**. Edit dở dang đã nằm trên disk ở `audioState.ts`, `videoState.ts`, `MeetingCallControls.tsx`. Có 2 compile error do thiếu i18n keys (`callControls.featureDisabled`, `callControls.cameraPermission`) — run đã resume sẽ hoàn tất các key này. |
| Phase 3 — CPU + quality governor | ⏳ PENDING |  |
| Phase 4 — Observability | ⏳ PENDING | `getNetworkStats` polling + `meetingSessionSummary` + telemetry. |
| Phase 5 — Scale subscription | ⏳ PENDING | Manual subscription + pagination + adaptive receive layer. |
| Phase 6 — Screenshare parity | ⏳ PENDING |  |
| Phase 7 — Worker room/token | ⏳ PENDING | Minimal, flag default OFF. |
| Integration verify | ⏳ PENDING | Full typecheck + tất cả unit tests mới + teardown/leak scan. |

## CÁCH RESUME KHI BỊ NGẮT

Relaunch Workflow tool với đúng params sau (các phase đã xong sẽ trả về từ cache **tức thì, không làm lại**; phase chưa xong đầu tiên và mọi phase sau nó chạy live; same-session caching):

```
Workflow {
  scriptPath: "C:\\Users\\MAP1756\\.claude\\projects\\D--LUAN-0-WIP-20-MEETING-CANVAS-excalidraw\\1de61f2a-6772-4a01-86da-caab4e07e7d6\\workflows\\scripts\\daily-monitoring-resilience-build-wf_617a0155-e8b.js",
  resumeFromRunId: "wf_617a0155-e8b"
}
```

- **Workflow name:** `daily-monitoring-resilience-build`
- **Run ID:** `wf_617a0155-e8b`

### Phục hồi file bị ghi dở

Một atomic file write bị ngắt có thể để lại sibling `*.tmp.*` cạnh file source. **Xóa file `.tmp` mồ côi** đó; file source thật thường vẫn nguyên vẹn.

## CÁCH KIỂM TRA ĐANG Ở ĐÂU

Ba cách (journal + `/workflows` là nguồn chân lý live):

1. **Chạy `/workflows`** để xem trạng thái live.
2. **Đọc journal.jsonl** (nguồn chân lý machine-readable về phase nào đã xong): `C:\Users\MAP1756\.claude\projects\D--LUAN-0-WIP-20-MEETING-CANVAS\1de61f2a-6772-4a01-86da-caab4e07e7d6\subagents\workflows\wf_617a0155-e8b\journal.jsonl`
   - Mỗi phase log một entry `"started"` rồi một entry `"result"`.
   - Một `"started"` **không có** `"result"` khớp = phase đó đang in-flight khi bị ngắt.
3. **Chạy `yarn test:typecheck`** trong repo excalidraw để xem state on-disk hiện có compile không.

## LƯU Ý

- Code được edit **trực tiếp trên working tree** của git repo tại `D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw` (nên mọi thứ revertable bằng git nếu cần). **Không có gì auto-commit.**
- **Phát hiện sai lệch SDK thật & đã xử lý:** `@daily-co/daily-js@0.90.0` type `network-quality-change.networkState` là `'good' | 'warning' | 'bad' | 'unknown'` (KHÔNG phải `good/low/bad` đơn giản hóa trong facts của plan). Code map `warning→low`, `unknown→good`. Ai sửa code liên quan phải code theo `.d.ts` SDK THẬT, không theo vocabulary đơn giản hóa của plan.
- Working tree CŨNG chứa thay đổi handbook **không liên quan** (`docs/handbook-web/*`, `docs/handbook/*`, một grid-systems PDF, `chapters-bespoke/`) KHÔNG thuộc Daily work — **để yên**, đó là việc riêng.
- Tài liệu này là **bản mirror cho người đọc**; state live chân lý là `journal.jsonl` + `/workflows`. Cập nhật status table ở đây khi một phase **verifiably** hoàn tất.
