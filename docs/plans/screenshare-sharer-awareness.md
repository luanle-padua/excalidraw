# Screen-share — sharer awareness ("đang share cái nào?")

**Trạng thái:** SPEC (chốt 2026-06-22) · implement SAU header-clarity-redesign (đụng chung MeetingShell/MeetingHeader). Verified bằng team audit.

## Vấn đề
Khi user Present 1 cửa sổ/tab (Daily.co), người share **bị "mù"** + dễ quên/nhầm:
- Không thấy preview cái mình đang chiếu (chỉ người xem thấy) — `ScreenSharePane.tsx:1-4,85-87` bail cho local.
- Không có banner "Bạn đang chia sẻ…" — string `screenShare.youArePresenting` ĐÃ dịch (en.ts:1233, vi.ts:1289, ko.ts:1241) nhưng **chưa nối**.
- Không hiện tên/loại nguồn; không viền.
- Stop = cùng icon nhỏ ở header, tooltip vẫn "Present" (`MeetingShell.tsx:425-427`); string `screenShare.stopShare` (en.ts:1231) chưa dùng.

## Daily/DOM cho phép gì (verified)
- **Self-preview track: CÓ.** Local screen track lấy từ `track-started` (`e.participant.local && e.type==='screenVideo'` → `e.track`, `DailyScreenShare.ts:402-408` — hiện VỨT đi) hoặc `participants().local.tracks.screenVideo.persistentTrack ?? .track`. Tái dùng `reconcileRemoteScreenVideo()` (`DailyScreenShare.ts:255-266`), bỏ skip `if (p.local) continue` (252-254).
- **Loại nguồn: `track.getSettings().displaySurface`** → `'monitor'|'window'|'browser'`. **CHỈ Chromium**; Safari/Firefox `undefined`.
- **Tên nguồn:** chỉ `track.label` (free text theo browser) — show as-is, đừng parse.
- Events `local-screen-share-started/stopped/canceled` chỉ là tín hiệu (payload rỗng) — vẫn lấy track từ participant/track-started.

## Thiết kế
1. **Self-preview thumbnail nổi** (quan trọng nhất): khi đang present, hiện ô `<video>` muted chiếu chính nội dung đang share → thấy đúng cái người khác thấy. Viền accent + nhãn "LIVE • mọi người đang thấy".
2. **Banner "Bạn đang chia sẻ [loại]" + nút "Dừng chia sẻ"**: dùng lại `youArePresenting` + `stopShare`. Loại = map `displaySurface` → Toàn màn hình / Cửa sổ / Tab; `undefined` → "màn hình" chung chung.
3. **Làm rõ Stop**: nút trong banner + tooltip Present button khi active đổi sang "Dừng chia sẻ".

## Implement
- `screenshare/screenShareState.ts` (`ScreenShareMedia` ~59-78): thêm `localStream: MediaStream|null`, `localSurface: 'monitor'|'window'|'browser'|null`, `localLabel: string|null`.
- `screenshare/DailyScreenShare.ts`: ở local branch `onTrackStarted` (402-408) GIỮ `e.track` → build `new MediaStream([track])` + đọc `track.getSettings().displaySurface` & `track.label`; clear khi stop. (Tái dùng pattern reconcile remote.)
- New `components/mcm/ScreenShareSelfView.tsx` (thumbnail + banner + Stop) — mount trong MeetingShell cạnh các overlay khác; chỉ hiện khi `iAmPresenting`.
- `MeetingShell.tsx`: `presentTitle` khi đang present = `stopShare`.
- i18n: chỉ NỐI string sẵn có; thêm nhãn loại nguồn (surface.monitor/window/browser) ở vi/ko/en nếu cần.

## Đồng bộ
- Build SAU header redesign (Present button + MeetingShell do header team đổi) để banner/Stop khớp header mới. Self-view dùng chung style accent.
- Liên quan [[mcm-screen-share]] (Daily managed, lazy-join, Phase 1 done).
