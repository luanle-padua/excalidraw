# Speaker attribution for a shared / room mic — decision doc

**Status:** ANALYSIS ONLY — approved direction, build later (Luân 2026-06-26).
**Decision:** Ship **Room mode** as the eventual MVP; defer diarization.

## Problem
Sometimes ONE user is the logged-in host, but a WHOLE TEAM physically sits around
that one PC/mic. The audio is a MIX of several humans on a single account. Today
the system attributes EVERYTHING spoken on that mic to the single logged-in user —
which is a lie, and it poisons the retrieval-grounded AI knowledge base / Chairman
behavior analysis ("host said everything").

## How attribution works TODAY (file:line)
- The fake label is stamped in `Collab.publishSTTSegment()` —
  `excalidraw-app/collab/Collab.tsx:2867-2875`: every finalized utterance gets
  `socketId: this.portal.socket.id`, `username: this.state.username || "Guest"`.
  The STT callbacks pass only `{ text, lang, ts }`, never a speaker
  (`audio/AudioRoomController.tsx:485-487`).
- The transcript model has ONE identity slot: `{ socketId, username, text, lang, ts }`
  — `data/transcription.ts:30-41`. No "room" / multi-speaker notion.
- Deepgram is a single mono stream with **NO diarization** today — the realtime URL
  sets model/smart_format/keyterms but never `diarize`/`multichannel`
  (`worker/src/stt-provider.ts:274-293`); server forwards `Results` verbatim
  (`worker/src/stt.ts:481-490`).
- Captions/replay render that single label (`LiveCaptionDock.tsx:108-117,229-240`,
  `SpeechToTextPanel.tsx:157-185`); "who's speaking now" = Daily `activeSpeakerAtom`
  which on a shared PC is always the one account.
- Recording per-mic blobs derive `speaker_id`/`speaker_name` from the uploader JWT
  (`data/recordings.ts:41-42,93-94`) — same single-account lie.
- AI summary is attribution-driven: prompt takes `{speaker,text,lang,ts}` and emits a
  `participants` list (`worker/src/ai.ts:293,311,320,862-874`).

## Options
| # | Option | UX | Feasibility | Accuracy | Effort | AI honest? |
|---|--------|----|-------------|----------|--------|-----------|
| **a** | **Room / Representative mode** — host toggles "this is a room mic"; mic labelled as a PLACE (e.g. "Phòng Kỹ thuật"), not a person | 1 toggle + free-text room name; captions/transcript/replay show "Phòng Kỹ thuật: …" with a room icon; summary lists the room | **High** — add `speakerKind:'room'`+`roomLabel` to the segment, override the socket-name stamp; no provider/audio change | Honest by construction (claims a place, not a person) | **Low ~1-2d** | **Yes** |
| b | Manual in-room tagging (host marks "now X speaking" / pick from roster) | Roster + current-speaker control | Medium | Low in practice (nobody re-taps every sentence → stale = new lies) | Medium ~3-5d | Partial |
| c | Auto diarization (Deepgram `diarize=true` → Speaker 0/1/2) | "Speaker 1/2/3" until mapped | Medium (add param + read `words[].speaker`) | **Low-medium for co-located speakers** (overlap, similar acoustics = label churn/swaps) | Medium-High ~1wk+ | Honest-ish (anonymous, not named) |
| d | Hybrid: diarize to split + one-time name-map UI, fall back to Room when unmapped | Host maps Speaker→name | Medium-high | Inherits (c) split ceiling | High ~2wk | Best potential, depends on splits |

## Recommendation
- **MVP (later, when scheduled): (a) Room mode.** Smallest change, fully honest, matches
  simplicity-first, immediately stops poisoning the knowledge base. ~1-2 days, no
  audio/provider/infra changes. Default OFF (solo accounts unchanged).
- **Later (only on real demand): (d) hybrid diarization** as the P4 "payoff" the
  per-speaker-audio plan already anticipates — Deepgram `diarize` + a one-time
  Speaker→name mapping UI that falls back to the Room label when unmapped. Gate behind
  A/B; verify accuracy on real co-located room audio before trusting splits.
- **Do NOT ship (b) standalone** — stale manual tags reproduce the same false-attribution
  class we're removing.

### MVP build sketch (for when it's scheduled)
1. Add `speakerKind:'person'|'room'` + optional `roomLabel` to `TranscriptSegment`
   (`data/transcription.ts`) and the AI segment shape (`worker/src/ai.ts`).
2. In `publishSTTSegment` (`Collab.tsx:2867`): when meeting is in room mode, stamp
   `speakerKind:'room'` + host-entered room label instead of the login name; keep a
   stable per-room `socketId` so colour/grouping still works.
3. Render the room label + a distinct "room" icon in `LiveCaptionDock` +
   `SpeechToTextPanel`; summary `participants` lists the room.
4. Carry the same room label onto the per-mic recording (`speaker_name`) so replay agrees.
5. One host toggle in meeting/recording setup ("This computer is a shared room mic") +
   room-name field. Default OFF.
