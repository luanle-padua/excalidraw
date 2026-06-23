// Meeting Event Log (P1 MVP) + join-time consent — client side.
//
// Two disclosed, NON-surveillance concerns live here:
//
//  1. CONSENT — a brief, localized notice the user accepts when JOINING a
//     meeting (it may be recorded / processed by AI as project data). The
//     wording lives in i18n (consent.*) and is versioned by CONSENT_VERSION so a
//     later change re-prompts everyone exactly once.
//
//  2. EVENT LOG — at End-for-all the host's client (which holds the room key and
//     already has the chat + transcript + canvas text loaded) parses them into a
//     server-readable timeline and POSTs them in ONE batch (consolidate-on-end).
//     This is a DERIVED, plaintext copy for AI/leadership to read the FLOW of the
//     meeting — there is NO per-person scoring or profiling, just attributed
//     "what was said / typed / written" lines. See docs/plans/meeting-event-log.md.
//
// Both reuse the existing worker base + auth (fetchWithAuth) and are fire-and-
// forget / fail-soft: they must never block joining or ending a meeting.

import { fetchWithAuth } from "./fetchWithAuth";
import { IS_PROJECTS_CONFIGURED, STORAGE_URL } from "./projects";

/** The CURRENT consent wording version. Bump this whenever the consent text
 *  (i18n consent.*) materially changes — every user is then re-prompted once,
 *  because the server-stored accepted version no longer matches. */
export const CONSENT_VERSION = "1";

const json = { "content-type": "application/json" };

/** One event in the meeting timeline, as POSTed by the client. `id` is derived
 *  server-side ("<meetingId>:<kind>:<seq>") for idempotency, so the client only
 *  supplies the content. */
export type MeetingEventInput = {
  kind: "transcript.segment" | "chat.message" | "canvas.text";
  /** Event time (ms epoch). Falls back to insert time server-side if absent. */
  ts: number;
  /** Stable order within the same kind — the idempotency key. */
  seq: number;
  /** Small JSON payload (the plaintext content). */
  payload: Record<string, unknown>;
  /** Who the line is attributed to (speaker / chat sender), lower-cased. */
  actor_email?: string;
};

/** Record that the current user accepted the join-time consent notice for this
 *  meeting. Fire-and-forget; the email is taken server-side from the JWT. */
export const acceptMeetingConsent = async (
  roomId: string,
  version: string = CONSENT_VERSION,
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/consent`,
      { method: "POST", headers: json, body: JSON.stringify({ version }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** POST a batch of meeting events. Idempotent server-side (stable ids), so a
 *  re-run never duplicates. Fail-soft: returns false instead of throwing. */
export const postMeetingEvents = async (
  roomId: string,
  events: MeetingEventInput[],
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !roomId || events.length === 0) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/events`,
      { method: "POST", headers: json, body: JSON.stringify({ events }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};
