# Video (camera) + Recording — design spec

> **Status:** RESEARCH + DESIGN (2026-06-17). Nothing here is built beyond what
> §1 marks as "exists today". For a PM (anh Luân): the **executive summary** and
> the **open questions** at the end are the parts to read first; the middle is
> the technical grounding so the build doesn't drift.
>
> Cross-refs: `docs/generated/architecture.md` §2.6 (media — STALE 06-11 banner,
> but the media section is accurate), `docs/plans/roadmap.md` Phase 5,
> `docs/runbooks/backup.md` (recordings = HEAVY R2 data), `docs/specs/meeting-lifecycle.md`,
> `docs/specs/chairman-account.md` (AI reasoning over meeting content).

---

## 0. Framing — the canvas is the star

Canvas M is a **real-time whiteboard meeting tool**. The whiteboard is the
product; audio / screen-share / (future) video / recording are **support media
around the canvas**, not the centre. Every design choice below keeps the canvas
primary: video tiles are small and peripheral, and the single most important
recording question — "**record what?**" — is answered by "record the thing that
makes this app different, which is the canvas," not just talking heads.

---

## 1. Current state (verified against code)

### 1.1 Audio — SHIPPED

- `excalidraw-app/audio/DailyAudio.ts` — Daily.co SFU, **audio-only** drop-in
  replacement for the old mesh WebRTC (`AudioRoom`/`AudioPeer` are now dead
  code). The call object is created with `audioSource: micTrack`,
  **`videoSource: false`**, `startVideoOff: true` (DailyAudio.ts L152-173).
- Runs in its **own Daily room** named `<roomId>-audio` (DailyAudio.ts L89), so
  it never collides with the screen-share room.
- Mic is requested **only when the user clicks "Join audio"** (`start()`), with a
  graceful no-mic listener fallback. Identity bridge: the app's `socket.id` is
  baked into the Daily token as `user_id` so remote Daily participants map back
  to collab presence (speaking rings / mic dots).
- Wiring: `audio/AudioRoomController.tsx` binds the manager to jotai.

### 1.2 Screen share — SHIPPED (Phase 1)

- `excalidraw-app/screenshare/DailyScreenShare.ts` + `ScreenShareController.tsx`.
- A **second** Daily call object on room `<roomId>` (the bare meeting id),
  `allowMultipleCallInstances: true` lets audio + screen coexist on one page.
- **Lazy-join**: the manager holds NO Daily connection until *someone* shares —
  the controller watches the socket presence atom (`screenShareStateAtom`) and
  only joins Daily when a remote peer starts presenting or when you press
  Present (ScreenShareController.tsx L94-117). When nobody shares it `leave()`s
  to stop the per-minute meter.
- **Single-share lock** via the socket (presence map); one presenter at a time.
- Screen share carries **screen video + optional tab/system audio, no webcam,
  no mic** (DailyScreenShare.ts L132).

### 1.3 The 2-Daily-room split (important for everything below)

| Daily room        | Purpose          | Tracks today            | Join model            |
| ----------------- | ---------------- | ----------------------- | --------------------- |
| `<roomId>-audio`  | voice            | mic audio               | join on "Join audio"  |
| `<roomId>`        | screen share     | screen video (+sys aud) | lazy: only while sharing |

Roadmap already flags **"merge audio + screen into 1 Daily room"** as a
prerequisite for *unified recording* and lower cost (roadmap.md L172). This
spec treats that merge as part of the recording/video work, not separate.

### 1.4 Daily token mint — SHIPPED, server-gated

- `GET /v1/daily/token` (`worker/src/index.ts` L3601). `DAILY_API_KEY` stays
  **server-side**; client only ever receives `{ url, token }`.
- Gated by `canSeeMeeting` (invitee/internal/admin), strips the `-audio` suffix
  to gate on the base meeting id (L3617), returns **409 on finished meetings**
  (review = look-only), and enforces the **waiting-room knock** for external
  guests (L3632-3648). Rooms are created **private, idempotently** on first use
  with `enable_screenshare: true`, `start_video_off`, `start_audio_off`.
- Orphan Daily rooms are cleaned by `deleteDailyRoom` on cascade delete (L4301).

### 1.5 VIDEO (camera / webcam) — **NONE (confirmed)**

There is **no camera capture anywhere**. Both Daily managers hardcode
`videoSource: false` / `startVideoOff: true`; `getUserMedia` is only ever called
with `video: false` (DailyAudio.ts L113). Grep for `setLocalVideo` / `startCamera`
/ `webcam` / `video: true` across `excalidraw-app/` returns only the IFC/DXF 3D
**orbit camera** and the `videoSource: false` lines. Video is greenfield.

### 1.6 RECORDING — local audio-only download (NOT the Phase 5 vision)

- `excalidraw-app/audio/MeetingRecorder.ts` + `components/mcm/RecordingControls.tsx`
  + `data/roomRecording.ts`.
- **What it does today:** the host clicks record → `MeetingRecorder` mixes the
  local mic + every remote peer audio stream through a Web Audio
  `MediaStreamAudioDestinationNode` → one `MediaRecorder` →
  **`audio/webm;codecs=opus`** blob → **`triggerDownload()` to the host's local
  disk** (RecordingControls.tsx L118-125, L303). A `RECORDING_STATE` socket
  broadcast shows peers a read-only "🔴 recording" pill.
- **Deliberately NOT uploaded** to R2 or the library — the code comment is
  explicit: multi-MB opus blobs would blow the websocket library broadcast +
  localStorage quotas (RecordingControls.tsx L19-24).
- **Audio only** — no screen, no canvas, no video. Host-only, **soft** (peers
  validate "is host" client-side via the same election as everything else; not
  server-enforced).

### 1.7 The `recordingEnabled` flag — sent, stored, **no live consumer**

- `recordingEnabled` is collected by `ScheduleMeetingForm`, sent on
  `POST /v1/meetings`, and persisted to D1 `meeting.recording_enabled`
  (default 0; schema `0009_meeting_schedule.sql`; index.ts L1673, L1745, L1767).
- **Nothing reads it at meeting time.** The local recorder in §1.6 does not
  consult it; the Daily token mint does not consult it. Architecture §5 lists it
  as "sent but has no consumer". This flag is the natural hook for the real
  recording feature: gate the record button + consent banner on it.

### 1.8 R2 / worker hooks already reserved

- R2 prefix **`recordings/`** is reserved, `server-readable`, "không E2E"
  (architecture.md R2 table; `recordings/`, `avatars/` = planned, unused).
- The project-archive endpoint **deliberately excludes** `recordings/<roomId>`
  (index.ts L4213-4220) with a TODO: recordings get a *separate per-file*
  signed-URL/retention path, **never** base64-bulk into an archive.
- Admin Cost tab reports `recording_minutes: 0` "tracked once Phase 5 lands"
  (index.ts L4748). Admin "Recordings tab" is pending Phase 5 (roadmap.md L104).

**Two-line summary:** Today = Daily audio + Daily screen-share (two rooms,
server-gated tokens) + a **host-local, audio-only** `MediaRecorder` download.
**No camera. No server-side recording.** The `recording_enabled` meeting flag is
stored but wired to nothing.

---

## 2. VIDEO (camera) — how to develop

### 2.1 Recommendation: enable camera on the EXISTING audio Daily room

Daily already carries video tracks natively. The cleanest path is **not a third
Daily room** — it is to let the existing `<roomId>-audio` call object *also*
publish/subscribe a camera track. Practically this means:

- Rename the concept from "audio room" to **"call room"** (`<roomId>-call`),
  carrying mic **and** camera. Screen share stays on its own `<roomId>` room
  (screen video is a different track class and has its own lazy-join + single-
  share lock).
- In `DailyAudio.ts` (becomes `DailyCall.ts`): currently `videoSource: false`.
  Add an opt-in camera path — `call.setLocalVideo(true)` / `startCamera()` on a
  toggle, **default OFF** (`startVideoOff: true` stays the join default).
- Subscribe to remote `video` tracks the same way audio is subscribed
  (`subscribeToTracksAutomatically: true` already set), and surface each remote
  camera `MediaStream` to a new `videoTilesAtom` keyed by `socket.id` (reuse the
  exact `socketId ↔ session_id` bridge that already powers speaking rings).

This reuses the entire identity bridge, token mint, and presence plumbing. **Do
NOT** spin a separate video Daily room — that triples per-participant cost and
duplicates the identity mapping.

> Ties into roadmap's "merge audio+screen into 1 Daily room" (L172). Recommend:
> merge **mic+camera** into one call room now (clean), but keep **screen share
> separate** for the foreseeable future — its lazy-join + single-share lock is
> load-bearing and screen video has very different bandwidth behaviour.

### 2.2 Canvas-centric video UI

The canvas must stay primary. Video is a **peripheral filmstrip**, never a grid
that takes the stage:

- **Filmstrip / floating tiles**: a small row of self-view + active-speaker
  tiles docked to one edge (bottom-right or right rail), ~120-160px wide,
  draggable, collapsible to avatars. Live in `MeetingShell` overlay layer, same
  z-band as the call-controls pill — never reflow the Excalidraw canvas.
- **Active-speaker promotion**: the existing speaking-detection analyser
  (DailyAudio.ts `attachAnalyser`, the 22/255 threshold) already knows who is
  talking — promote that tile (slightly larger / highlighted ring). No Daily
  "active-speaker" API needed; reuse what's there.
- **Who-renders-whom (bandwidth control)**: do **not** render every camera at
  full res. Subscribe at low/thumbnail layer for off-screen / collapsed tiles
  and request the higher simulcast layer only for the promoted active speaker
  (Daily `setSubscribedTracks` / `receiveSettings`). For 8+ people, render only
  the active speaker + self at video, others as avatars.
- **Toggle**: a camera button in the call-controls pill next to mic. **Default
  OFF.** Joining audio must not auto-start camera.
- **Self-view**: small, mirrored, dismissible.

### 2.3 Mobile / low-bandwidth fallback

- Default camera OFF protects mobile by default.
- Detect downlink (Daily `network-quality-change`) → drop remote video subscriptions
  to audio-only and show avatars; keep audio + canvas always.
- Cap simultaneous rendered camera tiles (e.g. 4) regardless of participant count.

### 2.4 Coexistence with screen share

- Camera lives on the **call room**; screen lives on the **screen room**. They
  are independent — a presenter can share screen with camera off, or have camera
  on while watching someone else present.
- When a screen share is active, **demote camera tiles** further (the shared
  screen and the canvas are what matter); show cameras as a thin strip or
  collapse to avatars.

### 2.5 Cost / B5 relevance — video is much heavier than audio

Daily bills **participant-minutes**, and video minutes cost materially more than
audio-only, plus far more bandwidth per participant. Every camera that is ON
multiplies egress and Daily spend. This is why:

- **Default OFF** is a cost decision as much as a privacy one.
- The B5 work (rate-limit `/daily/token`, block runaway Daily-room creation,
  cost-cap — roadmap.md L15) becomes **more** important once video is enabled.
  The admin Cost tab should start reporting video participant-minutes.
- Recommend a per-meeting / per-org **camera cap** and an admin cost ceiling
  before enabling video for external (Aug) traffic.

---

## 3. RECORDING — how to develop (the central design question)

### 3.1 "Record what?" — three options

| Option | Captures | Misses | Effort |
| --- | --- | --- | --- |
| **(a) Daily cloud recording** | server-composited A/V + screen share, one MP4 | the live canvas interactivity — only sees the canvas if someone *screen-shares* it | Low (Daily REST + webhook + copy to R2) |
| **(b) Canvas session replay** | the whiteboard itself, replayable from scene history + transcript/chat timeline | live voices/faces as media (you have the transcript, not the audio) | High (new replay engine + versioned scene capture) |
| **(c) Hybrid** | Daily cloud recording (A/V + screen) **+** canvas final state / scene-version timeline / transcript, all linked under one meeting | nothing material | Medium (a) + a thin link layer |

**Why (a) alone is wrong for THIS app:** Daily records talking heads + whatever
is on screen. In Canvas M the value is on the **canvas**, which is usually NOT
screen-shared (it's the native app surface). A pure (a) recording of a Canvas M
meeting would be audio + faces over a mostly-empty screen — it throws away the
product's whole point.

**Why (b) alone is too much, too soon:** the scene already autosaves to R2 with
a `[u32 ver]` version prefix and the transcript/chat are timelined — so a
"replay the whiteboard" engine is *architecturally plausible* (scrub scene
versions + sync transcript/chat). But it's a big build, and it has no audio as
*media*. Park it as the Phase-2 differentiator.

### 3.2 Recommendation: **(c) Hybrid, built in two layers**

- **MVP layer = (a)** Daily cloud recording for audio + screen + (optional)
  video → webhook → R2 → review-mode playback. This is the standard, reliable,
  cheap-to-build path and gives a watchable artefact immediately.
- **Differentiator layer = (b)** the canvas is *already* persisted and immutable
  on `finished` (scene/chat/transcript flushed via `flushPendingRoomSaves`).
  Layer 2 = a **canvas replay / timeline** reconstructed from scene versions +
  transcript + chat, **linked to** the Daily A/V so a reviewer can scrub the
  whiteboard's evolution alongside the voice track.

So a "Canvas M recording" is ultimately: **one Daily A/V file + the meeting's
canvas timeline + transcript + chat + AI summary, presented together in review
mode.** Ship (a) first; the canvas timeline is mostly *exposing data you already
store*, not recording something new.

### 3.3 Pipeline (Option a, the MVP)

```
Host presses Record (gated on meeting.recording_enabled + consent)
  → client calls Worker: POST /v1/recordings/:roomId/start
      → Worker (DAILY_API_KEY) → Daily REST start recording (cloud/composited)
      → broadcast RECORDING_STATE so peers see the consent pill (reuse existing)
  ... meeting runs ...
Host presses Stop → POST /v1/recordings/:roomId/stop → Daily REST stop
  → Daily finishes compositing → fires webhook `recording.ready-to-download`
  → Worker webhook handler:
       verify Daily signature → fetch the file → PUT to R2 recordings/<roomId>/<recId>
       (Daily writes only to AWS S3, not R2 — Worker copies; egress-free R2 is why)
       → insert D1 row (meeting_recording: id, room_id, bytes, duration, started_by, created_at)
       → optionally delete the Daily-side copy (stop double storage billing)
Review: GET /v1/recordings/:id → JWT + canSeeMeeting + (host/organizer/admin)
       → stream from R2 (private; NO public link) → <video> in review mode
```

This mirrors the Phase-5 plan already written in roadmap.md L93-95 and L165, and
the meeting-lifecycle finished-immutability rules.

> **Prerequisite:** unified-recording wants audio + screen on **one** Daily room
> (see §1.3 / roadmap L172) so Daily composites a single file. Today they're two
> rooms → Daily would produce two recordings. Decide: (i) merge the rooms (clean,
> also the right move for video), or (ii) record two files and stitch/link them.
> Recommend **merge mic+camera+screen** into one recordable room before Phase 5.

### 3.4 Storage cost — reuse the already-decided backup policy

`docs/runbooks/backup.md` already decided how recordings are stored (do not
re-litigate):

- **R2 `recordings/` prefix, server-readable** (NOT E2E — see §3.6).
- **No 2× duplication.** Rely on R2's own durability + soft-delete +
  **Infrequent-Access tier** + a **lifecycle retention rule**. Recordings are
  **excluded from the project-archive JSON** by design (would OOM the worker);
  pull a specific recording on demand via signed URL / `wrangler r2 object get`.

**Ballpark (decide the actual numbers with anh Luân):**

- Daily composited recording ≈ **~0.5–1.5 GB / hour** depending on resolution
  and whether video/screen is on (audio-only is a fraction of that).
- A 1-hour meeting on R2 standard ≈ low single-digit cents/month storage;
  **egress is free on R2** (vs ~$0.09/GB on S3 — the whole reason for copying to
  R2). Daily *recording* itself is billed per recorded-minute on top of the
  participant-minutes.
- The real cost driver is **volume × retention**, not any single file. Hence the
  IA tier + lifecycle retention rule below.

### 3.5 Retention, consent, control

- **Retention policy** (decide value): e.g. recordings auto-expire after N days
  via an R2 lifecycle rule on `recordings/`, unless explicitly pinned. Mirrors
  the `trash/` lifecycle approach. Chairman insights already propose a TTL
  (chairman-account.md §6) — keep recording retention at least as conservative.
- **Consent — default OFF + banner (multinational / Philippines).** Recording
  must be **off by default** and gated on `meeting.recording_enabled`. When a
  host starts a recording, **all participants get a clear banner/consent prompt**
  (reuse the `RECORDING_STATE` broadcast that already drives the peer pill — make
  it a consent surface, not just a status dot). This is the **same B8 consent
  posture** already required for STT ("STT default-OFF + banner consent … đặc
  biệt cho đa quốc gia/Phi", roadmap L14/L134) — recording + AI analysis raise
  the bar further. One unified "this meeting is being recorded / transcribed /
  AI-analysed" consent surface is the right UX.
- **Who can start/stop:** host (organizer/co-host) only — same authority model
  as End-for-all in meeting-lifecycle. For **external** meetings (Aug) this needs
  the planned **server-side host validation** (roadmap intro), since today host
  is client-soft.

### 3.6 E2E boundary — call it out explicitly

Scene / chat / transcript are **E2E-encrypted with `room_key`** (the server only
holds ciphertext, though `room_key` is managed in D1 = a *policy* boundary, not
pure crypto). **Daily cloud recordings are composited server-side and stored
server-readable in R2 — they are NOT E2E.** This is a deliberate policy boundary,
exactly like the managed `room_key` decision: the org chose server-readability to
enable admin compliance + the Chairman AI (roadmap L171, chairman-account §4).
Document it loudly so it's a conscious choice, not a leak:

> Recordings (and the AI summary, and the managed room_key) sit **outside** the
> E2E envelope by design — they are the org-compliance / Chairman-AI surface.
> Everything else in the meeting stays E2E.

### 3.7 Surfacing recordings: review mode + Chairman AI

- **Finished-meeting review** (`finished` = immutable, read-only on every entry
  path — meeting-lifecycle §finished): add a **Recordings** section showing the
  Daily A/V player (streamed from R2 via the auth-gated route) alongside the
  existing AI summary + transcript. Admin Console gets the pending "Recordings
  tab" (roadmap L104).
- **Chairman AI** (chairman-account.md): the Chairman reasons over
  transcript + chat + canvas + summary today. A recording (or its
  Daily/Deepgram transcript) is another grounding source — but note Chairman's
  hard rule: **every behavioural claim must cite a concrete segment**
  (chairman-account §43-45). A recording's value to the AI is mostly its
  **transcript** (which we already capture per-speaker via STT, attribution
  without diarization). The A/V file is for *humans* to review; the AI keeps
  citing transcript/chat/canvas segments. Don't over-invest in AI-watches-video.

---

## 4. Cost & risk summary

| Item | Driver | Mitigation |
| --- | --- | --- |
| Daily video minutes | participant-minutes × video (>> audio) | camera **default OFF**, simulcast/low-layer for non-speakers, cap rendered tiles, per-meeting camera cap |
| Daily recording minutes | recorded-minutes billed on top | recording default OFF, gated on `recording_enabled`, host-only |
| R2 storage | GB/hr × volume × retention | IA tier + **lifecycle retention rule** + soft-delete; never 2× duplicate; never bulk-archive (backup.md) |
| R2 egress | playback | **free on R2** (the reason to copy off Daily/S3) |
| `/daily/token` abuse | runaway room creation | **B5** rate-limit + block auto-create (roadmap L15) — more urgent with video |
| Legal / consent | multinational (PH) two-party-consent regimes | default OFF + explicit banner/consent (same posture as B8 STT); per-region policy via client branding/settings |
| E2E expectation gap | recordings are server-readable, NOT E2E | document the policy boundary (§3.6); admin compliance + Chairman depend on it |

---

## 5. Phasing

### MVP (target: align with July Phase 5 window)

1. **Wire `recording_enabled`** as the real gate (consume the flag that's already stored).
2. **Camera on the existing call room**, **default OFF**, with a canvas-centric
   filmstrip (self + active-speaker), low-bandwidth fallback. (Can ship
   independently of recording.)
3. **Merge mic+camera (+screen if feasible) into one recordable Daily room** so a
   single composited file is possible.
4. **Daily cloud recording → webhook → R2 `recordings/` → auth-gated review-mode
   playback** (audio + screen + video), host-only, with a **consent banner** for
   all participants.
5. **R2 lifecycle/IA-tier rule** on `recordings/` + retention period.
6. **Admin Recordings tab** + Cost tab reports recording/video minutes.

### Full (Aug+ / differentiator)

- **Canvas session replay** (Option b): scrub the whiteboard from scene versions
  + transcript/chat timeline, linked to the Daily A/V — the feature no
  talking-heads recorder has.
- **AI-on-recording**: Chairman / summary grounded on recording transcript
  (transcript already exists; mostly a linking job).
- **Server-side host validation** for start/stop (required before external).
- **Retention automation + per-region consent policy** + data-residency (R2/Daily
  region) for cross-border clients.

### Build order / decide-first

1. Decide **record-what** (a / b / c) — recommend **(c) hybrid: ship (a) first**.
2. Decide the **one-room merge** vs two-file-stitch.
3. Then: token/room plumbing → Daily REST start/stop → webhook → R2 copy →
   auth-gated playback → lifecycle rule → admin tab.

---

## 6. Open questions for anh Luân (non-CS PM)

1. **Record what?** Talking-heads + screen only (Option a), or *also* the canvas
   replay (Option c)? — recommend (c): ship A/V first, add canvas timeline later.
2. **Retention period?** How long do recordings live before auto-delete (e.g. 30 /
   90 / 180 days)? Different for internal vs client meetings?
3. **Consent policy?** Default OFF + mandatory banner is the recommendation — OK?
   Any country (Philippines) needing explicit *opt-in per participant* before record starts?
4. **Camera default?** OFF by default (cost + privacy) — confirm. Allow per-meeting
   "video meeting" toggle that defaults it ON?
5. **Cost ceiling?** A monthly Daily spend cap (video + recording minutes) and a
   per-meeting camera cap — what numbers? (feeds B5 cost-cap work.)
6. **Who controls recording?** Host-only confirmed — but for external meetings
   this needs the server-side host-validation that's still on the Aug list.
