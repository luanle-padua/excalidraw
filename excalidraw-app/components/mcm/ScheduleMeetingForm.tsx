import {
  ArrowLeft,
  Briefcase,
  CalendarClock,
  CalendarPlus,
  DoorOpen,
  Search,
  Users,
  Video,
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
import { registerMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { MemberPicker } from "./MemberPicker";
import {
  CONFIDENTIALITY,
  DISCIPLINE,
  MTG_TYPE,
  PRIORITY,
  withLegacy,
} from "./metadataFields";
import { PeopleGrid } from "./PeopleGrid";

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
  // Full create payload — form tạo = form edit: agenda metadata + roles +
  // per-meeting policies, not just a title and a time.
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [priority, setPriority] = useState("");
  const [confidentiality, setConfidentiality] = useState("");
  /** Designated HOST — defaults to me (the organizer); any selected internal
   *  invitee can take it instead ("host vắng → acting host" still applies). */
  const [hostEmail, setHostEmail] = useState<string>("");
  /** Optional pre-designated CO-HOST (one of the internal invitees). */
  const [cohostEmail, setCohostEmail] = useState<string>("");
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
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[.\s]+/g, " ")
        .trim();
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

  const add = (s: Selected) => setSelected((p) => new Map(p).set(s.email, s));
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
      // ONE atomic create — lifecycle + agenda + roles + policies (form tạo =
      // form edit). Organizer is stamped server-side from the verified JWT;
      // hostEmail (internal only) defaults to the organizer when blank.
      const ok = await registerMeeting({
        roomId,
        roomKey,
        projectId,
        title: title.trim(),
        createdBy: session?.name,
        topic: topic.trim() || undefined,
        description: description.trim() || undefined,
        type: type || undefined,
        discipline: discipline || undefined,
        priority: priority || undefined,
        confidentiality: confidentiality || undefined,
        hostEmail: hostEmail || undefined,
        ...(mode === "schedule"
          ? {
              status: "scheduled" as const,
              scheduledAt: dateStr
                ? new Date(`${dateStr}T${timeStr || "09:00"}`).toISOString()
                : undefined,
              durationMin: duration ? parseInt(duration, 10) : undefined,
            }
          : { status: "live" as const }),
      });
      if (!ok) {
        // Refused server-side (auth / worker down) — keep the form open
        // instead of pretending success. Same pattern as EditMeetingForm.
        window.alert(t("folder.saveFailed"));
        return;
      }
      const list = [...selected.values()];
      if (list.length) {
        await inviteToMeeting(
          roomId,
          // The pre-designated co-host carries the role on their invite row.
          list.map((s) => ({
            email: s.email,
            role: s.email === cohostEmail ? "cohost" : undefined,
          })),
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
  // My normalised email — the "" host option maps to me (the organizer), so
  // the host dropdown can keep `hostEmail === ""` as its default value.
  const meKey = session?.email?.toLowerCase() ?? "";
  // Host/co-host candidates: me + every selected INTERNAL invitee (a guest
  // never hosts). Names resolved through the directory for the dropdowns.
  const internalCandidates = useMemo(() => {
    const out = new Map<string, string>();
    if (session?.email) {
      out.set(session.email.toLowerCase(), session.name);
    }
    for (const s of selected.values()) {
      if (s.kind === "internal" && !out.has(s.email)) {
        out.set(s.email, dir.find((u) => u.email === s.email)?.name ?? s.name);
      }
    }
    return out;
  }, [session, selected, dir]);

  const sel = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: string[],
  ) => (
    <label className="mcm-editm__field">
      <span className="mcm-invite__label">{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {withLegacy(options, value).map((o) => (
          <option key={o} value={o}>
            {o || "—"}
          </option>
        ))}
      </select>
    </label>
  );

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

      {/* Body — four ZONES separated by hairlines (Apple/Notion utility):
          1 Essentials (focal title + event-card schedule), 2 Agenda,
          3 Roles & policies, 4 People. `.mcm-nmf` only re-skins; every
          control still drives the exact same state as before. */}
      <div className="mcm-invite__body mcm-nmf">
        {/* ── ZONE 1 · ESSENTIALS ──────────────────────────────────────
            Project eyebrow → big focal title → (schedule mode) the
            when-card: same date/time/duration trio, dressed like the
            detail panel's hero (accent wash + icon badge). */}
        <section className="mcm-nmf__zone">
          <span className="mcm-nmf__proj">
            <Briefcase size={12} /> {projectName}
          </span>
          <input
            className="mcm-nmf__title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("folder.meetingTitle")}
            aria-label={t("folder.meetingTitle")}
            autoFocus
          />
          {mode === "schedule" && (
            <div className="mcm-nmf__when">
              <span className="mcm-nmf__when-ico">
                <CalendarClock size={18} />
              </span>
              <div className="mcm-nmf__when-body">
                <span className="mcm-invite__label">
                  {t("folder.dateTime")}
                </span>
                <div className="mcm-nmf__when-grid">
                  <input
                    type="date"
                    value={dateStr}
                    onChange={(e) => setDateStr(e.target.value)}
                    onClick={(e) => {
                      try {
                        e.currentTarget.showPicker();
                      } catch {
                        /* showPicker unsupported / blocked — icon still works */
                      }
                    }}
                  />
                  <select
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
                  {/* duration: number input + quiet "phút" unit suffix */}
                  <div className="mcm-nmf__dur">
                    <input
                      type="number"
                      min={5}
                      step={5}
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      aria-label={t("folder.durationMin")}
                    />
                    <span>{t("folder.minutesShort")}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ── ZONE 2 · AGENDA ──────────────────────────────────────────
            Topic + description, then the 4 metadata vocabularies in the
            same 2-col grid the edit form uses (create = edit). */}
        <section className="mcm-nmf__zone">
          <h3 className="mcm-mdp__sec">{t("folder.secAgenda")}</h3>
          <label className="mcm-nmf__field">
            <span className="mcm-invite__label">{t("folder.fieldTopic")}</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("folder.topicPlaceholder")}
            />
          </label>
          <label className="mcm-nmf__field">
            <span className="mcm-invite__label">
              {t("folder.fieldDescription")}
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("folder.descPlaceholder")}
            />
          </label>
          <div className="mcm-editm__grid">
            {sel(t("admin.mType"), type, setType, MTG_TYPE)}
            {sel(t("admin.mDiscipline"), discipline, setDiscipline, DISCIPLINE)}
            {sel(t("admin.mPriority"), priority, setPriority, PRIORITY)}
            {sel(
              t("admin.mConfidentiality"),
              confidentiality,
              setConfidentiality,
              CONFIDENTIALITY,
            )}
          </div>
        </section>

        {/* ── ZONE 3 · ROLES & POLICIES ────────────────────────────────
            Host / co-host side by side (internal candidates only), then
            the per-meeting policies as switch rows. */}
        <section className="mcm-nmf__zone">
          <h3 className="mcm-mdp__sec">{t("folder.secRoles")}</h3>
          <div className="mcm-editm__grid">
            <label className="mcm-editm__field">
              <span className="mcm-invite__label">{t("folder.host")}</span>
              {/* "" = me (the organizer) — the create payload's default. */}
              <select
                value={hostEmail}
                onChange={(e) => {
                  const v = e.target.value;
                  setHostEmail(v);
                  // The new host can't stay co-host — drop the collision.
                  if (cohostEmail && cohostEmail === (v || meKey)) {
                    setCohostEmail("");
                  }
                }}
              >
                {[...internalCandidates].map(([email, name]) => (
                  <option key={email} value={email === meKey ? "" : email}>
                    {name}
                  </option>
                ))}
                {/* Keep a host whose invite was removed selectable (à la
                    withLegacy) so the select never silently mismatches. */}
                {hostEmail !== "" && !internalCandidates.has(hostEmail) && (
                  <option value={hostEmail}>{hostEmail}</option>
                )}
              </select>
            </label>
            <label className="mcm-editm__field">
              <span className="mcm-invite__label">{t("invite.cohost")}</span>
              <select
                value={cohostEmail}
                onChange={(e) => setCohostEmail(e.target.value)}
              >
                <option value="">{t("folder.noCohost")}</option>
                {/* Same candidates minus the effective host. */}
                {[...internalCandidates]
                  .filter(([email]) => email !== (hostEmail || meKey))
                  .map(([email, name]) => (
                    <option key={email} value={email}>
                      {name}
                    </option>
                  ))}
                {cohostEmail !== "" && !internalCandidates.has(cohostEmail) && (
                  <option value={cohostEmail}>{cohostEmail}</option>
                )}
              </select>
            </label>
          </div>
          {/* Waiting room + recording aren't enforced anywhere yet (Phase 4)
              — keep the switches visible but disabled so the form doesn't
              promise a policy the worker won't apply. */}
          <div className="mcm-nmf__toggles">
            <label className="mcm-nmf__toggle">
              <span className="mcm-nmf__toggle-ico">
                <DoorOpen size={15} />
              </span>
              <span className="mcm-nmf__toggle-txt">
                {t("folder.waitingRoom")} {t("folder.comingSoon")}
              </span>
              <input
                className="mcm-switch"
                type="checkbox"
                checked={false}
                disabled
              />
            </label>
            <label className="mcm-nmf__toggle">
              <span className="mcm-nmf__toggle-ico">
                <Video size={15} />
              </span>
              <span className="mcm-nmf__toggle-txt">
                {t("folder.recordingOn")} {t("folder.comingSoon")}
              </span>
              <input
                className="mcm-switch"
                type="checkbox"
                checked={false}
                disabled
              />
            </label>
          </div>
        </section>

        {/* ── ZONE 4 · PEOPLE ──────────────────────────────────────────
            Selected invitees (shared PeopleGrid: internal vs clients,
            division clusters, real avatars) + directory search, the
            Members picker, the synced client list and the free guest
            email — all the pre-existing pieces, recomposed. */}
        <section className="mcm-nmf__zone">
          <h3 className="mcm-mdp__sec">
            {t("folder.secPeople")}
            {selected.size > 0 && (
              <span className="mcm-mdp__sec-n">{selected.size}</span>
            )}
          </h3>

          {selected.size > 0 && (
            <PeopleGrid
              people={[...selected.values()].map((s) => {
                const u =
                  s.kind === "internal"
                    ? dir.find((x) => x.email === s.email)
                    : undefined;
                const cl =
                  s.kind === "guest"
                    ? clients.find((x) => x.email?.toLowerCase() === s.email)
                    : undefined;
                return {
                  email: s.email,
                  name: u?.name ?? cl?.name ?? s.name,
                  title: u?.title ?? null,
                  group: u?.division ?? cl?.company ?? null,
                  kind: s.kind,
                  avatar: u?.avatar ?? null,
                };
              })}
              onRemove={remove}
              removeLabel={t("admin.delete")}
            />
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
        </section>
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
          selectedEmails={
            new Set(
              [...selected.values()]
                .filter((s) => s.kind === "internal")
                .map((s) => s.email),
            )
          }
          onConfirm={(emails) => {
            // Reconcile: the picker result IS the new internal set — drop the
            // internal invitees no longer ticked, add the newly ticked ones.
            const keep = new Set(emails);
            setSelected((prev) => {
              const next = new Map(prev);
              for (const [k, v] of prev) {
                if (v.kind === "internal" && !keep.has(k)) {
                  next.delete(k);
                }
              }
              for (const e of emails) {
                if (!next.has(e)) {
                  const u = dir.find((x) => x.email === e);
                  if (u) {
                    next.set(e, {
                      email: u.email,
                      name: u.name,
                      kind: "internal",
                    });
                  }
                }
              }
              return next;
            });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
};

export default ScheduleMeetingForm;
