# Daily.co — Monitoring & Resilience hardening plan

**Status:** proposed · **Created:** 2026-06-22 · **Owner:** audio/video stack **SDK:** `@daily-co/daily-js@0.90.0` (call-object mode)

## 1. Mục tiêu

Khảo sát đối chiếu setup Daily hiện tại với docs "video architecture & monitoring" cho thấy phần **kiến trúc + bandwidth/quality đã chuẩn** (SFU, listener-only join, 3-tier simulcast, `updateSendSettings`/`updateReceiveSettings`/`updateInputSettings`, active-speaker layer promotion, room expiry + eject). Thiếu **toàn bộ nhóm monitoring & resilience** — code chỉ subscribe 8 event (track/participant/ active-speaker/error). Plan này lấp đủ các khoảng trống VÀ tối ưu những chỗ còn tối ưu được, theo đúng các pattern sẵn có của codebase.

### Nguyên tắc thiết kế (bám code hiện tại)

- **Non-fatal là mặc định**: mọi handler mới wrap try/catch, lỗi → `warn()` + tiếp tục, KHÔNG bao giờ làm rớt call đang chạy (giống `applyReceiveLayers`, `applyVideoQuality`).
- **State language-neutral**: UI nhận _code_, map sang i18n lúc render (giống `AudioErrorKind`). Không bao giờ bake chuỗi đã dịch vào state.
- **Identity = socket.id**: mọi event mới resolve session_id → socket.id qua `socketIdForSession()` đã có.
- **Atoms + controller bridge**: DailyAudio phát event qua `AudioRoomEvents`, `AudioRoomController` đổ vào atom, component đọc atom. Không prop-drill.

### File chạm tới

| File | Vai trò |
| --- | --- |
| `excalidraw-app/audio/DailyAudio.ts` | core call-object — thêm event wiring + governor |
| `excalidraw-app/audio/audioTypes.ts` | `AudioRoomEvents` — thêm callback |
| `excalidraw-app/audio/connectionState.ts` | **MỚI** — atom mạng/CPU/quality |
| `excalidraw-app/audio/AudioRoomController.tsx` | bridge event → atom |
| `excalidraw-app/components/mcm/ConnectionBanner.tsx` | **MỚI** — banner reconnect + chip chất lượng |
| `excalidraw-app/components/mcm/MeetingShell.tsx` | render banner |
| `excalidraw-app/screenshare/DailyScreenShare.ts` | parity event handling |
| `excalidraw-app/i18n/mcm/{vi,ko,en}.ts` | strings |
| `worker/src/index.ts` | room properties (Phase 7) |

---

## Phase 0 — Media processing conformance (quick wins, làm trước)

Đối chiếu `videoBg.ts` + `DailyAudio.setVideoBackground/applyVideoQuality` với docs media-processing. Shape processor, `source` field, atomic-replace re-send, strength (0,1], re-apply on camera-on — **đã đúng, giữ nguyên**. Cần sửa:

- **0a. Ảnh nền `.webp` không hợp lệ**: Daily `background-image` chỉ nhận **jpg/jpeg/png** (URL string hoặc ArrayBuffer). Preset `office-forest` trỏ `/backgrounds/client-forest.webp` → fail âm thầm. Đổi sang `.png`/`.jpg` (convert asset hoặc thay preset). Sửa `VIDEO_BG_IMAGE_PRESETS` trong `videoBg.ts`.
- **0b. Support detection dùng cờ chính thức**: thay heuristic `pointer:fine` trong `isVideoBgSupported()` bằng `Daily.supportedBrowser().supportsVideoProcessing` (bao OffscreenCanvas+WebGL, loại desktop Safari). Giữ fallback cũ nếu cờ không đọc được. Tránh hiện toggle blur ở nơi nó no-op.
- **0c. `video-processor-error` (gắn với Phase 2 nonfatal)**: docs — khi processor lỗi, Daily **clear processor settings + tắt local video**. Handler phải: (1) sync `cameraStateAtom` về `off`, (2) đọc state thật từ `input-settings-updated` (KHÔNG giả định settings cuối còn hiệu lực), (3) toast "đã tắt nền ảo/camera do lỗi xử lý". Wire `call.on("input-settings-updated", …)`.
- **0d. Không truyền `strength: 0`** để tắt (đã đúng) — giữ nguyên, chỉ thêm test khẳng định `toDailyProcessor({kind:'none'})` ⇒ `{type:'none'}`.
- **Bỏ** handler `video-processor-warning` khỏi Phase 2 (không phải type tài liệu hoá trong 0.90).

**Test**: unit test `toDailyProcessor` mapping; build với preset png; mock `supportedBrowser` để xác nhận gate.

---

## Phase 1 — Network resilience (P1, ưu tiên cao nhất)

**Vì sao trước**: app đi đa quốc gia (VN WiFi chặn, 4G chập chờn, Philippines). Hiện user rớt SFU/signaling chỉ thấy đứng hình, không biết gì.

### 1a. `network-connection` → banner "đang kết nối lại"

- Wire trong `DailyAudio.wire()`:
  ```ts
  call.on("network-connection", this.onNetworkConnection);
  ```
- Payload: `{ type: 'signaling'|'sfu'|'peer-to-peer', event: 'connected'|'interrupted', sfu_id, session_id }`.
- Xử lý:
  - `interrupted` (sfu) → state `reconnecting`, banner amber "Mất kết nối, đang kết nối lại…". Media tự phục hồi.
  - `interrupted` (signaling) → **cảnh báo nặng**: Daily eject sau ~20s. Banner đỏ "Kết nối không ổn định — có thể bị ngắt".
  - `connected` → clear banner, toast xanh "Đã kết nối lại" (auto-ẩn 3s).
- Emit qua callback mới `onConnectionState?(state: ConnectionLifecycle)`.

### 1b. `network-quality-change` → chip chất lượng kết nối

- Wire: `call.on("network-quality-change", this.onNetworkQuality)`.
- Payload (0.90): `{ networkState: 'good'|'low'|'bad', networkStateReasons: string[], stats }`. KHÔNG dùng `threshold`/`quality` (deprecated v0.77).
- Emit `onConnectionQuality?(q: 'good'|'low'|'bad', reasons: string[])`.
- UI: chip nhỏ ở header meeting (●xanh/●vàng/●đỏ) + tooltip lý do (`sendPacketLoss`/`recvPacketLoss`…). `bad` kéo dài → gợi ý tắt camera.

### 1c. State + UI

- `connectionState.ts` (mới):
  ```ts
  export type ConnectionLifecycle = "connected" | "reconnecting" | "unstable";
  export type ConnectionQuality = "good" | "low" | "bad";
  export const connectionStateAtom = atom<{
    lifecycle: ConnectionLifecycle;
    quality: ConnectionQuality;
    reasons: string[];
  }>({ lifecycle: "connected", quality: "good", reasons: [] });
  ```
- `ConnectionBanner.tsx`: đọc atom, render banner (reconnecting/unstable) + chip quality. Mount trong `MeetingShell`.
- Controller: thêm `onConnectionState`/`onConnectionQuality` → `setConnectionState`. Reset về `connected/good` khi tear-down (chỗ `setAudioState idle`).

**Test**: throttle network (DevTools offline 5s) → banner reconnecting → connected. Unit test cho mapping payload → state.

---

## Phase 2 — Device & error events (P2)

Hiện lỗi mic bắt qua `getUserMedia` try/catch (phân loại NotAllowed/NotReadable ở controller). Thiếu event có cấu trúc của Daily và toàn bộ `nonfatal-error`.

### 2a. `camera-error`

- Wire: `call.on("camera-error", this.onCameraError)`.
- Payload: `error.type` (`permissions`|`cam-in-use`|`mic-in-use`|`not-found`| `constraints`|`undefined-mediadevices`|`unknown`), `error.blockedBy`, `error.blockedMedia`, `error.missingMedia`.
- Map sang `cameraStateAtom` (`status: "error"` + code) và/hoặc `AudioErrorKind`. `permissions` → hiện nút "Cho phép camera/mic" + hướng dẫn. Bổ sung enum `CameraErrorKind` thay vì chỉ message thô.

### 2b. `nonfatal-error`

- Wire: `call.on("nonfatal-error", this.onNonfatalError)`.
- Payload `type`: `input-settings-error`, `screen-share-error`, `video-processor-error`, `audio-processor-error`, `local-audio-level-observer-error`, `meeting-session-data-error`…
- Xử lý quan trọng cho code hiện có: `video-processor-error` (virtual background blur fail dưới tải CPU — hiện đang nuốt lặng ở `setVideoBackground`). → toast nhẹ "Đã tắt nền ảo do máy quá tải", KHÔNG rớt camera.
- Emit `onNonfatal?(type: string, msg: string)` → toast, không đổi call state.

### 2c. `error` (fatal) — phân loại lại

- `onFatalError` hiện chỉ `new Error(errorMsg)`. Nâng cấp đọc `e.error?.type`: `ejected`, `exp-token`/`exp-room`, `meeting-full`, `not-allowed`, `connection-error`, `end-of-life`. Mỗi loại → UX riêng (phòng đầy / token hết hạn → mời refresh / version EOL).

**Test**: revoke camera permission giữa call → toast đúng; ép `meeting-full` → message đúng.

---

## Phase 3 — CPU + adaptive quality governor (P2, tối ưu lõi)

Gộp `cpu-load-change` + `network-quality-change` thành **một governor** tự hạ/ nâng chất lượng — đây là phần "tối ưu được thì tối ưu luôn".

### 3a. `cpu-load-change`

- Wire: `call.on("cpu-load-change", this.onCpuLoad)`.
- Payload: `{ cpuLoadState: 'low'|'high', cpuLoadStateReason: 'encode'|'decode'|'scheduleDuration'|'none' }`.
- App vừa render canvas Excalidraw vừa chạy blur processor → CPU cao là thật.

### 3b. Governor (DailyAudio, method `private governQuality()`)

Một state machine nhẹ hợp nhất 2 tín hiệu, **không chống lại** ABR của Daily — chỉ dịch trần (ceiling) như `applyVideoQuality` đang làm:

- `cpu high + reason=encode` **hoặc** `networkState=bad` → hạ send tier 1 nấc (high→medium→low) qua `updateSendSettings` + cân nhắc tắt blur tạm.
- `cpu high + reason=decode` → hạ receive: `RECEIVE_LAYER_BASE` về 0 cho tile không phải speaker (xem 5b) + giảm số tile subscribe (xem 5a).
- `low/good` ổn định ≥15s → nâng lại 1 nấc, **trần vẫn là `clampQuality(user, adminCap)`** (không vượt admin cap).
- Hysteresis + cooldown để không "đập" tier liên tục.
- Toàn bộ best-effort, non-fatal.

**Lưu ý**: governor chỉ override TẠM trần hiệu lực; pref người dùng giữ nguyên, khôi phục khi mạng/CPU hồi. Ghi `console.info("[audio] governor …")` để trace.

**Test**: giả lập `cpu-load-change high/encode` → xác nhận `updateSendSettings` xuống nấc; hồi `low` → nâng lại, không vượt cap.

---

## Phase 4 — Observability (P3)

Docs nêu rõ Daily **không có webhook chất lượng call live** → phải tự pull.

### 4a. `getNetworkStats()` polling

- Interval ~2s khi call live (clear trong `stop()`).
- Lấy `stats.latest.{videoSendBitsPerSecond, videoRecvBitsPerSecond, totalSendPacketLoss, totalRecvPacketLoss, networkRoundTripTime, availableOutgoingBitrate}` + `worstVideoSend/RecvPacketLoss`.
- Dùng cho: (1) tooltip chip quality số liệu thật, (2) feed governor (xác nhận trước khi nâng tier), (3) telemetry.

### 4b. `meetingSessionSummary()` — capture session id

- Gọi sau `joined-meeting`; lưu session id để đối chiếu log/recording sau họp.
- Wire `meeting-session-summary-updated` (tên đúng; KHÔNG phải `meeting-session-state-updated`).
- Emit `onSessionId?(id)` → controller có thể gắn vào recording metadata.

### 4c. Telemetry sink

- Gom mẫu (quality change, cpu change, stats mỗi ~10s, fatal/nonfatal) → POST gọn về Worker `POST /v1/daily/telemetry` (D1 bảng `daily_quality_log`), hoặc tối thiểu `console.info` có cấu trúc nếu chưa muốn build endpoint.
- Admin Console: tab thống kê chất lượng theo meeting (sau, tùy chọn).
- Reminder: webhook Daily chỉ có cho room/recording REST event, không có cho chất lượng live → đây là nguồn quan sát duy nhất.

---

## Phase 5 — Scale subscription (P3, tối ưu cho họp đông + mobile)

`subscribeToTracksAutomatically: true` + `max_participants` mặc định 50. Docs: laptop ~30 stream, mobile ~12, ~75 kbps/stream downstream. Trên ~30 video sẽ đuối.

### 5a. Manual subscription + pagination

- Khi số remote video > ngưỡng (desktop 20 / mobile 9, đo qua `deviceMemory`/UA), chuyển `setSubscribeToTracksAutomatically(false)` và chỉ subscribe các tile đang HIỂN THỊ (gallery page hiện tại + speaker) qua `updateParticipants()`.
- 3-tier: subscribed (đang xem) / staged (trang kề, giữ ấm) / unsubscribed.
- Tile ngoài viewport → `{ setSubscribedTracks: { video: false } }`.
- `MeetingGallery`/`VideoFilmstrip` báo "tile nào đang hiện" cho DailyAudio (callback mới hoặc atom `visibleTilesAtom`).

### 5b. Adaptive receive base layer

- `RECEIVE_LAYER_BASE` hiện cố định 1. Cho lưới lớn (>9 tile) hạ về 0 (docs khuyến nghị layer 0 mặc định cho grid lớn); lưới nhỏ giữ 1 (nét). Hàm `receiveBaseForTileCount(n)`.

### 5c. Ngưỡng tham số hoá

- Đưa ngưỡng (max video subscribe, base-layer cutoff) vào `videoQuality.ts` cạnh `QUALITY_TIERS` để admin tune sau, không hardcode rải rác.

**Lưu ý**: `log()` rõ khi pagination cắt bớt stream để không hiểu nhầm "đang hiện tất cả".

---

## Phase 6 — Screenshare parity

`DailyScreenShare.ts` là call object thứ 2 (`allowMultipleCallInstances`). Áp cùng chuẩn ở mức tối thiểu:

- `nonfatal-error` (`screen-share-error`) → message rõ thay vì nuốt.
- `error` fatal → phân loại.
- `network-connection` → nếu screenshare rớt, báo người đang trình bày.
- Cleanup giữ nguyên (`leave()`+`destroy()` đã có).

**Ghi chú kiến trúc**: 2 call object là deviation có chủ ý (lazy-join screenshare) — nhân đôi signaling nhưng chấp nhận được. Cân nhắc hợp nhất 1 call object (audio+video+screen) là việc lớn, để riêng, KHÔNG trong plan này.

---

## Phase 7 — Worker room/token hardening (tùy chọn)

`worker/src/index.ts` `GET /v1/daily/token` — room properties hiện đủ tốt. Thêm:

- `enable_network_ui` không cần (ta tự build UI).
- Cân nhắc `enable_adaptive_simulcast` / `enable_multiparty_adaptive_simulcast` (mặc định OFF) cho hành vi ABR tốt hơn khi đông — **test kỹ**, Firefox fallback 3-layer thường.
- `geo`: Daily auto-chọn region gần nhất; chỉ pin nếu thấy lệch (đa quốc gia nên để auto).
- Token: thêm `enable_recording` đúng scope nếu recording cần (theo July v1).
- Giữ nguyên `exp`/`eject_*` (chống cháy bill).

---

## Cross-cutting

- **i18n**: thêm keys cho banner/chip/toast vào `i18n/mcm/{vi,ko,en}.ts` (reconnecting, unstable, reconnected, quality good/low/bad + reasons, camera-permission, processor-disabled, meeting-full, token-expired).
- **Types**: dùng type Daily có sẵn (`DailyEventObjectNetworkConnectionEvent`, `DailyEventObjectNetworkQualityEvent`, `DailyEventObjectCpuLoadEvent`, `DailyEventObjectCameraError`, `DailyEventObjectNonfatalError`) từ `@daily-co/daily-js`.
- **Tests**: `yarn test:typecheck` + unit test payload→state mapping cho mỗi handler mới (mock DailyCall như `worker/test/dailyAdmin.test.ts` style).
- **Cleanup**: mọi interval/listener mới phải teardown trong `stop()` (đối xứng governor, stats poller).

---

## Thứ tự thực hiện đề xuất

| Bước | Nội dung | Lý do ưu tiên |
| --- | --- | --- |
| 1 | Phase 1 (network-connection + quality UI) | Impact trực tiếp demo đa quốc gia; chỉ thêm `.on()` + UI nhỏ |
| 2 | Phase 2 (camera-error + nonfatal-error) | Sửa lỗi nuốt lặng blur/permission đang có |
| 3 | Phase 3 (governor) | Tối ưu lõi, dựa trên event Phase 1 |
| 4 | Phase 4 (observability) | Cần để debug than phiền "lag" |
| 5 | Phase 5 (scale/pagination) | Chỉ cần khi họp >20 camera; làm trước Aug khách ngoài |
| 6 | Phase 6 (screenshare parity) | Nhỏ, làm kèm |
| 7 | Phase 7 (worker props) | Tùy chọn, test kỹ |

Phase 1–2 không đụng kiến trúc, có thể ship sớm. Phase 3–5 là tối ưu, build trên hạ tầng event của Phase 1.
