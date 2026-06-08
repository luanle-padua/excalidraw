import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Eye,
  FileText,
  HardDrive,
  LayoutDashboard,
  Lock,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Trash2,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  createAdminUser,
  deleteAdminMeeting,
  deleteAdminUser,
  getAdminAnalytics,
  getAdminAudit,
  getAdminCost,
  getAdminIntegrations,
  getAdminMeetingDetail,
  getAdminSettings,
  getAdminStats,
  getAdminStorage,
  listAdminMeetings,
  listAdminUsers,
  putAdminSettings,
  updateAdminUser,
  type AdminAnalytics,
  type AdminAuditEntry,
  type AdminCost,
  type AdminIntegration,
  type AdminMeeting,
  type AdminMeetingDetail,
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
  | "clients"
  | "meetings"
  | "analytics"
  | "cost"
  | "integrations"
  | "storage"
  | "audit"
  | "settings"
  | "security"
  | "recordings";

const SETTING_DEFAULTS: Record<string, string> = {
  org_name: "MAP CanvasMeet",
  internal_domains: "mapgroup.co.kr",
  default_waiting_room: "on",
  default_recording: "off",
  retention_days: "365",
};

const INTERNAL_DOMAIN = "@mapgroup.co.kr";
const isInternal = (email: string): boolean =>
  email.toLowerCase().endsWith(INTERNAL_DOMAIN);
const isAdminUser = (u: AdminUser): boolean =>
  u.app_metadata?.role === "admin";

// Korean corporate rank order (직급), most senior first — drives the default
// sort inside each department group. Unknown titles sort last.
const TITLE_RANK = [
  "회장",
  "이사장",
  "부회장",
  "고문",
  "사장",
  "부사장",
  "전무",
  "상무",
  "전문위원",
  "이사",
  "이사대우",
  "실장",
  "소장(S1)",
  "소장(S2)",
  "소장",
  "부장",
  "차장",
  "팀장",
  "부팀장",
  "과장",
  "대리",
  "4급사원",
  "5급사원",
  "6급사원",
];
const rankOf = (title?: string): number => {
  const i = title ? TITLE_RANK.indexOf(title) : -1;
  return i === -1 ? 999 : i;
};

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
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [detail, setDetail] = useState<AdminMeetingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const openDetail = async (roomId: string) => {
    setLoading(true);
    try {
      setDetail(await getAdminMeetingDetail(roomId));
    } finally {
      setLoading(false);
    }
  };

  // New-user form
  const [nuEmail, setNuEmail] = useState("");
  const [nuPassword, setNuPassword] = useState("");
  const [nuName, setNuName] = useState("");
  const [nuCompany, setNuCompany] = useState("");
  const [usersSort, setUsersSort] = useState<"rank" | "name">("rank");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

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
    setDetail(null);
    if (tab === "users" || tab === "clients") {
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
    } else if (tab === "analytics") {
      void getAdminAnalytics().then(setAnalytics);
    } else if (tab === "settings") {
      void getAdminSettings().then((s) => {
        setSettings(s);
        setSettingsDirty(false);
      });
    } else if (tab === "security") {
      void refreshUsers();
      void getAdminAudit().then(setAudit);
    }
  }, [tab, refreshUsers, refreshMeetings]);

  const setSetting = (key: string, value: string) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setSettingsDirty(true);
  };
  const saveSettings = async () => {
    setBusy(true);
    await putAdminSettings(settings);
    setBusy(false);
    setSettingsDirty(false);
  };
  const settingOf = (key: string) => settings[key] ?? SETTING_DEFAULTS[key] ?? "";

  const handleCreate = async () => {
    if (!nuEmail.trim() || !nuPassword || busy) {
      return;
    }
    setBusy(true);
    const ok = await createAdminUser({
      email: nuEmail.trim(),
      password: nuPassword,
      name: nuName.trim() || undefined,
      company: nuCompany.trim() || undefined,
    });
    setBusy(false);
    if (ok) {
      setNuEmail("");
      setNuPassword("");
      setNuName("");
      setNuCompany("");
      void refreshUsers();
    }
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

  const nameOf = (u: AdminUser) =>
    u.user_metadata?.name || u.user_metadata?.display_name || u.email;

  // INTERNAL staff grouped by division (phòng ban), sorted within each group by
  // rank (직급) or name. Groups themselves ordered alphabetically.
  const groupedUsers = useMemo(() => {
    const groups = new Map<string, AdminUser[]>();
    for (const u of users) {
      if (!isInternal(u.email)) {
        continue; // clients go to their own tab
      }
      const key = u.user_metadata?.division || "—";
      const arr = groups.get(key);
      if (arr) {
        arr.push(u);
      } else {
        groups.set(key, [u]);
      }
    }
    const byName = (a: AdminUser, b: AdminUser) =>
      nameOf(a).localeCompare(nameOf(b));
    const cmp =
      usersSort === "name"
        ? byName
        : (a: AdminUser, b: AdminUser) =>
            rankOf(a.user_metadata?.title) - rankOf(b.user_metadata?.title) ||
            byName(a, b);
    for (const arr of groups.values()) {
      arr.sort(cmp);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [users, usersSort]);

  // EXTERNAL clients (non-@mapgroup), flat list sorted by name.
  const clients = useMemo(
    () =>
      users
        .filter((u) => !isInternal(u.email))
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [users],
  );

  // One reusable user row (no actions on the admin account).
  const renderUserRow = (u: AdminUser) => {
    const banned = !!u.banned_until && u.banned_until !== "none";
    const md = u.user_metadata;
    return (
      <tr key={u.id}>
        <td>
          <strong>
            {md?.name || md?.display_name || u.email}
            {md?.title && <span className="mcm-admin__chip">{md.title}</span>}
          </strong>
          <span className="mcm-admin__sub">{u.email}</span>
          {(md?.department || md?.company) && (
            <span className="mcm-admin__sub">
              {md?.department || md?.company}
            </span>
          )}
        </td>
        <td>
          <span
            className={
              banned ? "mcm-admin__badge --off" : "mcm-admin__badge --on"
            }
          >
            {banned ? t("admin.disabled") : t("admin.active")}
          </span>
        </td>
        <td>{fmtIso(u.last_sign_in_at)}</td>
        <td className="mcm-admin__row-actions">
          {isAdminUser(u) ? (
            <span className="mcm-admin__sub">
              <Lock size={12} style={{ verticalAlign: "-1px" }} /> admin
            </span>
          ) : (
            <>
              <button type="button" onClick={() => void toggleDisabled(u)}>
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
            </>
          )}
        </td>
      </tr>
    );
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
            className={`mcm-admin__tab${tab === "clients" ? " --active" : ""}`}
            onClick={() => setTab("clients")}
          >
            <Briefcase size={16} /> {t("admin.tabClients")}
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
            className={`mcm-admin__tab${tab === "analytics" ? " --active" : ""}`}
            onClick={() => setTab("analytics")}
          >
            <BarChart3 size={16} /> {t("admin.tabAnalytics")}
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
            className={`mcm-admin__tab${tab === "security" ? " --active" : ""}`}
            onClick={() => setTab("security")}
          >
            <ShieldAlert size={16} /> {t("admin.tabSecurity")}
          </button>
          <button
            type="button"
            className={`mcm-admin__tab${tab === "settings" ? " --active" : ""}`}
            onClick={() => setTab("settings")}
          >
            <Settings size={16} /> {t("admin.tabSettings")}
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
              <button
                type="button"
                className="mcm-admin__primary"
                onClick={handleCreate}
                disabled={busy || !nuEmail.trim() || !nuPassword}
              >
                {t("admin.create")}
              </button>
            </div>

            <div className="mcm-admin__toolbar">
              <span className="mcm-admin__count">
                {users.length} {t("admin.tabUsers")}
              </span>
              <button
                type="button"
                className="mcm-admin__ghost"
                onClick={() =>
                  setUsersSort((s) => (s === "rank" ? "name" : "rank"))
                }
              >
                <ArrowUpDown size={14} /> {t("admin.sortBy")}{" "}
                {usersSort === "rank"
                  ? t("admin.sortRank")
                  : t("admin.sortName")}
              </button>
            </div>

            <table className="mcm-admin__table">
              <thead>
                <tr>
                  <th>{t("admin.colUser")}</th>
                  <th>{t("admin.colStatus")}</th>
                  <th>{t("admin.colLastLogin")}</th>
                  <th>{t("admin.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={4}>{t("admin.loading")}</td>
                  </tr>
                )}
                {!loading && users.length === 0 && (
                  <tr>
                    <td colSpan={4}>{t("admin.empty")}</td>
                  </tr>
                )}
                {!loading &&
                  groupedUsers.map(([division, list]) => {
                    const isOpen = !collapsed.has(division);
                    return (
                      <Fragment key={division}>
                        <tr className="mcm-admin__grouprow">
                          <td colSpan={4}>
                            <button
                              type="button"
                              className="mcm-admin__grouptoggle"
                              onClick={() => toggleGroup(division)}
                            >
                              {isOpen ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                              <Building2 size={13} /> {division}
                              <span className="mcm-admin__gcount">
                                {list.length}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {isOpen && list.map(renderUserRow)}
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}

        {tab === "clients" && (
          <div className="mcm-admin__section">
            <div className="mcm-admin__newuser">
              <Briefcase size={16} />
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
                placeholder={t("admin.company")}
                value={nuCompany}
                onChange={(e) => setNuCompany(e.target.value)}
              />
              <input
                type="password"
                placeholder={t("admin.password")}
                value={nuPassword}
                onChange={(e) => setNuPassword(e.target.value)}
              />
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
                  <th>{t("admin.colStatus")}</th>
                  <th>{t("admin.colLastLogin")}</th>
                  <th>{t("admin.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={4}>{t("admin.loading")}</td>
                  </tr>
                )}
                {!loading && clients.length === 0 && (
                  <tr>
                    <td colSpan={4}>{t("admin.noClients")}</td>
                  </tr>
                )}
                {!loading && clients.map(renderUserRow)}
              </tbody>
            </table>
          </div>
        )}

        {tab === "meetings" && !detail && (
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
                      <button
                        type="button"
                        className="mcm-admin__link"
                        onClick={() => void openDetail(m.id)}
                      >
                        {m.title || m.id}
                      </button>
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
                        title={t("admin.secMeta")}
                        aria-label={t("admin.secMeta")}
                        onClick={() => void openDetail(m.id)}
                      >
                        <Eye size={14} />
                      </button>
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

        {tab === "meetings" && detail && (
          <div className="mcm-admin__pad">
            <div className="mcm-admin__detail-head">
              <button
                type="button"
                className="mcm-admin__ghost"
                onClick={() => setDetail(null)}
              >
                <ArrowLeft size={15} /> {t("admin.detailBack")}
              </button>
              <button
                type="button"
                className="mcm-admin__ghost mcm-admin__danger"
                onClick={() =>
                  void (async () => {
                    if (window.confirm(t("admin.confirmDeleteMeeting"))) {
                      await deleteAdminMeeting(detail.meeting.id);
                      setDetail(null);
                      void refreshMeetings();
                    }
                  })()
                }
              >
                <Trash2 size={14} /> {t("admin.delete")}
              </button>
            </div>

            <h2 className="mcm-admin__detail-title">
              {detail.meeting.title || detail.meeting.id}
              {detail.meeting.status && (
                <span className="mcm-admin__badge --on">
                  {detail.meeting.status}
                </span>
              )}
            </h2>

            <h4 className="mcm-admin__h4">{t("admin.secProject")}</h4>
            <dl className="mcm-admin__dl">
              <div>
                <dt>{t("admin.colProject")}</dt>
                <dd>
                  {detail.meeting.project_name || "—"}
                  {detail.meeting.project_code
                    ? ` · ${detail.meeting.project_code}`
                    : ""}
                  {detail.meeting.project_stage
                    ? ` · ${detail.meeting.project_stage}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>{t("admin.colHost")}</dt>
                <dd>{detail.meeting.created_by || "—"}</dd>
              </div>
            </dl>

            <h4 className="mcm-admin__h4">{t("admin.secMeta")}</h4>
            <dl className="mcm-admin__dl">
              {detail.meeting.topic && (
                <div>
                  <dt>{t("admin.mTopic")}</dt>
                  <dd>{detail.meeting.topic}</dd>
                </div>
              )}
              {detail.meeting.description && (
                <div>
                  <dt>{t("admin.mDescription")}</dt>
                  <dd>{detail.meeting.description}</dd>
                </div>
              )}
              {detail.meeting.type && (
                <div>
                  <dt>{t("admin.mType")}</dt>
                  <dd>{detail.meeting.type}</dd>
                </div>
              )}
              {detail.meeting.discipline && (
                <div>
                  <dt>{t("admin.mDiscipline")}</dt>
                  <dd>{detail.meeting.discipline}</dd>
                </div>
              )}
              {detail.meeting.priority && (
                <div>
                  <dt>{t("admin.mPriority")}</dt>
                  <dd>{detail.meeting.priority}</dd>
                </div>
              )}
              {detail.meeting.confidentiality && (
                <div>
                  <dt>{t("admin.mConfidentiality")}</dt>
                  <dd>{detail.meeting.confidentiality}</dd>
                </div>
              )}
              {detail.meeting.scheduled_at && (
                <div>
                  <dt>{t("admin.mScheduled")}</dt>
                  <dd>{detail.meeting.scheduled_at}</dd>
                </div>
              )}
              <div>
                <dt>{t("admin.colDuration")}</dt>
                <dd>{fmtDur(detail.meeting.duration_s)}</dd>
              </div>
              <div>
                <dt>{t("admin.colCreated")}</dt>
                <dd>{fmtDate(detail.meeting.created_at)}</dd>
              </div>
              <div>
                <dt>{t("admin.mUpdated")}</dt>
                <dd>{fmtDate(detail.meeting.updated_at)}</dd>
              </div>
              <div>
                <dt>{t("admin.mLastOpened")}</dt>
                <dd>{fmtDate(detail.meeting.last_opened_at)}</dd>
              </div>
            </dl>

            <h4 className="mcm-admin__h4">
              {t("admin.secParticipants")} ({detail.participants.length})
            </h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <thead>
                  <tr>
                    <th>{t("admin.colUser")}</th>
                    <th>{t("admin.pJoined")}</th>
                    <th>{t("admin.pLastSeen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.participants.length === 0 && (
                    <tr>
                      <td colSpan={3}>{t("admin.noParticipants")}</td>
                    </tr>
                  )}
                  {detail.participants.map((p) => (
                    <tr key={p.user_email}>
                      <td>
                        <strong>{p.name || p.user_email}</strong>
                        <span className="mcm-admin__sub">{p.user_email}</span>
                      </td>
                      <td>{fmtDate(p.joined_at)}</td>
                      <td>{fmtDate(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mcm-admin__h4">
              {t("admin.secFiles")} ({detail.files.length})
            </h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {detail.files.length === 0 && (
                    <tr>
                      <td>{t("admin.noFiles")}</td>
                    </tr>
                  )}
                  {detail.files.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <FileText
                          size={13}
                          style={{ verticalAlign: "-2px", marginRight: 6 }}
                        />
                        {f.name || f.id}
                      </td>
                      <td>{f.kind || "—"}</td>
                      <td>{fmtBytes(f.size)}</td>
                      <td>{fmtDate(f.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

        {tab === "analytics" && (
          <div className="mcm-admin__pad">
            <div className="mcm-admin__cards">
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {analytics?.counts.meetings_7d ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.meetings7d")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {analytics?.counts.meetings_30d ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.meetings30d")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {analytics?.counts.participations ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.participations")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {analytics?.counts.unique_participants ?? "—"}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.uniqueParticipants")}
                </span>
              </div>
            </div>

            <h4 className="mcm-admin__h4">{t("admin.topProjects")}</h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {(analytics?.topProjects ?? []).length === 0 && (
                    <tr>
                      <td>{t("admin.empty")}</td>
                    </tr>
                  )}
                  {(analytics?.topProjects ?? []).map((p, i) => (
                    <tr key={i}>
                      <td>
                        <strong>{p.name || "—"}</strong>
                      </td>
                      <td>
                        {p.meetings} {t("admin.tabMeetings")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mcm-admin__h4">{t("admin.topParticipants")}</h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {(analytics?.topParticipants ?? []).length === 0 && (
                    <tr>
                      <td>{t("admin.empty")}</td>
                    </tr>
                  )}
                  {(analytics?.topParticipants ?? []).map((p) => (
                    <tr key={p.user_email}>
                      <td>
                        <strong>{p.name || p.user_email}</strong>
                        <span className="mcm-admin__sub">{p.user_email}</span>
                      </td>
                      <td>
                        {p.meetings} {t("admin.tabMeetings")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="mcm-admin__pad mcm-admin__settings">
            <label className="mcm-admin__field">
              <span>{t("admin.setOrgName")}</span>
              <input
                value={settingOf("org_name")}
                onChange={(e) => setSetting("org_name", e.target.value)}
              />
            </label>
            <label className="mcm-admin__field">
              <span>{t("admin.setInternalDomains")}</span>
              <input
                value={settingOf("internal_domains")}
                onChange={(e) => setSetting("internal_domains", e.target.value)}
              />
              <small>{t("admin.setInternalDomainsHint")}</small>
            </label>
            <label className="mcm-admin__field mcm-admin__field--row">
              <input
                type="checkbox"
                checked={settingOf("default_waiting_room") === "on"}
                onChange={(e) =>
                  setSetting(
                    "default_waiting_room",
                    e.target.checked ? "on" : "off",
                  )
                }
              />
              <span>{t("admin.setWaitingRoom")}</span>
            </label>
            <label className="mcm-admin__field mcm-admin__field--row">
              <input
                type="checkbox"
                checked={settingOf("default_recording") === "on"}
                onChange={(e) =>
                  setSetting(
                    "default_recording",
                    e.target.checked ? "on" : "off",
                  )
                }
              />
              <span>{t("admin.setRecording")}</span>
            </label>
            <label className="mcm-admin__field">
              <span>{t("admin.setRetention")}</span>
              <input
                type="number"
                value={settingOf("retention_days")}
                onChange={(e) => setSetting("retention_days", e.target.value)}
              />
            </label>
            <button
              type="button"
              className="mcm-admin__primary"
              onClick={() => void saveSettings()}
              disabled={busy || !settingsDirty}
            >
              {t("admin.save")}
            </button>
          </div>
        )}

        {tab === "security" && (
          <div className="mcm-admin__pad">
            <div className="mcm-admin__cards">
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">{users.length}</span>
                <span className="mcm-admin__card-label">
                  {t("admin.tabUsers")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {users.filter(isAdminUser).length}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.roleAdmin")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {
                    users.filter(
                      (u) => !!u.banned_until && u.banned_until !== "none",
                    ).length
                  }
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.disabled")}
                </span>
              </div>
              <div className="mcm-admin__card">
                <span className="mcm-admin__card-num">
                  {users.filter((u) => !isInternal(u.email)).length}
                </span>
                <span className="mcm-admin__card-label">
                  {t("admin.tabClients")}
                </span>
              </div>
            </div>
            <p className="mcm-admin__note">{t("admin.securityNote")}</p>
            <h4 className="mcm-admin__h4">{t("admin.tabAudit")}</h4>
            <div className="mcm-admin__section">
              <table className="mcm-admin__table">
                <tbody>
                  {audit.length === 0 && (
                    <tr>
                      <td>{t("admin.empty")}</td>
                    </tr>
                  )}
                  {audit.slice(0, 20).map((e) => (
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
