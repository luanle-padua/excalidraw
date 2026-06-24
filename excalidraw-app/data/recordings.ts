// Meeting Recording (Phase 5) — client API.
//
// Thin wrapper over the auth-gated Worker recording routes. The host starts /
// stops a Daily cloud recording; Daily composites the file and (via a webhook)
// the Worker copies it into R2 PRIVATE. Review mode lists a meeting's recordings
// and plays / downloads them — every read goes through the Worker's auth gate
// (host / organizer / co-host / project leadership / admin), NEVER a public link.
//
// All calls go through fetchWithAuth (Supabase JWT) and are fail-soft: they
// return null/false/[] instead of throwing, so a recording hiccup never breaks
// the meeting or the review surface.
//
// IMPORTANT — the recordable Daily room. The Worker derives the meeting id from
// the roomId by stripping a "-audio" suffix, exactly like the Daily token mint,
// so passing either the bare meeting id OR the "<id>-audio" room name works.

import { fetchWithAuth } from "./fetchWithAuth";
import { IS_PROJECTS_CONFIGURED, STORAGE_URL } from "./projects";

const json = { "content-type": "application/json" };

/** Which source a recording came from (per-source / per-speaker, #23). `mixed`
 *  is the legacy single-file shape (kept backward-compatible). */
export type RecordingKind = "mic" | "screen-audio" | "screen-video" | "mixed";

/** One recording row as returned by the list route. Mirrors the D1 `recording`
 *  table (status 'deleted' rows are filtered out server-side). */
export type Recording = {
  id: string;
  meeting_id: string;
  project_id: string | null;
  duration: number | null;
  bytes: number | null;
  status: "processing" | "ready" | "failed" | "deleted";
  started_by: string | null;
  created_at: number;
  ready_at: number | null;
  // Per-source fields (migration 0037). Older rows are `kind:'mixed'` with the
  // speaker/session columns null.
  kind: RecordingKind;
  speaker_id: string | null;
  speaker_name: string | null;
  session_id: string | null;
};

/** Host: start a Daily cloud recording for this meeting's recordable room.
 *  Host-gated server-side; returns true on the Daily {"status":"sent"} ack. The
 *  recording_id arrives later via the webhook, so there is nothing to return
 *  here beyond success. */
export const startRecording = async (roomId: string): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/recordings/${encodeURIComponent(roomId)}/start`,
      { method: "POST", headers: json },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Host: stop the running cloud recording. Daily then composites the file and
 *  fires the ready-to-download webhook. A double-stop is a server no-op. */
export const stopRecording = async (roomId: string): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/recordings/${encodeURIComponent(roomId)}/stop`,
      { method: "POST", headers: json },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Upload a CLIENT-SIDE recording (06-24 per-source / per-speaker pivot, #23).
 *
 *  Each source is its own file now (see audio/clientRecording.ts): every
 *  participant uploads their own `mic` blob; the session owner additionally
 *  uploads `screen-audio` and (opt-in) `screen-video`. All files from one
 *  Record→Stop press share one `sessionId` so they can be re-aligned later. The
 *  Worker stores the blob in R2 and inserts a `recording` row (status 'ready')
 *  with the given `kind`/`sessionId`; for `kind:'mic'` the server derives the
 *  speaker identity from the JWT (NOT trusted from the client). Review-mode lists
 *  + plays through the SAME gated routes as before. Fail-soft → boolean.
 *
 *  Content-Type: `mic` & `screen-audio` → audio/webm; `screen-video` &
 *  legacy `mixed` → video/webm (the blob's own type wins when present).
 *
 *  `durationSec` is the client-measured length (MediaRecorder gives no reliable
 *  duration); it is passed as a query param so the row + UI can show it.
 *
 *  Backward-compatible: a caller that omits `kind` records `mixed` (the legacy
 *  single-file shape). */
export const uploadRecording = async (
  roomId: string,
  blob: Blob,
  opts: {
    durationSec?: number;
    kind?: RecordingKind;
    sessionId?: string;
  } = {},
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId || blob.size === 0) {
    return false;
  }
  const kind: RecordingKind = opts.kind ?? "mixed";
  // Audio kinds carry audio/webm; video kinds carry video/webm. Honour the
  // blob's own type when it has one (MediaRecorder sets it), else fall back per
  // kind so the Worker stores a sensible Content-Type.
  const fallbackType =
    kind === "mic" || kind === "screen-audio" ? "audio/webm" : "video/webm";
  try {
    const params = new URLSearchParams();
    if (opts.durationSec != null && Number.isFinite(opts.durationSec)) {
      params.set("duration", String(Math.max(0, Math.round(opts.durationSec))));
    }
    params.set("kind", kind);
    if (opts.sessionId) {
      params.set("sessionId", opts.sessionId);
    }
    const qs = params.toString();
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/recordings/${encodeURIComponent(roomId)}/upload${
        qs ? `?${qs}` : ""
      }`,
      {
        method: "PUT",
        headers: { "content-type": blob.type || fallbackType },
        body: blob,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** List a meeting's recordings (review-mode "Recordings" section), newest first.
 *  Same authority gate as start/stop. Returns [] on any error / no access. */
export const listRecordings = async (roomId: string): Promise<Recording[]> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/recordings/${encodeURIComponent(roomId)}`,
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { recordings?: Recording[] };
    return data.recordings ?? [];
  } catch {
    return [];
  }
};

/** Build the raw Worker stream URL for a recording's MP4. This is the gated
 *  route — it requires the Authorization bearer, so you CANNOT put it directly in
 *  `<video src>` (an <img>/<video> element cannot attach the header, and the
 *  route is deliberately NOT a public link). It exists so callers can build the
 *  `?download=1` link or pass the URL to fetchWithAuth. `download:true` flips the
 *  Content-Disposition to attachment. */
export const recordingMediaUrl = (
  recordingId: string,
  opts: { download?: boolean } = {},
): string =>
  `${STORAGE_URL}/v1/recordings/${encodeURIComponent(recordingId)}/media${
    opts.download ? "?download=1" : ""
  }`;

/** Authenticate the media for a `<video>` element.
 *
 *  Because the stream route is JWT-gated and a media element can't carry the
 *  bearer header, we fetch the MP4 through fetchWithAuth (which attaches the
 *  token) into a Blob and hand back an object URL that IS safe as `<video src>`.
 *  This mirrors the codebase's existing fetchWithAuth → blob → createObjectURL
 *  pattern for guest logos / backdrops / user files.
 *
 *  Tradeoff (documented intentionally): a blob URL buffers the whole file, so it
 *  loses HTTP Range seeking on very large recordings. The Worker route DOES
 *  support Range (206) for a future short-lived-signed-URL approach — when a
 *  signed-URL scheme lands, swap this helper to return `recordingMediaUrl()`
 *  with the token in the query so the element streams + seeks natively. For
 *  review/docs-sized 480p files (the owner's "minimum size" target) buffering is
 *  fine.
 *
 *  The caller MUST `URL.revokeObjectURL(url)` when the player unmounts to free
 *  the blob. Returns null on any error / no access. */
export const fetchRecordingObjectUrl = async (
  recordingId: string,
): Promise<string | null> => {
  if (!IS_PROJECTS_CONFIGURED || !recordingId) {
    return null;
  }
  try {
    const res = await fetchWithAuth(recordingMediaUrl(recordingId));
    if (!res.ok) {
      return null;
    }
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
};

/** Download a recording to the user's disk (the "Download" button). Fetches the
 *  attachment variant through fetchWithAuth (so the gate is honoured) and drives
 *  a temporary anchor click. Returns false on error / no access. */
export const downloadRecording = async (
  recordingId: string,
  filename?: string,
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !recordingId) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      recordingMediaUrl(recordingId, { download: true }),
    );
    if (!res.ok) {
      return false;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `recording-${recordingId}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
};
