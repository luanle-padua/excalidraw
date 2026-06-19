> **TÀI LIỆU SINH TỰ ĐỘNG (generated).** Kiến trúc hiện thời, khảo sát đa-agent 2026-06-19. ĐỪNG hand-edit — regenerate khi cần. Hạ tầng/tên thật: xem docs/specs/infrastructure.md.

## Mục lục

- [Tổng quan](#tổng-quan)
- [1. App shell + Meeting UI + View modes](#1-app-shell--meeting-ui--view-modes)
- [2. Realtime collaboration + Durable Objects](#2-realtime-collaboration--durable-objects)
- [3. Audio call + Speech-to-Text pipeline](#3-audio-call--speech-to-text-pipeline)
- [4. Transcription, Caption Dock + Translation](#4-transcription-caption-dock--translation)
- [5. Screen share / Present](#5-screen-share--present)
- [6. Worker REST backend + Data (D1/R2)](#6-worker-rest-backend--data-d1r2)
- [7. Auth + Access / Permissions model](#7-auth--access--permissions-model)
- [8. Build, deploy, environments & infra](#8-build-deploy-environments--infra)
- [Xuyên suốt (cross-cutting)](#xuyên-suốt-cross-cutting)

---

## Tổng quan

**Canvas M (MCM, "MAP CanvasMeet")** là công cụ họp nội bộ xây trên một fork Excalidraw: một canvas cộng tác realtime được bọc bởi "chrome" cuộc họp (header, participants, video tiles, call controls, caption) cộng audio/screen-share, live transcription/translation, và một backend serverless duy nhất trên Cloudflare. Toàn bộ stack đã online Cloudflare từ 06-17 — không còn dev box / room-server / Fly.

Mọi "chrome" được mount vô điều kiện quanh Excalidraw (không có route riêng): `MeetingShell` (App.tsx:876) là wrapper top-level. Backend là **MỘT** Worker `mcm-storage` gánh REST `/v1`, realtime Durable Objects, AI proxy (Gemini) và STT proxy (Deepgram). Media (audio + screen share) đi thẳng client ↔ Daily.co SFU, không qua Worker. Auth là Supabase (JWT/JWKS verify offline ở Worker).

```
                                Browser (PWA, Excalidraw fork + MeetingShell chrome)
                                      │            │                 │
                 ┌────────────────────┘            │                 └──────────────┐
                 │ (login/JWT)                      │ (REST/WS/AI)                   │ (media)
                 ▼                                  ▼                                ▼
          Supabase Auth                  Cloudflare Pages  map-canvasm        Daily.co SFU
       (GoTrue, JWKS/ES256)              (app tĩnh, VITE_* nhúng build)    (audio + screen share)
                 ▲                                  │                                ▲
                 │ /auth/v1/* reverse-proxy         │ gọi API → VITE_APP_STORAGE_URL │ /v1/daily/token
                 │ (né ISP chặn supabase.co)        ▼                                │ mint token
                 └────────────────────  Worker mcm-storage  ──────────────────────────┘
                                        (mcm-storage.rnd-ai.workers.dev)
                                          │
              ┌───────────────────────────┼──────────────────────────────┬─────────────────┐
              │ REST /v1/* (Hono)          │ WS /rooms/:id/ws             │ WS /stt         │ /translate
              ▼                            ▼  (realtime relay)            ▼  (proxy)        ▼ /summarize /chatbot
        D1 mcm-db (metadata)         RoomDO (1 DO = 1 phòng,          Deepgram nova-3     Gemini 2.5 Flash
        R2 mcm-storage (blob,        Hibernation, E2E-encrypted        (STT live)         (dịch/summary/bot)
        trash/, backups/)            relay — KHÔNG decrypt scene)
```

Cross-reference giữa các subsystem được giữ inline trong từng mục (đặc biệt `captionSurfaceAtom` nối §1/§4/§5, identity-bridge `socket.id` nối §1/§2/§3, presence-vs-media nối §2/§5).

---

## 1. App shell + Meeting UI + View modes

### Trách nhiệm
Subsystem này là toàn bộ "chrome" bao quanh canvas Excalidraw cho Canvas M (MCM): header (brand/title/clock/đếm người/actions), thanh participants dưới đáy, các call controls nổi, và đặc biệt là **view modes của video** — quyết định mỗi người tự chọn surface hiển thị camera (minimal strip / filmstrip / gallery) cộng các overlay trực giao (floating presenter PiP, focus/pin của 1 người). Nó cũng host các overlay canvas (DXF/PDF/IFC/sticker/bot/caption), điều phối vòng đời meeting (join/leave/kick), đồng bộ identity từ session vào collab username, và route nơi caption dock mount. Đây là layout layer; mọi presence/identity/camera-stream được dựng ở `ParticipantsBar` rồi truyền xuống — các surface khác chỉ render lại cùng một `Tile[]`.

### Thành phần chính
- **`MeetingShell.tsx`** — outer chrome, mount tại App.tsx:876 (luôn wrap Excalidraw, không có route riêng). Dựng header + canvas-wrap + tất cả overlay; chạy các effect vòng đời (joinedAt, font preload, hydrate meeting files, resolve host identity, logParticipation heartbeat, sync session→profile). Quyết định `isHost`, `iAmPresenting`, `captionSurface` mount.
- **`MeetingHeader.tsx`** — brand "Canvas M (MCM)", title editable (organizer-only), meeting clock (objective từ `created_at`), đếm người (collaborators map) + đếm in-call (audioState), cluster actions: folder/transcript/LayoutSwitcher/Present/CC/lang/settings/invite/end/leave. Tự fetch meeting info, tính `canEditMeeting`/`canEndMeeting`, chạy AI summary khi End.
- **`MeetingCallControls.tsx`** — bar nổi cho WebRTC audio call (Daily); state machine idle/connecting/live/error; mic/camera toggle, raise-hand, reactions popover, `RecordingButton`. Ẩn khi `viewOnly` hoặc chưa vào room.
- **`ParticipantsBar.tsx`** (1425 dòng — trung tâm) — dựng `Tile[]` (export `type Tile`, export `TileVideo`), strip participants dưới đáy, resolve `focusedSocketId` qua `resolveFocusedId`, và **dispatch surface theo `videoLayout`**: render `VideoFilmstrip` / `MeetingGallery` / `FloatingPresenter` / `ParticipantsPanel`. Click tile → `togglePinnedSocketId`.
- **`LayoutSwitcher.tsx`** — popover chọn surface (minimal/filmstrip/gallery) + toggle floating presenter; hook `usePickVideoLayout()` ghi `videoLayoutAtom` đồng thời giữ `galleryOpenAtom` đồng bộ.
- **`MeetingGallery.tsx`** — modal full-screen grid ↔ speaker sub-mode (`gallerySubModeAtom`); reuse `GalleryTile` cho grid/big-tile/rail.
- **`VideoFilmstrip.tsx`** — rail camera ~140px dưới đáy qua `createPortal(document.body)`, set `body.mcm-has-filmstrip`.
- **`FloatingPresenter.tsx`** — PiP kéo-thả của 1 người focus, snap 4 góc (`floatingPresenterCornerAtom`), minimise thành puck.
- **Atoms**: `videoLayout.ts` (`videoLayoutAtom` persisted LS `mcm:videoLayout`), `videoFocus.ts` (`pinnedSocketIdAtom` ephemeral + `resolveFocusedId` pure + `gallerySubModeAtom`/`floatingPresenterAtom`/`floatingPresenterCornerAtom`), `videoState.ts` (`videoTilesAtom`, `galleryOpenAtom`, `cameraStateAtom`), `videoPerf.ts` (`activeSpeakerAtom`), `captionState.ts` (`captionSurfaceAtom` router).

### Luồng dữ liệu
```
Session (login) ──► MeetingShell effect ──► saveUserProfile + collabAPI.setUsername
                                          └► logParticipation (heartbeat 40s → D1)
getMeeting(roomId) ──► meetingCreator/HostEmail/viewerAuthority atoms ──► isHost / canEnd

DailyAudio (1 call object, audio+video) ──► AudioRoomController ──► videoTilesAtom (socket.id→MediaStream)
                                                                 └► activeSpeakerAtom (active-speaker-change)
collab presence (WS) ──► collaborators / peerProfiles / screenShareStateAtom / raisedHands / peerAudio

ParticipantsBar:  collaborators+profiles+videoTiles+audio ──► build Tile[]
                  resolveFocusedId(tiles, {pinned, activeSpeaker, sharerId, hostId})
                       precedence: pin > screen-sharer > active-speaker > host > first
                  ┌─ videoLayout==="filmstrip" → VideoFilmstrip(tiles, focusedSocketId)
                  ├─ ==="gallery" || galleryOpen → MeetingGallery
                  ├─ floatingPresenter && !gallery → FloatingPresenter
                  └─ always: strip + ParticipantsPanel (panelOpen)
   click tile → togglePinnedSocketId → focus recompute → mọi surface đồng ý 1 socketId

captionSurfaceAtom (derived: screenShareMedia + floatingPresenter + galleryOpen + poppedOut)
   → ONE surface owns dock: popout|pane|gallery|presenter|overlay|panel-only|none
   → MeetingShell mount overlay khi ==="overlay"; Gallery/FloatingPresenter/Pane mount theo value của mình
```

### File then chốt
- `excalidraw-app/App.tsx:876` — `<MeetingShell>` wrap Excalidraw (mount vô điều kiện ở top-level return; 99 import).
- `MeetingShell.tsx:134-136` — `isHost` = `!isGuest && (socket-elected host || viewerAuthority)`.
- `MeetingShell.tsx:146-151` — `canScreenShare` detect `getDisplayMedia` (iOS Safari thiếu); `someoneElseSharing` lock.
- `MeetingShell.tsx:284-301` — `logParticipation` heartbeat 40s (skip stealth/viewOnly).
- `MeetingShell.tsx:315-362` — sync session→userProfile (chống avatar/name của user trước trên máy demo dùng chung; `mcm:userProfile:v1` là 1 key/browser).
- `MeetingShell.tsx:405-407` — chỉ mount `LiveCaptionDock variant="overlay"` khi `captionSurface==="overlay"`.
- `videoFocus.ts:61-87` — `resolveFocusedId` precedence (pure, không có atom mới).
- `videoLayout.ts:13,37-47` — `VideoLayout` union 3 giá trị, persist LS.
- `captionState.ts:171-202` — `captionSurfaceAtom` router 7-surface, precedence theo viewport.
- `ParticipantsBar.tsx:1160-1167` — tính `sharerId` = key đầu của presence map, gọi resolveFocusedId.
- `ParticipantsBar.tsx:1210-1242` — dispatch filmstrip/gallery/floating theo `videoLayout`.
- `MeetingHeader.tsx:226-244` — meeting clock dùng `created_at` (objective, late joiner thấy cùng giờ).
- `MeetingHeader.tsx:315-331` — `canEndMeeting` (host/organizer/cohost/viewerAuthority/legacy-internal).
- `MeetingHeader.tsx:398-426` — End → `updateMeeting status=finished` trước, rồi AI summary fire-and-forget + broadcast `END_MEETING` + `markReviewRoom`.

### Quyết định & gotcha
- **1 Daily call object cho cả audio + video** (`videoState.ts:1-10`), không phải room riêng; video tiles keyed bằng **socket.id** (identity bridge — xem §2/§3), không phải Daily session_id — để khớp với tile sẵn có.
- **`activeSpeakerAtom` cũng key bằng socket.id** (`videoPerf.ts`), set bởi AudioRoomController; nó cũng được DailyAudio dùng nội bộ để promote simulcast layer nhưng đó là ở DailyAudio, UI chỉ mirror.
- **VideoLayout (surface) tách hẳn videoFocus (overlay)** — cố ý không gộp pin/floating/gallery-submode vào enum surface; mỗi union giữ "honest". Surface persist per-user (LS), pin/floating/active-speaker **ephemeral, không synced** (mỗi viewer tự chọn).
- **`captionSurfaceAtom` là single source of truth** chống double-mount: trước đây mỗi surface tự quyết từ share/PiP flags cục bộ → viewer pop floating presenter khi đang xem share bị mount 2 dock, dock leak ra canvas cạnh STT panel. Router route theo **media state** (không theo presence map) vì media mới biết viewer có pane để pin không, và tránh import Collab nặng. Cùng router này được §4 (caption) và §5 (screen share pop-out) tiêu thụ.
- **`galleryOpenAtom` legacy giữ đồng bộ với `videoLayout==="gallery"`** qua `usePickVideoLayout` — nhiều consumer đọc một trong hai signal, cả hai phải đồng ý; điều kiện render gallery là `videoLayout==="gallery" || galleryOpen`.
- **FloatingPresenter không bao giờ show mặt mình**: `focusedSocketId` có thể bottom-out về self (tiles[0]) khi không ai share/nói → fallback sang remote tile đầu, render null khi ở một mình; PiP bị tắt trong gallery (redundant).
- **VideoFilmstrip dùng `createPortal(document.body)`** + class `mcm-has-filmstrip` trên `<body>` để CSS global nâng call controls trên rail 140px và slim people-bar.
- **Present button**: disable bằng absence của `getDisplayMedia` (robust hơn UA-sniff iPad spoof desktop UA); single-sharer lock qua presence map (xem §5).
- **Meeting clock objective** từ registry `created_at` (late joiner cùng elapsed), fallback room-entry chỉ cho ad-hoc room.
- **`viewOnly` (finished/review)** gate khắp nơi: ẩn StickerPicker/CanvasBotTool/TextTranslateOverlay (writes), ẩn call controls, ẩn End/Invite — immutable extract-only.
- **CC toggle nằm ở header** (`captionDockEnabledAtom`, persist `mcm:captionDockEnabled`) vì panel-only/none surface không có dock → không có CC puck; phân biệt với `sttEnabledAtom` (nguồn STT) và STT panel control.
- **`MOCK_PARTICIPANTS`** vẫn được truyền làm `participantCount` fallback cho preview/storybook (MeetingShell.tsx:367) — real count đến từ collaborators map.
- **AI summary khi End là fire-and-forget** (Gemini hiccup không được block/delay việc kết thúc); status=finished ghi D1 trước mọi side-effect, fail thì abort sạch.

---

## 2. Realtime collaboration + Durable Objects

### Trách nhiệm
Relay realtime E2E-encrypted cho mỗi phòng họp (1 DO = 1 roomId): đồng bộ scene/cursor (Excalidraw collab), presence (user profile, screen-share, raise-hand, audio/mic, knock/host control), và các kênh phụ (chat, library, STT segment, reactions, recording state). Server là **dumb relay** — chỉ route frame và suy ra presence, **không bao giờ decrypt** scene/cursor bytes (roomKey nằm trong `#room` hash, không gửi lên server). Đã cutover **100% từ socket.io relay (Fly.io) sang Cloudflare Durable Objects** (`roomDO.ts` comment 1-9; `Collab.tsx:1134`).

### Thành phần chính
- `RoomDO` (Durable Object server) — `worker/src/roomDO.ts`: WebSocket Hibernation API relay (`acceptWebSocket` + `webSocketMessage/Close/Error/alarm`), presence, host-election input, ghost reaper. Binding `ROOM` / `new_sqlite_classes:["RoomDO"]` (`wrangler.jsonc:62-77`).
- `handleRealtimeUpgrade` (AUTH GATE) — `worker/src/index.ts:6283`: verify JWT + `canSeeMeeting` + finished + knock + WS-cap TRƯỚC khi `env.ROOM.get()` và TRƯỚC 101. Route-split `GET /rooms/:roomId/ws` ở fetch entrypoint (`index.ts:6441-6448`), TRƯỚC Hono.
- `verifyRealtimeJwt` — `index.ts:6220`: offline ES256 JWKS verify (issuer + audience `authenticated`), mirror /v1 middleware.
- `RawWsTransport` (client transport) — `excalidraw-app/collab/RawWsTransport.ts`: shim native WebSocket trình bày đúng slice của socket.io `Socket` (`.on/.off/.once/.emit/.id/.connect/.close` + lifecycle `connect`/`disconnect`/`connect_error`) để downstream chạy byte-identical. Reconnect backoff, heartbeat, circuit breaker.
- `Portal` — `excalidraw-app/collab/Portal.tsx`: mọi hàm `broadcast*` đóng gói `WS_SUBTYPES` → `_broadcastSocketData` (encrypt bằng roomKey → emit `server-broadcast`/`server-volatile-broadcast`). Transport-agnostic (`socket` có thể là socket.io hoặc RawWsTransport cast).
- `Collab` — `excalidraw-app/collab/Collab.tsx`: `startCollaboration` chọn transport (`:1132-1155`), handler `client-broadcast` với 18-subtype switch (`:1291`), `_reconcileElements` (`:1726`), host election atom.
- `WS_EVENTS` / `WS_SUBTYPES` — `excalidraw-app/app_constants.ts:16-70`: tên event wire + 18 subtype payload.

### Luồng dữ liệu
```
Client A                     Worker (AUTH GATE)            RoomDO (1/room)            Client B
--------                     ------------------            -----------------          --------
ws://…/rooms/:id/ws
  Sec-WebSocket-Protocol:
    [mcm.v1, <JWT>]   ─────►  realtimeToken: token =
                              segment ≠ "mcm.v1"
                              verifyRealtimeJwt (JWKS)
                              canSeeMeeting / finished(409)
                              knock 'admitted'(403)
                              __count RPC < cap(403)
                              set x-mcm-sub/email/role  ──►  fetch(server WS)
                              echo subprotocol "mcm.v1"      acceptWebSocket([socketId])
  ◄── 101 (Sec-WS-Protocol: mcm.v1) ◄────────────────────── serializeAttachment
                                                            send "init-room"[{socketId}]
on "init-room" → .id=socketId
emit "join-room"  ───────────────────────────────────────► onJoinRoom:
                                                            first-in-room | new-user
                                                            broadcast "room-user-change" ─► setCollaborators
broadcastScene(INIT) → encrypt(roomKey)
emit "server-broadcast"
  BINARY [type:1][iv:12][cipher] ──────────────────────►   handleBinary: relay byte-identical ─► on "client-broadcast"
                                                                                                  decryptPayload → switch(type)
                                                                                                  → _reconcileElements
```

Cursor/idle/reactions đi qua `server-volatile-broadcast` (BINARY type 2) → drop-on-backpressure cả hai phía. Control (join-room, user-follow, rtc-signal, hb) đi qua CONTROL JSON `{ev,args}`.

### File then chốt
- `worker/src/index.ts:6283` `handleRealtimeUpgrade` (4 gate: JWT→canSee→finished 409→knock 403→cap 403, fail-open chỉ ở cap `:6386`).
- `worker/src/index.ts:6189` `realtimeToken` — token từ subprotocol, echo marker chứ KHÔNG echo JWT (`:6401`).
- `worker/src/index.ts:6441` route-split `/rooms/:id/ws`; `:6455` `/stt` tách TRƯỚC để không chạm RoomDO.
- `worker/src/roomDO.ts:167` `fetch` (`__count`/`__destroy`/upgrade); `:243` send `init-room`; `:259` `webSocketMessage` (typeof string vs ArrayBuffer); `:390` `onJoinRoom` (first-in-room qua flag persisted `roomEverInitialized`); `:499` `handleBinary` relay opaque; `:592` `alarm` ghost reaper.
- `worker/src/roomDO.ts:115` `WsAttachment` (`serializeAttachment`, sống sót hibernation).
- `excalidraw-app/collab/RawWsTransport.ts:189` `emit` (binary vs control); `:245` `openSocket` (token qua subprotocol); `:364` `scheduleReconnect` (circuit breaker); `:463` `sendBinary` (frame `[type][iv][cipher]`, drop volatile).
- `excalidraw-app/collab/Portal.tsx:95` `_broadcastSocketData` (CENTRAL REVIEW SEAL + encrypt); `:47` `open` (init-room→join-room→new-user).
- `excalidraw-app/collab/Collab.tsx:1147` `wsBase`; `:1150` `new RawWsTransport`; `:1291` 18-subtype `client-broadcast` switch; `:1726` `_reconcileElements`.
- `excalidraw-app/app_constants.ts:16` `WS_EVENTS`, `:23` `WS_SUBTYPES`.

### Quyết định & gotcha
- **`binaryType = "arraybuffer"`** bắt buộc đặt trên client WS (`RawWsTransport.ts:278`); nếu là Blob, `handleMessage` log + drop (`:447`). (Cùng họ bug Blob với STT — xem §3/§8.)
- **Wire frame phải khớp byte-identical 2 phía**: `[type:1B][iv:12B][ciphertext]`, type 1=broadcast / 2=volatile. Hằng số trùng nhau: client `FRAME_BROADCAST/VOLATILE` (`RawWsTransport.ts:43`), server `BINARY_BROADCAST/VOLATILE` + `IV_LENGTH=12` (`roomDO.ts:30-35`). roomId bị **drop khỏi wire** (1 DO = 1 room) (`RawWsTransport.ts:468`).
- **JWT trong WS subprotocol, KHÔNG query param** (`?token=` chỉ là fallback) — query param leak vào logs/referrer (plan §4 R7). Browser WS API không có header knob nên subprotocol là field duy nhất app điều khiển. Phải echo marker `mcm.v1` (không echo JWT) trên 101 hoặc handshake fail (`index.ts:6401`, `roomDO`/`RawWsTransport` comment).
- **DO RE-TRUSTS identity** qua header `x-mcm-sub/email/role`, **không re-verify JWKS** trong hot path (`index.ts:6394`, `roomDO.ts:208-211`). Auth chỉ ở Worker gate (xem §7).
- **first-in-room dùng flag persisted `roomEverInitialized`, KHÔNG dùng `getWebSockets().length`** — wake-from-hibernation socket đầu tiên không được báo "first" (sẽ clear scene). Plan §3.1 invariant 1 (`roomDO.ts:390-406`).
- **Reconnect-storm fix (06-18)**: backoff 0.5s→30s full-jitter; chỉ reset counter sau `STABLE_OPEN_MS=10s` mở ổn định (`RawWsTransport.ts:290-296`); circuit breaker `MAX_RECONNECT_ATTEMPTS=60` (`:376`). Lý do: upgrade bị reject vĩnh viễn (finished 409 / revoked-not-invited 403 / token 401) đều trả **TRƯỚC 101** nên browser chỉ thấy generic close, không thấy status → retry vô hạn nếu không cap.
- **Ghost reaper (06-18)**: client gửi `hb` control mỗi `HEARTBEAT_MS=40s` (`RawWsTransport.ts:77,348`); DO `alarm` mỗi 50s drop socket `lastSeen` > `GHOST_TIMEOUT_MS=130s` (`roomDO.ts:61,592`). `hb` là frame riêng KHÁC runtime ping/pong auto-response — ping/pong KHÔNG wake DO nên không refresh lastSeen server-side. Alarm chỉ re-arm khi còn socket → phòng rỗng hibernate, giữ $0 idle.
- **CENTRAL REVIEW SEAL** (`Portal.tsx:106`): reviewer của finished meeting (`meetingViewOnlyAtom`) emit NOTHING — relay không gate server-side nên un-gated broadcast sẽ desync mọi peer. Worker cũng re-enforce: finished → 409 trên upgrade (`index.ts:6334`).
- **Transport-agnostic 100% DO**: không còn branch theo `realtime_backend` flag ở client — mọi entry path (live / ad-hoc / review) dùng RawWsTransport; flag chỉ giữ cho admin rollout view (`Collab.tsx:975-981,1024`). `wsBase` = `VITE_APP_STORAGE_URL` (mcm-storage Worker) hoặc `""` same-origin khi `VITE_DEV_TUNNEL=true` (`:1141-1149`).
- **Volatile backpressure drop** hai phía: client `VOLATILE_BUFFER_LIMIT_BYTES=256KiB` (`RawWsTransport.ts:82`), server `VOLATILE_BUFFER_THRESHOLD=512KiB` (`roomDO.ts:43`) — chống cursor 60fps làm phình buffer.
- **rtc-signal / request-room-clients hiện UNUSED** (WebRTC audio mesh đã thay bằng Daily.co — xem §3) nhưng giữ lại forward-compat (`roomDO.ts:361-371`). Screen-share/audio chỉ là **presence signal** qua subtype; media thật chạy trên Daily.co.
- **room-user-change debounce 250ms** (`ROOM_USER_CHANGE_DEBOUNCE_MS`, `roomDO.ts:47,564`) gộp burst N×close khi deploy/restart thành 1 broadcast.
- **realtime.reject audit dedup** per-isolate Map ~1 row/phút/(room,email,reason) chống reconnect-storm làm ngập audit_log; pre-auth 401 (anonymous) bỏ qua audit hẳn (`index.ts:6247-6307`).
- **Reconcile**: `_reconcileElements` (`Collab.tsx:1726`) dùng `reconcileElements` + `bumpElementVersions`; reconnect KHÔNG gọi `Portal.close()` nên `broadcastedElementVersions` được giữ → không re-broadcast full scene (invariant 2). `__destroy` RPC hard-wipe storage DO khi meeting hard-delete (`roomDO.ts:184`).

---

## 3. Audio call + Speech-to-Text pipeline

### Trách nhiệm
Subsystem cung cấp (1) **voice/video call** thời gian thực cho phòng họp (mic, camera opt-in, speaking-ring, recorder mixer) trên hạ tầng **Daily.co SFU**, và (2) **live Speech-to-Text** stream mic của user qua **Cloudflare Worker `/stt` proxy → Deepgram nova-3**, sinh interim/final transcript rồi broadcast cho mọi peer (caption + log). STT là provider-agnostic qua một seam adapter (Deepgram live; OpenAI/ElevenLabs/Gemini-Live còn skeleton). Hai phần dùng CHUNG một AudioContext được unlock trong Join gesture.

### Thành phần chính
- **`DailyAudio`** (`excalidraw-app/audio/DailyAudio.ts:86`) — imperative manager của call: acquire mic (fallback listener-only khi NotFoundError), mint Daily token (bake socket.id), join room `"<roomId>-audio"` riêng với screen-share room, publish mic, phát remote audio qua hidden `<audio>` (call-object mode KHÔNG auto-play), speaking analyser, camera opt-in, receive-layer simulcast optimisation. Surface API giữ nguyên như mesh AudioRoom cũ.
- **`AudioRoomController`** (`excalidraw-app/audio/AudioRoomController.tsx:37`) — React glue mount ở app-shell; provision/teardown `DailyAudio` theo `activeRoomLinkAtom`, bơm event vào Jotai (`audioStateAtom`, `videoTilesAtom`, `activeSpeakerAtom`...), và quản vòng đời `STTSession` (chạy khi `audio live + canTransmit + sttEnabled`).
- **`STTSession`** (`excalidraw-app/audio/sttSession.ts:119`) — client STT: mở WS tới `/stt`, load AudioWorklet, route `source → worklet → gain=0 sink → destination`, gửi PCM binary, parse Deepgram `Results`/`Error` frame, phát `onInterim/onFinal/onCapture/onError`.
- **`sttWorklet.js`** (`excalidraw-app/audio/sttWorklet.js`) — AudioWorkletProcessor `stt-downsampler`: Float32@native → Int16 LE 16kHz mono, anti-alias box-filter decimation, post mỗi ~100ms (`registerProcessor`, line 112). PHẢI là plain JS.
- **`stt.ts` (Worker)** (`worker/src/stt.ts:219` `handleSttUpgrade`) — WS proxy: kill-switch, JWT auth, membership gate, real-money guards, mở upstream adapter, pipe PCM lên / transcript xuống, meter cost vào D1.
- **`stt-provider.ts`** (`worker/src/stt-provider.ts`) — seam `SttAdapter` + `REGISTRY` (`deepgram`/`openai`/`elevenlabs`/`gemini-live`), `DeepgramAdapter` (line 319, nova-3 + keyterms KO + endpointing per-lang), skeleton adapters, `getProviderByIdOrActive` (line 690).
- **`aiBackend.ts`** (`excalidraw-app/data/aiBackend.ts:24` `sttBackendWsUrl`) — base WS = `VITE_APP_STORAGE_URL` (Worker), không còn Fly.
- **`transcription.ts`** (`excalidraw-app/data/transcription.ts`) — atoms: `sttEnabledAtom`, `sttSpokenLanguageAtom`, `sttCapturingAtom`, `sttLiveErrorAtom`, `liveTranscriptsAtom`, `transcriptionLogAtom` (+ localStorage persist theo roomId).
- **`sttProviders.ts`** (`excalidraw-app/data/sttProviders.ts`) — client mirror metadata + `sttProviderAtom` (A/B picker; chỉ Deepgram live, còn lại `comingSoon`).
- **Collab/Portal** — `publishSTTSegment`/`applySTTSegment` (`collab/Collab.tsx:2535/2490`), `broadcastSTTSegment` (`collab/Portal.tsx:411`) qua `WS_SUBTYPES.STT_SEGMENT` (`app_constants.ts:51`). **Chỉ final được broadcast; interim là local-only**.
- **Token route** `worker/src/index.ts:3907` `/v1/daily/token` — `?uid` → Daily `user_id` (line 4032), room tạo với `start_audio_off: true` (line 3996).

### Luồng dữ liệu
```
Join click ─ unlockAudioPlayback(): play silent WAV + new+resume captureCtx (trong gesture)
   │
DailyAudio.start: getUserMedia(mic) → waitForSocketId → getDailyToken(rid,name,uid)
   │                                        ↓ Worker mint token (user_id=socket.id), create "<rid>-audio"
   └─ Daily.join → setLocalAudio(!muted)  ── SFU fans out ──► remote peers
            ▲                                      │
   onPeerStream → recorder.addStream          remote track ─► hidden <audio> (phát) + analyser (speaking) + onPeerStream

STT (song song, dùng captureCtx của DailyAudio):
 mic.clone() → MediaStreamSource → AudioWorklet(stt-downsampler) → Int16 16k PCM
   │  (onmessage: peak→onCapture heartbeat; ws.send(PCM))
   ▼
 WS /stt?lang&meetingId&provider  (subprotocol ["mcm.v1", <supabase JWT>])
   ▼  Worker handleSttUpgrade: STT_ENABLED → JWT verify → meetingId required → sttCanSeeMeeting → rate-limit
 adapter.open() ─ fetch(https://api.deepgram.com/v1/listen, Upgrade:websocket) ─► Deepgram
   ▲ PCM forward (binaryType=arraybuffer)        │ Results JSON
   └────────────────────────────────────────────┘ forward VERBATIM xuống client
   ▼
 STTSession.onmessage: Results.is_final ? onFinal → collab.publishSTTSegment → broadcast STT_SEGMENT → applySTTSegment (log+localStorage)
                                        : onInterim → setLocalInterimTranscript (KHÔNG broadcast)
```

### File then chốt
- `excalidraw-app/audio/DailyAudio.ts:152` (`start`), `:849` (`unlockAudioPlayback`/captureCtx), `:885` (`getCaptureContext`), `:889` (`playPeerAudio` + autoplay-resume capture-phase listener), `:535` (`applyReceiveLayers`), `:637` (`waitForSocketId`)
- `excalidraw-app/audio/AudioRoomController.tsx:239` (STT lifecycle effect), `:289` (reuse `getCaptureContext`), `:298` (`onCapture` gate >0.01), `:332` (capture watchdog 1.5s)
- `excalidraw-app/audio/sttSession.ts:174` (subprotocol token), `:177` (`binaryType="arraybuffer"`), `:247` (reuse audioCtx, `ownsCtx`), `:284` (clone mic track), `:308` (worklet), `:349` (gain=0 sink)
- `excalidraw-app/audio/sttWorklet.js:41` (`TARGET_BUFFER_SAMPLES` ~100ms), `:86` (box-filter)
- `worker/src/stt.ts:231` (kill-switch), `:241` (auth), `:262` (meetingId required), `:265` (membership), `:292` (`server.binaryType="arraybuffer"`), `:326` (cost meter), `:531` (echo subprotocol trên 101)
- `worker/src/stt-provider.ts:131/137/262/274` (model/keyterms/endpointing/buildDeepgramUrl), `:340` (fetch upgrade), `:108` (`wrapBinaryAsJson`)

### Quyết định & gotcha
- **`binaryType="arraybuffer"` hai phía** — client (`sttSession.ts:177`) và Worker (`stt.ts:292`). Nếu Worker để mặc định Blob, `providerWs.send(blob)` → "[object Blob]" (Deepgram reject SchemaError) và `pcmToBase64` throw → "STT silent everywhere" (06-19). Xem [Xuyên suốt](#xuyên-suốt-cross-cutting).
- **Echo subprotocol trên 101** (`stt.ts:531`) — RFC 6455 yêu cầu server echo đúng 1 subprotocol, thiếu nó browser FAIL WS open → STT không bao giờ start (bug khi port từ Fly).
- **CF fetch WS upgrade phải `https://`, KHÔNG `wss://`** (`stt-provider.ts:315/436/543`) — port từ Node `ws` (wss://) làm upgrade fail.
- **Deepgram keyterms chỉ gắn khi `lang==="ko"`** (`stt-provider.ts:307`) — keyterms tiếng Hàn gửi kèm lang non-KO → Deepgram HTTP 400, vỡ STT cho EN/VI. `numerals` cũng đã bị bỏ vì gây 400 (line ~285).
- **Reuse AudioContext của DailyAudio cho STT** (`captureCtx` tạo+resume trong Join gesture) — context tạo trong React effect (không user activation) bị iOS Safari để SUSPENDED → worklet không emit PCM → Deepgram nhận silence (06-18). `ownsCtx` quyết định ai close.
- **Clone mic track cho STT** (`sttSession.ts:284`) — iOS giao mic độc quyền cho Daily PeerConnection; source node thứ 2 trên track live nhận silence → phải `.clone()`.
- **gain=0 sink node** (`sttSession.ts:349`) — AudioWorklet không có đường tới `destination` thì graph không PULL (process() không chạy) trên iOS/một số Chromium → `{ready}` nhưng 0 transcript (06-19).
- **`onCapture` level-gate (>0.01) + watchdog 1.5s** — phân biệt "đang capture thật" với silent clone (chunk vẫn chảy ở peak≈0); là tín hiệu "enabled nhưng no audio" cho PM thấy không cần console.
- **Worklet PHẢI `.js` plain** (`sttWorklet.js` header) — `?url` của Vite copy verbatim; nếu `.ts` thì prod serve raw TS (`video/mp2t`) và `addModule()` fail.
- **Membership gate FAIL-CLOSED + `meetingId` bắt buộc** (`stt.ts:262`) — bản cũ `if(meetingId && …)` là no-op (client chưa gửi meetingId), bypass được → bất kỳ user login nào cũng đốt key Deepgram.
- **Real-money guards**: `STT_ENABLED=off` kill-switch (503, không cần redeploy), open rate-limit per-isolate (soft, không cross-colo), `MAX_SESSION 90min`, `AUDIO_IDLE 60s` reset theo binary frame; cost metered per-session vào `usage_events` theo adapter (không hardcode Deepgram).
- **STT route nằm trên mcm-storage Worker** (DO migration I-1), tách TRƯỚC RoomDO route; base WS = `VITE_APP_STORAGE_URL`, tunnel mode → same-origin.
- **`?provider=` per-session A/B override** (`getProviderByIdOrActive`) — id lạ degrade về `STT_PROVIDER` env default (deepgram); chỉ Deepgram live, 3 adapter còn lại throw "provider not configured".
- **`GEMINI_LIVE_API_KEY` tách riêng `GEMINI_API_KEY`** (`stt-provider.ts:35`) — Live API là sản phẩm bidi-WS riêng billing; `GeminiLiveAdapter.open` là STUB (throw, line 649). Provider thật = `gemini-3.5-live-translate-preview`, chưa nối API.
- **Daily identity bridge** — token bake `?uid=socket.id` → Daily `user_id` + `setUserData({socketId})` fallback; thiếu nó camera/audio remote map sai về Daily UUID (06-18). Phải `waitForSocketId` trước khi mint (slow-network race). Đây là identity bridge dùng chung với §1 (video tiles) và §2 (presence).
- **Room tạo `start_audio_off:true`** → join với audioSource KHÔNG auto-publish; phải `setLocalAudio` thủ công nếu không peer im lặng (06-18 iPad).
- **Caption broadcast**: chỉ FINAL qua `STT_SEGMENT` (interim noisy → local-only); log persist localStorage theo roomId; segment dùng `socketId` (hoặc `"local"`). Render/dịch xem §4.

---

## 4. Transcription, Caption Dock + Translation

### Trách nhiệm
Subsystem realtime "nghe → chữ → dịch" của Canvas M: bắt mic local, đẩy PCM qua WebSocket tới Worker `/stt` (proxy Deepgram), nhận interim/final, broadcast final tới peers, dựng (a) panel transcript lịch sử trên canvas và (b) caption dock kiểu phụ đề khi present/share, và dịch từng dòng/từng tin chat sang ngôn ngữ ưu tiên của **mỗi viewer** qua Gemini (Worker). Đồng thời cung cấp `/summarize` + `/chatbot` đọc transcript làm context. (Phần capture/transport mic xem §3; phần này tập trung render + dịch + persistence.)

### Thành phần chính
- **`audio/sttSession.ts` — `STTSession`**: mic stream → AudioWorklet downsampler (`sttWorklet.js`) → WS `/stt`. Callback `onInterim/onFinal/onReady/onError/onClose/onCapture`. Định nghĩa `STTLang` (vi/en/ko/ja/zh/multi) và `STTProvider` (deepgram/openai/elevenlabs/gemini-live).
- **`audio/AudioRoomController.tsx`**: chủ sở hữu session LIVE — tạo `STTSession`, truyền `audioCtx` dùng chung (Daily unlock), nối `onCapture→sttCapturingAtom` + watchdog, `onInterim→collabAPI.setLocalInterimTranscript`, `onFinal→collabAPI.publishSTTSegment`; restart session khi đổi `sttProvider`/`spokenLang`.
- **`data/transcription.ts`**: atoms + persistence. `sttEnabledAtom`, `sttCapturingAtom`, `sttLiveErrorAtom`, `liveTranscriptsAtom` (Record<socketId,InterimEntry>), `transcriptionLogAtom` (append-only), `sttTranslateEnabledAtom`, `sttSpokenLanguageAtom`, `sttPanelStyleAtom`, `meetingSummaryAtom`; helpers localStorage keyed theo roomId (`mcm:transcript:*`, `mcm:summary:*`).
- **`data/translation.ts`**: `preferredLanguageAtom` (derived từ `appLangCodeAtom`), `translationEnabledAtom`, hook **`useTranslate(text,{assumedSource,preset})`** per-viewer (cache + dedup + fallback gốc), `fetchBatchTranslation` (1 round-trip mọi ngôn ngữ), `getCachedTranslation`, cache theo identity (`setTranslationCacheIdentity`).
- **`components/mcm/SpeechToTextPanel.tsx`**: overlay góc dưới-trái — lịch sử transcript đầy đủ, toggle STT/translate, chọn provider + spoken-language, drag/resize, density full/compact, **đường test upload audio file** (offline `STTSession`, không broadcast giả).
- **`components/mcm/LiveCaptionDock.tsx`**: dải phụ đề glass dưới surface đang present/share; hiện 1–3 dòng mới nhất của active speaker, mỗi viewer ngôn ngữ riêng; auto-hide khi im lặng (`SILENCE_HIDE_MS=4000`). Mount theo `captionSurfaceAtom` (pane/presenter/overlay/gallery).
- **`components/mcm/captionPopOut.ts` — `mountPopOutCaption(doc)`**: bản caption **DOM thuần** cho cửa sổ Document-PiP, subscribe trực tiếp `appJotaiStore` (không React, tránh reconciliation xuyên document); chỉ đọc cache dịch, không tự fetch.
- **`data/captionState.ts`**: prefs caption (`captionDockEnabledAtom` default ON, `captionLineCountAtom`, `captionFontScaleAtom`) + **router `captionSurfaceAtom`** quyết định DUY NHẤT surface nào sở hữu caption (xem §1 và §5).
- **`worker/src/ai.ts` (`aiRoutes` Hono)**: `/translate`, `/translate-batch`, `/chatbot`, `/summarize` → Gemini (`gemini-2.5-flash`).
- **`collab/Collab.tsx`**: `publishSTTSegment` (echo local + broadcast `WS_SUBTYPES.STT_SEGMENT`), `applySTTSegment` (dedup theo id, persist), `setLocalInterimTranscript` (KHÔNG broadcast), `persistTranscript`/`loadTranscriptHistory` (mirror R2).
- **`data/aiBackend.ts`**: `aiBackendUrl()` (HTTP) + `sttBackendWsUrl()` (ws/wss) — base = `VITE_APP_STORAGE_URL`, "" khi `VITE_DEV_TUNNEL=true`.

### Luồng dữ liệu
```
mic (Daily-owned) ──clone track──> AudioContext(shared) ──> AudioWorkletNode("stt-downsampler")
   └─ port.onmessage: Int16 PCM → ws.send(buf) ; peak level → onCapture(level)
      worklet → gain=0 sink → destination   (bắt buộc, nếu không graph không pull → im lặng)

WS /stt  (subprotocol ["mcm.v1", <supabase JWT>], binaryType="arraybuffer")
   Worker xác thực JWT + membership(meetingId) → proxy Deepgram
   ← {type:"ready"} → onReady (bật AI-activity)
   ← {type:"Results", is_final} →  is_final ? onFinal(text, Date.now()) : onInterim(text)

onInterim → collabAPI.setLocalInterimTranscript → liveTranscriptsAtom[me]  (LOCAL ONLY)
onFinal   → collabAPI.publishSTTSegment → applySTTSegment(local, dedup theo id)
                                        → portal.broadcastSTTSegment (STT_SEGMENT)
                                        → saveTranscriptLog(roomId) + persistTranscript()→R2(debounce 5s)
peer nhận STT_SEGMENT → applySTTSegment → transcriptionLogAtom (+ xóa interim của speaker đó)

Render (mỗi viewer):
  transcriptionLogAtom ─┬─> SpeechToTextPanel.SegmentRow → useTranslate(text,{assumedSource:seg.lang})
                        ├─> LiveCaptionDock.FinalCaptionLine → useTranslate(...) (gate bằng sttTranslateEnabledAtom)
                        └─> captionPopOut.buildLines → getCachedTranslation (chỉ đọc cache)
  liveTranscriptsAtom ─> interim ORIGINAL (italic, không dịch — tránh thrash API)
  useTranslate → /translate (Gemini) ; chat dùng fetchBatchTranslation → /translate-batch
```

### File then chốt
- `audio/sttSession.ts:177` — `ws.binaryType = "arraybuffer"`; `:175` subprotocol `[mcm.v1, token]`; `:308` AudioWorkletNode `"stt-downsampler"`; `:349-353` source→worklet→gain0 sink→destination (fix "ready nhưng không có transcript"); `:284` `tr.clone()` (fix iOS mic im lặng); `:222-225` is_final→onFinal/onInterim.
- `collab/Collab.tsx:1460` nhận `STT_SEGMENT`; `:2490` `applySTTSegment` (dedup id); `:2535` `publishSTTSegment`; `:2560` `setLocalInterimTranscript` (không broadcast); `:2164` `persistTranscript` (R2 debounce 5s); `:2185` `loadTranscriptHistory` (local cache thắng).
- `data/captionState.ts:171-202` — `captionSurfaceAtom` (router precedence popout→gallery→pane→presenter/overlay→panel-only); `:107-111` `CAPTION_FONT_SCALE_VALUE`.
- `data/transcription.ts:99` `sttCapturingAtom`; `:176-179` `sttSpokenLanguageAtom` (độc lập UI lang); `:28` `SPOKEN_LANGUAGES=[en,ko,vi]`.
- `data/translation.ts:385` `useTranslate`; `:303` `fetchBatchTranslation` (timeout 8000ms); `:210` `setTranslationCacheIdentity`.
- `components/mcm/LiveCaptionDock.tsx:125` caption theo `sttTranslateEnabledAtom`; `:130-133` `seg.lang==="multi"`→assumedSource undefined; `:62` `SILENCE_HIDE_MS`.
- `components/mcm/captionPopOut.ts:74` `buildLines` (mirror imperative); `:209-218` subscribe atoms.
- `worker/src/ai.ts:63` `DEFAULT_GEMINI_MODEL="gemini-2.5-flash"`; `:142-154` `INJECTION_GUARD`/`stripFence`; `:338,408,973` `thinkingBudget:0`; `:456,538,597,848` 4 routes.
- `components/mcm/MeetingShell.tsx:123,406` đọc `captionSurfaceAtom` + mount `LiveCaptionDock variant="overlay"`.

### Quyết định & gotcha
- **STT_SEGMENT broadcast, interim KHÔNG**: final đi qua collab (peers thấy, dedup theo `id`); interim chỉ local (noisy + viewer-local UX). Sender echo local rồi broadcast → `applySTTSegment` dedup tránh nhân đôi.
- **binaryType="arraybuffer" + subprotocol auth**: PCM gửi nhị phân; JWT Supabase nhét vào segment thứ 2 của WS subprotocol (`[mcm.v1, token]`), Worker 401 nếu thiếu → mở WS fail (onerror). `meetingId` bắt buộc để gate membership (trước đây no-op). (Cùng pattern subprotocol-auth với realtime §2.)
- **gain=0 sink bắt buộc**: AudioWorkletNode không có đường tới destination thì `process()` không chạy trên iOS/Safari + một số Chromium → Deepgram nhận im lặng dù `{ready}`. Phải route qua sink gain=0 (capture-only, không vọng ra loa).
- **iOS mic clone + audioCtx dùng chung**: tap **clone** track (track live của Daily delivery im lặng tới source node thứ 2); tái dùng `AudioContext` Daily đã resume trong Join gesture (context tự tạo trong React effect bị SUSPENDED trên iOS). `sttCapturingAtom` = ground-truth (peak amplitude), phân biệt "enabled nhưng câm".
- **captionSurfaceAtom là single source of truth**: trước đây mỗi surface tự quyết → double-mount dock / dock leak ra canvas. Router đọc share **media** (không phải presence map) để tránh import Collab nặng; `panel-only` = canvas thường, KHÔNG dock. Cùng atom §1 và §5 dùng.
- **Pop-out caption là DOM thuần**: di chuyển node React-reconciled xuyên document phá reconciliation → dựng `<div>` thủ công, subscribe `appJotaiStore`, chỉ đọc cache dịch (in-app dock đã warm), miss → hiện gốc (không bao giờ trống).
- **Caption translate gate bằng `sttTranslateEnabledAtom`** (KHÔNG phải `translationEnabledAtom` của chat) — để dock + panel + pop-out luôn cùng trạng thái ngôn ngữ ("ngôn ngữ phải đúng user dù ở dạng nào"). Interim không dịch (tránh thrash + flicker). `seg.lang==="multi"` → assumedSource undefined để backend tự detect.
- **Gemini `thinkingBudget:0`** chỉ hợp lệ với `gemini-2.5-flash`; với structured output, thinking tokens ăn `maxOutputTokens` → candidate rỗng (MAX_TOKENS) → 502 → client âm thầm hiện bản gốc. Pro model sẽ 400 nếu giữ dòng này.
- **Anti prompt-injection**: mọi content cuộc họp (chat/canvas/transcript/tên file) UNTRUSTED → `INJECTION_GUARD` system prompt + fence `<<<MEETING_DATA>>>` + `stripFence` cả input lẫn output (vì output bị sync lên canvas/chat chung).
- **`/chatbot` luôn 200**: lỗi/empty → fallback string theo ngôn ngữ (non-200 sẽ hard-fail bot). Rate-limit per-isolate in-memory (đủ nội bộ, B7 sẽ harden), cache dịch per-isolate Map (mất khi isolate xoay).
- **DO migration I-1**: `/translate*`, `/summarize`, `/chatbot`, `/stt` đã dời từ Fly room server sang Worker `mcm-storage`; base đổi từ `VITE_APP_WS_SERVER_URL` → `VITE_APP_STORAGE_URL` (tunnel mode = same-origin "").
- **Persistence 2 tầng**: localStorage keyed `roomId` (cache nhanh) + R2 (debounce 5s, mirror bền). `loadTranscriptHistory` ưu tiên local cache; KHÔNG ghi khi `meetingViewOnlyAtom` (review immutable). `meterGemini` dùng `waitUntil` để INSERT usage không bị huỷ khi response trả về (xem [Xuyên suốt](#xuyên-suốt-cross-cutting)).
- **Batch timeout 8000ms** (không phải 4s): cold isolate + Gemini batch vượt 4s khiến sender broadcast không kèm dịch → receiver thấy gốc.
- **`fetchBatchTranslation` warm cache** per-(lang,text) để `useTranslate` legacy resolve tức thì; cache localStorage namespaced theo identity (2 account chung browser không đọc chéo).

---

## 5. Screen share / Present

### Trách nhiệm
Cho phép một participant "present" màn hình của mình cho cả phòng họp xem. Media (screen video + screen audio) chạy qua **Daily.co** (managed SFU/WebRTC); **socket** của app chỉ tải tín hiệu **presence/lock** (ai đang share). Hỗ trợ: lazy-join (chỉ giữ kết nối Daily khi thực sự có người share), single-share lock (một lúc chỉ một người present), viewer pane nổi, **pop-out** sang Document Picture-in-Picture (kéo qua màn hình thứ 2), và phục hồi qua refresh/rejoin/late-join.

### Thành phần chính
- `ScreenShareController.tsx` (`excalidraw-app/screenshare/`) — orchestrator vô hình, mount 1 lần ở app-shell (trong `MeetingShell`). Bind `DailyScreenShare` manager vào Jotai; provision/destroy manager theo collab room; lazy join/leave Daily theo presence atom.
- `DailyScreenShare.ts` — imperative manager bọc **một** Daily call object (`videoSource:false, audioSource:false, subscribeToTracksAutomatically:true, allowMultipleCallInstances:true`). Quản lý join/leave, start/stopScreenShare, reconcile remote/local tracks, phát screen audio thủ công.
- `screenShareState.ts` — 2 atom MEDIA cục bộ: `screenShareMediaAtom` (status/remoteStream/remoteSharerName/localActive/errorMessage) cho UI; `screenShareInstanceAtom` giữ manager cho Present button gọi start/stop.
- `ScreenSharePane.tsx` — viewer pane nổi (chỉ hiện khi `remoteStream` set, tức ta đang xem người khác). Bind stream vào `<video>`, nút minimize + **Pop out**, mount `LiveCaptionDock` khi caption router trả "pane".
- `popOut.ts` — helper Document-PiP (`documentPictureInPicture`), **Chromium-only** (`isPopOutSupported()`), copyStyles + di chuyển (không clone) node vào window PiP, trả `close()`.
- `collab/Collab.tsx` — `screenShareStateAtom` (presence map `socketId→true`, dòng 239), `applyScreenShare`/`setScreenShare`/`broadcastScreenShareSnapshot`; prune presence khi peer rời.
- `collab/Portal.tsx:377` — `broadcastScreenShare(sharing)` qua `WS_SUBTYPES.SCREEN_SHARE`.
- `data/projects.ts:631` — `getDailyToken(roomId, name)` → `GET {STORAGE_URL}/v1/daily/token` qua `fetchWithAuth` (trả `{url, token}` hoặc null).
- `components/mcm/MeetingShell.tsx` — UI Present button (handler + lock); mount `<ScreenSharePane/>` (404) và `<ScreenShareController/>` (419).

### Luồng dữ liệu
```
Present button (MeetingShell.handlePresent)
  → screenShareInstance.startSharing()
  → ensureJoined() [getDailyToken → Daily.createCallObject → call.join]
  → call.startScreenShare()  (browser prompt chọn screen)
  → Daily "track-started" (local screenVideo)
      → localActive=true, emit() → screenShareMediaAtom
      → onLocalShareChange(true) → collabAPI.setScreenShare(true)
          → applyScreenShare(me) → screenShareStateAtom
          → Portal.broadcastScreenShare(true) ──socket(SCREEN_SHARE)──▶ peers

Peer nhận SCREEN_SHARE → applyScreenShare(socketId,sharing) → screenShareStateAtom
  → ScreenShareController effect (2): someoneElseSharing && !connected
      → manager.ensureJoined()  (lazy join để xem)
      → Daily "track-started" remote screenVideo
          → reconcileRemoteScreenVideo() → remoteStream set → screenShareMediaAtom
          → ScreenSharePane render <video> (+ screenAudio phát qua <audio> ẩn)
```
Late-join / refresh: `new-user` → `broadcastScreenShareSnapshot()` (Collab.tsx:1616) re-announce nếu `localActive`; viewer học presence → `ensureJoined()` → `reconcileRemoteScreenVideo()` quét `participants()` để bắt share đã chạy trước khi join.

### File then chốt
- `ScreenShareController.tsx:49-80` provision manager (gate `viewOnly`/room); `:94-117` lazy join/leave theo presence; `:73-77` events bridge.
- `DailyScreenShare.ts:139-145` cấu hình call object (no cam/mic, multi-instance); `:163-170` reconcile remote + local lúc join; `:210-244` `reconcileRemoteScreenVideo`; `:253-271` `reconcileLocalScreenShare` (phục hồi local share sau reload); `:273-275` `onParticipantUpdated`; `:409-431` phát remote screen audio + retry autoplay.
- `ScreenSharePane.tsx:49-55` bind stream; `:89-129` pop-out + mount caption vào PiP doc; `:58-69` cleanup khi stream kết thúc.
- `popOut.ts:26-45` copyStyles; `:74-84` append node + `pagehide`→onReturn.
- `Collab.tsx:239` presence atom; `:1891-1912` prune presence peer rời; `:2434-2462` apply/set screen share; `:3264-3284` `broadcastScreenShareSnapshot` (đọc MEDIA `localActive`, không đọc presence map).
- `MeetingShell.tsx:140-151` `iAmPresenting`/`canScreenShare`/`someoneElseSharing`; `:168-178` handlePresent; `:373-377` lock nút.

### Quyết định & gotcha
- **Media vs presence tách bạch**: media (Daily stream) ở `screenShareState.ts`; presence/lock (socket) ở `Collab.tsx` `screenShareStateAtom`. Cố ý — presence drive lock/badge, media drive pane (ghi rõ ở header cả 2 file). Cùng nguyên tắc media-vs-presence với §2.
- **Lazy connection**: manager **không** giữ Daily connection cho tới khi có người share; nobody sharing → `leave()` để dừng meter per-minute của Daily (`ScreenShareController.tsx:108-116`). Phí Daily là động lực thiết kế.
- **Hai call object riêng**: audio call (§3) và screen share là 2 Daily call object tách biệt trên cùng page → bắt buộc `allowMultipleCallInstances:true` (`DailyScreenShare.ts:144`).
- **Refresh-mid-share recovery**: reload reset `localActive=false` nhưng screen track vẫn live trong SFU và Daily **không** re-fire local `track-started` → `reconcileLocalScreenShare()` tự phát hiện và re-broadcast presence, nếu không peers prune socketId cũ và mất share (`:160-170, 246-271`).
- **Minimise/un-mute không re-fire track-started**: presenter thu nhỏ cửa sổ → Daily báo qua `participant-updated` (mute→un-mute), không phải `track-started`; thiếu `onParticipantUpdated`→`reconcileRemoteScreenVideo` thì video viewer đứng hình/đen vĩnh viễn (fix 06-18, `:194-198, 273-275`).
- **Screen audio không auto-play**: ở call-object mode Daily không auto-play "screenAudio" → tự tạo `<audio>` ẩn; autoplay policy có thể chặn → retry 1 lần ở pointerdown/keydown kế tiếp (`:409-431`).
- **Late-joiner**: Daily chỉ fire `track-started` cho track bắt đầu **sau** khi subscribe → phải quét `participants()` trong reconcile để bắt share đang chạy.
- **Pop-out là `<video>` riêng**: pane tạo node `<video>` plain mới feed cùng MediaStream, KHÔNG di chuyển node React-managed qua document khác (chống đánh nhau với reconciliation); in-app `<video>` vẫn mounted (ẩn) để không re-subscribe stream (`ScreenSharePane.tsx` header). `popOut` di chuyển node thật (không clone) để video tiếp tục chạy; **Chromium-only**, Firefox/Safari fallback về pane.
- **Caption follow pop-out**: dùng `captionSurfaceAtom`/`captionPoppedOutAtom` (central router — xem §1/§4); pop-out set `captionPoppedOut=true` để dock in-pane nhường chỗ, mount caption strip plain-DOM vào PiP doc qua `mountPopOutCaption`; cleanup phải clear cờ trên unmount/stream-end nếu không selector kẹt "popout" cho share kế tiếp (`:58-83, 100-128`).
- **viewOnly gate**: meeting đã xong (review read-only) không bao giờ được cấp manager (`ScreenShareController.tsx:50`).
- **Single-share lock**: nút Present `disabled` khi `viewOnly || someoneElseSharing || !canScreenShare`; `someoneElseSharing` suy từ presence map (loại `mySocketId`).
- **Browser support**: `getDisplayMedia` không có trên iOS/iPadOS Safari → `canScreenShare` false, nút disabled kèm tip thay vì fail thầm trong Daily.
- **Prune presence khi peer drop**: sharer rớt không gửi được `sharing:false` → `Collab.tsx:1891-1912` prune theo danh sách socket hợp lệ, tránh lock kẹt + viewer treo stream chết.
- **Token gating**: `getDailyToken` trả null nếu `!IS_PROJECTS_CONFIGURED` (env `STORAGE_URL` ở `data/projects.ts:15-19`) → `ensureJoined` set `errorMessage:"token"`.

---

## 6. Worker REST backend + Data (D1/R2)

Backend serverless toàn bộ của Canvas M chạy trong MỘT Cloudflare Worker tên `mcm-storage` (`worker/wrangler.jsonc:17`), code chính ở `worker/src/index.ts` (6510 dòng). Đây là "hạt giống" của cả backend: REST `/v1`, AI routes, STT proxy, Durable Object realtime relay và cron backup đều land chung Worker này.

### Trách nhiệm
- **Durable meeting storage**: bytes (scene/chat/transcript/library/file/userfile) → R2 `mcm-storage` (encrypted-at-rest, server chỉ relay không đọc); metadata/pointers/folder-structure → D1 `mcm-db`.
- **REST API `/v1`**: projects (folders), meetings + lifecycle state machine, invitees, guests (external), knock/waiting-room, directory/divisions, notes, user-files library, clients, admin console, Daily token minting.
- **Auth gateway**: verify Supabase JWT (offline JWKS/ES256) cho mọi `/v1` + AI routes; reverse-proxy `/auth/v1/*` để né ISP chặn `*.supabase.co` (xem §7).
- **Cost control & metering**: usage_events (Gemini/Deepgram/Daily), kill-switches, Daily cost range.
- **Data durability/lifecycle**: R2 soft-delete sang `trash/`, cron backup D1→R2, on-demand admin export/archive.

### Thành phần chính
- **Hono app** (`index.ts:201`) — router cho ~100 routes `/v1` + AI routes mount ở root.
- **`Bindings` type** (`index.ts:62-127`) — toàn bộ env: `BUCKET` (R2), `DB` (D1), `ROOM` (DO namespace), Daily/Supabase/Resend/Gemini/Deepgram secrets, STT provider seam, kill-switches.
- **CORS allowlist** `isAllowedOrigin` (`index.ts:139-181`) — localhost/LAN-RFC1918/`*.pages.dev`/`*.workers.dev`/`*.trycloudflare.com` + `ALLOWED_ORIGINS`; trả origin chính nó (không `*`) vì gửi credentials.
- **`jwtGate` middleware** (`index.ts:298-352`) — verify bearer JWT, attach `userId/email/role`; áp cho `/v1/*` (trừ `/v1/health`) và trực tiếp 4 AI routes. Admin gate `/v1/admin/*` (`:426`, `isAdminish` = admin|owner), owner gate `/v1/owner/*` (`:440`, stub).
- **R2 blob routes**: scenes PUT/GET (`:1075/:1128`), chats (`:1147/:1196`), transcripts (`:1170/:1186`), library manifest (`:1211/:1227`), file bytes (`:1239/:1284`). Key helpers `sceneKey/fileKey/chatKey/libraryKey/transcriptKey/userFileKey` (`:451-457`).
- **D1 domain routes**: projects (`:1311+`), members (`:1615+`), meetings + lifecycle PATCH (`:1884/:2085`), invitees (`:2403`), guests/project_guest (`:2543-3074`), knock/waiting-room (`:3143-3311`), directory/divisions (`:3359/:1805`), clients (`:3445+`), notes (`:3627`), user-files (`:3684-3907`).
- **Daily token** (`:3907`) — ensure room + mint token (audio/screenshare, webcam off, `exp`/`eject_*` cost caps).
- **Admin console** (`:4226-5978`) — users (proxy Supabase Admin REST), meetings, projects, backup/archive export, stats, realtime, audit, storage, cost, usage, daily, system-status, settings, analytics, backdrops, portal.
- **`usage.ts`** — pricing constants + `logUsageEvent` (best-effort, never throws); re-export từ index.
- **`migrate.mjs`** — D1 migration runner (SSOT `schema/000N_*.sql`, tracked qua `schema_version` table; cùng script local+remote chống drift).
- **`scheduled()` cron** (`:6468`) — dump mọi D1 table → R2 `backups/db-<date>.json`.
- **Entry `export default { fetch, scheduled }`** (`:6420`) — route-split theo pathname TRƯỚC Hono: `/health`, `/rooms/:id/ws` (realtime), `/stt`, else Hono.

### Luồng dữ liệu
```
Client (fetchWithAuth, Bearer JWT)
  │
  ├─ /auth/v1/*  ──► reverse-proxy ──► Supabase GoTrue   (login, OUTSIDE JWT gate)
  │
  ▼  (default.fetch route-split by pathname)
  ├─ /health                         → "ok" (no DB)
  ├─ /rooms/:id/ws  → handleRealtimeUpgrade → [JWT→canSeeMeeting→finished→knock→WS-cap] → RoomDO stub
  ├─ /stt           → handleSttUpgrade (PCM↔Deepgram, never hits RoomDO)
  └─ else → Hono
            ├─ cors() → jwtGate (JWKS verify, set email/role, refreshInternalDomains)
            ├─ blob PUT: isDeletedMeeting(410)→isFinishedLocked(409)→R2.put→D1 upsert(meeting/file)
            ├─ blob GET: R2.get → 204 nếu miss (KHÔNG 404)
            ├─ domain routes → D1 (project/meeting/invitee/guest/knock/...)
            ├─ AI routes → aiKillSwitch→jwtGate→aiRoomGate(canSeeMeeting)→Gemini → logUsageEvent→usage_events
            └─ /v1/admin/* → adminGate → D1 aggregates / Supabase Admin REST proxy

cron (Sun 03:00 UTC) → scheduled() → SELECT * mọi table → R2 backups/db-<date>.json
DELETE project/meeting/user → trashR2Prefix: R2 copy → trash/<ts>/<key> rồi delete bản gốc
```

### File then chốt
- `worker/src/index.ts:62-127` — `Bindings` (mọi binding/secret/var).
- `worker/src/index.ts:139-181` — CORS allowlist.
- `worker/src/index.ts:298-352` — `jwtGate` (JWKS offline verify).
- `worker/src/index.ts:242-` — Supabase Auth reverse-proxy `/auth/v1/*`.
- `worker/src/index.ts:451-457` — R2 key helpers.
- `worker/src/index.ts:494-522` — `isDeletedMeeting` (tombstone) + `isFinishedLocked` (grace 10 phút).
- `worker/src/index.ts:558-` — `canSeeMeeting` (per-meeting authz, gồm guest synthetic↔real email reconciliation).
- `worker/src/index.ts:1075-1302` — toàn bộ blob PUT/GET (scene/chat/transcript/library/file).
- `worker/src/index.ts:3907-` — Daily token route (cost caps).
- `worker/src/index.ts:4145-4174` — `trashR2Prefix` (R2 soft-delete).
- `worker/src/index.ts:6283-6412` — `handleRealtimeUpgrade` (auth gate trước DO — xem §2/§7).
- `worker/src/index.ts:6420-6510` — entry `fetch` route-split + `scheduled` cron backup.
- `worker/src/usage.ts:102-138` — `logUsageEvent` (metering best-effort).
- `worker/migrate.mjs` — migration runner; `worker/schema/0001_init.sql` (project/meeting/file), `0027_realtime_backend.sql`, `0028_usage_events.sql`.

### Quyết định & gotcha
- **BOM-poisoned secrets = outage 06-17**: `wrangler secret put` từ PowerShell stamps UTF-8 BOM vào value → `new URL()` throw → 500/502 mọi upstream. Fix: `cleanSecret()` (`:137`) trim, và `jwtGate` trim+strip trailing `/` trên `SUPABASE_URL` (`:305`); SUPABASE_URL malformed phải ra 503 (misconfig) chứ không 500. Xem [Xuyên suốt](#xuyên-suốt-cross-cutting).
- **Blob GET trả 204 KHÔNG 404** (`:1132`, `:1289`): brand-new room / decoration race / file đã trashed là bình thường; 404 spam console và đánh dấu image permanently-errored. Loader coi empty body = "nothing stored".
- **Finished-write grace 10 phút** (`FINISHED_WRITE_GRACE_MS`, `:511`): client còn flush sau finish PATCH (leave flush, final scene, chat timer). Soft spot đã chấp nhận: admin PATCH field khác refresh `updated_at` → mở lại window. Summary POST cố ý KHÔNG gate (AI summary đến sau finish — xem §1 End flow).
- **Tombstone `deleted_meeting`** (`:494`): client còn mở room có thể re-create row qua upsert PUT → trả 410.
- **revoke ≠ delete**: R2 không hard-delete mà soft-delete sang `trash/<ts>/...` rồi mới `delete` bản gốc (`trashR2Prefix:4145`, deleteMeetingCascade `:4864`); dựa R2 lifecycle rule expire prefix `trash/` (cấu hình dashboard, KHÔNG trong code).
- **realtime_backend per-meeting runtime flag** (`0027`, default `'socketio'`): cờ chọn transport ở runtime per meeting; client đọc qua GET `/v1/meetings/:roomId`. Thực tế socket.io đã retire 06-17, `resolveRealtimeBackend` luôn trả `'do'` và scene PUT upsert hardcode `realtime_backend='do'` cho meeting mới (`:1114`) — xem §2/§8.
- **Realtime auth gate ở Worker, KHÔNG ở DO hot path** (`:6391`): Worker verify JWT→canSeeMeeting→finished→knock→WS-cap, rồi forward identity qua headers `x-mcm-sub/email/role`; DO không re-verify JWKS. WS-count cap fail-OPEN (auth đã pass) chứ không 101-bypass.
- **AI key bảo vệ 3 lớp**: `aiKillSwitch` (env `AI_ENABLED==="off"`→503 trước cả JWT) → `jwtGate` → `aiRoomGate` (canSeeMeeting theo meetingId trong body/query, `:396`). Kill-switch dùng `wrangler secret put <NAME> off` instant không redeploy; bất kỳ giá trị ≠ literal `"off"` (kể cả unset) = ON (missing var không vô tình tắt feature). Cùng pattern: `STT_ENABLED`, `DAILY_ENABLED`.
- **STT lang=multi tránh dùng** (`usage.ts:20-26`): Nova-3 Multilingual đắt hơn ($0.0058) VÀ không cover VI/KO → MCM pin một ngôn ngữ/stream, bill rate monolingual $0.0048.
- **Daily cost luôn là RANGE low→high** (`usage.ts:68-92`): tier audio-only vs video UNVERIFIED nên không show single number; có free allowance 10k participant-min/tháng.
- **Daily room id strip `-audio`** (`:3929`): audio chạy room dẫn xuất `<meetingId>-audio` (§3) nhưng registry/canSeeMeeting/knock keyed theo base meeting id → strip trước khi gate.
- **Metering/audit best-effort, NEVER throw** (`logUsageEvent`, `logOwnerAudit`): un-migrated table / transient D1 error không được block response đang đo; admin cost query un-migrated → all-zeros chứ không 500.
- **Migration discipline**: chỉ chạy `migrate.mjs`, KHÔNG `wrangler d1 execute --file` tay (bypass `schema_version` tracking → drift). Cùng script local+remote.
- **Cron backup chỉ metadata D1** (`:6468`): R2 bytes durable nằm lại bucket; restore = đọc object + re-insert. Head sampling observability 0.25 (giữ trend, giảm log ~75%).
- **`isInternalEmail` cache per-isolate 60s** (`:466`): nguồn `system_settings.internal_domains` (admin-editable), fallback hardcode `mapgroup.co.kr`; refresh bởi jwtGate mỗi request (xem §7).
- **Guest identity reconciliation** (`canSeeMeeting:579`): guest login synthetic `pg-<hex>@guest.canvasm.app` vs real_email; `project_guest` là map duy nhất, resolve counterpart spelling để invitee check match được cả hai (bug fix 06-18).
- **Scene/file PUT strip projectId nếu không có full access** (`:1100`, `:1260`): autosave path bypass meeting-create gate, nên strip (không 403) để save vẫn thành công; row cũ giữ project_id qua COALESCE.

---

## 7. Auth + Access / Permissions model

### Trách nhiệm
Xác lập **identity ở mức login** (tách khỏi `userProfileAtom` per-meeting) và toàn bộ **authorization** của Canvas M: ai đăng nhập được, JWT được verify thế nào, và ai được thấy/vào/quản lý từng meeting + project. Frontend chỉ làm UX gating; **mọi data gate được Worker enforce độc lập** (verified JWT là nguồn sự thật, client không tự khai role/host email). Bao gồm: Supabase Auth (password + magic-link/OTP cho guest), JWKS verify offline ở Worker, waiting-room knock-to-join, `canSeeMeeting`, phân tầng role (owner > admin > internal staff > guest), project/division permissions, và gate cho realtime WS upgrade vào Durable Object (xem §2).

### Thành phần chính
- **`excalidraw-app/data/supabaseClient.ts`** — khởi tạo `supabase` client (`persistSession`, `autoRefreshToken`, `detectSessionInUrl`). `IS_SUPABASE_CONFIGURED`. Chứa **auth-proxy fetch** (`authProxyFetch`) rewrite chỉ network hop của `/auth/v1/*` qua Worker edge (B1).
- **`excalidraw-app/data/fetchWithAuth.ts`** — chokepoint duy nhất: đọc token tươi từ `supabase.auth.getSession()` mỗi call, gắn `Authorization: Bearer <jwt>`. Không session → đi không-auth, Worker 401.
- **`excalidraw-app/data/session.ts`** — `Session` shape + `sessionAtom`, `authReadyAtom`; `deriveSession(user)` map Supabase user → role/projectId/isAdmin/isOwner/isGuest; `isInternalEmail` / `isGuestEmail`; `initAuthSync()` mirror `onAuthStateChange`; `syncInternalDomains()` kéo list `internal_domains` từ `/v1/config`; `signOut`.
- **`worker/src/index.ts`** — `jwtGate` middleware (JWKS verify), gate `/v1/*` + AI routes, gate `/v1/admin/*` (`isAdminish`) + `/v1/owner/*` (owner-only); `canSeeMeeting`, `roomGate`, `isAdmittedForRoom`, `isMeetingManager`, `isMeetingProjectAuthority`, `isOwningDeptMember`, `canCreateProject`; auth-proxy `app.all("/auth/v1/*")`; route knock (POST/GET/PATCH), guests mint (`/v1/guests`), invitees, project members/leader.
- **`worker/src/roomDO.ts`** + `handleRealtimeUpgrade` / `verifyRealtimeJwt` (cuối index.ts) — gate WS upgrade vào Durable Object; DO đọc identity từ header `x-mcm-*` (không re-verify JWKS).
- **Data clients access-model**: `knock.ts`, `invite.ts` (+ `invitations.ts`), `guests.ts`, `projects.ts` (members/leader/divisions), `projectGuests.ts`.

### Luồng dữ liệu
Login → JWT → mọi request authed → per-meeting authz:
```
Browser  supabase.auth.signIn ──(authProxyFetch rewrite /auth/v1)──> Worker /auth/v1/* ──proxy──> *.supabase.co GoTrue
   │  (vì ISP VN chặn supabase.co; iss vẫn = supabase.co → JWKS verify nguyên vẹn)
   │ onAuthStateChange → deriveSession(user) → sessionAtom (isAdmin/isGuest/role/projectId), authReadyAtom=true
   ▼
fetchWithAuth: getSession().access_token → Authorization: Bearer <jwt>
   ▼
Worker jwtGate: jwtVerify(token, JWKS, {issuer: SUPABASE_URL/auth/v1, audience:"authenticated"})  [ES256 offline]
   │  set userId/email/role ; refreshInternalDomains(DB)  → next()
   ├─ /v1/admin/* : isAdminish(role) else 403
   ├─ /v1/owner/* : role==="owner" else 403
   └─ roomGate (/v1/scenes|chats|library|files|transcripts|meetings/:id):
         canSeeMeeting(DB,email,role,roomId)  ─false→ 403 forbidden
         + nếu blob route & external guest: isAdmittedForRoom (meeting_knock='admitted') else 403
         + nếu guest & meeting finished: 403 (review internal-only)
```
Guest knock-to-join (external, không internal-domain):
```
guest login (pg-<hex>@guest.canvasm.app, role=guest) → canSeeMeeting cần meeting_invitee row (đã mời)
 → POST /v1/meetings/:id/knock (chỉ khi status='live') → meeting_knock status='invited'
 → poll GET .../knock (self-scoped)   |   manager: GET .../knocks, PATCH .../knock/:email admit|deny
 → admit → status='admitted' → roomGate cho đọc blob + WS upgrade vào DO mới mở
```
Realtime WS upgrade (DO): `verifyRealtimeJwt` → `canSeeMeeting` → `isFinishedLocked` → knock-gate cho external → WS count cap → forward request mang `x-mcm-sub/email/role` cho DO (DO **tin** header này, không verify lại). Chi tiết relay xem §2.

### File then chốt
- `excalidraw-app/data/supabaseClient.ts:26-43` (authProxyBase + `authProxyFetch`), `:45-55` (createClient).
- `excalidraw-app/data/fetchWithAuth.ts:13-25` (token tươi mỗi call).
- `excalidraw-app/data/session.ts:124-161` (`deriveSession` → role/projectId/isGuest), `:68-79` (internal/guest domain), `:87-106` (`syncInternalDomains`), `:185-210` (`initAuthSync`).
- `worker/src/index.ts:35` (`import jose`), `:198-199` (`isAdminish` = admin|owner), `:242-278` (auth-proxy `/auth/v1/*`), `:293-344` (`jwtGate` JWKS verify), `:346-352` (gate `/v1/*`, health open), `:426-445` (admin/owner gate), `:466-489` (`refreshInternalDomains` + `isInternalEmail`).
- `worker/src/index.ts:558-653` (`canSeeMeeting` — confidential invitee-only, guest identity reconciliation qua `project_guest`, plain-member không auto-join), `:987-1004` (`isAdmittedForRoom`), `:1006-1063` (`roomGate`), `:931-967` (`isMeetingManager`), `:874-922` (`isMeetingProjectAuthority` / `isOwningDeptMember`).
- `worker/src/index.ts:3143-3225` (POST knock), `:3245-3310` (manager list/admit-deny), `:2751-2771` (mint guest `pg-<hex>@guest.canvasm.app`, `app_metadata.role="guest"+project_id`).
- `worker/src/index.ts:6220-6245` (`verifyRealtimeJwt`), `:6283-6398` (`handleRealtimeUpgrade` 4 gate + forward `x-mcm-*`); `worker/src/roomDO.ts:208-210` (DO đọc header identity).

### Quyết định & gotcha
- **JWKS verify OFFLINE** (ES256), cache `jwks` per-isolate; `audience:"authenticated"`, `issuer = SUPABASE_URL/auth/v1`. **`SUPABASE_URL` phải trim + bỏ trailing slash** — newline/`/` thừa làm `new URL()` throw → 500 mọi request authed (sự cố 06-17); nay defensive normalize + 503 misconfig thay vì 500.
- **Auth-proxy chỉ đổi network hop**, KHÔNG đổi `supabaseUrl` → session storage key, redirect base, và JWT `iss` (do GoTrue stamp từ external URL, không phải Host) đều giữ nguyên → JWKS verify "vô hình" với proxy. Lý do: một số ISP VN DNS/SNI-block `*.supabase.co` (login fail WiFi, OK 4G).
- **Role tier**: `owner` > `admin` > internal staff > guest. `isAdminish = admin||owner` là predicate duy nhất; `owner` strictly additive (qua mọi admin gate) + có `/v1/owner/*` riêng. **`chairman` chưa build** (spec `docs/specs/chairman-account.md`, chỉ là role tương lai).
- **`canSeeMeeting` thắt chặt 06-10/06-16**: KHÔNG còn blanket internal-allow; internal chưa-mời & không-member cũng không thấy. **Confidential = invitee-only** (kể cả division head/leader cũng bị chặn trừ khi owner/được mời). **Plain project member KHÔNG auto-join** mọi meeting — chỉ `owner`/`manager` member, organizer/host, co-host, invited, hoặc authority (leader/head). Ad-hoc room không có D1 row → mở cho mọi authed.
- **Guest identity reconciliation** (`canSeeMeeting:579-598`): guest login synthetic `pg-<hex>@guest.canvasm.app` nhưng `meeting_invitee` có thể lưu real_email; resolve qua `project_guest` (chỉ row của chính caller, không nới quyền người khác).
- **Waiting-room read bypass** (06-18): `roomGate` tách 2 tầng — `canSeeMeeting` (invited) chưa đủ cho blob; phải `isAdmittedForRoom` (`meeting_knock='admitted'`). Internal/admin auto-admit, không bao giờ knock (POST knock của internal → 409).
- **REVOKE ≠ flip knock**: revoke đổi `meeting_invitee`, KHÔNG đổi `meeting_knock`; `isAdmittedForRoom` chỉ nhìn knock nên KHÔNG được dùng standalone — luôn chạy `canSeeMeeting` trước (đã filter `status<>'revoked'`). Knock chỉ mở khi meeting `status='live'`; deny là SOFT (re-knockable sau `REKNOCK_COOLDOWN_MS=30s`).
- **DO không re-verify JWKS** trong hot path: tin header `x-mcm-sub/email/role` do `handleRealtimeUpgrade` set sau khi verify — đừng để route khác chạm DO mà bỏ qua upgrade gate. `realtime_backend` nay **forced "do"** (`resolveRealtimeBackend` luôn trả `"do"`, socket.io relay đã retire 06-17).
- **AI routes** mounted ở ROOT (ngoài `/v1`) nhưng có `jwtGate` + `aiRoomGate` (chạy lại `canSeeMeeting` theo `meetingId`) + kill-switch `AI_ENABLED="off"` → bảo vệ GEMINI_API_KEY (xem §6).
- **`internal_domains`** là system setting admin-editable (D1 `system_settings`), cache per-isolate 60s ở Worker; client mirror qua `/v1/config` và **mutate in-place** `INTERNAL_DOMAINS` (mọi importer thấy update). Fallback hardcode `mapgroup.co.kr`.
- **env ở root**: `.env.*` nằm ở `excalidraw/` (root) lẫn `excalidraw-app/`; client đọc `VITE_SUPABASE_URL/ANON_KEY`, `VITE_APP_STORAGE_URL`, `VITE_DEV_TUNNEL`. Anon key public by design (RLS + Worker authz mới là enforcement). Tunnel mode (`VITE_DEV_TUNNEL==="true"`) → STORAGE_URL="" (same-origin Vite proxy `/v1`), tắt auth-proxy rewrite (giữ local dev chạy). Chi tiết env/build xem §8.

---

## 8. Build, deploy, environments & infra

### Trách nhiệm
Đưa Canvas M (fork Excalidraw) lên Cloudflare từ source: build app tĩnh (Vite/PWA), inject biến môi trường lúc build, deploy 2 artifact duy nhất — **Worker `mcm-storage`** (backend: REST + Durable Objects realtime + AI/STT proxy + cron backup) và **App Pages `map-canvasm`** — cùng quản lý D1 migration, R2 bucket, secrets, cron trigger. Toàn bộ stack đã online Cloudflare từ 06-17, không còn dev box / room-server / Fly.

### Thành phần chính
- **Vite app build** — `excalidraw-app/vite.config.mts:13` (config theo `mode`), output `build/` (`:171`), `envDir: "../"` (`:79`) → đọc env từ **ROOT repo** chứ không phải `excalidraw-app/`. PWA via `VitePWA` (`:242`), `registerType: "autoUpdate"` (`:250`), `cacheId: "canvas-m"` (`:260`), brand manifest "Canvas M" (`:326`), `maximumFileSizeToCacheInBytes: 4MB` (`:324`).
- **Build scripts** — `package.json:62` (`build` → `excalidraw-app` build) → `excalidraw-app/package.json:62` (`build` = `build:app && build:version`); `build:app` (`:60`) chạy `vite build` với `VITE_APP_GIT_SHA`; `build:version` → `scripts/build-version.js` (ghi `build/version.json` + thay `{version}` trong `index.html` bằng `commitDate-shortHash`).
- **Worker config** — `worker/wrangler.jsonc`: `name: "mcm-storage"` (`:17`), entry `src/index.ts` (`:18`), `nodejs_compat` (`:20`), observability head-sampling 0.25 (`:25`), bindings `ROOM`→`RoomDO` (`:62`), `BUCKET`→R2 `mcm-storage` (`:90`), `DB`→D1 `mcm-db` id `70c15c3f-...` (`:97`), DO SQLite migration tag `v1` (`:74`), cron `["0 3 * * SUN"]` (`:86`).
- **Worker entry** — `worker/src/index.ts:6420` `export default { fetch, scheduled }`. `fetch` route-split TRƯỚC Hono: `/health` (`:6433`), `/rooms/:id/ws`→DO upgrade (`:6441`), `/stt`→STT proxy (`:6455`), còn lại → `app.fetch` (Hono `/v1/*`). `scheduled()` (`:6468`) dump mọi bảng D1 → R2 `backups/db-<date>.json` qua `ctx.waitUntil`.
- **D1 migration runner** — `worker/migrate.mjs`: tự quét `worker/schema/NNNN_*.sql` (hiện 0001→0030), track trong bảng `schema_version`, chạy local (`--local`) hay remote (`--remote`); KHÔNG dùng `wrangler d1 execute --file` tay (lệch tracking).
- **Env files (ROOT)** — `.env.production` (upstream defaults, MODE=production), `.env.production.local` (override prod thật, gitignored, trỏ Worker thật), `.env.development`, `.env.local` (dev tunnel + Supabase), `excalidraw-app/.env.development.local` (override dev → Worker local `:8787`). Secret Worker local ở `worker/.dev.vars`.

### Luồng dữ liệu
```
Source → yarn build (ROOT)
   │  Vite loadEnv(mode, "../")  ← .env.production + .env.production.local (VITE_* nhúng vào bundle)
   ▼
excalidraw-app/build/  (PWA, version.json từ git SHA)
   │  wrangler pages deploy ... --project-name=map-canvasm --branch=main
   ▼
Cloudflare Pages map-canvasm  →  https://map-canvasm.pages.dev
   │  (bundle gọi API tới VITE_APP_STORAGE_URL = https://mcm-storage.rnd-ai.workers.dev)
   ▼
Worker mcm-storage  (deploy: 1) node migrate.mjs --remote  2) wrangler deploy)
   ├─ /v1/* (Hono) ─► D1 mcm-db (metadata) + R2 mcm-storage (blob, trash/, backups/)
   ├─ /rooms/:id/ws ─► RoomDO (verify JWT+canSeeMeeting+knock+WS-cap TRƯỚC 101)
   ├─ /stt ─► Deepgram nova-3 (server.binaryType="arraybuffer")
   ├─ /translate /summarize /chatbot ─► Gemini 2.5 Flash
   └─ scheduled() (cron SUN 03:00 UTC) ─► dump D1 → R2 backups/
```
Pages KHÔNG nối Git (không auto-build); `git push` chỉ backup code lên GitHub. Deploy luôn thủ công 2 lệnh riêng. Dev: Vite proxy (`vite.config.mts:32`) forward `/v1` → `localhost:8787` (wrangler dev) và `/stt`,`/socket.io`,`/translate*`,`/chatbot`,`/summarize` → `localhost:3002`.

### File then chốt
- `worker/wrangler.jsonc:17,62,74,86,97` — name, DO binding, DO sqlite migration, cron, D1 id.
- `worker/src/index.ts:6420` (export default), `:6441` (DO route), `:6455` (STT route), `:6468` (cron backup), `:6495` (`backups/db-<date>.json`), `:137` (`cleanSecret` strip BOM read-side).
- `worker/migrate.mjs:54-74` — quét schema, track `schema_version`, apply pending.
- `excalidraw-app/vite.config.mts:79` (envDir ROOT), `:171` (outDir build), `:250` (autoUpdate SW), `:324` (4MB cache cap).
- `scripts/build-version.js:34` — version = commitDate-shortHash.
- `.env.production.local:10` (`VITE_APP_STORAGE_URL` → Worker thật), `:6` (`VITE_DEV_TUNNEL=false`).
- `excalidraw-app/.env.development.local:8` — dev trỏ Worker local `:8787`.
- `worker/src/stt.ts:292` — `server.binaryType = "arraybuffer"`.

### Quyết định & gotcha
- **Env nhúng lúc build, đọc từ ROOT repo** (`vite.config.mts:79` `envDir:"../"`; `loadEnv(mode,"../")` `:15`). Bản prod đọc `.env.production.local` (gitignored, load CUỐI → override `.env.production`/`.env.local`). Sai env build = app trỏ nhầm backend, không báo lỗi.
- **Pages production branch = `main`, git local = `master`.** Deploy thiếu `--branch=main` → PREVIEW deployment, âm thầm không lên production (đã đốt thời gian 06-17). Tên thật trong deploy.md.
- **Set secret bằng bash pipe (`printf | wrangler secret put`), KHÔNG PowerShell `Out-File`/`>`** → PowerShell thêm BOM vào giá trị secret → 401/502 (cháy thật 06-17 với `SUPABASE_SERVICE_API_KEY`,`DAILY_API_KEY`,`RESEND_API_KEY`). Worker có `cleanSecret()` (`index.ts:137`) guard read-side `.trim()` nhưng vẫn phải set sạch từ nguồn.
- **Cron phải dạng chữ `0 3 * * SUN`** (CF từ chối số `0 3 * * 0` → `/schedules failed`). Khai báo `wrangler.jsonc`.
- **STT binary forward PHẢI `server.binaryType="arraybuffer"`** (`stt.ts:292`) — gốc rễ bug `[object Blob]`: CF Workers giao frame nhị phân client dưới dạng `Blob` (≠ Node Buffer), `send(blob)` coerce thành text `"[object Blob]"` → Deepgram SchemaError mỗi frame → STT câm mọi provider. Fix 1 dòng. (Chi tiết §3; cùng họ bug Blob với realtime §2.)
- **Realtime = 100% Durable Objects** (socket.io/Fly khai tử 06-17). Cờ `realtime_backend` (D1 migration `0027`, per-meeting) chỉ là công tắc TẠM build/test; default `'do'`. Env legacy `VITE_APP_WS_SERVER_URL` được trỏ vào Worker để không dangling (`.env.production.local`).
- **AI/STT chạy chung Worker, JWT-gated**, kill-switch tức thì qua secret/var `AI_ENABLED`/`STT_ENABLED`/`DAILY_ENABLED` (`wrangler.jsonc`) — secret cùng tên override var, không cần redeploy.
- **Migration runner Windows-aware** (`migrate.mjs:27-33`): `npx.cmd` + `shell:true` + tự quote arg có space; cùng 1 script cho local/remote nên 2 môi trường không drift cấu trúc.
- **DO storage class phải khai báo `new_sqlite_classes`** (`wrangler.jsonc:74`) dù relay chỉ dùng KV + Hibernation — bắt buộc để tạo class trên standard plan.
- **PWA `autoUpdate`**: sau deploy phải Unregister SW / mở incognito, nếu không thấy bundle cũ. Trade-off "load 2 lần" được chấp nhận trong dev/test (`vite.config.mts:243` comment).
- **Worker giữ `/health` trần** (`index.ts:6433`) đúng path cũ của Fly room-server để uptime monitor không trip khi cutover.

Tham chiếu chuẩn (không mâu thuẫn): `docs/specs/infrastructure.md`, `docs/runbooks/deploy.md`.

---

## Xuyên suốt (cross-cutting)

Các chủ đề trải dài nhiều subsystem, gom lại để khỏi lặp:

### Auth / JWT
- **Một identity duy nhất ở mức login** (Supabase session), tách khỏi `userProfileAtom` per-meeting. JWKS verify **offline ES256** ở Worker (`issuer=SUPABASE_URL/auth/v1`, `audience="authenticated"`), cache per-isolate. Chi tiết §7.
- **Auth là Worker-enforced**, client chỉ UX-gate. Mọi `/v1/*` (trừ `/v1/health`) + 4 AI route qua `jwtGate`. Per-meeting authz qua `canSeeMeeting` + `roomGate` (+ `isAdmittedForRoom` cho external guest).
- **Subprotocol-auth cho WebSocket**: cả realtime (§2) lẫn STT (§3/§4) nhét JWT vào segment thứ 2 của `Sec-WebSocket-Protocol` (`[mcm.v1, <JWT>]`) vì browser WS API không cho set header; server **phải echo `mcm.v1`** (không echo JWT) trên 101.
- **Realtime/STT gate ở Worker, KHÔNG ở DO hot path**: Worker verify rồi forward identity qua header `x-mcm-sub/email/role`; DO **tin** header, không re-verify JWKS.
- **Auth-proxy `/auth/v1/*`**: reverse-proxy qua Worker để né ISP VN chặn `*.supabase.co`; chỉ đổi network hop, `iss`/storage-key/redirect giữ nguyên → JWKS verify vô hình.

### Persistence (D1 / R2 / trash)
- **D1 `mcm-db`** = metadata/pointers (project/meeting/membership/invitee/knock/notes/`usage_events`/`schema_version`). **R2 `mcm-storage`** = blob (scene/chat/transcript/library/file/branding) + `trash/` + `backups/`. Worker chỉ relay blob — **không decrypt** scene bytes (E2E, roomKey ở `#room` hash). Chi tiết §6.
- **revoke ≠ delete**: KHÔNG hard-delete; R2 soft-delete sang `trash/<ts>/...` rồi mới remove bản gốc, dựa R2 lifecycle rule (config dashboard, không trong code) để giữ full history/moat.
- **Blob GET miss = 204, KHÔNG 404** (brand-new room / trashed file là bình thường; loader coi empty body = "nothing stored").
- **Persistence 2 tầng cho transcript** (§4): localStorage keyed roomId (cache nhanh) + R2 (debounce 5s, mirror bền); review (`meetingViewOnlyAtom`) KHÔNG ghi.
- **Finished meeting immutable**: write có grace 10 phút (flush sót) rồi 409-lock; review = read-only mọi entry path. Tombstone `deleted_meeting` → 410.

### Đo đếm chi phí (usage_events)
- Mọi lượt AI/STT/media đo vào D1 `usage_events` (migration `0026`/`0028`): provider `gemini` (token in/out), `deepgram` (phút × người), `daily` (range low→high). Hiện ở Admin Console (AI&Cost + System-status).
- **Metering best-effort, NEVER throw** (`logUsageEvent`/`logOwnerAudit`) — un-migrated/transient D1 error không block response; dùng `waitUntil` để INSERT không bị huỷ khi response trả về.
- **Real-money guards**: kill-switch tức thì `AI_ENABLED`/`STT_ENABLED`/`DAILY_ENABLED` = `"off"` (giá trị ≠ literal `"off"`, kể cả unset = ON); STT `MAX_SESSION 90min` + `AUDIO_IDLE 60s`; Daily caps room expiry 6h / max 50 participant; rate-limit per-isolate (soft).
- **STT lang=multi tránh dùng**: Nova-3 Multilingual đắt hơn ($0.0058) và không cover VI/KO → pin một ngôn ngữ/stream (bill $0.0048). **Hàng rào tiền CỨNG** (budget/quota ở dashboard GCP-Gemini/Deepgram/Daily) còn nợ — rate-limit Worker không phải trần tiền.

### Env / deploy
- **2 artifact**: Worker `mcm-storage` (`https://mcm-storage.rnd-ai.workers.dev`) + Pages `map-canvasm` (`https://map-canvasm.pages.dev`). Deploy thủ công, Pages KHÔNG nối Git. Chi tiết §8.
- **VITE_\* nhúng lúc build, đọc từ ROOT repo** (`envDir:"../"`); prod đọc `.env.production.local` (gitignored). Sai env = app trỏ nhầm backend, không báo lỗi.
- **Tunnel mode** (`VITE_DEV_TUNNEL==="true"`): STORAGE_URL="" same-origin (Vite proxy `/v1`), tắt auth-proxy rewrite.

### Gotcha toàn cục
- **binaryType="arraybuffer" cho mọi WS binary** — STT client+Worker (§3/§4) và realtime client (§2). Bỏ sót ở Worker STT → `send(Blob)` coerce `"[object Blob]"` → Deepgram SchemaError → "STT câm mọi nơi" (06-19). Bài học: bug ở **biên runtime** (CF WS giao Blob ≠ Node Buffer).
- **`--branch=main` khi deploy Pages** (git local = `master`) — thiếu nó → PREVIEW deployment, âm thầm không lên production.
- **Service Worker cache (PWA autoUpdate)** — sau deploy phải Unregister SW / incognito, nếu không thấy bundle cũ.
- **BOM trong secret** — set secret bằng bash pipe, KHÔNG PowerShell `Out-File`/`>` (PowerShell thêm BOM → `new URL()` throw → 401/500/502). `cleanSecret()` guard read-side nhưng vẫn phải set sạch.
- **Cron dạng chữ `0 3 * * SUN`** (CF từ chối số `0 3 * * 0`).
- **Identity bridge `socket.id`** — Daily token bake `?uid=socket.id` → video tiles (§1), audio/active-speaker (§3) và presence (§2) đều key bằng socket.id (không phải Daily UUID); thiếu nó map sai remote.
- **`captionSurfaceAtom` là single source of truth** cho caption dock — nối §1/§4/§5, chống double-mount / dock leak ra canvas.
