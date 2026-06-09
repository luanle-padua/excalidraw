import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  getMyMeetings,
  getNote,
  saveNote,
  type CalMeeting,
} from "../../data/calendar";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

// ---------------------------------------------------------------------------
// Pure date helpers — JS Date built-ins only, no libraries. Weeks start Monday.
// We work in LOCAL time so a meeting lands on the day the user sees on the wall
// clock (toISOString would push it to UTC and can shift the date by a day).
// ---------------------------------------------------------------------------

/** Local "YYYY-MM-DD" key for a Date (NOT UTC — see note above). */
const dayKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** "HH:mm" local time, or "" for an all-day / unscheduled meeting. */
const fmtTime = (d: Date, lang: string): string =>
  d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

/** Mon=0 … Sun=6 (JS getDay is Sun=0). */
const isoWeekday = (d: Date): number => (d.getDay() + 6) % 7;

const startOfMonth = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), 1);

const addMonths = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth() + n, 1);

const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The 6×7 grid of Dates covering the month, padded to whole Monday-weeks. */
const buildMonthGrid = (anchor: Date): Date[] => {
  const first = startOfMonth(anchor);
  const gridStart = addDays(first, -isoWeekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
};

/** Where a meeting sits on the calendar: scheduled_at if set, else created_at. */
const meetingDate = (m: CalMeeting): Date =>
  m.scheduled_at ? new Date(m.scheduled_at) : new Date(m.created_at);

type StatusKind = "scheduled" | "live" | "muted";

/** Map a free-form worker status string to one of three pill colours. */
const statusKind = (status: string | null): StatusKind => {
  const s = (status ?? "").toLowerCase();
  if (s === "in progress" || s === "in_progress" || s === "live") {
    return "live";
  }
  if (s === "completed" || s === "cancelled" || s === "canceled") {
    return "muted";
  }
  return "scheduled";
};

type View = "month" | "day";

/** Inline (non-modal) calendar of the user's meetings: a Month grid and a Day
 *  agenda, with per-day and per-meeting notes. Rendered as a plain <div>. */
export const CalendarView = ({
  onCreateOnDay,
  onOpenMeeting,
  onJoinMeeting,
  meetings: externalMeetings,
}: {
  onCreateOnDay: (dateISO: string) => void;
  onOpenMeeting: (roomId: string) => void;
  onJoinMeeting: (roomId: string) => void;
  /** When provided (e.g. by the split view), use these instead of self-fetching
   *  so the list + calendar share one fetch. */
  meetings?: CalMeeting[];
}) => {
  const t = useT();
  const lang = useAtomValue(preferredLanguageAtom);
  const [localMeetings, setLocalMeetings] = useState<CalMeeting[]>([]);
  const meetings = externalMeetings ?? localMeetings;
  const [view, setView] = useState<View>("month");
  // `cursor` = the month being shown; `selected` = the focused day.
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState<Date>(() => new Date());

  useEffect(() => {
    if (!externalMeetings) {
      void getMyMeetings().then(setLocalMeetings);
    }
  }, [externalMeetings]);

  // Group meetings by local day key once — both views read from this.
  const byDay = useMemo(() => {
    const map = new Map<string, CalMeeting[]>();
    for (const m of meetings) {
      const d = meetingDate(m);
      if (Number.isNaN(d.getTime())) {
        continue;
      }
      const key = dayKey(d);
      const arr = map.get(key);
      if (arr) {
        arr.push(m);
      } else {
        map.set(key, [m]);
      }
    }
    // Sort each day's meetings by time so pills/agenda read top-to-bottom.
    for (const arr of map.values()) {
      arr.sort((a, b) => meetingDate(a).getTime() - meetingDate(b).getTime());
    }
    return map;
  }, [meetings]);

  const today = useMemo(() => new Date(), []);
  const grid = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const goToday = () => {
    const now = new Date();
    setCursor(startOfMonth(now));
    setSelected(now);
  };

  const pickDay = (d: Date) => {
    setSelected(d);
    if (!sameDay(startOfMonth(d), cursor)) {
      setCursor(startOfMonth(d));
    }
    setView("day");
  };

  const monthLabel = cursor.toLocaleDateString(lang, {
    month: "long",
    year: "numeric",
  });

  // Localized Monday-first weekday headers (Mon…Sun) via a known Monday.
  const weekdayLabels = useMemo(() => {
    const monday = new Date(2024, 0, 1); // 2024-01-01 is a Monday
    return Array.from({ length: 7 }, (_, i) =>
      addDays(monday, i).toLocaleDateString(lang, { weekday: "short" }),
    );
  }, [lang]);

  return (
    <div className="mcm-cal">
      <header className="mcm-cal__bar">
        <div className="mcm-cal__nav">
          <button
            type="button"
            className="mcm-cal__nav-btn"
            onClick={() => setCursor((c) => addMonths(c, -1))}
            aria-label={`${t("cal.month")} ‹`}
          >
            <ChevronLeft size={18} />
          </button>
          <h2 className="mcm-cal__month">{monthLabel}</h2>
          <button
            type="button"
            className="mcm-cal__nav-btn"
            onClick={() => setCursor((c) => addMonths(c, 1))}
            aria-label={`${t("cal.month")} ›`}
          >
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            className="mcm-cal__today"
            onClick={goToday}
          >
            {t("cal.today")}
          </button>
        </div>

        <div className="mcm-cal__seg" role="tablist" aria-label={t("cal.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={view === "month"}
            className={`mcm-cal__seg-btn${
              view === "month" ? " --on" : ""
            }`}
            onClick={() => setView("month")}
          >
            {t("cal.month")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "day"}
            className={`mcm-cal__seg-btn${view === "day" ? " --on" : ""}`}
            onClick={() => setView("day")}
          >
            {t("cal.day")}
          </button>
        </div>
      </header>

      {view === "month" ? (
        <MonthGrid
          grid={grid}
          cursor={cursor}
          today={today}
          selected={selected}
          byDay={byDay}
          weekdayLabels={weekdayLabels}
          lang={lang}
          onPickDay={pickDay}
          onOpenMeeting={onOpenMeeting}
          onCreateOnDay={onCreateOnDay}
        />
      ) : (
        <DayAgenda
          day={selected}
          meetings={byDay.get(dayKey(selected)) ?? []}
          lang={lang}
          onOpenMeeting={onOpenMeeting}
          onJoinMeeting={onJoinMeeting}
          onCreateOnDay={onCreateOnDay}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------

const MAX_PILLS = 3;

const MonthGrid = ({
  grid,
  cursor,
  today,
  selected,
  byDay,
  weekdayLabels,
  lang,
  onPickDay,
  onOpenMeeting,
  onCreateOnDay,
}: {
  grid: Date[];
  cursor: Date;
  today: Date;
  selected: Date;
  byDay: Map<string, CalMeeting[]>;
  weekdayLabels: string[];
  lang: string;
  onPickDay: (d: Date) => void;
  onOpenMeeting: (roomId: string) => void;
  onCreateOnDay: (dateISO: string) => void;
}) => {
  const t = useT();
  return (
    <div className="mcm-cal__month-wrap">
      <div className="mcm-cal__weekdays">
        {weekdayLabels.map((w) => (
          <div key={w} className="mcm-cal__weekday">
            {w}
          </div>
        ))}
      </div>
      <div className="mcm-cal__grid">
        {grid.map((d) => {
          const key = dayKey(d);
          const dayMeetings = byDay.get(key) ?? [];
          const outside = d.getMonth() !== cursor.getMonth();
          const isToday = sameDay(d, today);
          const isSelected = sameDay(d, selected);
          const overflow = dayMeetings.length - MAX_PILLS;
          return (
            <div
              key={key}
              className={`mcm-cal__cell${outside ? " --outside" : ""}${
                isSelected ? " --selected" : ""
              }`}
              onClick={() => onPickDay(d)}
              role="gridcell"
            >
              <div className="mcm-cal__cell-head">
                <span
                  className={`mcm-cal__daynum${isToday ? " --today" : ""}`}
                >
                  {d.getDate()}
                </span>
                <button
                  type="button"
                  className="mcm-cal__cell-add"
                  aria-label={t("cal.createOnDay")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreateOnDay(`${key}T09:00`);
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
              <div className="mcm-cal__pills">
                {dayMeetings.slice(0, MAX_PILLS).map((m) => {
                  const md = meetingDate(m);
                  const kind = statusKind(m.status);
                  return (
                    <button
                      type="button"
                      key={m.id}
                      className={`mcm-cal__pill --${kind}`}
                      title={m.title ?? m.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenMeeting(m.id);
                      }}
                    >
                      {m.scheduled_at && (
                        <span className="mcm-cal__pill-time">
                          {fmtTime(md, lang)}
                        </span>
                      )}
                      <span className="mcm-cal__pill-title">
                        {m.title ?? m.id}
                      </span>
                    </button>
                  );
                })}
                {overflow > 0 && (
                  <button
                    type="button"
                    className="mcm-cal__more"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPickDay(d);
                    }}
                  >
                    {t("cal.more", { count: overflow })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

const DayAgenda = ({
  day,
  meetings,
  lang,
  onOpenMeeting,
  onJoinMeeting,
  onCreateOnDay,
}: {
  day: Date;
  meetings: CalMeeting[];
  lang: string;
  onOpenMeeting: (roomId: string) => void;
  onJoinMeeting: (roomId: string) => void;
  onCreateOnDay: (dateISO: string) => void;
}) => {
  const t = useT();
  const key = dayKey(day);
  const dayTitle = day.toLocaleDateString(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="mcm-cal__day">
      <div className="mcm-cal__day-head">
        <h3 className="mcm-cal__day-title">{dayTitle}</h3>
        <button
          type="button"
          className="mcm-cal__day-create"
          onClick={() => onCreateOnDay(`${key}T09:00`)}
        >
          {t("cal.createOnDay")}
        </button>
      </div>

      {meetings.length === 0 ? (
        <p className="mcm-cal__day-empty">{t("cal.noMeetings")}</p>
      ) : (
        <ul className="mcm-cal__agenda">
          {meetings.map((m) => (
            <AgendaRow
              key={m.id}
              meeting={m}
              lang={lang}
              onOpenMeeting={onOpenMeeting}
              onJoinMeeting={onJoinMeeting}
            />
          ))}
        </ul>
      )}

      <DayNotes dayKeyStr={key} />
    </div>
  );
};

const AgendaRow = ({
  meeting,
  lang,
  onOpenMeeting,
  onJoinMeeting,
}: {
  meeting: CalMeeting;
  lang: string;
  onOpenMeeting: (roomId: string) => void;
  onJoinMeeting: (roomId: string) => void;
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const md = meetingDate(meeting);
  const kind = statusKind(meeting.status);
  const time = meeting.scheduled_at ? fmtTime(md, lang) : "—";

  return (
    <li className={`mcm-cal__row --${kind}`}>
      <div className="mcm-cal__row-main">
        <span className="mcm-cal__row-time">{time}</span>
        <span className={`mcm-cal__row-dot --${kind}`} aria-hidden />
        <button
          type="button"
          className="mcm-cal__row-body"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="mcm-cal__row-title">
            {meeting.title ?? meeting.id}
          </span>
          <span className="mcm-cal__row-meta">
            {[meeting.project_name, meeting.status, meeting.created_by]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        <div className="mcm-cal__row-actions">
          <button
            type="button"
            className="mcm-cal__row-join"
            onClick={() => onJoinMeeting(meeting.id)}
          >
            {t("cal.join")}
          </button>
          <button
            type="button"
            className="mcm-cal__row-detail"
            onClick={() => onOpenMeeting(meeting.id)}
          >
            {t("cal.detail")}
          </button>
        </div>
      </div>
      {open && (
        <MeetingNotes roomId={meeting.id} />
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Notes — shared editor wired to a (scope, ref). Loads on ref change, saves on
// blur and on a 700ms debounce while typing. Self-contained & resilient: a
// failed load/save just leaves the textarea usable.
// ---------------------------------------------------------------------------

const NotesEditor = ({
  scope,
  refKey,
  label,
  rows,
}: {
  scope: "day" | "meeting";
  refKey: string;
  label: string;
  rows: number;
}) => {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track what's persisted so we don't fire redundant saves (e.g. on blur
  // right after a debounced save already flushed the same text).
  const savedRef = useRef("");

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void getNote(scope, refKey).then((body) => {
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
  }, [scope, refKey]);

  const flush = useCallback(
    (next: string) => {
      if (next === savedRef.current) {
        return;
      }
      savedRef.current = next;
      void saveNote(scope, refKey, next);
    },
    [scope, refKey],
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
    <label className="mcm-cal__notes">
      <span className="mcm-cal__notes-label">{label}</span>
      <textarea
        className="mcm-cal__notes-area"
        rows={rows}
        value={value}
        disabled={!loaded}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </label>
  );
};

const DayNotes = ({ dayKeyStr }: { dayKeyStr: string }) => {
  const t = useT();
  return (
    <NotesEditor scope="day" refKey={dayKeyStr} label={t("cal.notes")} rows={4} />
  );
};

const MeetingNotes = ({ roomId }: { roomId: string }) => {
  const t = useT();
  return (
    <div className="mcm-cal__row-notes">
      <NotesEditor
        scope="meeting"
        refKey={roomId}
        label={t("cal.notes")}
        rows={3}
      />
    </div>
  );
};

export default CalendarView;
