// CalendarX — drop-in replacement for CalendarView built on the Schedule-X
// calendar library (https://schedule-x.dev), v2.x (string-date API, React 19
// compatible). Same props as CalendarView so swapping is a one-line change.
//
// What it does that the hand-rolled CalendarView did:
//   • Month / Week / Day (+ month-agenda) views with a built-in view switcher.
//   • Color-marks each meeting by status via Schedule-X "calendars"
//     (scheduled = blue, in-progress = green, completed = gray, cancelled = red).
//   • Clicking an event opens the meeting; clicking an empty day/slot creates
//     a meeting on that day (default 09:00) — matching the old affordances.
//   • Keeps the NOTES feature: a textarea below the calendar bound to the
//     focused day, loading getNote("day", …) and saving via saveNote
//     (blur + 700ms debounce) — identical behaviour to CalendarView's DayNotes.
//   • Syncs Schedule-X's light/dark theme to the app theme.
//
// Why Schedule-X v2 (not v3): v2 takes plain "YYYY-MM-DD HH:mm" strings for
// event start/end and string dates in callbacks, and its peerDependencies
// allow React 19. v3 switched to Temporal.* objects (needs a polyfill) — more
// friction for no benefit here.

import { THEME } from "@excalidraw/excalidraw";
import {
  createViewDay,
  createViewMonthAgenda,
  createViewMonthGrid,
  createViewWeek,
} from "@schedule-x/calendar";
import { createEventsServicePlugin } from "@schedule-x/events-service";
import { ScheduleXCalendar, useCalendarApp } from "@schedule-x/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import "@schedule-x/theme-default/dist/index.css";

import { useAtomValue } from "../../app-jotai";
import {
  getMyMeetings,
  getNote,
  saveNote,
  type CalMeeting,
} from "../../data/calendar";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";
import { appThemeAtom } from "../../useHandleAppTheme";

import type { CalendarEventExternal, CalendarType } from "@schedule-x/calendar";

// ---------------------------------------------------------------------------
// Status → calendar (colour) mapping. Schedule-X colours events by their
// `calendarId`, which must match a key in the `calendars` config below.
// ---------------------------------------------------------------------------

type StatusCalendarId =
  | "scheduled"
  | "in-progress"
  | "completed"
  | "cancelled";

/** Map a free-form worker status string to one of four colour buckets. */
const statusCalendarId = (status: string | null): StatusCalendarId => {
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

/** The colour palette for each status bucket (light + dark variants). These
 *  are the "colours by meeting status" the owner asked for. */
const CALENDARS: Record<StatusCalendarId, CalendarType> = {
  scheduled: {
    colorName: "scheduled",
    lightColors: { main: "#1c7df9", container: "#d2e7ff", onContainer: "#002859" },
    darkColors: { main: "#7db4ff", container: "#19315a", onContainer: "#dee9ff" },
  },
  "in-progress": {
    colorName: "in-progress",
    lightColors: { main: "#16a34a", container: "#caf1d8", onContainer: "#012d16" },
    darkColors: { main: "#67e0a3", container: "#0f3d28", onContainer: "#daf6e6" },
  },
  completed: {
    colorName: "completed",
    lightColors: { main: "#64748b", container: "#e2e8f0", onContainer: "#1e293b" },
    darkColors: { main: "#9aa7b8", container: "#2b3442", onContainer: "#e6ebf2" },
  },
  cancelled: {
    colorName: "cancelled",
    lightColors: { main: "#ef4444", container: "#ffd5d5", onContainer: "#4c0000" },
    darkColors: { main: "#ff9b9b", container: "#4a1a1a", onContainer: "#ffe2e2" },
  },
};

// ---------------------------------------------------------------------------
// Date helpers — Schedule-X v2 wants LOCAL "YYYY-MM-DD HH:mm" strings. We build
// them from local Date parts (NOT toISOString, which would shift to UTC and can
// land the meeting on the wrong day).
// ---------------------------------------------------------------------------

const pad = (n: number): string => `${n}`.padStart(2, "0");

/** Local "YYYY-MM-DD" for a Date. */
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local "YYYY-MM-DD HH:mm" for a Date (Schedule-X timed-event format). */
const dateTimeKey = (d: Date): string =>
  `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Where a meeting sits: scheduled_at if set, else created_at. */
const meetingDate = (m: CalMeeting): Date =>
  m.scheduled_at ? new Date(m.scheduled_at) : new Date(m.created_at);

/** Map one CalMeeting → a Schedule-X event. end = start + duration (default
 *  60 min). Events are colour-coded through `calendarId`. */
const toEvent = (m: CalMeeting): CalendarEventExternal => {
  const start = meetingDate(m);
  const durationMin = m.duration_min && m.duration_min > 0 ? m.duration_min : 60;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return {
    id: m.id,
    title: m.title ?? m.id,
    start: dateTimeKey(start),
    end: dateTimeKey(end),
    calendarId: statusCalendarId(m.status),
  };
};

/** Resolve the app theme atom (which may be "system") to a concrete dark flag. */
const useIsDark = (): boolean => {
  const appTheme = useAtomValue(appThemeAtom);
  return useMemo(() => {
    if (appTheme === "system") {
      return Boolean(
        typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-color-scheme: dark)").matches,
      );
    }
    return appTheme === THEME.DARK;
  }, [appTheme]);
};

/** MCM lang (vi/en/ko) → a BCP-47 locale Schedule-X understands. */
const LOCALE_MAP: Record<string, string> = {
  vi: "vi-VN",
  en: "en-US",
  ko: "ko-KR",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Inline Schedule-X calendar of the user's meetings, colour-marked by status,
 *  with a per-day notes panel underneath. Same props as CalendarView. */
export const CalendarX = ({
  onCreateOnDay,
  onOpenMeeting,
  // onJoinMeeting is part of the shared prop contract; Schedule-X opens the
  // meeting detail on event click (join lives inside the detail), so it is not
  // wired to a calendar gesture here — kept for signature parity.
  onJoinMeeting: _onJoinMeeting,
  meetings: externalMeetings,
}: {
  onCreateOnDay: (dateISO: string) => void;
  onOpenMeeting: (roomId: string) => void;
  onJoinMeeting: (roomId: string) => void;
  /** When provided (e.g. by the split view), use these instead of self-fetching
   *  so the list + calendar share one fetch. */
  meetings?: CalMeeting[];
}) => {
  const lang = useAtomValue(preferredLanguageAtom);
  const isDark = useIsDark();

  const [localMeetings, setLocalMeetings] = useState<CalMeeting[]>([]);
  const meetings = externalMeetings ?? localMeetings;

  // The day the notes panel is bound to. Starts on today; follows the
  // calendar's selected date as the user navigates / clicks.
  const [focusedDay, setFocusedDay] = useState<string>(() => dayKey(new Date()));

  // Self-fetch when the parent didn't hand us a list.
  useEffect(() => {
    if (!externalMeetings) {
      void getMyMeetings().then(setLocalMeetings);
    }
  }, [externalMeetings]);

  // Stable refs so the (memoised-at-creation) Schedule-X callbacks always see
  // the latest handlers without re-creating the calendar app.
  const onCreateRef = useRef(onCreateOnDay);
  const onOpenRef = useRef(onOpenMeeting);
  onCreateRef.current = onCreateOnDay;
  onOpenRef.current = onOpenMeeting;

  // Events service plugin — created once; we push the live event list through
  // it via .set() whenever `meetings` changes (see effect below).
  const eventsService = useState(() => createEventsServicePlugin())[0];

  const events = useMemo<CalendarEventExternal[]>(() => {
    return meetings
      .filter((m) => !Number.isNaN(meetingDate(m).getTime()))
      .map(toEvent);
  }, [meetings]);

  const calendar = useCalendarApp(
    {
      views: [
        createViewMonthGrid(),
        createViewWeek(),
        createViewDay(),
        createViewMonthAgenda(),
      ],
      defaultView: createViewMonthGrid().name,
      events,
      calendars: CALENDARS,
      isDark,
      locale: LOCALE_MAP[lang] ?? "en-US",
      selectedDate: dayKey(new Date()),
      callbacks: {
        // Open the meeting detail when an event pill is clicked.
        onEventClick: (event) => {
          onOpenRef.current(String(event.id));
        },
        // Month view: clicking a day → create a meeting on it (default 09:00).
        onClickDate: (date) => {
          setFocusedDay(date);
          onCreateRef.current(`${date}T09:00`);
        },
        // Week/Day view: clicking a time slot → create at that day, 09:00.
        onClickDateTime: (dateTime) => {
          const date = dateTime.slice(0, 10);
          setFocusedDay(date);
          onCreateRef.current(`${date}T09:00`);
        },
        // Navigating / selecting a date (without creating) re-points the notes.
        onSelectedDateUpdate: (date) => {
          setFocusedDay(date.slice(0, 10));
        },
        // Month-agenda day click → just focus the notes for that day.
        onClickAgendaDate: (date) => {
          setFocusedDay(date.slice(0, 10));
        },
      },
    },
    [eventsService],
  );

  // Keep Schedule-X's events in sync with our meeting list. Seeding via config
  // covers first render; this covers later fetches / prop updates.
  useEffect(() => {
    if (calendar) {
      eventsService.set(events);
    }
  }, [calendar, eventsService, events]);

  // Sync the calendar theme with the app theme on toggle.
  useEffect(() => {
    calendar?.setTheme(isDark ? "dark" : "light");
  }, [calendar, isDark]);

  return (
    <div className="mcm-cal mcm-calx">
      <div className="mcm-calx__cal">
        <ScheduleXCalendar calendarApp={calendar} />
      </div>
      <DayNotes dayKeyStr={focusedDay} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Notes — same editor + behaviour as CalendarView: loads getNote("day", key)
// on key change, saves via saveNote on blur and a 700ms debounce. Resilient:
// a failed load/save just leaves the textarea usable.
// ---------------------------------------------------------------------------

const DayNotes = ({ dayKeyStr }: { dayKeyStr: string }) => {
  const t = useT();
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef("");

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void getNote("day", dayKeyStr).then((body) => {
      if (alive) {
        setValue(body);
        savedRef.current = body;
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [dayKeyStr]);

  const flush = useCallback(
    (next: string) => {
      if (next === savedRef.current) {
        return;
      }
      savedRef.current = next;
      void saveNote("day", dayKeyStr, next);
    },
    [dayKeyStr],
  );

  const onChange = (next: string) => {
    setValue(next);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => flush(next), 700);
  };

  const onBlur = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    flush(value);
  };

  return (
    <label className="mcm-cal__notes mcm-calx__notes">
      <span className="mcm-cal__notes-label">
        {t("cal.notes")} · {dayKeyStr}
      </span>
      <textarea
        className="mcm-cal__notes-area"
        rows={4}
        value={value}
        disabled={!loaded}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </label>
  );
};

export default CalendarX;
