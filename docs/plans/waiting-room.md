# Waiting Room — design & build plan (production)

> 2026-06-16. Decided with anh Luân: build the meeting waiting room for
> **production** (chuẩn chỉnh, no quick fixes). Designed by a research team
> (workflow `wf_c5fa1f07`) + adversarial critique; this doc is the agreed scope.

## Principle — "calm lobby, not a checkpoint"

A waiting guest **already has access** (they were invited → `canSeeMeeting`
returns *found*, not *forbidden*). The host is gating **entry timing**, NOT
access. Access denial (revoked / never-invited → kick) is a **separate, earlier
branch** and must never be conflated with "Deny from the lobby".

## Who waits vs auto-admits

- **Internal** (`isInternalEmail`, @mapgroup.co.kr) → **auto-admit**, falls
  straight through to the room (same predicate as the acting-host Start button).
  Never appears in the host's waiting queue.
- **External invited guest** on a **LIVE** meeting → **knock + wait**.
- **Uninvited / revoked** → **kick** (existing `forbidden` branch, unchanged).

## Flow

```
link (#room=ID,KEY) → force login → startCollaboration admit matrix:
  forbidden (revoked/uninvited) → kick                [existing]
  scheduled/cancelled           → WaitingForStart     [existing]
  finished                      → review              [existing]
  LIVE + internal               → AUTO-ADMIT (fall through to socket connect)
  LIVE + external invited        → park in waitingRoomAtom + write knock → poll
on admit → fade the .mcm-gate card out as the socket connects → live canvas, MUTED
```

## Guest experience (reuse `WaitingForStart` / `.mcm-gate`)

- Frosted Glass-Desk card: meeting title, host name, human time, "Joining as
  &lt;logged-in name&gt;" (read-only — login owns identity).
- One **honest** status line: "Waiting for the host to let you in" (no rotating
  carousel — gimmicky).
- Enters the room **muted** with a prominent unmute toggle (`start_audio_off`
  already set) — the single biggest "can you hear me?" preventer.
- **Denied = soft & re-knockable**: calm in-card copy ("The host isn't ready for
  you yet"), a Leave button, and a **server-side** re-knock cooldown. Deny does
  NOT touch invitee status (that's what revoke is for).
- Admit transition is a fade under the same wallpaper — "door opening", not a
  page reload.

## Host experience (reuse `ParticipantsPanel` + moderation pair)

- New **"Waiting (knocking)"** `<ul>` section in the panel, above "Invited / not
  here yet", reusing the existing row markup (avatar, name, guest tag, title
  chip, org line). Each row: **Admit** (`mcm-pp__btn`) / **Deny**
  (`mcm-pp__btn--danger`) — mirroring `doKick`/`doMute`, passing
  `fromAuthority: viewerAuthority`.
- **Count badge** on the existing `CountChip` ("2 waiting") — glanceable,
  non-interrupting. (No focus-stealing modal; toast deferred.)
- Authority to admit = the **existing** `iAmHost` (`!isGuest && (host ||
  viewerAuthority)`) + co-host — no new permission logic. Host-absent: the first
  internal user in the room can admit; if none present, the guest keeps waiting
  (never auto-admitted into an unhosted room).

## Server — the REAL gate (production, no "trust-the-key")

- **`meeting_knock` D1 table**: `(room_id, email, name, status
  invited|admitted|denied, created_at, last_seen)` — migration `0025_*`.
- **Endpoints** (Worker, authz-gated):
  - `POST /v1/meetings/:roomId/knock` — an invited external registers a knock
    (gated by `canSeeMeeting`, external only).
  - `GET /v1/meetings/:roomId/knocks` — host/manager reads the queue
    (`isMeetingManager`).
  - `PATCH /v1/meetings/:roomId/knock/:email` — admit/deny (`isMeetingManager`).
- **Enforcement**: the Daily token endpoint (`index.ts:3168`, where
  `canSeeMeeting` already lives) additionally requires `status='admitted'` for
  externals; internal skip. This is the enforceable media gate.

### ⚠️ Production security reality (must decide — open #1)

The canvas collab socket talks to a **stock, unauthenticated** Excalidraw room
server (`VITE_APP_WS_SERVER_URL`): possession of `#room=ID,KEY` **is** the
credential — there is no JWT/`canSeeMeeting` check there today. So "enforce
admitted on the socket" is **not** a small add. For a true production gate, the
admitted-flag is enforceable on the **Worker** surfaces (Daily token + blob
endpoints); the **canvas relay stays trust-the-key** until room-server auth is
added (a separate, larger track). Pick one:
- **(1a)** Ship now: gate the Daily token (audio) on admitted; accept that a
  leaked roomKey already reaches the canvas today (pre-existing condition).
- **(1b)** Block on adding auth to the room server (own JWT-gated relay) — larger
  scope, before any external demo.

## Out of v1 (scope cut — NOT a corner cut)

Mic green-room level meter + pre-warmed-stream handoff, device picker,
"Admit all", the inline-admit toast, the per-client theming slot (ship on default
wallpaper), rotating reassurance line, heartbeat-expiry cleverness. Add each only
when a real external demo demands it.

## Chốt 06-16 (anh Luân) — Open decisions đã đóng

1. **Canvas-relay security**: chọn **(1a)** ship-now — gate Daily token (audio) +
   blob trên admitted; **(1b)** add-room-auth **deferred** = blocker TRƯỚC khi mở
   cho khách ngoài thật.
2. **Co-host** được Admit/Deny trong v1 (cùng `iAmHost` + co-host, không thêm
   permission logic).
3. **Admit latency**: chấp nhận **poll ~5s** (không làm socket pending-state).
4. **Host-absent**: giữ **"keep waiting"** cho v1 (không escalate / auto-admit).

## Build phases

> Update 06-16: Waiting room verified live per daily log; Open decisions now
> closed; 0025_meeting_knock migration pending remote deploy.

1. **Server** — ✅ DONE (`37e5953c`): `0025_meeting_knock` knock table + 4 routes
   (POST/GET knock self-poll · GET knocks host queue · PATCH admit/deny soft +
   30s cooldown) + Daily-token admitted gate (1a). Hooks-order fix `3e13f1c2`;
   403-guest fix `95942b6c` (strip `-audio` suffix).
2. **Guest** — ✅ DONE (`37e5953c`): `WaitingRoom.tsx` (clone `WaitingForStart`,
   poll 5s, re-read status on admit) + `waitingRoomAtom` + the external branch in
   `startCollaboration`; enters muted.
3. **Host** — ✅ DONE (`37e5953c`): "Waiting (knocking)" section + Admit/Deny in
   ParticipantsBar + "N waiting" badge on CountChip.
4. **i18n** vi/en/ko + gates (typecheck, eslint, build, worker typecheck).
