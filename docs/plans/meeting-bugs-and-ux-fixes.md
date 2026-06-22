# Meeting bugs + UX fixes — chẩn đoán & kế hoạch

**Cập nhật:** 2026-06-22 · **Nguồn:** team điều tra read-only (4 nhánh) · **Trạng thái:** ✅ HOÀN TẤT — 6/6 item PASS

## ✅ HOÀN TẤT (2026-06-22)
- Workflow `meeting-bugs-ux-fixes-build` (run `wf_fdc94680-b2b`) chạy xong: **cả 6 item implement → verify → review → fix đều PASS**.
- **Integration: GO** — `yarn test:typecheck` sạch (0 lỗi); **13 file test / 130 test PASS, 0 fail** (gồm các suite mới: previewCamera, useJoinCall, avatarIdentity, captionBatch, aiRateLimitKey…).
- Item 6 review bắt 1 bug thật (`previewCamera()` teardown race rò camera) → đã **fix + thêm 5 test teardown-race** → re-review sạch.
- ⚠️ **Toàn bộ thay đổi CHƯA COMMIT** — nằm trên working tree `excalidraw/` (không có gì auto-commit). Cần Luân review `git diff` rồi commit/push.
- 🔧 **Ops follow-up (Luân, không phải code):** rà quota/billing tier key Gemini; verify tải thực bằng `wrangler tail mcm-storage` (~25 caption/phút) xem 429/quota.

<details><summary>Lịch sử RESUME (đã đóng)</summary>

- Run ID: `wf_fdc94680-b2b` · Script: `…/1de61f2a-…/workflows/scripts/meeting-bugs-ux-fixes-build-wf_fdc94680-b2b.js`
- Run gốc bị mồ côi khi session tắt; đã resume sang session `505fba12-…` (item đã xong lấy cache), chạy tiếp tới hết.
- Tiền đề: workflow Daily `wf_617a0155-e8b` đã XONG (8/8 phase PASS, integration GO, typecheck sạch, 81+5 test).
</details>

Doc này theo dõi 6 việc anh Luân nêu (4 bug + 2 feature). Thực thi **SAU KHI** workflow
`daily-monitoring-resilience-build` (run `wf_617a0155-e8b`) chạy xong, vì nhiều việc
đụng cùng file (`DailyAudio.ts`, `MeetingShell.tsx`, `MeetingCallControls.tsx`, i18n).

---

## AI dịch + tóm tắt — KHÔNG phải lỗi code, KHÔNG thiếu key (đã xác minh)

Chẩn đoán ban đầu của agent ("thiếu `GEMINI_API_KEY`") **SAI** — chỉ đúng cho local
`.dev.vars` (vốn trống cả 2 key). Sự thật trên môi trường anh dùng (app **deploy**):
- `wrangler secret list mcm-storage` → có ĐỦ `GEMINI_API_KEY` + `DEEPGRAM_API_KEY`;
  `AI_ENABLED: "on"`. AI và STT dùng **chung worker + chung base URL**
  (`VITE_APP_STORAGE_URL`); `/translate` chỉ cần đăng nhập (không cần membership).
- **`wrangler tail mcm-storage` (2026-06-22 10:45): `POST /translate` và
  `/translate-batch` đều trả `Ok` (200)** — AI dịch CHẠY BÌNH THƯỜNG trên prod.

→ "Không được hôm qua" nhiều khả năng **transient** (Gemini quota/rate-limit reset,
outage ngắn, hoặc key vừa được thêm/sửa). Không có lỗi cố định.

**Còn lại cần chốt:** chưa test `/summarize` qua tail. `/summarize` khác `/translate`
ở chỗ có **`aiRoomGate`** (membership, 403 nếu không phải thành viên meeting) —
nếu Tóm tắt lỗi mà Dịch chạy thì thủ phạm là gate này, KHÔNG phải key.
Cách test: `wrangler tail mcm-storage` + bấm Tóm tắt → xem 200 / 403 / 502.

Tham chiếu code: `/translate` route `worker/src/ai.ts:538-595` (502 + `console.error`
khi Gemini lỗi); `aiRoomGate` `worker/src/index.ts:396-420`; local-only thiếu key là
`worker/.dev.vars` (chỉ cần khi muốn test bằng `wrangler dev` local).

---

## Việc code (thực thi sau khi workflow Daily xong)

### 1. Blur background trên PC — PHẦN LỚN ĐÃ XONG bởi Phase 0
2 lỗi thật, **Phase 0 của workflow Daily đã fix cả hai** (đã nằm trên đĩa):
- Gating sai: `isVideoBgSupported()` cũ dùng heuristic `pointer:fine` → **laptop PC
  cảm ứng** (Surface/ThinkPad…) bị nhận nhầm là mobile → toàn bộ mục background bị
  **disable xám**. Đã đổi sang `Daily.supportedBrowser().supportsVideoProcessing`. ✅
- Preset `.webp` (`client-forest.webp`) bị Daily từ chối âm thầm. Đã trỏ sang `.png`. ✅

**Còn lại (chỉ mỹ thuật, không chặn):** preset "office" giờ tạm trùng ảnh
`crystal-leaves.png`. Cần 1 ảnh office png/jpg thật bỏ vào `public/backgrounds/` rồi
repoint `videoBg.ts` (~dòng 85). → **Việc: verify local + (tùy chọn) thêm asset office.**

Verify: desktop Chrome/Edge, bật camera → Settings → Preferences → "Camera background"
phải **enabled**; bấm Blur·medium → nền mờ trong ~1s.

### 2. Avatar user chưa đồng bộ — lỗi code, nhiều điểm phân kỳ
Component chuẩn: `MCMAvatar` (`components/mcm/Avatar.tsx`) — ảnh, hoặc initials +
`personColor`. Các phân kỳ chính gây "chưa đồng bộ":
- **To nhất:** cursor trên canvas (`collab/Collab.tsx:513, 1379`) dùng
  `resolveAvatarUrlWithDefault(avatar, socketId)` → **mặt random theo socketId**
  (đổi mỗi lần reconnect), trong khi mọi nơi khác = initials theo **email**. ⇒ cùng 1
  người: bar/chat hiện initials, canvas hiện mặt cartoon lạ & đổi liên tục.
- Directory/roster (`data/invite.ts`) chỉ mang `lib:NN.png` → **rớt avatar upload**:
  trong họp thấy ảnh thật, ở roster/people-grid lại thấy initials.
- Lệch màu seed: `PeopleGrid` ring seed `group||email` vs initials seed `email`;
  STT/log name color `colorFor(socketId)` vs avatar `personColor(email)`.
- `AuthorBadgeOverlay` keo theo `author.id` snapshot → peer rời là tụt về initials.

**Fix (single source of truth = initials/avatar theo EMAIL):**
- Bỏ random-face: `Collab.tsx:513,1379` → dùng `resolveAvatarUrl` (hoặc fallback key
  `email`), tốt nhất render cursor qua cùng resolver.
- Thống nhất seed màu theo `email` ở `SpeechToTextPanel.tsx:99`, `MeetingLogModal.tsx:417`,
  `PeopleGrid.tsx:41,109`.
- Cho roster hiện avatar upload: mở rộng `DirectoryUser.avatar` + `/v1/directory` +
  nới `session.ts:157-160`.
- Snapshot `{avatar,email}` vào author badge (`AuthorBadgeOverlay.tsx:246-268`).

Files: `collab/Collab.tsx`, `data/userProfile.ts`, `components/mcm/SpeechToTextPanel.tsx`,
`MeetingLogModal.tsx`, `PeopleGrid.tsx`, `data/invite.ts` + worker `/v1/directory`,
`data/session.ts`, `AuthorBadgeOverlay.tsx`. **Ít đụng file workflow Daily** (an toàn
hơn nhưng vẫn làm sau cho chắc).

### 3. Pre-join modal ("hair check") — feature mới
Hiện: user vào thẳng canvas (A: `activeRoomLink`), rồi BẤM "Join" riêng (B: call), rồi
mới unmute/bật cam. Daily join luôn **listener-only**, mic lazy (`ensureMic`), cam opt-in
(`setCamera`).

**Thiết kế (Option A — gate join-call, ít rủi ro nhất):**
- New `components/mcm/PreJoinModal.tsx` mount trong `MeetingShell` (cạnh gate khác,
  ~dòng 446-452), hiện khi `activeRoomLink` set + `audioState.status==="idle"` + !viewOnly.
- Nội dung: tên+avatar preview, **camera preview** (Daily `startCamera`/`previewCamera()`
  mới, KHÔNG join), toggle **mic on/off** + **camera on/off** (default off), nút **Join**.
- Wiring khi bấm Join: `audioRoom.start()` (listener-only như cũ) → nếu chọn mic →
  `ensureMic()`; nếu chọn cam → `setCamera(true)`. Tôn trọng nguyên kiến trúc lazy.
- Quan hệ với gate khác: `WaitingForStart`/`WaitingRoom` gate "vào phòng"; PreJoin gate
  "vào call" — tuần tự, không trùng. Giữ nút "Join" idle cũ làm fallback.
- New atoms: `preJoinPendingAtom`, `preJoinMicIntentAtom`, `preJoinCamIntentAtom`.
- Refactor: tách `useJoinCall()` từ `MeetingCallControls.join()`.
- **Đụng file workflow Daily nặng** → BẮT BUỘC làm sau.

### 4. Icon + chữ ("icon đẹp nhưng nhìn sợ không hiểu")
Hiện mọi nút header là icon 34px vuông, chỉ có tooltip hover + `aria-label` (chữ đã có
sẵn trong i18n). Thêm label chữ cạnh icon.

**Thiết kế (label chọn lọc + thu gọn responsive, tránh tràn header):**
- Thêm biến thể `mcm-header__icon-btn--labeled` (min-width + padding + gap) + span
  `.mcm-header__icon-label`; ẩn label ở `≤1100px` (về icon + tooltip).
- **Gắn chữ cho nhóm "đáng sợ" trước:** cụm call (Join, Mute, Camera, Leave call) +
  exit hủy (Leave, End). Nút chrome ít rủi ro (Settings, Layout) để icon-only.
- Tận dụng string i18n sẵn có (`header.*`, `callControls.*`) cho vi/ko/en.
- Files: `MeetingHeader.tsx`, `MeetingCallControls.tsx`, `MeetingShell.scss`, i18n.
- **Đụng file workflow Daily** → làm sau.

### 5. AI hardening — chống "chết khi họp đông" (root cause thật)
**Chốt root cause (2026-06-22):** AI dịch/tóm tắt KHÔNG hỏng do code/auth/key.
Code không đổi từ hôm qua; proxy auth live từ 18/06 (commit `26c230af`, đã push); key
+ AI_ENABLED có đủ trên prod; tail hôm nay `POST /translate` = Ok. → "hôm qua chết, nay
sống" chỉ giải thích được bằng cái **đổi theo tải/thời gian, không cần đổi code**:
- **Rate-limit 20 req/phút/IP** (`ai.ts:539`) — họp thật dịch caption dồn dập → vượt →
  429 → client âm thầm tụt về text gốc. Test lẻ hôm nay → dưới ngưỡng → ok.
- **Gemini quota/billing** reset theo ngày — cháy trong họp, qua đêm hồi.

**Hardening (worker/src/ai.ts + client, KHÔNG đụng file workflow Daily):**
- **Rate-limit theo USER (email/uid) thay vì IP** — office NAT chung IP là điểm chết;
  + nâng ngưỡng hợp lý cho caption realtime.
- **Gom dịch caption qua `/translate-batch` + debounce** (`data/translation.ts`,
  `LiveCaptionDock.tsx`) — giảm số call mạnh thay vì bắn từng dòng.
- **Hiện lỗi thật** (429/502) cho user ("đang quá tải, thử lại") thay vì im lặng tụt
  text gốc — để biết là *bị giới hạn* chứ không phải *hỏng*.
- Rà quota/billing tier key Gemini (ops, ghi việc cho Luân).
- Verify: `wrangler tail mcm-storage` + tạo tải (~25 câu/phút) xem 429/quota.

### 6. Auth đồng bộ chuẩn mực — magic-link VN-safe
Đã verify: **1 supabase client duy nhất**, `authProxyFetch` toàn cục → login mật khẩu +
refresh (cả khách synthetic) đi qua worker → VN-safe. Mật khẩu khách = `genTempPassword()`
(16 byte crypto, ~22 ký tự, trả 1 lần, không vào email) → **bảo mật OK**. Lỗ còn lại:
- **Magic-link `signInWithOtp`** (`LoginScreen.tsx:180`) — email verify trỏ thẳng
  `supabase.co/auth/v1/verify` (hop đầu không qua proxy) → bấm trên WiFi VN bị chặn.
- **Fix (code, nhỏ):** ẩn/khóa nút magic-link tới khi có custom domain → mọi người
  (gồm khách) chỉ dùng mật khẩu = proxied = VN-safe.
- **Fix triệt để (ops, Luân, ~Aug):** custom auth domain qua Cloudflare / sửa template
  email Supabase để link verify đi qua domain proxy.

---

## MASTER BACKLOG — team làm HẾT (loop design, sau khi workflow Daily `wf_617a0155-e8b` xong)

Chạy tuần tự, mỗi việc: implement → `yarn test:typecheck` + vitest local → review → fix,
gate typecheck sạch mới qua việc kế. Thứ tự (ít phụ thuộc → phụ thuộc nhiều):
1. **AI hardening** (§5) — worker/ai.ts + translation.ts + LiveCaptionDock; độc lập.
2. **Magic-link gating** (§6) — LoginScreen.tsx; độc lập.
3. **Blur verify + asset office** (§1) — Phase 0 đã fix; chỉ verify + (tùy chọn) ảnh png.
4. **Avatar sync** (§2) — Collab.tsx, userProfile.ts, PeopleGrid, SpeechToTextPanel,
   MeetingLogModal, invite.ts + worker /v1/directory, session.ts, AuthorBadgeOverlay.
5. **Icon + chữ** (§4) — MeetingHeader, MeetingCallControls, MeetingShell.scss, i18n.
6. **Pre-join modal** (§3) — PreJoinModal.tsx + atoms + useJoinCall + DailyAudio
   previewCamera + MeetingShell + i18n (lớn nhất, làm cuối).

**Lý do chờ Daily xong:** việc 3–6 đụng nặng file workflow Daily (DailyAudio, MeetingShell,
MeetingCallControls, i18n); chạy song song = nhiễu typecheck chéo, hỏng cả hai.
