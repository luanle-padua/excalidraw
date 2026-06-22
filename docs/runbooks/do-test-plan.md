# DO realtime — GO/NO-GO test execution plan [HISTORICAL — cutover DONE 06-17]

> **✅ CUTOVER DONE (06-17):** realtime is now 100% Durable Objects; the socket.io
> (Fly) room server + the `room/` directory are RETIRED/removed. This GO/NO-GO matrix
> is kept as the historical record of the cutover gate — there is no longer a flag to
> flip back to socket.io.

Cutover matrix for the socket.io → Durable Objects realtime migration. Maps
**every** item of the "Parity acceptance checklist (Team C)" + the §9.4 GO/NO-GO
gate in `docs/plans/durable-objects-migration.md` to the artifact that verifies
it. Execute this whole matrix against a meeting with `realtime_backend='do'`
before flipping the flag for real traffic.

> **Everything below requires a DEPLOYED DO** (the unit tests excepted). Until
> the Worker + RoomDO are live with `realtime_backend='do'`, the load + E2E
> rows cannot run. Be honest at cutover: a row is GO only when its test was
> actually executed and passed — not by inspection.

## Artifacts referenced

| Tag | Artifact | Needs live DO? |
|---|---|---|
| **UNIT** | `worker` vitest DO tests (frame pack/unpack, join/broadcast/follow/close, hibernation attachment, auth) — plan §9.1. *(authored by the unit-test slice, not this slice)* | no (miniflare) |
| **LOAD** | `scripts/do-loadtest.mjs` (this slice) | **yes** |
| **E2E** | `e2e/do-realtime.spec.ts` (this slice) | **yes** |
| **MANUAL** | Human steps below / `wrangler tail` / D1 inspection | **yes** |

Run commands:

```bash
# UNIT (no DO): in worker/ once the vitest DO suite exists
cd worker && npx vitest run

# LOAD (after deploy):
node scripts/do-loadtest.mjs --base wss://mcm-storage.rnd-ai.workers.dev \
  --room <ROOM_ID> --token "<JWT>" --clients 50 --messages 100 --rate 5

# E2E (after deploy): see e2e/README.md for env + Playwright wiring
npx playwright test e2e/do-realtime.spec.ts
```

---

## Parity matrix (Team C checklist → test)

### 1. Scene sync

| Item | Verified by | Status |
|---|---|---|
| `INIT` late-joiner gets full scene once; `socketInitialized` blocks dup | E2E `scene-sync › late joiner gets full scene once` | ☐ |
| `UPDATE` draw/move/delete reconcile by version + order; deletion needs version bump | E2E `scene-sync › two clients: draw / move / delete` | ☐ |
| 20s full-sync fan-out (N×(N-1)) no desync / no version doubling | E2E `scene-sync › 20s full-sync fanout` + LOAD `--fullsync` | ☐ |

### 2. Presence

| Item | Verified by | Status |
|---|---|---|
| `first-in-room` once per room lifetime (`roomEverInitialized`, not length); wake-from-hibernate doesn't clear reconnect | UNIT (flag persists across simulated hibernation) + E2E `presence › first-in-room fires once` | ☐ |
| `new-user`: peers re-push USER_PROFILE+INIT; no double on reconnect | E2E `presence › reconnect does not double the collaborator` | ☐ |
| `room-user-change`: join/leave list correct; ~250ms debounce, no flicker | UNIT (debounce collapses N close) + E2E `presence › join/leave updates the room-user list` | ☐ |
| `USER_PROFILE` name/company/avatar + joinedAt; late-joiner snapshot | E2E `presence` (avatar visible) — MANUAL spot-check name/avatar | ☐ |
| `MOUSE_LOCATION` volatile cursor smooth; backpressure-drop | LOAD (volatile path under flood) + MANUAL (cursor smoothness) | ☐ |
| `IDLE_STATUS` active/idle/away | MANUAL (let a client idle; observe status pill) | ☐ |
| `USER_VISIBLE_SCENE_BOUNDS` only acts when following that socketId | E2E `follow` (viewport push) | ☐ |

### 3. Follow

| Item | Verified by | Status |
|---|---|---|
| `user-follow` FOLLOW/UNFOLLOW: A follows B → B viewport pushes to A | E2E `follow › A follows B` | ☐ |
| `user-follow-room-change`: followed gets correct follower list | UNIT (follow map) + E2E `follow` | ☐ |
| `broadcast-unfollow`: B leaves / loses followers → A unfollows, no hang | UNIT (last-follower → unfollow) + E2E `follow` (B leaves) | ☐ |

### 4. RTC / voice (D1 — kept-but-unused)

| Item | Verified by | Status |
|---|---|---|
| `rtc-signal` + `request-room-clients` NOT triggered accidentally (no caller; Daily.co replaced mesh) | UNIT (handlers exist + route; assert no client emits) + MANUAL (network log: no rtc-signal frames in a normal call) | ☐ |
| `AUDIO_STATE` in-call + muted (incl. self-mute) renders mic icon per peer | MANUAL (two clients, toggle mute, observe icons) | ☐ |

### 5. Locks

| Item | Verified by | Status |
|---|---|---|
| `SCREEN_SHARE` one sharer → others early-return; abrupt drop prunes lock; media via Daily.co | E2E `screen-share-lock › one sharer locks others` | ☐ |
| `LIBRARY_FILE_LOCK` lock/unlock mirrors to referencing canvas image | MANUAL (lock a library file; observe mirror on peer) | ☐ |

### 6. Chat / reactions / raise-hand

| Item | Verified by | Status |
|---|---|---|
| `CHAT` message order | E2E `chat-reactions-raisehand` | ☐ |
| `CHAT_REACTION` applies to correct message | E2E `chat-reactions-raisehand` (extend assertion) + MANUAL | ☐ |
| `MEETING_REACTION` ephemeral, self-expiring, bounded | MANUAL (fire emoji; confirm it floats + expires) | ☐ |
| `RAISE_HAND` sticky badge until lowered; pruned on leave | E2E `chat-reactions-raisehand` (raise → leave → pruned) | ☐ |

### 7. STT

| Item | Verified by | Status |
|---|---|---|
| `STT_SEGMENT` finalized caption rides client-broadcast (E2E roomKey), per-sender order; `/stt` never hits RoomDO | E2E `stt-segment` (`fixme` until fake-audio fixture) + MANUAL (`wrangler tail`: no RoomDO wake on `/stt` upgrade) | ☐ |

### 8. Recording

| Item | Verified by | Status |
|---|---|---|
| `RECORDING_STATE` banner + elapsed timer correct for late-joiner; host check at render | MANUAL (start recording; late-joiner sees banner + timer) | ☐ |

### 9. Knock / auth

| Item | Verified by | Status |
|---|---|---|
| External `denied`/`invited` (not admitted) → handshake 403, no WS | E2E `knock-auth › external denied guest CANNOT open the WS` + UNIT (gate logic) | ☐ |
| External `admitted` → 101; internal/admin auto-skip knock | E2E `knock-auth › admitted internal user CAN open` + MANUAL (admit a guest, confirm join) | ☐ |
| JWT expired/wrong-audience → 401; canSeeMeeting fail → 403; WS-count cap → 403 | UNIT (`verifyRealtimeJwt` + gate branches) + LOAD (cap: push past `--clients` > ROOM_WS_CAP → 403 closes) | ☐ |
| Finished = read-only (D3) → handshake 409 | UNIT (`isFinishedLocked` branch) + MANUAL (finish a meeting; reviewer WS rejected 409) | ☐ |
| Subprotocol: token ≠ `mcm.v1`; server echoes `mcm.v1` only on 101 | UNIT (`realtimeToken` parsing) + MANUAL (`wrangler tail` / browser handshake) | ☐ |
| `init-room` carries `args:[{socketId}]`; client sets `.id` | UNIT (DO sends init-room) + LOAD (script reads `args[0].socketId`) | ☐ |
| `realtime_backend` (do\|socketio) end-to-end; absent/null → socketio | UNIT (D1 read) + MANUAL (flip flag, observe transport) | ☐ |

### 10. Reconnect

| Item | Verified by | Status |
|---|---|---|
| Kill network 2s → auto-reconnect (backoff+jitter), re-join, re-INIT, no desync | E2E `reconnect › network blip` | ☐ |
| Deploy Worker → all clients reconnect; no `Portal.close()` → no full-scene storm (keep `broadcastedElementVersions`) | E2E `reconnect` (convergence, no storm) + MANUAL (`wrangler deploy` mid-session; watch all clients re-sync) | ☐ |
| DO mints new socketId per accept → host dedup by joinedAt, not socketId | E2E `presence › reconnect does not double the collaborator` | ☐ |

### 11. Host command / AI

| Item | Verified by | Status |
|---|---|---|
| `HOST_COMMAND` END_MEETING via registry; KICK only elected host/`fromAuthority`; MUTE target-scoped self-mute | MANUAL (host ends/kicks/mutes; non-host blocked) | ☐ |
| AI `/translate` `/chatbot` `/summarize` return results + rate-limit (per-isolate) works | MANUAL (call each; trip the rate limit) | ☐ |

### 12. Library-file

| Item | Verified by | Status |
|---|---|---|
| `LIBRARY_FILE` / `LIBRARY_FILE_DELETE` via R2-by-reference (no inline >1MiB); 30MB+ ok | MANUAL (add + delete a 30MB+ library file; confirm broadcast carries `{fileId,r2Key}`, not bytes) | ☐ |
| `INVALID_RESPONSE` early-return; `default: assertNever` compile-net intact (D7) | UNIT (frame handling) + compile-time (TS `assertNever`) | ☐ |

---

## §9.4 GO/NO-GO gate (cutover blockers)

NO-GO if **any** auth / file / reconnect / first-in-room / runtime-flag /
rollback row fails.

| Gate | Verified by | Status |
|---|---|---|
| **1b closed:** external denied/revoked cannot relay | E2E `knock-auth` + MANUAL (revoke mid-meeting → kicked within poll-60s) | ☐ |
| **LIBRARY_FILE** R2-by-reference, 30MB+ ok, no inline >1MiB; both backends deployed in sync | MANUAL (group 12) | ☐ |
| **Reconnect after Worker deploy** recovers 100% of clients; presence debounce no flicker | E2E `reconnect` + MANUAL (deploy mid-session) | ☐ |
| **`first-in-room`** uses `roomEverInitialized`; wake-from-hibernate doesn't clear scene | UNIT + E2E `presence › first-in-room fires once` | ☐ |
| **Backend flag RUNTIME per-meeting** (D1), not build-time; no cross-build split-brain | UNIT (D1 read) + MANUAL (flip flag; both clients same backend) | ☐ |
| **Parity** canvas/presence/chat/follow/rtc/lock/knock pass vs socket.io | All E2E groups above | ☐ |
| **AI + STT** on Worker; rate-limit (B7) + STT OFF (B8); `/stt` never hits RoomDO | MANUAL (group 11) + `wrangler tail` (no RoomDO wake on `/stt`) | ☐ |
| **Secrets rotated** (B3); CORS allowlist (B6) | MANUAL (`wrangler secret list`; CORS preflight) | ☐ |
| **Rollback drill:** flip D1 to `socketio` + reconnect < 5 min, no data loss; socket.io-client still bundled | MANUAL (timed drill) | ☐ |
| **Hibernation real:** idle 10 min → DO evicts → $0; **0 wake events** | LOAD `--hibernation` + MANUAL (`wrangler tail` 10 min, 0 wake lines) | ☐ |
| **Cloudflare docs verified:** `idFromName` + `locationHint` real-world placement before promising multi-region | MANUAL (doc check; do NOT add `home_region` schema) | ☐ |

---

## Load / capacity checks (plan §9.3)

| Scenario | Command / method | Pass criteria | Status |
|---|---|---|---|
| 1 room × 100 users fanout | `do-loadtest.mjs --clients 100 --messages 200 --rate 5 --size 4096` | delivery ratio ~100%; p99 latency bounded | ☐ |
| 20s full-sync worst case (D6) | `do-loadtest.mjs --clients 100 --fullsync --size 204800 --duration 70` | no delivery collapse; p99 doesn't run away (else chunk fanout, R13) | ☐ |
| 1 room × 500 users (workshop) close O(N) | `do-loadtest.mjs --clients 500 ...` then mass-disconnect | close handling stays O(N); WS-count cap (403) enforced past `ROOM_WS_CAP` | ☐ |
| Eviction transparency | force DO idle-evict, then client reconnect | reconnect transparent; presence resync; scene intact (R2) | ☐ |
| Hibernation | `do-loadtest.mjs --hibernation` + `wrangler tail` 10 min | **0 wake events** in 10 min idle | ☐ |

---

## Honest status (as of this slice)

- **UNIT** rows depend on the `worker` vitest DO suite (separate slice). The DO
  source (`worker/src/roomDO.ts`) exports the frame helpers
  (`packControl`/`parseControl`/`readBinaryType`) so those tests are
  straightforward — but they are not authored here.
- **LOAD** (`scripts/do-loadtest.mjs`) and **E2E** (`e2e/do-realtime.spec.ts`)
  are authored and protocol-correct but **cannot be executed until a DO is
  deployed** with `realtime_backend='do'` on the target meeting. They have not
  been run.
- **MANUAL** rows are human steps to perform at cutover.
- No row in this matrix should be marked GO by inspection — only after its test
  ran green against the live DO.
