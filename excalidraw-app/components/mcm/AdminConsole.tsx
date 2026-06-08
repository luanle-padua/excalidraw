import {
  DollarSign,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Plug,
  ScrollText,
  Trash2,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  createAdminUser,
  deleteAdminMeeting,
  deleteAdminUser,
  getAdminAudit,
  getAdminCost,
  getAdminIntegrations,
  getAdminStats,
  getAdminStorage,
  listAdminMeetings,
  listAdminUsers,
  updateAdminUser,
  type AdminAuditEntry,
  type AdminCost,
  type AdminIntegration,
  type AdminMeeting,
  type AdminStats,
  type AdminStorage,
  type AdminUser,
} from "../../data/admin";
import { signOut } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { LangThemeSwitcher } from "./LangThemeSwitcher";

import "./AdminConsole.scss";

type Tab =
  | "dashboard"
  | "users"
  | "meetings"
  | "cost"
  | "integrations"
  | "storage"
  | "audit"
  | "recordings";

const ROLES = ["admin", "host", "member"] as const;

const fmtBytes = (b: number | null | undefined): string => {
  if (!b) {
    return "0 B";
  }
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

// Real billing lives in each provider's dashboard (we link out); the estimate
// below is derived from our own usage × published rates.
const BILLING_LINKS: { name: string; url: string }[] = [
  { name: "Daily.co", url: "https://dashboard.daily.co/billing" },
  { name: "Supabase", url: "https://supabase.com/dashboard/project/_/settings/billing" },
  { name: "Cloudflare (R2/Workers)", url: "https://dash.cloudflare.com/" },
  { name: "Google (Gemini)", url: "https://console.cloud.google.com/billing" },
  { name: "Deepgram", url: "https://console.deepgram.com/" },
];
const R2_USD_PER_GB_MONTH = 0.015;

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleString() : "—";
const fmtIso = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString() : "—";
const fmtDur = (s: number | null | undefined): string => {
  if (!s || s <= 0) {
    return "—";
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
};

export const AdminConsole = () => {
  const t = useT();
  const [tab, setTab] = useState<Tab>("dashboard");

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [meetings, setMeetings] = useState<AdminMeeting[]>([]);
  const [cost, setCost] = useState<AdminCost | null>(null);
  const [integrations, setIntegrations] = useState<AdminIntegration[]>([]);
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // New-user form
  const [nuEmail, setNuEmail] = useState("");
  const [nuPassword, setNuPassword] = useState("");
  const [nuName, setNuName] = useState("");
  const [nuRole, setNuRole] = useState<string>("member");

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await listAdminUsers());
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMeetings = useCallback(async () => {
    setLoading(true);
    try {
      setMeetings((await listAdminMeetings()).meetings);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void getAdminStats().then(setStats);
  }, []);

  useEffect(() => {
    if (tab === "users") {
      void refreshUsers();
    } else if (tab === "meetings") {
      void refreshMeetings();
    } else if (tab === "cost") {
      void getAdminCost().then(setCost);
    } else if (tab === "integrations") {
      void getAdminIntegrations().then(setIntegrations);
    } else if (tab === "storage") {
      void getAdminStorage().then(setStorage);
    } else if (tab === "audit") {
      void getAdminAudit().then(setAudit);
    }
  }, [tab, refreshUsers, refreshMeetings]);

  const handleCreate = async () => {
    if (!nuEmail.trim() || !nuPassword || busy) {
      return;
    }
    setBusy(true);
    const ok = await createAdminUser({
      email: nuEmail.trim(),
      password: nuPassword,
      name: nuName.trim() || undefined,
      role: nuRole,
    });
    setBusy(false);
    if (ok) {
      setNuEmail("");
      setNuPassword("");
      setNuName("");
      setNuRole("member");
      void refreshUsers();
    }
  };

  const setRole = async (u: AdminUser, role: string) => {
    setBusy(true);
    await updateAdminUser(u.id, { role });
    setBusy(false);
    void refreshUsers();
  };

  const toggleDisabled = async (u: AdminUser) => {
    const isBanned = !!u.banned_until && u.banned_until !== "none";
    setBusy(true);
    await updateAdminUser(u.id, { disabled: !isBanned });
    setBusy(false);
    void refreshUsers();
  };

  const resetPw = async (u: AdminUser) => {
    const pw = window.prompt(t("admin.resetPrompt"));
    if (!pw) {
      return;
    }
    setBusy(true);
    await updateAdminUser(u.id, { password: pw });
    setBusy(false);
  };

  const removeUser = async (u: AdminUser) => {
    if (!window.confirm(t("admin.confirmDeleteUser"))) {
      return;
    }
    setBusy(true);
    await deleteAdminUser(u.id);
    setBusy(false);
    void refreshUsers();
  };

  const removeMeeting = async (m: AdminMeeting) => {
    if (!window.confirm(t("admin.confirmDeleteMeeting"))) {
      return;
    }
    setBusy(true);
    await deleteAdminMeeting(m.id);
    setBusy(false);
    void refreshMeetings();
  };

  return (
    <div className="mcm-admin" role="dialog" aria-modal="true">
      <header className="mcm-admin__top">
        <div className="mcm-admin__brand">
          <span className="mcm-admin__logo">MAP</span>
          <strong>{t("admin.title")}</strong>
        </div>
        <nav className="mcm-admin__tabs">
          <button
            type="button"
            className={`mcm-admin__tab${tab === "dashboard" ? " --active" : ""}`}
            onClick={() => setTab("dashboard")}
          >
            <LayoutDashboard size={16} /> {t("admin.tabDashboard")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "users" ? " --active" : ""}`}
            onClick={() => setTab("users")}
          >
            <Users size={16} /> {t("admin.tabUsers")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "meetings" ? " --active" : ""}`}
            onClick={() => setTab("meetings")}
          >
            <LayoutDashboard size={16} /> {t("admin.tabMeetings")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "cost" ? " --active" : ""}`}
            onClick={() => setTab("cost")}
          >
            <DollarSign size={16} /> {t("admin.tabCost")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "integrations" ? " --active" : ""}`}
            onClick={() => setTab("integrations")}
          >
            <Plug size={16} /> {t("admin.tabApi")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "storage" ? " --active" : ""}`}
            onClick={() => setTab("storage")}
          >
            <HardDrive size={16} /> {t("admin.tabStorage")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "audit" ? " --active" : ""}`}
            onClick={() => setTab("audit")}
          >
            <ScrollText size={16} /> {t("admin.tabAudit")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "recordings" ? " --active" : ""}`}
            onClick={() => setTab("recordings")}
          >
            <Video size={16} /> {t("admin.tabRecordings")}
          </button>
        </nav>
        <div className="mcm-admin__top-actions">
          <LangThemeSwitcher />
          <button
            type="button"
            className="mcm-admin__ghost"
            onClick={() => void signOut()}
          >
            <LogOut size={16} /> {t("login.signOut")}
          </button>
        </div>
      </header>

      <div className="mcm-admin__body">
        {tab === "dashboard" && (
          <div className="mcm-admin__cards">
            <div className="mcm-admin__card">
              <span className="mcm-admin__card-num">
                {stats?.total_meetings ?? "—"}
              </span>
              <span className="mcm-admin__card-label">
                {t("admin.statMeetings")}
              </span>
            </div>
            <div className="mcm-admin__card">
              <span className="mcm-admin__card-num">
                {stats?.total_projects ?? "—"}
              </span>
              <span className="mcm-admin__card-label">
                {t("admin.statProjects")}
              </span>
            </div>
            <div className="mcm-admin__card">
              <span className="mcm-admin__card-num">
                {stats?.meetings_today ?? "—"}
              </span>
              <span className="mcm-admin__card-label">
                {t("admin.statToday")}
              </span>
            </div>
            <div className="mcm-admin__card">
              <span className="mcm-admin__card-num">
                {stats?.total_files ?? "—"}
              </span>
              <span className="mcm-admin__card-label">
                {t("admin.statFiles")}
              </span>
            </div>
          </div>
        )}

        {tab === "users" && (
          <div className="mcm-admin__section">
            <div className="mcm-admin__newuser">
              <UserPlus size={16} />
              <input
                placeholder={t("admin.email")}
                value={nuEmail}
                onChange={(e) => setNuEmail(e.target.value)}
              />
              <input
                placeholder={t("admin.name")}
                value={nuName}
                onChange={(e) => setNuName(e.target.value)}
              />
              <input
                type="password"
                placeholder={t("admin.password")}
                value={nuPassword}
                onChange={(e) => setNuPassword(e.target.value)}
              />
              <select
                aria-label={t("admin.role")}
                value={nuRole}
                onChange={(e) => setNuRole(e.target.value)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`admin.role${r[0].toUpperCase()}${r.slice(1)}` as any)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="mcm-admin__primary"
                onClick={handleCreate}
                disabled={busy || !nuEmail.trim() || !nuPassword}
              >
                {t("admin.create")}
              </button>
            </div>

            <table className="mcm-admin__table">
              <thead>
                <tr>
                  <th>{t("admin.colUser")}</th>
                  <th>{t("admin.colRole")}</th>
                  <th>{t("admin.colStatus")}</th>
                  <th>{t("admin.colLastLogin")}</th>
                  <th>{t("admin.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={5}>{t("admin.loading")}</td>
                  </tr>
                )}
                {!loading && users.length === 0 && (
                  <tr>
                    <td colSpan={5}>{t("admin.empty")}</td>
                  </tr>
                )}
                {users.map((u) => {
                  const banned = !!u.banned_until && u.banned_until !== "none";
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>
                          {u.user_metadata?.display_name ||
                            u.user_metadata?.name ||
                            u.email}
                        </strong>
                        <span className="mcm-admin__sub">{u.email}</span>
                      </td>
                      <td>
                        <select
                          aria-label={t("admin.role")}
                          value={u.app_metadata?.role ?? "member"}
                          onChange={(e) => void setRole(u, e.target.value)}
                          disabled={busy}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span
                          className={
                            banned
                              ? "mcm-admin__badge --off"
                              : "mcm-admin__badge --on"
                          }
                        >
                          {banned ? t("admin.disabled") : t("admin.active")}
                        </span>
                      </td>
                      <td>{fmtIso(u.last_sign_in_at)}</td>
                      <td className="mcm-admin__row-actions">
                        <button
                          type="button"
                          onClick={() => void toggleDisabled(u)}
                        >
                          {banned ? t("admin.enable") : t("admin.disable")}
                        </button>
                        <button type="button" onClick={() => void resetPw(u)}>
                          {t("admin.reset")}
                        </button>
                        <button
                          type="button"
                          className="mcm-admin__danger"
                          title={t("admin.delete")}
                          aria-label={t("admin.delete")}
                          onClick={() => void removeUser(u)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === "meetings" && (
          <div className="mcm-admin__section">
            <table className="mcm-admin__table">
              <thead>
                <tr>
                  <th>{t("admin.colMeeting")}</th>
                  <th>{t("admin.colProject")}</th>
                  <th>{t("admin.colHost")}</th>
                  <th>{t("admin.colParticipants")}</th>
                  <th>{t("admin.colDuration")}</th>
                  <th>{t("admin.colCreated")}</th>
                  <th>{t("admin.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7}>{t("admin.loading")}</td>
                  </tr>
                )}
                {!loading && meetings.length === 0 && (
                  <tr>
                    <td colSpan={7}>{t("admin.empty")}</td>
                  </tr>
                )}
                {meetings.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.title || m.id}</strong>
                      {m.topic && <span className="mcm-admin__sub">{m.topic}</span>}
                    </td>
                    <td>{m.project_name || "—"}</td>
                    <td>{m.created_by || "—"}</td>
                    <td>{m.participant_count ?? "—"}</td>
                    <td>{fmtDur(m.duration_s)}</td>
                    <td>{fmtDate(m.created_at)}</td>
                    <td className="mcm-admin__row-actions">
                      <button
                        type="button"
                        className="mcm-admin__danger"
                        title={t("admin.delete")}
                        aria-label={t("admin.delete")}
                        onClick={() => void removeMeeting(m)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "cost" && (
          <div className="mcm-admin__pad">
            <p className="mcm-admin__note">{t("admin.billingNote")}</p>
            <div className="mcm-admin__cards">
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {cost?.meetings ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.statMeetings")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {cost?.meeting_minutes ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.costUsage")} (min)
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {fmtBytes(cost?.storage_bytes)}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.statFiles")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  $
                  {(
                    ((cost?.storage_bytes ?? 0) / 1024 ** 3) *
                    R2_USD_PER_GB_MONTH
                  ).toFixed(3)}
                  /mo
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.costEstimate")} (R2)
                </span>
              </div>
            </div>
            <h4 className="mcm-admin__h4">{t("admin.costBilling")}</h4>
            <div className="mcm-admin__links">
              {BILLING_LINKS.map((l) => (
                <a
                  key={l.name}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {l.name} ↗
                </a>
              ))}
            </div>
          </div>
        )}

        {tab === "integrations" && (
          <div className="mcm-admin__section">
            <table className="mcm-admin__table">
              <tbody>
                {integrations.map((i) => (
                  <tr key={i.name}>
                    <td>
                      <strong>{i.name}</strong>
                      <span className="mcm-admin__sub">{i.note}</span>
                    </td>
                    <td>
                      <span
                        className={
                          i.configured === true
                            ? "mcm-admin__badge --on"
                            : i.configured === false
                            ? "mcm-admin__badge --off"
                            : "mcm-admin__badge"
                        }
                      >
                        {i.configured === true
                          ? t("admin.integConfigured")
                          : i.configured === false
                          ? t("admin.integNotConfigured")
                          : t("admin.integExternal")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "storage" && (
          <div className="mcm-admin__pad">
            <div className="mcm-admin__cards">
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {fmtBytes(storage?.total.bytes)}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.storageTotal")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {storage?.total.files ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.statFiles")}
                </span>
              </div>
            </div>
            <h4 className="mcm-admin__h4">{t("admin.storageByKind")}</h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {(storage?.byKind ?? []).map((k) => (
                    <tr key={k.kind ?? "?"}>
                      <td>
                        <strong>{k.kind ?? "—"}</strong>
                      </td>
                      <td>
                        {k.files} {t("admin.files")}
                      </td>
                      <td>{fmtBytes(k.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h4 className="mcm-admin__h4">{t("admin.storageTopMeetings")}</h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {(storage?.topMeetings ?? []).map((m) => (
                    <tr key={m.meeting_id}>
                      <td>
                        <strong>{m.title || m.meeting_id}</strong>
                      </td>
                      <td>
                        {m.files} {t("admin.files")}
                      </td>
                      <td>{fmtBytes(m.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="mcm-admin__section">
            <table className="mcm-admin__table">
              <thead>
                <tr>
                  <th>{t("admin.auditTime")}</th>
                  <th>{t("admin.auditActor")}</th>
                  <th>{t("admin.auditAction")}</th>
                  <th>{t("admin.auditTarget")}</th>
                </tr>
              </thead>
              <tbody>
                {audit.length === 0 && (
                  <tr>
                    <td colSpan={4}>{t("admin.empty")}</td>
                  </tr>
                )}
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.ts)}</td>
                    <td>{e.actor_email || "—"}</td>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td className="mcm-admin__sub">{e.target || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "recordings" && (
          <div className="mcm-admin__pad mcm-admin__center">
            <p className="mcm-admin__note">{t("admin.recordingsSoon")}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminConsole;
