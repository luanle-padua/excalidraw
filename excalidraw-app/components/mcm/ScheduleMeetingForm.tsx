import {
  ArrowLeft,
  Briefcase,
  CalendarPlus,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { generateCollaborationLinkData } from "../../data";
import { listClients, type Client } from "../../data/clients";
import {
  getDirectory,
  inviteToMeeting,
  type DirectoryUser,
} from "../../data/invite";
import { registerMeeting, updateMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { MemberPicker } from "./MemberPicker";

type Selected = { email: string; name: string; kind: "internal" | "guest" };

// 30-minute time slots (00:00 … 23:30) for the time dropdown — click, not type.
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 ? 30 : 0;
  const value = `${String(h).padStart(2, "0")}:${m ? "30" : "00"}`;
  const label = new Date(2000, 0, 1, h, m).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return { value, label };
});

/** Schedule a meeting AHEAD of time: pick a date/time + invitees, create it as
 *  `scheduled` (without entering), and send invites. The invited users then see
 *  it in their "Invited / Upcoming" list. */
export const ScheduleMeetingForm = ({
  projectId,
  projectName,
  mode,
  defaultWhen,
  onClose,
  onCreated,
  onCreatedEnter,
}: {
  projectId: string;
  projectName: string;
  /** "now" = create + enter the room immediately; "schedule" = create as
   *  scheduled (date/time shown), don't enter — appears in Upcoming. */
  mode: "now" | "schedule";
  /** Prefill date/time (e.g. from a calendar day click), "YYYY-MM-DDTHH:mm". */
  defaultWhen?: string;
  onClose: () => void;
  onCreated: () => void;
  onCreatedEnter?: (roomId: string, roomKey: string) => void;
}) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [title, setTitle] = useState("");
  const [dateStr, setDateStr] = useState(
    defaultWhen ? defaultWhen.slice(0, 10) : "",
  );
  const [timeStr, setTimeStr] = useState(defaultWhen?.slice(11, 16) || "09:00");
  const [duration, setDuration] = useState("60");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dir, setDir] = useState<DirectoryUser[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [clientEmail, setClientEmail] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientQ, setClientQ] = useState("");
  const [addToProject, setAddToProject] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getDirectory().then(setDir);
    void listClients().then(setClients);
  }, []);

  // Saved clients (with an email) not already picked, filtered by the search —
  // invite straight from the synced client list instead of retyping.
  const clientMatches = useMemo(() => {
    const n = clientQ.trim().toLowerCase();
    return clients
      .filter((c) => c.email && !selected.has(c.email.toLowerCase()))
      .filter(
        (c) =>
          !n ||
          c.name.toLowerCase().includes(n) ||
          (c.company ?? "").toLowerCase().includes(n) ||
          (c.email ?? "").toLowerCase().includes(n),
      )
      .slice(0, 30);
  }, [clients, clientQ, selected]);

  const filtered = useMemo(() => {
    // Normalise punctuation/spacing so "div 1" matches "Div. 1", and search the
    // title too (people search by role + department).
    const norm = (s: string) => s.toLowerCase().replace(/[.\s]+/g, " ").trim();
    const n = norm(q);
    return dir
      .filter((u) => !selected.has(u.email))
      .filter(
        (u) =>
          !n ||
          norm(u.name).includes(n) ||
          norm(u.email).includes(n) ||
          norm(u.division ?? "").includes(n) ||
          norm(u.title ?? "").includes(n),
      )
      .slice(0, 50);
  }, [dir, q, selected]);

  const add = (s: Selected) =>
    setSelected((p) => new Map(p).set(s.email, s));
  const remove = (email: string) =>
    setSelected((p) => {
      const n = new Map(p);
      n.delete(email);
      return n;
    });
  const addClient = () => {
    const e = clientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || selected.has(e)) {
      return;
    }
    add({ email: e, name: e, kind: "guest" });
    setClientEmail("");
  };

  const create = async () => {
    if (!title.trim() || saving) {
      return;
    }
    setSaving(true);
    try {
      const { roomId, roomKey } = await generateCollaborationLinkData();
      await registerMeeting({
        roomId,
        roomKey,
        projectId,
        title: title.trim(),
        createdBy: session?.name,
      });
      await updateMeeting(roomId, {
        organizer_email: session?.email,
        host_email: session?.email,
        ...(mode === "schedule"
          ? {
              status: "scheduled",
              scheduled_at: dateStr
                ? new Date(`${dateStr}T${timeStr || "09:00"}`).toISOString()
                : undefined,
              duration_min: duration ? parseInt(duration, 10) : undefined,
            }
          : {}),
      });
      const list = [...selected.values()];
      if (list.length) {
        await inviteToMeeting(
          roomId,
          list.map((s) => ({ email: s.email })),
          addToProject
            ? list.filter((s) => s.kind === "internal").map((s) => s.email)
            : [],
        );
      }
      if (mode === "now") {
        onCreatedEnter?.(roomId, roomKey);
      } else {
        onCreated();
      }
    } finally {
      setSaving(false);
    }
  };

  const hasInternal = [...selected.values()].some((s) => s.kind === "internal");

  return (
    <div className="mcm-folder__rpanel">
      <header className="mcm-folder__rpanel-head">
        <button
          type="button"
          className="mcm-folder__rpanel-back"
          onClick={onClose}
          aria-label={t("header.leave")}
        >
          <ArrowLeft size={16} />
        </button>
        <strong>
          <CalendarPlus size={16} />{" "}
          {mode === "schedule"
            ? t("folder.schedule")
            : t("folder.newMeetingInProject")}
        </strong>
      </header>

        <div className="mcm-invite__body">
          <span className="mcm-invite__label">{projectName}</span>

          <label className="mcm-invite__label">{t("folder.meetingTitle")}</label>
          <div className="mcm-invite__client">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("folder.meetingTitle")}
            />
          </div>

          {mode === "schedule" && (
            <div className="mcm-sched__row">
              <label>
                <span className="mcm-invite__label">
                  {t("folder.dateTime")}
                </span>
                <input
                  type="date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                />
              </label>
              <label>
                <span className="mcm-invite__label">&nbsp;</span>
                <select
                  className="mcm-sched__time"
                  aria-label={t("folder.dateTime")}
                  value={timeStr}
                  onChange={(e) => setTimeStr(e.target.value)}
                >
                  {TIME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="mcm-invite__label">
                  {t("folder.durationMin")}
                </span>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </label>
            </div>
          )}

          {selected.size > 0 && (
            <div className="mcm-invite__chips">
              {[...selected.values()].map((s) => (
                <span
                  key={s.email}
                  className={`mcm-invite__chip${
                    s.kind === "guest" ? " --guest" : ""
                  }`}
                >
                  {s.name}
                  <button
                    type="button"
                    onClick={() => remove(s.email)}
                    aria-label={t("admin.delete")}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mcm-invite__label-row">
            <span className="mcm-invite__label">{t("invite.internal")}</span>
            <button
              type="button"
              className="mcm-invite__pick-btn"
              onClick={() => setPickerOpen(true)}
            >
              <Users size={13} /> {t("invite.pickMembers")}
            </button>
          </div>
          <div className="mcm-invite__search">
            <Search size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("invite.search")}
            />
          </div>
          <ul className="mcm-invite__list">
            {filtered.map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  onClick={() =>
                    add({ email: u.email, name: u.name, kind: "internal" })
                  }
                >
                  <strong>{u.name}</strong>
                  <span>
                    {[u.title, u.division].filter(Boolean).join(" · ") ||
                      u.email}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="mcm-invite__empty">{t("invite.empty")}</li>
            )}
          </ul>

          <label className="mcm-invite__label">
            <Briefcase size={13} style={{ verticalAlign: "-2px" }} />{" "}
            {t("clients.pickFromList")}
          </label>
          <div className="mcm-invite__search">
            <Search size={14} />
            <input
              value={clientQ}
              onChange={(e) => setClientQ(e.target.value)}
              placeholder={t("clients.pickSearch")}
            />
          </div>
          <ul className="mcm-invite__list">
            {clientMatches.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() =>
                    add({
                      email: c.email!.toLowerCase(),
                      name: c.company ? `${c.name} · ${c.company}` : c.name,
                      kind: "guest",
                    })
                  }
                >
                  <strong>{c.name}</strong>
                  <span>
                    {[c.company, c.email].filter(Boolean).join(" · ") ||
                      c.email}
                  </span>
                </button>
              </li>
            ))}
            {clientMatches.length === 0 && (
              <li className="mcm-invite__empty">{t("clients.pickEmpty")}</li>
            )}
          </ul>

          <label className="mcm-invite__label">{t("invite.client")}</label>
          <div className="mcm-invite__client">
            <input
              type="email"
              value={clientEmail}
              onChange={(e) => setClientEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addClient()}
              placeholder={t("invite.clientPlaceholder")}
            />
            <button
              type="button"
              className="mcm-btn mcm-btn--primary mcm-btn--sm"
              onClick={addClient}
            >
              {t("invite.add")}
            </button>
          </div>

          {hasInternal && (
            <label className="mcm-invite__check">
              <input
                type="checkbox"
                checked={addToProject}
                onChange={(e) => setAddToProject(e.target.checked)}
              />
              <span>{t("invite.addToProject")}</span>
            </label>
          )}
        </div>

        <footer className="mcm-invite__foot">
          <button
            type="button"
            className="mcm-btn mcm-btn--primary mcm-btn--block"
            onClick={() => void create()}
            disabled={!title.trim() || saving}
          >
            {mode === "schedule"
              ? t("folder.createScheduled")
              : t("folder.createNow")}
          </button>
        </footer>
      {pickerOpen && (
        <MemberPicker
          directory={dir}
          disabledEmails={
            new Set(
              [...selected.values()]
                .filter((s) => s.kind === "internal")
                .map((s) => s.email),
            )
          }
          onConfirm={(emails) =>
            emails.forEach((e) => {
              const u = dir.find((x) => x.email === e);
              if (u) {
                add({ email: u.email, name: u.name, kind: "internal" });
              }
            })
          }
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
};

export default ScheduleMeetingForm;
