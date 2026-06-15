// Canonical meeting lifecycle — ONE status vocabulary for DB + UI
// (docs/specs/host-and-scheduling.md state machine):
//
//   scheduled ──(host/acting-host Starts)──> live ──(End for all)──> finished
//       └───────────(organizer cancels)────────────────────────────> cancelled
//
// The DB historically held capitalized variants ("Scheduled", "In progress",
// "Completed", "Cancelled") — migration 0013 rewrites them, and
// `normalizeMeetingStatus` keeps READS tolerant of any stragglers (old
// exports, free-text edits). WRITES must always use the canonical values.

export type MeetingStatus = "scheduled" | "live" | "finished" | "cancelled";

export const MEETING_STATUSES: readonly MeetingStatus[] = [
  "scheduled",
  "live",
  "finished",
  "cancelled",
];

/** Map any historical/free-form status string onto the canonical set.
 *  Returns null for empty or unrecognized values (e.g. an unregistered
 *  ad-hoc room with no status row). */
export const normalizeMeetingStatus = (
  status: string | null | undefined,
): MeetingStatus | null => {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) {
    return null;
  }
  if (s === "live" || s === "in progress" || s === "in_progress") {
    return "live";
  }
  if (s === "finished" || s === "completed" || s === "done") {
    return "finished";
  }
  if (s === "cancelled" || s === "canceled") {
    return "cancelled";
  }
  if (s === "scheduled") {
    return "scheduled";
  }
  return null;
};

/** Terminal states — the meeting opens as immutable read-only review. */
export const isFinishedStatus = (
  status: string | null | undefined,
): boolean => {
  const n = normalizeMeetingStatus(status);
  return n === "finished" || n === "cancelled";
};

/** Who may edit a meeting (content, schedule, invitees, co-host). The ORGANIZER
 *  owns it, AND — anh Luân 06-15 — anyone with PROJECT authority over it (the
 *  project leader / co-operator / division head / deputy / admin), so a head can
 *  set a co-host on a meeting a co-operator created. Legacy meetings predating
 *  organizer_email fall back to internal-allow. The server re-checks all of this
 *  (PATCH gate = organizer OR project authority). */
export const canManageMeeting = (
  myEmail: string | null | undefined,
  organizerEmail: string | null | undefined,
  isInternal: boolean,
  isAuthority = false,
): boolean => {
  if (!myEmail) {
    return false;
  }
  if (isAuthority) {
    return true;
  }
  return organizerEmail
    ? organizerEmail.toLowerCase() === myEmail.toLowerCase()
    : isInternal;
};

/** Which states still take edits. `scheduled` = full edit · `live` = content
 *  + invitees (the schedule fields are moot mid-meeting) · `finished` and
 *  `cancelled` take NONE (immutable / restore-first — worker-enforced).
 *  null = legacy/ad-hoc rows, treated like live. */
export const isEditableMeetingStatus = (
  status: string | null | undefined,
): boolean => {
  const n = normalizeMeetingStatus(status);
  return n === null || n === "scheduled" || n === "live";
};

/** Human label for a status pill. Canonical values come from i18n
 *  (`status.*`); anything unrecognized falls through verbatim so legacy
 *  free-text never renders blank. The param type is the narrow key set so
 *  the McmKey-typed `t` from useT() is assignable (contravariance). */
export const meetingStatusLabel = (
  t: (key: `status.${MeetingStatus}`) => string,
  status: string | null | undefined,
): string => {
  const n = normalizeMeetingStatus(status);
  return n ? t(`status.${n}`) : status ?? "";
};
