// Shared meeting-colour model — one source of truth for both the meeting
// cards (ProjectBrowser) and the calendar (CalendarX) so a meeting's stripe
// and its calendar event always agree.
//
// A meeting's effective colour is: `meeting.color` (user-assigned hex) when
// set, else the colour of its status bucket. Keep this in sync with the
// `.mcm-folder__card-status--*` / CalendarX `CALENDARS` palettes.

/** The four status buckets we colour by. */
export type StatusBucket =
  | "scheduled"
  | "in-progress"
  | "completed"
  | "cancelled";

/** Map a free-form worker status string to one of four buckets. Mirrors the
 *  logic in CalendarX so cards + calendar classify identically. */
export const statusBucket = (
  status: string | null | undefined,
): StatusBucket => {
  const s = (status ?? "").toLowerCase();
  if (s === "in progress" || s === "in_progress" || s === "live") {
    return "in-progress";
  }
  if (s === "completed" || s === "done") {
    return "completed";
  }
  if (s === "cancelled" || s === "canceled") {
    return "cancelled";
  }
  return "scheduled";
};

/** Solid accent hex per status bucket (light-mode "main" colours — they read
 *  fine on the card stripe in both themes). */
export const STATUS_COLOR: Record<StatusBucket, string> = {
  scheduled: "#1c7df9",
  "in-progress": "#16a34a",
  completed: "#64748b",
  cancelled: "#ef4444",
};

/** The ~6 preset swatches offered when a user colours a meeting. Chosen to be
 *  distinct and calm (Apple/Notion-ish), one per common intent. */
export const MEETING_COLOR_PRESETS: readonly string[] = [
  "#6965db", // brand purple
  "#1c7df9", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#ef4444", // red
  "#64748b", // slate
] as const;

/** Resolve a meeting's effective stripe/event colour: explicit colour wins,
 *  else the status colour. */
export const meetingColor = (
  color: string | null | undefined,
  status: string | null | undefined,
): string => color || STATUS_COLOR[statusBucket(status)];
