import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { getMyMeetings, type CalMeeting } from "../../data/calendar";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

import { CalendarView } from "./CalendarView";

const meetingDate = (m: CalMeeting): Date =>
  m.scheduled_at ? new Date(m.scheduled_at) : new Date(m.created_at);

const statusKind = (status: string | null): "scheduled" | "live" | "muted" => {
  const s = (status ?? "").toLowerCase();
  if (s === "in progress" || s === "in_progress" || s === "live") {
    return "live";
  }
  if (s === "completed" || s === "cancelled" || s === "canceled") {
    return "muted";
  }
  return "scheduled";
};

/** Calendar tab split view: LEFT = a scrollable list of meeting cards, RIGHT =
 *  the month/day calendar. One fetch is shared between both panes. */
export const CalendarSplit = ({
  onJoinMeeting,
  onOpenMeeting,
  onCreateOnDay,
}: {
  onJoinMeeting: (id: string) => void;
  onOpenMeeting: (id: string) => void;
  onCreateOnDay: (dateISO: string) => void;
}) => {
  const t = useT();
  const lang = useAtomValue(preferredLanguageAtom);
  const [meetings, setMeetings] = useState<CalMeeting[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void getMyMeetings().then(setMeetings);
  }, []);

  const sorted = useMemo(
    () =>
      [...meetings].sort(
        (a, b) => meetingDate(b).getTime() - meetingDate(a).getTime(),
      ),
    [meetings],
  );

  return (
    <div className="mcm-split">
      <aside className="mcm-split__list">
        <div className="mcm-split__list-head">{t("cal.upcoming")}</div>
        <ul className="mcm-split__cards">
          {sorted.length === 0 && (
            <li className="mcm-split__empty">{t("cal.noMeetings")}</li>
          )}
          {sorted.map((m) => {
            const d = meetingDate(m);
            const kind = statusKind(m.status);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className={`mcm-split__card${
                    selectedId === m.id ? " mcm-split__card--active" : ""
                  }`}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="mcm-split__card-title">
                    {m.title || m.id}
                  </span>
                  <span className="mcm-split__card-row">
                    {m.status && (
                      <span
                        className={`mcm-split__pill mcm-split__pill--${kind}`}
                      >
                        {m.status}
                      </span>
                    )}
                    <span className="mcm-split__card-when">
                      {d.toLocaleDateString(lang, {
                        month: "short",
                        day: "numeric",
                      })}
                      {m.scheduled_at &&
                        ` · ${d.toLocaleTimeString(lang, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`}
                    </span>
                  </span>
                  {m.project_name && (
                    <span className="mcm-split__card-sub">
                      {m.project_name}
                    </span>
                  )}
                  <span className="mcm-split__card-actions">
                    <span
                      role="button"
                      tabIndex={0}
                      className="mcm-split__card-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenMeeting(m.id);
                      }}
                    >
                      {t("cal.detail")}
                    </span>
                    {kind !== "muted" && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="mcm-split__card-btn mcm-split__card-btn--primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onJoinMeeting(m.id);
                        }}
                      >
                        {t("cal.join")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="mcm-split__main">
        <CalendarView
          meetings={meetings}
          onJoinMeeting={onJoinMeeting}
          onOpenMeeting={onOpenMeeting}
          onCreateOnDay={onCreateOnDay}
        />
      </div>
    </div>
  );
};

export default CalendarSplit;
