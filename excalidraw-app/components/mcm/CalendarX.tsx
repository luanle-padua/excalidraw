// CalendarX — drop-in replacement for CalendarView built on the Schedule-X
// calendar library (https://schedule-x.dev), v2.x (string-date API, React 19
// compatible). Same props as CalendarView so swapping is a one-line change.
//
// What it does that the hand-rolled CalendarView did:
//   • Month / Week / Day (+ month-agenda) views with a built-in view switcher.
//   • Colour-marks each meeting by its EFFECTIVE colour — the exact hex its card
//     stripe uses: meetingColor(m.color, m.status) (assigned colour wins, else
//     the status colour). Derived from STATUS_COLOR in meetingColors.ts, the one
//     source of truth shared with the cards, so card ↔ calendar always agree.
//   • Clicking an event opens the meeting; clicking an empty day/slot creates
//     a meeting on that day (default 09:00) — matching the old affordances.
//   • Keeps the NOTES feature: a textarea below the calendar bound to the
//     focused day, loading getNote("day", …) and saving via saveNote
//     (blur + 700ms debounce) — identical behaviour to CalendarView's DayNotes.
//   • Syncs Schedule-X's light/dark theme to the app theme.
//   • Korean red-calendar: Sundays + public holidays render the date in RED,
//     Saturdays in BLUE, with the holiday name in the cell. Holidays are fetched
//     on demand per visible year from a free API (see holidaysApi.ts) — never
//     hard-coded — and re-fetched as the user navigates across years.
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
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

import { getKoreanHolidays, type HolidayMap } from "./holidaysApi";
import {
  MEETING_COLOR_PRESETS,
  meetingColor,
  STATUS_COLOR,
} from "./meetingColors";

import "./CalendarX.scss";

import type { CalendarEventExternal, CalendarType } from "@schedule-x/calendar";

// ---------------------------------------------------------------------------
// Colour → Schedule-X "calendar". Schedule-X colours an event by its
// `calendarId`, which must match a key in the `calendars` config. We want every
// event painted EXACTLY meetingColor(m.color, m.status) — the same hex the card
// stripe uses — so we register one calendar per distinct EFFECTIVE hex (status
// colours come straight from STATUS_COLOR, the shared source of truth) and map
// each meeting to the calendar for its effective hex.
// ---------------------------------------------------------------------------

/** A Schedule-X calendarId for a hex colour. One "calendar" is registered per
 *  distinct effective hex (see effectiveCalendars) so the event paints in that
 *  exact colour — keeping card + calendar in sync. Sanitised to the [a-f0-9]
 *  an id needs. */
const colorCalendarId = (hex: string): string =>
  `c-${hex.replace(/[^a-fA-F0-9]/g, "").toLowerCase()}`;

/** Build a Schedule-X `CalendarType` from an arbitrary hex. We derive soft
 *  container tints from the base colour with `color-mix` so events read
 *  consistently in both themes while the pill/accent stays the exact hex. */
const calendarForColor = (hex: string): CalendarType => ({
  colorName: colorCalendarId(hex),
  lightColors: {
    main: hex,
    container: `color-mix(in srgb, ${hex} 20%, #ffffff)`,
    onContainer: `color-mix(in srgb, ${hex} 64%, #000000)`,
  },
  darkColors: {
    main: hex,
    container: `color-mix(in srgb, ${hex} 30%, #1b1b1f)`,
    onContainer: `color-mix(in srgb, ${hex} 32%, #ffffff)`,
  },
});

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

/** The effective colour for a meeting — the EXACT hex its card stripe paints.
 *  Single source of truth: meetingColor() over STATUS_COLOR. */
const effectiveColor = (m: CalMeeting): string =>
  meetingColor(m.color, m.status);

/** Map one CalMeeting → a Schedule-X event. end = start + duration (default
 *  60 min). Colour: the meeting's effective hex via its colour-calendar. */
const toEvent = (m: CalMeeting): CalendarEventExternal => {
  const start = meetingDate(m);
  const durationMin =
    m.duration_min && m.duration_min > 0 ? m.duration_min : 60;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return {
    id: m.id,
    title: m.title ?? m.id,
    start: dateTimeKey(start),
    end: dateTimeKey(end),
    calendarId: colorCalendarId(effectiveColor(m)),
  };
};

/** The four status colours, pre-registered as calendars so even meetings whose
 *  effective colour equals a status colour resolve to a stable id. Built once
 *  from STATUS_COLOR. */
const STATUS_CALENDARS: Record<string, CalendarType> = Object.fromEntries(
  Object.values(STATUS_COLOR).map((hex) => [
    colorCalendarId(hex),
    calendarForColor(hex),
  ]),
);

/** Every colour a meeting can paint with — the 4 status colours + the 6 user
 *  presets — pre-registered ONCE so the Schedule-X app is created with a static
 *  `calendars` set (no per-meeting rebuild). Any assigned preset colour is
 *  therefore already registered and the event matches the card stripe exactly. */
const ALL_CALENDARS: Record<string, CalendarType> = {
  ...STATUS_CALENDARS,
  ...Object.fromEntries(
    MEETING_COLOR_PRESETS.map((hex) => [
      colorCalendarId(hex),
      calendarForColor(hex),
    ]),
  ),
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

/** Inline Schedule-X calendar of the user's meetings, colour-marked to match
 *  each card's stripe, with Korean weekend/holiday tinting and a per-day notes
 *  panel underneath. Same props as CalendarView. */
export const CalendarX = ({
  onCreateOnDay,
  onOpenMeeting,
  // onJoinMeeting is part of the shared prop contract; Schedule-X opens the
  // meeting detail on event click (join lives inside the detail), so it is not
  // wired to a calendar gesture here — kept for signature parity.
  onJoinMeeting: _onJoinMeeting,
  meetings: externalMeetings,
  refreshKey,
}: {
  onCreateOnDay: (dateISO: string) => void;
  onOpenMeeting: (roomId: string) => void;
  onJoinMeeting: (roomId: string) => void;
  /** When provided (e.g. by the split view), use these instead of self-fetching
   *  so the list + calendar share one fetch. */
  meetings?: CalMeeting[];
  /** Bump to force a self-fetch refresh (e.g. after a colour change). */
  refreshKey?: number;
}) => {
  const lang = useAtomValue(preferredLanguageAtom);
  const isDark = useIsDark();

  const [localMeetings, setLocalMeetings] = useState<CalMeeting[]>([]);
  const meetings = externalMeetings ?? localMeetings;

  // The day the notes panel is bound to. Starts on today; follows the
  // calendar's selected date as the user navigates / clicks.
  const [focusedDay, setFocusedDay] = useState<string>(() =>
    dayKey(new Date()),
  );

  // Korean public holidays for the years the user has navigated to. Fetched on
  // demand per visible year (holidaysApi caches + fails gracefully), merged
  // here, and read by the month-grid date cell via a ref so the (stable) custom
  // component always sees the freshest map without rebuilding the calendar.
  const [holidays, setHolidays] = useState<HolidayMap>(() => new Map());
  const holidaysRef = useRef<HolidayMap>(holidays);
  holidaysRef.current = holidays;
  const loadedYears = useRef<Set<number>>(new Set());

  const ensureHolidaysForYear = useCallback((year: number) => {
    if (loadedYears.current.has(year) || !Number.isFinite(year)) {
      return;
    }
    loadedYears.current.add(year);
    void getKoreanHolidays(year).then((map) => {
      if (map.size === 0) {
        return;
      }
      setHolidays((prev) => {
        const next = new Map(prev);
        for (const [k, v] of map) {
          next.set(k, v);
        }
        return next;
      });
    });
  }, []);

  // Prime the current year up front so today's grid is tinted on first paint.
  useEffect(() => {
    ensureHolidaysForYear(new Date().getFullYear());
  }, [ensureHolidaysForYear]);

  // Self-fetch when the parent didn't hand us a list; re-fetch when refreshKey
  // bumps (e.g. a meeting colour was assigned) so event colours stay in sync.
  useEffect(() => {
    if (!externalMeetings) {
      void getMyMeetings().then(setLocalMeetings);
    }
  }, [externalMeetings, refreshKey]);

  // Stable refs so the (memoised-at-creation) Schedule-X callbacks always see
  // the latest handlers without re-creating the calendar app.
  const onCreateRef = useRef(onCreateOnDay);
  const onOpenRef = useRef(onOpenMeeting);
  onCreateRef.current = onCreateOnDay;
  onOpenRef.current = onOpenMeeting;

  // Events service plugin — created once, REGISTERED in `plugins` below; we push
  // the live event list through it via .set() whenever `meetings` changes.
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
      calendars: ALL_CALENDARS,
      plugins: [eventsService],
      isDark,
      locale: LOCALE_MAP[lang] ?? "en-US",
      selectedDate: dayKey(new Date()),
      callbacks: {
        // Open the meeting detail when an event pill is clicked.
        onEventClick: (event) => {
          onOpenRef.current(String(event.id));
        },
        // Clicking a day FOCUSES it — the day panel below then shows that day's
        // meetings + notes, with a "+" to create (no longer create-on-click).
        onClickDate: (date) => {
          setFocusedDay(date);
        },
        onClickDateTime: (dateTime) => {
          setFocusedDay(dateTime.slice(0, 10));
        },
        // Navigating / selecting a date (without creating) re-points the notes.
        onSelectedDateUpdate: (date) => {
          setFocusedDay(date.slice(0, 10));
        },
        // Month-agenda day click → just focus the notes for that day.
        onClickAgendaDate: (date) => {
          setFocusedDay(date.slice(0, 10));
        },
        // Whenever the visible range changes (navigation / view switch / first
        // render), make sure holidays for every year it spans are loaded so the
        // red/blue tinting is robust across month navigation and year edges.
        onRangeUpdate: (range) => {
          const startYear = Number(String(range.start).slice(0, 4));
          const endYear = Number(String(range.end).slice(0, 4));
          ensureHolidaysForYear(startYear);
          if (endYear !== startYear) {
            ensureHolidaysForYear(endYear);
          }
        },
      },
    },
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

  // Custom month-grid date cell: paint the day number per the Korean
  // red-calendar convention and surface the holiday name. Stable identity (no
  // deps) so it never forces a calendar rebuild; it reads the latest holidays
  // through holidaysRef. Schedule-X's prop shape varies by version, so we
  // forward whatever it passes and let the cell derive the date defensively.
  const customComponents = useMemo(
    () => ({
      monthGridDate: (props: Record<string, unknown>) => (
        <MonthGridDate {...props} holidaysRef={holidaysRef} />
      ),
    }),
    [],
  );

  return (
    <div className="mcm-cal mcm-calx">
      <div className="mcm-calx__cal">
        <ScheduleXCalendar
          calendarApp={calendar}
          customComponents={customComponents}
        />
      </div>
      <DayPanel
        dayKeyStr={focusedDay}
        meetings={meetings}
        lang={lang}
        onOpen={(id) => onOpenRef.current(id)}
        onCreate={() => onCreateRef.current(`${focusedDay}T09:00`)}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Day panel (below the calendar): the focused day's meetings + a notes box,
// with a floating "+" (bottom-right) to create a meeting on that day. Clicking
// a calendar day focuses it here rather than jumping straight into create.
// ---------------------------------------------------------------------------

const DayPanel = ({
  dayKeyStr,
  meetings,
  lang,
  onOpen,
  onCreate,
}: {
  dayKeyStr: string;
  meetings: CalMeeting[];
  lang: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) => {
  const t = useT();
  const dayMeetings = useMemo(
    () =>
      meetings
        .filter((m) => dayKey(meetingDate(m)) === dayKeyStr)
        .sort((a, b) => meetingDate(a).getTime() - meetingDate(b).getTime()),
    [meetings, dayKeyStr],
  );
  const [y, mo, d] = dayKeyStr.split("-").map(Number);
  const label = new Date(y, (mo || 1) - 1, d || 1).toLocaleDateString(lang, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mcm-calx__day">
      <div className="mcm-calx__day-head">{label}</div>
      <ul className="mcm-calx__day-list">
        {dayMeetings.length === 0 && (
          <li className="mcm-calx__day-empty">{t("cal.noMeetings")}</li>
        )}
        {dayMeetings.map((m) => {
          const md = meetingDate(m);
          return (
            <li key={m.id}>
              <button
                type="button"
                className="mcm-calx__day-item"
                onClick={() => onOpen(m.id)}
                style={
                  {
                    ["--mc" as string]: meetingColor(m.color, m.status),
                  } as React.CSSProperties
                }
              >
                <span className="mcm-calx__day-time">
                  {m.scheduled_at
                    ? md.toLocaleTimeString(lang, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </span>
                <span className="mcm-calx__day-title">{m.title || m.id}</span>
                {m.status && (
                  <span className="mcm-pill mcm-pill--scheduled mcm-calx__day-status">
                    {m.status}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <DayNotes dayKeyStr={dayKeyStr} />
      <button
        type="button"
        className="mcm-calx__fab"
        onClick={onCreate}
        title={t("cal.createOnDay")}
        aria-label={t("cal.createOnDay")}
      >
        <Plus size={20} />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Month-grid date cell — Korean red-calendar tinting.
//   • Sunday (getDay() === 0) or a public holiday → date in RED.
//   • Saturday (getDay() === 6)                   → date in BLUE.
//   • Holiday name shown beneath the number when present.
// Classes are styled in CalendarX.scss; data-attrs let CSS target the states
// without inline colour so light/dark both resolve via tokens.
// ---------------------------------------------------------------------------

const MonthGridDate = ({
  date,
  jsDate,
  holidaysRef,
}: {
  date?: unknown;
  jsDate?: unknown;
  holidaysRef: React.MutableRefObject<HolidayMap>;
}) => {
  // Schedule-X's prop shape varies by version — it may hand us a "YYYY-MM-DD"
  // string, a Date in `date`, or a Date in `jsDate`. Derive a concrete local
  // Date defensively (never assume `date` is a string → no `.split` crash).
  const jd =
    jsDate instanceof Date
      ? jsDate
      : date instanceof Date
      ? date
      : typeof date === "string"
      ? (() => {
          const [y, m, d] = date.slice(0, 10).split("-").map(Number);
          return new Date(y, (m || 1) - 1, d || 1);
        })()
      : null;

  if (!jd || Number.isNaN(jd.getTime())) {
    return (
      <div className="mcm-calx__date">
        <span className="mcm-calx__date-num">
          {typeof date === "number" || typeof date === "string"
            ? String(date)
            : ""}
        </span>
      </div>
    );
  }

  const weekday = jd.getDay();
  const name = holidaysRef.current.get(dayKey(jd));
  const tone =
    name || weekday === 0 ? "holiday" : weekday === 6 ? "saturday" : "weekday";

  return (
    <div className="mcm-calx__date" data-tone={tone}>
      <span className="mcm-calx__date-num">{jd.getDate()}</span>
      {name ? (
        <span className="mcm-calx__date-holiday" title={name}>
          {name}
        </span>
      ) : null}
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
