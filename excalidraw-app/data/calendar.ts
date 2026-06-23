// Client API for the MCM Calendar (worker /v1/...). Mirrors data/invite.ts:
// every call goes through fetchWithAuth (Supabase JWT) and is wrapped in
// try/catch so a flaky worker never crashes the calendar — it just renders
// empty / no-op instead.

import { fetchWithAuth } from "./fetchWithAuth";

import type { ListResult } from "./projects";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** A meeting as the calendar needs it — flattened across project + schedule. */
export type CalMeeting = {
  id: string;
  title: string | null;
  status: string | null;
  scheduled_at: string | null;
  created_at: number;
  project_id: string;
  project_name: string | null;
  created_by: string | null;
  /** Who scheduled it (lower-cased email) — gates the Edit affordance. */
  organizer_email: string | null;
  duration_min: number | null;
  /** User-assigned accent colour (hex). When set, the calendar event uses
   *  it instead of the status palette so card + calendar colours match. */
  color?: string | null;
  /** User-assigned icon (emoji/id) — same cosmetic class as `color`. */
  icon?: string | null;
  /** 1 when I'm a direct (non-revoked) invitee — drives the live-invite
   *  nudge; project-member visibility alone doesn't count as an invite. */
  invited_direct?: number;
  /** 1 when I already joined this meeting at least once (participant row). */
  attended?: number;
  /** My RSVP state ('invited'|'accepted'|'declined') — NULL when I'm not a
   *  direct invitee. */
  my_invite_status?: string | null;
  /** When I was invited / when I first joined (ms) — personal timestamps
   *  for the dashboard activity log. */
  my_invited_at?: number | null;
  my_joined_at?: number | null;
  /** 1 when this meeting has a PUBLISHED recap package — drives the card's
   *  "Recap" badge. SQLite EXISTS returns 0/1; absent on older payloads. */
  has_recap?: number;
};

/** Every meeting the current user can see, for placement on the calendar.
 *  Checked variant: `ok: false` = worker unreachable / errored, so the
 *  caller can show "couldn't load" instead of a lying empty calendar. */
export const getMyMeetingsChecked = async (): Promise<
  ListResult<CalMeeting>
> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/meetings`);
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, items: (await res.json()).meetings ?? [] };
  } catch {
    return { ok: false };
  }
};

export const getMyMeetings = async (): Promise<CalMeeting[]> => {
  const r = await getMyMeetingsChecked();
  return r.ok ? r.items : [];
};

// ---------------------------------------------------------------------
// Shared lobby poller
// ---------------------------------------------------------------------
// Three lobby widgets (NotificationBell, MeetingDueNotice, ActivityLog)
// all need the SAME `/v1/me/meetings` list on the SAME 60s cadence. Left
// alone they each own a setInterval and hit the route independently — 3×
// the traffic for identical data (and a quota cap-breaker once the org
// grows). This module-level store runs ONE poll for all subscribers,
// dedups concurrent fetches, and pushes the latest list to every reader.
// Mirrors the subscribe/inflight pattern in data/translation.ts.

const LOBBY_POLL_MS = 60 * 1000;

type LobbySubscriber = (meetings: CalMeeting[]) => void;
const lobbySubscribers = new Set<LobbySubscriber>();
let lobbyLatest: CalMeeting[] = [];
let lobbyTimer: number | null = null;
let lobbyInflight: Promise<void> | null = null;

const runLobbyPoll = (): Promise<void> => {
  // Dedup: a poll already in flight serves every caller that arrives
  // before it resolves (e.g. several widgets mounting at once).
  if (lobbyInflight) {
    return lobbyInflight;
  }
  lobbyInflight = (async () => {
    const r = await getMyMeetingsChecked();
    // Keep the last-known list on a transient error — a flaky poll
    // shouldn't blank every widget for a minute.
    if (r.ok) {
      lobbyLatest = r.items;
      for (const s of lobbySubscribers) {
        s(lobbyLatest);
      }
    }
  })().finally(() => {
    lobbyInflight = null;
  });
  return lobbyInflight;
};

/**
 * Subscribe to the shared lobby meeting list. The callback fires once
 * with the current list as soon as it's available, then on every 60s
 * poll. Returns an unsubscribe fn; polling stops when the last
 * subscriber leaves. `refresh()` forces an immediate (deduped) re-poll.
 */
export const subscribeLobbyMeetings = (
  cb: LobbySubscriber,
): { unsubscribe: () => void; refresh: () => Promise<void> } => {
  lobbySubscribers.add(cb);

  // Start the interval on the first subscriber.
  if (lobbyTimer === null && typeof window !== "undefined") {
    lobbyTimer = window.setInterval(() => void runLobbyPoll(), LOBBY_POLL_MS);
  }

  // Hand the new subscriber the cached list immediately (if any), then
  // kick a fresh poll so it isn't waiting up to 60s for first data.
  if (lobbyLatest.length > 0) {
    cb(lobbyLatest);
  }
  void runLobbyPoll();

  return {
    unsubscribe: () => {
      lobbySubscribers.delete(cb);
      if (lobbySubscribers.size === 0 && lobbyTimer !== null) {
        window.clearInterval(lobbyTimer);
        lobbyTimer = null;
        // Drop the cache so a later sign-in starts clean rather than
        // flashing the previous user's meetings.
        lobbyLatest = [];
      }
    },
    refresh: runLobbyPoll,
  };
};

/** Free-text note scoped to a day (YYYY-MM-DD) or a meeting (roomId). Returns
 *  the note body, or "" on a miss / error (loud-quiet: never throws). */
export const getNote = async (
  scope: "day" | "meeting",
  ref: string,
): Promise<string> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/notes?scope=${encodeURIComponent(
        scope,
      )}&ref=${encodeURIComponent(ref)}`,
    );
    return res.ok ? (await res.json()).body ?? "" : "";
  } catch {
    return "";
  }
};

/** Upsert a day/meeting note. Returns whether the save succeeded. */
export const saveNote = async (
  scope: "day" | "meeting",
  ref: string,
  body: string,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ref, body }),
    });
    return res.ok;
  } catch {
    return false;
  }
};
