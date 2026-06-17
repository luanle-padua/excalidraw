import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Briefcase,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  Eye,
  FileText,
  FolderKanban,
  HardDrive,
  Image as ImageIcon,
  LayoutDashboard,
  Lock,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import {
  addAdminProjectMembers,
  createAdminUser,
  deleteAdminMeeting,
  deleteAdminProject,
  deleteAdminUser,
  getAdminAnalytics,
  getAdminAudit,
  getAdminCost,
  getAdminIntegrations,
  getAdminMeetingDetail,
  getAdminProjectMembers,
  getAdminSettings,
  getAdminStats,
  getAdminStorage,
  listAdminMeetings,
  listAdminProjects,
  listAdminUsers,
  openAdminMeetingContent,
  putAdminSettings,
  removeAdminProjectMember,
  updateAdminUser,
  type AdminAnalytics,
  type AdminAuditEntry,
  type AdminCost,
  type AdminIntegration,
  type AdminMeeting,
  type AdminMeetingDetail,
  type AdminProject,
  type AdminProjectMember,
  type AdminStats,
  type AdminStorage,
  type AdminUser,
} from "../../data/admin";
import {
  deleteBackdrop,
  fetchBackdropImage,
  listAdminBackdrops,
  updateBackdrop,
  uploadBackdrop,
  type AdminBackdrop,
} from "../../data/backdrops";
import { createGuest } from "../../data/guests";
import { markReviewRoom, markStealthRoom } from "../../data/reviewMode";
import { isInternalEmail as isInternal, signOut } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { statusBucket } from "./meetingColors";

import { ClientsManager } from "./ClientsManager";
import { LangThemeSwitcher } from "./LangThemeSwitcher";

import "./AdminConsole.scss";

type Tab =
  | "dashboard"
  | "users"
  | "clients"
  | "projects"
  | "meetings"
  | "analytics"
  | "cost"
  | "integrations"
  | "storage"
  | "audit"
  | "settings"
  | "security"
  | "backdrops"
  | "recordings";

const SETTING_DEFAULTS: Record<string, string> = {
  org_name: "Canvas M",
  internal_domains: "mapgroup.co.kr",
  default_waiting_room: "on",
  default_recording: "off",
  retention_days: "365",
};

const isAdminUser = (u: AdminUser): boolean => u.app_metadata?.role === "admin";

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
  {
    name: "Supabase",
    url: "https://supabase.com/dashboard/project/_/settings/billing",
  },
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

  // Client-page backdrops (admin-managed). `backdropThumbs` maps id → object
  // URL of the fetched image (the image route is auth-gated, so a bare <img
  // src> can't carry the JWT — we fetch the blob and createObjectURL it).
  const [backdrops, setBackdrops] = useState<AdminBackdrop[]>([]);
  const [backdropThumbs, setBackdropThumbs] = useState<Record<string, string>>(
    {},
  );
  const [newBackdropTitle, setNewBackdropTitle] = useState("");

  const openDetail = async (roomId: string) => {
    setLoading(true);
    try {
      setDetail(await getAdminMeetingDetail(roomId));
    } finally {
      setLoading(false);
    }
  };

  // ---- Projects back-office (06-10 #1) ----------------------------------
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [projectDetail, setProjectDetail] = useState<AdminProject | null>(null);
  const [members, setMembers] = useState<AdminProjectMember[]>([]);
  const [memberInput, setMemberInput] = useState("");
  // Compliance open joins the meeting through the SAME collab API the app
  // uses — markReviewRoom + viewOnly keep the canvas/chat/library read-only.
  const collabAPI = useAtomValue(collabAPIAtom);

  const refreshProjects = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listAdminProjects());
    } finally {
      setLoading(false);
    }
  }, []);

  const openProjectDetail = async (p: AdminProject) => {
    setProjectDetail(p);
    setMemberInput("");
    setLoading(true);
    try {
      setMembers(await getAdminProjectMembers(p.id));
    } finally {
      setLoading(false);
    }
  };

  const handleAddMembers = async () => {
    if (!projectDetail || busy) {
      return;
    }
    const emails = memberInput
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!emails.length) {
      return;
    }
    setBusy(true);
    try {
      await addAdminProjectMembers(projectDetail.id, emails);
      setMemberInput("");
      setMembers(await getAdminProjectMembers(projectDetail.id));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (m: AdminProjectMember) => {
    if (!projectDetail || busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await removeAdminProjectMember(projectDetail.id, m.email);
      if (!res.ok && res.status === 409) {
        // Server refuses to orphan the project (last owner).
        window.alert(t("admin.lastOwnerError"));
      }
      setMembers(await getAdminProjectMembers(projectDetail.id));
    } finally {
      setBusy(false);
    }
  };

  // Force-delete cascades EVERY meeting + blobs + members — typed
  // confirmation (re-enter the project name) so it can't happen by reflex.
  const handleDeleteProject = async (p: AdminProject) => {
    if (busy) {
      return;
    }
    const typed = window.prompt(
      t("admin.confirmDeleteProject", {
        name: p.name ?? p.id,
        count: p.meeting_count,
      }),
    );
    if (typed === null) {
      return;
    }
    if (typed.trim() !== (p.name ?? p.id)) {
      window.alert(t("admin.deleteProjectMismatch"));
      return;
    }
    setBusy(true);
    try {
      await deleteAdminProject(p.id);
      setProjectDetail(null);
      await refreshProjects();
    } finally {
      setBusy(false);
    }
  };

  // COMPLIANCE OPEN: the Worker audit-logs the access (mandatory) and hands
  // back the room key; we then enter in STEALTH review ("ẩn hoàn toàn",
  // quyết định 06-10) — read-only AND no socket join, so the admin is never
  // visible to the people in the meeting (no presence, no participant row;
  // the audit_log entry is the only trace). Marks set BEFORE joining so a
  // reload re-enters stealth. A live meeting shows its last autosaved state.
  const handleComplianceOpen = async () => {
    if (!detail || busy) {
      return;
    }
    if (!window.confirm(t("admin.openContentConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      const res = await openAdminMeetingContent(detail.meeting.id);
      if (!res.ok) {
        window.alert(
          res.status === 409
            ? t("admin.openContentNoKey")
            : t("admin.openContentFailed"),
        );
        return;
      }
      markReviewRoom(res.roomId);
      markStealthRoom(res.roomId);
      window.history.pushState(
        {},
        "",
        getCollaborationLink({ roomId: res.roomId, roomKey: res.roomKey }),
      );
      if (collabAPI) {
        if (collabAPI.isCollaborating()) {
          collabAPI.stopCollaboration(false);
        }
        await collabAPI.startCollaboration(
          { roomId: res.roomId, roomKey: res.roomKey },
          { viewOnly: true, stealth: true },
        );
      }
    } finally {
      setBusy(false);
    }
  };

  // New-user form
  const [nuEmail, setNuEmail] = useState("");
  const [nuPassword, setNuPassword] = useState("");
  const [nuName, setNuName] = useState("");
  const [nuCompany, setNuCompany] = useState("");
  // Guest-account provisioning (external invitee logins, no email delivery).
  const [guEmail, setGuEmail] = useState("");
  const [guName, setGuName] = useState("");
  const [guBusy, setGuBusy] = useState(false);
  const [guError, setGuError] = useState<string | null>(null);
  const [guCopied, setGuCopied] = useState(false);
  const [guCreds, setGuCreds] = useState<{
    email: string;
    password?: string;
    existed: boolean;
  } | null>(null);
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

  const refreshBackdrops = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listAdminBackdrops();
      setBackdrops(rows);
      // Fetch any thumbnails we don't already have an object URL for.
      setBackdropThumbs((prev) => {
        rows.forEach((r) => {
          if (!prev[r.id]) {
            void fetchBackdropImage(r.id).then((src) => {
              if (src) {
                setBackdropThumbs((m) => ({ ...m, [r.id]: src }));
              }
            });
          }
        });
        return prev;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Revoke any backdrop thumbnail object URLs when the console unmounts.
  useEffect(
    () => () => {
      setBackdropThumbs((m) => {
        Object.values(m).forEach((src) => URL.revokeObjectURL(src));
        return {};
      });
    },
    [],
  );

  useEffect(() => {
    void getAdminStats().then(setStats);
  }, []);

  useEffect(() => {
    setDetail(null);
    setProjectDetail(null);
    if (tab === "users" || tab === "clients") {
      void refreshUsers();
    } else if (tab === "projects") {
      void refreshProjects();
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
    } else if (tab === "backdrops") {
      void refreshBackdrops();
    }
  }, [tab, refreshUsers, refreshMeetings, refreshProjects, refreshBackdrops]);

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
  const settingOf = (key: string) =>
    settings[key] ?? SETTING_DEFAULTS[key] ?? "";

  const handleBackdropUpload = async (file: File | null) => {
    if (!file || busy) {
      return;
    }
    setBusy(true);
    try {
      await uploadBackdrop(file, newBackdropTitle);
      setNewBackdropTitle("");
      await refreshBackdrops();
    } finally {
      setBusy(false);
    }
  };

  const handleBackdropDelete = async (id: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await deleteBackdrop(id);
      setBackdropThumbs((m) => {
        if (m[id]) {
          URL.revokeObjectURL(m[id]);
        }
        const { [id]: _drop, ...rest } = m;
        return rest;
      });
      await refreshBackdrops();
    } finally {
      setBusy(false);
    }
  };

  // Reorder by swapping sort_order with the neighbour in `dir` direction.
  const handleBackdropMove = async (id: string, dir: -1 | 1) => {
    if (busy) {
      return;
    }
    const idx = backdrops.findIndex((b) => b.id === id);
    const swapIdx = idx + dir;
    if (idx === -1 || swapIdx < 0 || swapIdx >= backdrops.length) {
      return;
    }
    const a = backdrops[idx];
    const b = backdrops[swapIdx];
    setBusy(true);
    try {
      await updateBackdrop(a.id, { sort_order: b.sort_order });
      await updateBackdrop(b.id, { sort_order: a.sort_order });
      await refreshBackdrops();
    } finally {
      setBusy(false);
    }
  };

  const handleBackdropRename = async (id: string, title: string) => {
    await updateBackdrop(id, { title });
    await refreshBackdrops();
  };

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

  const handleCreateGuest = async () => {
    const e = guEmail.trim().toLowerCase();
    if (!e || guBusy) {
      return;
    }
    if (isInternal(e)) {
      setGuError(t("guest.errInternal"));
      return;
    }
    setGuBusy(true);
    setGuError(null);
    setGuCreds(null);
    setGuCopied(false);
    const r = await createGuest(e, guName.trim() || undefined);
    setGuBusy(false);
    if (!r.ok) {
      setGuError(
        r.status === 403
          ? t("guest.errForbidden")
          : r.status === 400
          ? t("guest.errInvalid")
          : t("guest.errNetwork"),
      );
      return;
    }
    setGuCreds({
      email: r.email,
      password: r.existed ? undefined : r.password,
      existed: r.existed,
    });
    setGuEmail("");
    setGuName("");
    void refreshUsers();
  };

  const copyGuestCreds = async () => {
    if (!guCreds) {
      return;
    }
    const line = guCreds.password
      ? `${guCreds.email} / ${guCreds.password}`
      : guCreds.email;
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      window.prompt(t("guest.copyAll"), line);
    }
    setGuCopied(true);
    window.setTimeout(() => setGuCopied(false), 2000);
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
            {md?.title && (
              <span className="mcm-pill mcm-pill--accent mcm-pill--tag">
                {md.title}
              </span>
            )}
          </strong>
          <span className="mcm-table__sub">{u.email}</span>
          {(md?.department || md?.company) && (
            <span className="mcm-table__sub">
              {md?.department || md?.company}
            </span>
          )}
        </td>
        <td>
          <span
            className={`mcm-pill ${banned ? "mcm-pill--off" : "mcm-pill--on"}`}
          >
            {banned ? t("admin.disabled") : t("admin.active")}
          </span>
        </td>
        <td>{fmtIso(u.last_sign_in_at)}</td>
        <td className="mcm-table__actions">
          {isAdminUser(u) ? (
            <span className="mcm-table__sub">
              <Lock size={12} style={{ verticalAlign: "-1px" }} /> admin
            </span>
          ) : (
            <>
              <button
                type="button"
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                onClick={() => void toggleDisabled(u)}
              >
                {banned ? t("admin.enable") : t("admin.disable")}
              </button>
              <button
                type="button"
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                onClick={() => void resetPw(u)}
              >
                {t("admin.reset")}
              </button>
              <button
                type="button"
                className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
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
          <img
            src="/canvas-m.png"
            alt="Canvas M"
            className="mcm-admin__logo-img"
          />
          <strong>{t("admin.title")}</strong>
        </div>
        <nav className="mcm-admin__tabs">
          <button
            type="button"
            className={`mcm-admin__tab${
              tab === "dashboard" ? " --active" : ""
            }`}
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
            className={`mcm-admin__tab${tab === "projects" ? " --active" : ""}`}
            onClick={() => setTab("projects")}
          >
            <FolderKanban size={16} /> {t("admin.tabProjects")}
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
            className={`mcm-admin__tab${
              tab === "analytics" ? " --active" : ""
            }`}
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
            className={`mcm-admin__tab${
              tab === "integrations" ? " --active" : ""
            }`}
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
            className={`mcm-admin__tab${
              tab === "backdrops" ? " --active" : ""
            }`}
            onClick={() => setTab("backdrops")}
          >
            <ImageIcon size={16} /> {t("admin.tabBackdrops")}
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
            className={`mcm-admin__tab${
              tab === "recordings" ? " --active" : ""
            }`}
            onClick={() => setTab("recordings")}
          >
            <Video size={16} /> {t("admin.tabRecordings")}
          </button>
        </nav>
        <div className="mcm-admin__top-actions">
          <LangThemeSwitcher />
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary mcm-btn--sm"
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
          <div className="mcm-tablecard">
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
                className="mcm-btn mcm-btn--primary mcm-btn--sm"
                onClick={handleCreate}
                disabled={busy || !nuEmail.trim() || !nuPassword}
              >
                {t("admin.create")}
              </button>
            </div>

            {/* Guest account: external email + optional name → server-generated
                temp password, shown once for the host to share manually. */}
            <div className="mcm-admin__newuser">
              <UserPlus size={16} />
              <input
                placeholder={t("guest.emailLabel")}
                value={guEmail}
                onChange={(e) => setGuEmail(e.target.value)}
              />
              <input
                placeholder={t("guest.namePlaceholder")}
                value={guName}
                onChange={(e) => setGuName(e.target.value)}
              />
              <button
                type="button"
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                onClick={handleCreateGuest}
                disabled={guBusy || !guEmail.trim()}
              >
                {guBusy ? t("guest.creating") : t("guest.create")}
              </button>
            </div>
            {guError && (
              <p role="alert" style={{ color: "#d04545", fontSize: "0.8rem" }}>
                {guError}
              </p>
            )}
            {guCreds && (
              <div className="mcm-guest-creds">
                <strong>{t("guest.title")}</strong>
                {guCreds.existed ? (
                  <p style={{ fontSize: "0.8rem", margin: "0.3rem 0 0" }}>
                    {t("guest.existed")}
                  </p>
                ) : (
                  <>
                    <p
                      style={{ fontSize: "0.78rem", margin: "0.3rem 0 0.4rem" }}
                    >
                      {t("guest.hint")}
                    </p>
                    <code
                      style={{
                        display: "block",
                        userSelect: "all",
                        wordBreak: "break-all",
                        fontSize: "0.82rem",
                        padding: "0.4rem 0.5rem",
                        borderRadius: 6,
                        background: "rgba(0,0,0,0.06)",
                      }}
                    >
                      {t("guest.emailLabel")}: {guCreds.email}
                      {"\n"}
                      {t("guest.passwordLabel")}: {guCreds.password}
                    </code>
                    <button
                      type="button"
                      className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                      onClick={() => void copyGuestCreds()}
                      style={{ marginTop: "0.4rem" }}
                    >
                      {guCopied ? <Check size={14} /> : <Copy size={14} />}
                      {guCopied ? t("guest.copied") : t("guest.copyAll")}
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="mcm-admin__toolbar">
              <span className="mcm-admin__count">
                {users.length} {t("admin.tabUsers")}
              </span>
              <button
                type="button"
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
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

            <table className="mcm-table">
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
                        <tr className="mcm-table__grouprow">
                          <td colSpan={4}>
                            <button
                              type="button"
                              className="mcm-table__grouptoggle"
                              onClick={() => toggleGroup(division)}
                            >
                              {isOpen ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                              <Building2 size={13} /> {division}
                              <span className="mcm-table__gcount">
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
          <div className="mcm-admin__pad">
            <h4 className="mcm-admin__h4">{t("clients.title")}</h4>
            <p className="mcm-admin__note">{t("clients.subtitle")}</p>
            <ClientsManager />

            {/* Secondary: external contacts that ALSO have a login account
                (Supabase users on a non-internal domain). Read-only monitor. */}
            <h4 className="mcm-admin__h4">{t("admin.tabUsers")}</h4>
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
          </div>
        )}

        {tab === "projects" && !projectDetail && (
          <div className="mcm-tablecard">
            <table className="mcm-table">
              <thead>
                <tr>
                  <th>{t("admin.colProject")}</th>
                  <th>{t("admin.colOwner")}</th>
                  <th>{t("admin.colStage")}</th>
                  <th>{t("admin.tabMeetings")}</th>
                  <th>{t("admin.colMembers")}</th>
                  <th>{t("admin.colUpdated")}</th>
                  <th>{t("admin.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7}>{t("admin.loading")}</td>
                  </tr>
                )}
                {!loading && projects.length === 0 && (
                  <tr>
                    <td colSpan={7}>{t("admin.empty")}</td>
                  </tr>
                )}
                {!loading &&
                  projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button
                          type="button"
                          className="mcm-table__link"
                          onClick={() => void openProjectDetail(p)}
                        >
                          {p.name || p.id}
                        </button>
                        {(p.code || p.client) && (
                          <span className="mcm-table__sub">
                            {[p.code, p.client].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td>{p.host_email || "—"}</td>
                      <td>{p.stage || "—"}</td>
                      <td>{p.meeting_count}</td>
                      <td>{p.member_count}</td>
                      <td>{fmtDate(p.updated_at)}</td>
                      <td className="mcm-table__actions">
                        <button
                          type="button"
                          className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--outline"
                          title={t("admin.secMeta")}
                          aria-label={t("admin.secMeta")}
                          onClick={() => void openProjectDetail(p)}
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
                          title={t("admin.deleteProject")}
                          aria-label={t("admin.deleteProject")}
                          onClick={() => void handleDeleteProject(p)}
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

        {tab === "projects" && projectDetail && (
          <div className="mcm-admin__pad">
            <div className="mcm-admin__detail-head">
              <button
                type="button"
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                onClick={() => setProjectDetail(null)}
              >
                <ArrowLeft size={15} /> {t("admin.detailBack")}
              </button>
              <button
                type="button"
                className="mcm-btn mcm-btn--danger mcm-btn--sm"
                disabled={busy}
                onClick={() => void handleDeleteProject(projectDetail)}
              >
                <Trash2 size={14} /> {t("admin.deleteProject")}
              </button>
            </div>

            <h2 className="mcm-admin__detail-title">
              {projectDetail.name || projectDetail.id}
              {projectDetail.stage && (
                <span className="mcm-pill mcm-pill--accent">
                  {projectDetail.stage}
                </span>
              )}
            </h2>

            <h4 className="mcm-admin__h4">{t("admin.secMeta")}</h4>
            <dl className="mcm-admin__dl">
              <div>
                <dt>{t("admin.colOwner")}</dt>
                <dd>{projectDetail.host_email || "—"}</dd>
              </div>
              {projectDetail.code && (
                <div>
                  <dt>Code</dt>
                  <dd>{projectDetail.code}</dd>
                </div>
              )}
              {projectDetail.client && (
                <div>
                  <dt>{t("admin.tabClients")}</dt>
                  <dd>{projectDetail.client}</dd>
                </div>
              )}
              <div>
                <dt>{t("admin.tabMeetings")}</dt>
                <dd>{projectDetail.meeting_count}</dd>
              </div>
              <div>
                <dt>{t("admin.colCreated")}</dt>
                <dd>{fmtDate(projectDetail.created_at)}</dd>
              </div>
              <div>
                <dt>{t("admin.colUpdated")}</dt>
                <dd>{fmtDate(projectDetail.updated_at)}</dd>
              </div>
            </dl>

            <h4 className="mcm-admin__h4">
              {t("admin.secMembers")} ({members.length})
            </h4>
            <div className="mcm-tablecard">
              <div className="mcm-admin__newuser">
                <UserPlus size={16} />
                <input
                  placeholder={t("admin.membersPlaceholder")}
                  value={memberInput}
                  onChange={(e) => setMemberInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void handleAddMembers();
                    }
                  }}
                />
                <button
                  type="button"
                  className="mcm-btn mcm-btn--primary mcm-btn--sm"
                  onClick={() => void handleAddMembers()}
                  disabled={busy || !memberInput.trim()}
                >
                  {t("admin.addMembers")}
                </button>
                <span className="mcm-admin__count">
                  {t("admin.membersHint")}
                </span>
              </div>
              <table className="mcm-table">
                <thead>
                  <tr>
                    <th>{t("admin.email")}</th>
                    <th>{t("admin.colRole")}</th>
                    <th>{t("clients.colAddedBy")}</th>
                    <th>{t("clients.colAdded")}</th>
                    <th>{t("admin.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={5}>{t("admin.loading")}</td>
                    </tr>
                  )}
                  {!loading && members.length === 0 && (
                    <tr>
                      <td colSpan={5}>{t("admin.noMembers")}</td>
                    </tr>
                  )}
                  {!loading &&
                    members.map((m) => (
                      <tr key={m.email}>
                        <td>
                          <strong>{m.email}</strong>
                        </td>
                        <td>
                          <span
                            className={`mcm-pill ${
                              m.role === "owner"
                                ? "mcm-pill--accent"
                                : "mcm-pill--neutral"
                            }`}
                          >
                            {m.role || "member"}
                          </span>
                        </td>
                        <td>{m.added_by || "—"}</td>
                        <td>{fmtDate(m.added_at)}</td>
                        <td className="mcm-table__actions">
                          <button
                            type="button"
                            className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                            disabled={busy}
                            onClick={() => void handleRemoveMember(m)}
                          >
                            {t("admin.removeMember")}
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "meetings" && !detail && (
          <div className="mcm-tablecard">
            <table className="mcm-table">
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
                        className="mcm-table__link"
                        onClick={() => void openDetail(m.id)}
                      >
                        {m.title || m.id}
                      </button>
                      {m.topic && (
                        <span className="mcm-table__sub">{m.topic}</span>
                      )}
                    </td>
                    <td>{m.project_name || "—"}</td>
                    <td>{m.created_by || "—"}</td>
                    <td>{m.participant_count ?? "—"}</td>
                    <td>{fmtDur(m.duration_s)}</td>
                    <td>{fmtDate(m.created_at)}</td>
                    <td className="mcm-table__actions">
                      <button
                        type="button"
                        className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--outline"
                        title={t("admin.secMeta")}
                        aria-label={t("admin.secMeta")}
                        onClick={() => void openDetail(m.id)}
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        type="button"
                        className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
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
                className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                onClick={() => setDetail(null)}
              >
                <ArrowLeft size={15} /> {t("admin.detailBack")}
              </button>
              <div className="mcm-admin__detail-actions">
                {/* COMPLIANCE: read-only content access, audit-logged
                    server-side before the key is released. */}
                <button
                  type="button"
                  className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                  disabled={busy}
                  title={t("admin.openContentConfirm")}
                  onClick={() => void handleComplianceOpen()}
                >
                  <ShieldCheck size={14} /> {t("admin.openContent")}
                </button>
                <button
                  type="button"
                  className="mcm-btn mcm-btn--danger mcm-btn--sm"
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
            </div>

            <h2 className="mcm-admin__detail-title">
              {detail.meeting.title || detail.meeting.id}
              {detail.meeting.status && (
                <span
                  className={`mcm-pill mcm-pill--${statusBucket(
                    detail.meeting.status,
                  )}`}
                >
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
              <div>
                <dt>{t("admin.mOrganizer")}</dt>
                <dd>{detail.meeting.organizer_email || "—"}</dd>
              </div>
              <div>
                <dt>{t("admin.mHost")}</dt>
                <dd>{detail.meeting.host_email || "—"}</dd>
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

            {detail.meeting.ai_summary && (
              <>
                <h4 className="mcm-admin__h4">{t("admin.secAiSummary")}</h4>
                <div className="mcm-admin__summary">
                  {detail.meeting.ai_summary}
                  {detail.meeting.ai_summary_at && (
                    <span className="mcm-admin__summary-when">
                      {fmtDate(detail.meeting.ai_summary_at)}
                    </span>
                  )}
                </div>
              </>
            )}

            <h4 className="mcm-admin__h4">
              {t("admin.secParticipants")} ({detail.participants.length})
            </h4>
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
                        <span className="mcm-table__sub">{p.user_email}</span>
                      </td>
                      <td>{fmtDate(p.joined_at)}</td>
                      <td>{fmtDate(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mcm-admin__h4">
              {t("admin.secInvitees")} ({(detail.invitees ?? []).length})
            </h4>
            <div className="mcm-tablecard">
              <table className="mcm-table">
                <thead>
                  <tr>
                    <th>{t("admin.email")}</th>
                    <th>{t("admin.invKind")}</th>
                    <th>{t("admin.colRole")}</th>
                    <th>{t("admin.invStatus")}</th>
                    <th>{t("admin.invitedBy")}</th>
                    <th>{t("admin.invitedAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.invitees ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6}>{t("admin.noInvitees")}</td>
                    </tr>
                  )}
                  {(detail.invitees ?? []).map((inv) => (
                    <tr key={inv.email}>
                      <td>
                        <strong>{inv.email}</strong>
                      </td>
                      <td>{inv.kind || "—"}</td>
                      <td>{inv.role || "—"}</td>
                      <td>
                        <span
                          className={`mcm-pill ${
                            inv.status === "revoked"
                              ? "mcm-pill--off"
                              : "mcm-pill--neutral"
                          }`}
                        >
                          {inv.status || "—"}
                        </span>
                      </td>
                      <td>{inv.invited_by || "—"}</td>
                      <td>{fmtDate(inv.invited_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mcm-admin__h4">
              {t("admin.secFiles")} ({detail.files.length})
            </h4>
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
          <div className="mcm-tablecard">
            <table className="mcm-table">
              <tbody>
                {integrations.map((i) => (
                  <tr key={i.name}>
                    <td>
                      <strong>{i.name}</strong>
                      <span className="mcm-table__sub">{i.note}</span>
                    </td>
                    <td>
                      <span
                        className={
                          i.configured === true
                            ? "mcm-pill mcm-pill--on"
                            : i.configured === false
                            ? "mcm-pill mcm-pill--off"
                            : "mcm-pill mcm-pill--neutral"
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
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
          <div className="mcm-tablecard">
            <table className="mcm-table">
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
                      {/* Compliance content access stands out in the trail —
                          it's the accountability for the admin's open power. */}
                      {e.action === "admin.open_content" && (
                        <span className="mcm-pill mcm-pill--accent mcm-pill--tag">
                          <ShieldCheck size={10} style={{ marginRight: 3 }} />
                          compliance
                        </span>
                      )}
                    </td>
                    <td className="mcm-table__sub">{e.target || "—"}</td>
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
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
                        <span className="mcm-table__sub">{p.user_email}</span>
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
              className="mcm-btn mcm-btn--primary mcm-btn--sm"
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
            <div className="mcm-tablecard">
              <table className="mcm-table">
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
                      <td className="mcm-table__sub">{e.target || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "backdrops" && (
          <div className="mcm-admin__pad mcm-admin__backdrops">
            <p className="mcm-admin__note">{t("admin.backdropsIntro")}</p>
            <div className="mcm-admin__backdrop-upload">
              <input
                value={newBackdropTitle}
                onChange={(e) => setNewBackdropTitle(e.target.value)}
                placeholder={t("admin.backdropTitlePlaceholder")}
              />
              <label className="mcm-btn mcm-btn--primary mcm-btn--sm">
                <UserPlus size={14} /> {t("admin.backdropUpload")}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void handleBackdropUpload(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {backdrops.length === 0 ? (
              <p className="mcm-admin__note">{t("admin.backdropEmpty")}</p>
            ) : (
              <div className="mcm-admin__backdrop-grid">
                {backdrops.map((b, i) => (
                  <div key={b.id} className="mcm-admin__backdrop-card">
                    <div
                      className="mcm-admin__backdrop-thumb"
                      // Fetched (auth-gated) image as an object URL.
                      // eslint-disable-next-line react/forbid-dom-props
                      style={
                        backdropThumbs[b.id]
                          ? {
                              backgroundImage: `url("${backdropThumbs[b.id]}")`,
                            }
                          : undefined
                      }
                    >
                      {!backdropThumbs[b.id] && <ImageIcon size={24} />}
                    </div>
                    <input
                      className="mcm-admin__backdrop-title"
                      defaultValue={b.title ?? ""}
                      placeholder={t("admin.backdropTitlePlaceholder")}
                      onBlur={(e) => {
                        if (e.target.value !== (b.title ?? "")) {
                          void handleBackdropRename(b.id, e.target.value);
                        }
                      }}
                    />
                    <div className="mcm-admin__backdrop-actions">
                      <button
                        type="button"
                        className="mcm-icon-btn mcm-icon-btn--sm"
                        disabled={busy || i === 0}
                        title={t("admin.backdropMoveUp")}
                        onClick={() => void handleBackdropMove(b.id, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="mcm-icon-btn mcm-icon-btn--sm"
                        disabled={busy || i === backdrops.length - 1}
                        title={t("admin.backdropMoveDown")}
                        onClick={() => void handleBackdropMove(b.id, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
                        disabled={busy}
                        title={t("admin.backdropDelete")}
                        onClick={() => void handleBackdropDelete(b.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
