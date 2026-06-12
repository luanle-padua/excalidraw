import { ArrowLeft, Briefcase, Pencil, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { listClients, type Client } from "../../data/clients";
import {
  getDirectory,
  inviteToMeeting,
  listInvitees,
  revokeInvitee,
  type DirectoryUser,
} from "../../data/invite";
import { getMeeting, updateMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { MemberPicker } from "./MemberPicker";
import {
  CONFIDENTIALITY,
  DISCIPLINE,
  MTG_TYPE,
  PRIORITY,
  metaOptionLabel,
  withLegacy,
} from "./metadataFields";
import { statusBucket } from "./meetingColors";
import { meetingStatusLabel, normalizeMeetingStatus } from "./meetingStatus";
import { PeopleGrid } from "./PeopleGrid";

type Selected = { email: string; name: string; kind: "internal" | "guest" };

// Same 30-minute slots as the create form — create/edit stay one data set.
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

/** FULL meeting editor for the ORGANIZER — the edit-side mirror of
 *  ScheduleMeetingForm, so what you set at create time is exactly what you
 *  can change later: title + agenda metadata, date/time/duration (while
 *  still `scheduled`), and the invitee list (add AND remove). Saving diffs
 *  the invitees: new ones get invited, unticked ones get revoked.
 *
 *  Callers gate rendering by canManageMeeting + isEditableMeetingStatus;
 *  the worker re-enforces both (organizer-only 403, finished/cancelled 409). */
export const EditMeetingForm = ({
  roomId,
  onClose,
  onSaved,
}: {
  roomId: string;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [priority, setPriority] = useState("");
  const [confidentiality, setConfidentiality] = useState("");
  const [dateStr, setDateStr] = useState("");
  const [timeStr, setTimeStr] = useState("09:00");
  const [duration, setDuration] = useState("60");
  /** Roles — mirror of the create form. Host holds the ACTUAL email (no
   *  ""=me shorthand here: an admin may edit someone else's meeting), the
   *  co-host rides on the invitee row's role, diffed at save. */
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [hostEmail, setHostEmail] = useState("");
  const [origHost, setOrigHost] = useState("");
  const [cohostEmail, setCohostEmail] = useState("");
  const [origCohost, setOrigCohost] = useState("");

  const [dir, setDir] = useState<DirectoryUser[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [clientQ, setClientQ] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  /** Emails invited BEFORE this edit session — the diff base for save. */
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [addToProject, setAddToProject] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [m, invitees, directory, clientList] = await Promise.all([
        getMeeting(roomId),
        listInvitees(roomId),
        getDirectory(),
        listClients(),
      ]);
      if (!alive) {
        return;
      }
      setDir(directory);
      setClients(clientList);
      if (m) {
        setStatus(m.status);
        setTitle(m.title ?? "");
        setTopic(m.topic ?? "");
        setDescription(m.description ?? "");
        setType(m.type ?? "");
        setDiscipline(m.discipline ?? "");
        setPriority(m.priority ?? "");
        setConfidentiality(m.confidentiality ?? "");
        setDuration(m.duration_min ? String(m.duration_min) : "60");
        const org = (m.organizer_email ?? "").toLowerCase();
        const host = (m.host_email ?? m.organizer_email ?? "").toLowerCase();
        setOrganizerEmail(org);
        setHostEmail(host);
        setOrigHost(host);
        if (m.scheduled_at) {
          const dt = new Date(m.scheduled_at);
          if (!Number.isNaN(dt.getTime())) {
            const pad = (n: number) => String(n).padStart(2, "0");
            setDateStr(
              `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
                dt.getDate(),
              )}`,
            );
            setTimeStr(
              `${pad(dt.getHours())}:${dt.getMinutes() >= 30 ? "30" : "00"}`,
            );
          }
        }
      }
      const active = invitees.filter((iv) => iv.status !== "revoked");
      const next = new Map<string, Selected>();
      for (const iv of active) {
        const u = directory.find((x) => x.email === iv.email);
        const cl = clientList.find((x) => x.email?.toLowerCase() === iv.email);
        next.set(iv.email, {
          email: iv.email,
          name:
            u?.name ??
            (cl
              ? cl.company
                ? `${cl.name} · ${cl.company}`
                : cl.name
              : iv.email),
          kind: iv.kind === "internal" ? "internal" : "guest",
        });
      }
      setSelected(next);
      setOriginal(new Set(next.keys()));
      const cohost =
        active.find((iv) => iv.role === "cohost")?.email.toLowerCase() ?? "";
      setCohostEmail(cohost);
      setOrigCohost(cohost);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  const normalized = normalizeMeetingStatus(status);
  // Schedule fields only make sense while the meeting hasn't started —
  // mid-`live` you can still fix the agenda and invite people, not the clock.
  const canEditSchedule = normalized === "scheduled";

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

  // A co-host who got un-invited in this session can't stay co-host —
  // otherwise saving would silently re-invite them just to carry the role.
  useEffect(() => {
    if (
      cohostEmail &&
      cohostEmail !== organizerEmail &&
      !selected.has(cohostEmail)
    ) {
      setCohostEmail("");
    }
  }, [cohostEmail, organizerEmail, selected]);

  // Host/co-host candidates: the organizer + every selected INTERNAL invitee
  // (a guest never hosts) — same pool as the create form, names via directory.
  const internalCandidates = useMemo(() => {
    const out = new Map<string, string>();
    if (organizerEmail) {
      out.set(
        organizerEmail,
        dir.find((u) => u.email === organizerEmail)?.name ?? organizerEmail,
      );
    }
    for (const s of selected.values()) {
      if (s.kind === "internal" && !out.has(s.email)) {
        out.set(s.email, dir.find((u) => u.email === s.email)?.name ?? s.name);
      }
    }
    return out;
  }, [organizerEmail, selected, dir]);

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

  const save = async () => {
    if (!title.trim() || saving) {
      return;
    }
    setSaving(true);
    try {
      const ok = await updateMeeting(roomId, {
        title: title.trim(),
        topic,
        description,
        type,
        discipline,
        priority,
        confidentiality,
        ...(canEditSchedule && dateStr
          ? {
              scheduled_at: new Date(
                `${dateStr}T${timeStr || "09:00"}`,
              ).toISOString(),
              duration_min: duration ? parseInt(duration, 10) : undefined,
            }
          : {}),
        ...(hostEmail && hostEmail !== origHost
          ? { host_email: hostEmail }
          : {}),
      });
      if (!ok) {
        // Refused server-side (organizer race / meeting went terminal between
        // load and save) — keep the form open instead of pretending success.
        window.alert(t("folder.saveFailed"));
        return;
      }
      // Invitee diff: invite the newly added, revoke the removed.
      const added = [...selected.values()].filter(
        (s) => !original.has(s.email),
      );
      const removed = [...original].filter((e) => !selected.has(e));
      if (added.length) {
        await inviteToMeeting(
          roomId,
          // A freshly added co-host carries the role on their invite row.
          added.map((s) => ({
            email: s.email,
            role: s.email === cohostEmail ? "cohost" : undefined,
          })),
          addToProject
            ? added.filter((s) => s.kind === "internal").map((s) => s.email)
            : [],
        );
      }
      for (const e of removed) {
        await revokeInvitee(roomId, e);
      }
      // Co-host diff for PRE-EXISTING rows (the invite upsert rewrites the
      // role): demote the old co-host back to attendee, promote the new one
      // unless their fresh invite above already carried it.
      if (cohostEmail !== origCohost) {
        const roleUpdates: { email: string; role?: string }[] = [];
        if (origCohost && selected.has(origCohost)) {
          roleUpdates.push({ email: origCohost });
        }
        if (cohostEmail && !added.some((s) => s.email === cohostEmail)) {
          roleUpdates.push({ email: cohostEmail, role: "cohost" });
        }
        if (roleUpdates.length) {
          await inviteToMeeting(roomId, roleUpdates, []);
        }
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const hasNewInternal = [...selected.values()].some(
    (s) => s.kind === "internal" && !original.has(s.email),
  );
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
            {o ? metaOptionLabel(t, o) : "—"}
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
          <Pencil size={15} /> {t("folder.editMeeting")}
        </strong>
        {status && (
          <span className={`mcm-pill mcm-pill--${statusBucket(status)}`}>
            {meetingStatusLabel(t, status)}
          </span>
        )}
      </header>

      {loading ? (
        <div className="mcm-invite__body">
          <p className="mcm-admin__note">{t("admin.loading")}</p>
        </div>
      ) : (
        <div className="mcm-invite__body">
          {!session && <p className="mcm-admin__note">{t("admin.empty")}</p>}

          <label className="mcm-invite__label">
            {t("folder.meetingTitle")}
          </label>
          <div className="mcm-invite__client">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("folder.meetingTitle")}
            />
          </div>

          {canEditSchedule ? (
            <div className="mcm-sched__row">
              <label>
                <span className="mcm-invite__label">
                  {t("folder.dateTime")}
                </span>
                <input
                  type="date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                  onClick={(e) => {
                    try {
                      e.currentTarget.showPicker();
                    } catch {
                      /* showPicker unsupported — icon still works */
                    }
                  }}
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
          ) : (
            <p className="mcm-editm__note">{t("folder.scheduleLockedLive")}</p>
          )}

          <label className="mcm-invite__label">{t("folder.fieldTopic")}</label>
          <div className="mcm-invite__client">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("folder.topicPlaceholder")}
            />
          </div>

          <label className="mcm-invite__label">
            {t("folder.fieldDescription")}
          </label>
          <div className="mcm-invite__client">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("folder.descPlaceholder")}
            />
          </div>

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

          {/* Roles — same pair as the create form (form tạo = form sửa). */}
          <div className="mcm-editm__grid">
            <label className="mcm-editm__field">
              <span className="mcm-invite__label">{t("folder.host")}</span>
              <select
                value={hostEmail}
                onChange={(e) => {
                  const v = e.target.value;
                  setHostEmail(v);
                  // The new host can't stay co-host — drop the collision.
                  if (cohostEmail && cohostEmail === v) {
                    setCohostEmail("");
                  }
                }}
              >
                {[...internalCandidates].map(([email, name]) => (
                  <option key={email} value={email}>
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
                {/* Same candidates minus the current host. */}
                {[...internalCandidates]
                  .filter(([email]) => email !== hostEmail)
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

          <div className="mcm-invite__label-row">
            <span className="mcm-invite__label">
              {t("invite.currentInvitees", { count: String(selected.size) })}
            </span>
            <button
              type="button"
              className="mcm-invite__pick-btn"
              onClick={() => setPickerOpen(true)}
            >
              <Users size={13} /> {t("invite.pickMembers")}
            </button>
          </div>
          {/* Invitees as the shared PEOPLE GRID — internal vs clients split,
              clustered by division/company, real avatars, removable chips. */}
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
            emptyLabel={t("invite.empty")}
          />

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

          {hasNewInternal && (
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
      )}

      <footer className="mcm-invite__foot">
        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--block"
          onClick={() => void save()}
          disabled={loading || !title.trim() || saving}
        >
          {t("folder.save")}
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

export default EditMeetingForm;
