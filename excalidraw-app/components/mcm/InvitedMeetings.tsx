import { CalendarClock, LogIn } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { getMyInvitations, type MyInvitation } from "../../data/invite";
import { getMeeting } from "../../data/projects";
import { useT } from "../../i18n/mcm";

const fmtWhen = (s: string | null): string => {
  if (!s) {
    return "";
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};

/** "Invited / Upcoming" — the meetings the current user was invited to. The
 *  ONLY meeting surface a client sees (project NAME only, never the folder).
 *  Internal members still browse the full folders separately. */
export const InvitedMeetings = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const [items, setItems] = useState<MyInvitation[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getMyInvitations().then(setItems);
  }, []);

  if (items.length === 0) {
    return null;
  }

  const join = async (id: string) => {
    if (busy || !collabAPI) {
      return;
    }
    setBusy(true);
    try {
      const m = await getMeeting(id);
      if (!m?.room_key) {
        return;
      }
      const finished = m.status === "Completed" || m.status === "Cancelled";
      // Mirror ProjectBrowser.enterRoom: tear down the current room first so
      // startCollaboration actually switches, then enter (review if finished).
      collabAPI.stopCollaboration(false);
      window.history.pushState(
        {},
        "",
        getCollaborationLink({ roomId: id, roomKey: m.room_key }),
      );
      await collabAPI.startCollaboration(
        { roomId: id, roomKey: m.room_key },
        { viewOnly: finished },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcm-invited" aria-label={t("invited.title")}>
      <h3 className="mcm-invited__title">
        <CalendarClock size={16} /> {t("invited.title")}
      </h3>
      <ul className="mcm-invited__list">
        {items.map((iv) => (
          <li key={iv.id} className="mcm-invited__card">
            <div className="mcm-invited__meta">
              <strong>{iv.title || iv.topic || iv.id}</strong>
              <span>
                {[
                  iv.project_name,
                  fmtWhen(iv.scheduled_at),
                  iv.status,
                  iv.created_by ? `· ${iv.created_by}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <button
              type="button"
              className="mcm-invited__join"
              onClick={() => void join(iv.id)}
              disabled={busy}
            >
              <LogIn size={15} /> {t("invited.join")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default InvitedMeetings;
