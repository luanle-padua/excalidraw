import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import type { CalMeeting } from "../../data/calendar";

// A meeting's day comes from its scheduled time, else its creation time.
const meetingMs = (m: CalMeeting): number =>
  m.scheduled_at ? Date.parse(m.scheduled_at) : m.created_at;
const dayKey = (y: number, m: number, d: number): string => `${y}-${m}-${d}`;

/**
 * A lightweight, transparent month calendar for the client portal — far simpler
 * than the staff CalendarX (no notes / per-day panels). It just marks the days
 * the guest has a meeting (a dot) + today, with prev/next month nav. Floats to
 * the right of the portal card (anh Luân 06-16: "có calendar, trong suốt, không
 * cần phức tạp như app chính").
 */
export const ClientCalendar = ({ meetings }: { meetings: CalMeeting[] }) => {
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const meetingDays = useMemo(() => {
    const s = new Set<string>();
    for (const mtg of meetings) {
      const ms = meetingMs(mtg);
      if (!ms || Number.isNaN(ms)) {
        continue;
      }
      const d = new Date(ms);
      s.add(dayKey(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    return s;
  }, [meetings]);

  // Locale-aware narrow weekday headers, Monday-first.
  const weekdays = useMemo(() => {
    const monday = new Date(2024, 0, 1); // a known Monday
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d.toLocaleDateString(undefined, { weekday: "narrow" });
    });
  }, []);

  const first = new Date(view.y, view.m, 1);
  const monthLabel = first.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const startDow = (first.getDay() + 6) % 7; // shift Sun=0 → Monday-first
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const today = new Date();

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) {
    cells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(d);
  }

  const shift = (delta: number) =>
    setView(({ y, m }) => {
      const nm = m + delta;
      return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });

  return (
    <aside className="mcm-portal__cal" aria-label={monthLabel}>
      <div className="mcm-portal__cal-head">
        <button
          type="button"
          className="mcm-portal__cal-nav"
          onClick={() => shift(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="mcm-portal__cal-month">{monthLabel}</span>
        <button
          type="button"
          className="mcm-portal__cal-nav"
          onClick={() => shift(1)}
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="mcm-portal__cal-grid">
        {weekdays.map((w, i) => (
          <span key={`w${i}`} className="mcm-portal__cal-dow">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (d === null) {
            return <span key={`e${i}`} className="mcm-portal__cal-cell" />;
          }
          const has = meetingDays.has(dayKey(view.y, view.m, d));
          const isToday =
            today.getFullYear() === view.y &&
            today.getMonth() === view.m &&
            today.getDate() === d;
          return (
            <span
              key={`d${d}`}
              className={`mcm-portal__cal-cell mcm-portal__cal-cell--day${
                isToday ? " mcm-portal__cal-cell--today" : ""
              }${has ? " mcm-portal__cal-cell--has" : ""}`}
            >
              {d}
              {has && (
                <span className="mcm-portal__cal-dot" aria-hidden="true" />
              )}
            </span>
          );
        })}
      </div>
    </aside>
  );
};

export default ClientCalendar;
