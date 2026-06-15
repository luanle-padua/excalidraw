// "Quản lý khách" — CENTRALIZED project-guest manager (06-15). One place to
// see/manage guests ACROSS every project the caller can manage, instead of
// project-by-project. The list is grouped by project; per-guest Reset/Revoke
// and per-project "Clean tất cả khách" reuse the per-project endpoints, and a
// single Issue form with a PROJECT SELECTOR issues into any project the caller
// owns/is a member of.
//
// CONFIDENTIALITY: the list comes from /v1/me/project-guests, which scopes
// SERVER-SIDE to the caller's project memberships (admin → all). The project
// selector is likewise restricted to owned/member projects (NOT invitee) — we
// never offer to manage a project the worker would 403 on.

import {
  Check,
  Copy,
  KeyRound,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { showAppToast } from "../../data/appToast";
import {
  cleanProjectGuests,
  issueProjectGuest,
  listMyProjectGuests,
  resetProjectGuest,
  revokeProjectGuest,
  type MyProjectGuest,
} from "../../data/projectGuests";
import { listProjectsChecked, type Project } from "../../data/projects";
import { useT } from "../../i18n/mcm";

import "./ProjectMemberRoster.scss";

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString() : "—";

/** Copy text to the clipboard, falling back to a prompt the host can copy
 *  from manually (works even where the Clipboard API is blocked). */
const copyOrPrompt = async (promptLabel: string, text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt(promptLabel, text);
    return false;
  }
};

export const GuestManager = () => {
  const t = useT();
  const [guests, setGuests] = useState<MyProjectGuest[]>([]);
  // Projects the caller can ISSUE into — owned/member only (NOT invitee).
  const [manageable, setManageable] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [label, setLabel] = useState("");
  const [realEmail, setRealEmail] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The just-issued (or just-reset) credentials — shown ONCE, copyable.
  const [creds, setCreds] = useState<{
    login: string;
    password: string;
  } | null>(null);
  const [credsCopied, setCredsCopied] = useState(false);

  const reload = useCallback(() => {
    void listMyProjectGuests().then(setGuests);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    void listProjectsChecked().then((r) => {
      if (!r.ok) {
        return;
      }
      const mine = r.items.filter((p) => p.access !== "invitee");
      setManageable(mine);
      // Default the selector to the first manageable project.
      setProjectId((cur) => cur || mine[0]?.id || "");
    });
  }, []);

  // Group guests by project (preserving the server's project_name/created_at
  // ordering — the list already arrives ordered by project name then date).
  const groups = useMemo(() => {
    const byProject = new Map<
      string,
      { name: string; guests: MyProjectGuest[] }
    >();
    for (const g of guests) {
      const grp = byProject.get(g.project_id);
      if (grp) {
        grp.guests.push(g);
      } else {
        byProject.set(g.project_id, { name: g.project_name, guests: [g] });
      }
    }
    return [...byProject.entries()].map(([id, v]) => ({ id, ...v }));
  }, [guests]);

  const issue = async () => {
    if (!projectId || !label.trim() || issuing) {
      return;
    }
    setIssuing(true);
    const r = await issueProjectGuest(
      projectId,
      label.trim(),
      realEmail.trim() || undefined,
    );
    setIssuing(false);
    if (!r) {
      showAppToast(t("projGuest.errIssue"));
      return;
    }
    setLabel("");
    setRealEmail("");
    setCreds({ login: r.login, password: r.password });
    setCredsCopied(false);
    reload();
  };

  const reset = async (g: MyProjectGuest) => {
    if (busyId) {
      return;
    }
    setBusyId(g.id);
    const r = await resetProjectGuest(g.project_id, g.id);
    setBusyId(null);
    if (!r) {
      showAppToast(t("projGuest.errReset"));
      return;
    }
    setCreds({ login: r.login, password: r.password });
    setCredsCopied(false);
  };

  const revoke = async (g: MyProjectGuest) => {
    if (
      busyId ||
      !window.confirm(
        t("projGuest.revokeConfirm", { label: g.label || g.login }),
      )
    ) {
      return;
    }
    setBusyId(g.id);
    const ok = await revokeProjectGuest(g.project_id, g.id);
    setBusyId(null);
    if (!ok) {
      showAppToast(t("projGuest.errRevoke"));
      return;
    }
    reload();
  };

  const clean = async (pid: string) => {
    if (!window.confirm(t("projGuest.cleanConfirm"))) {
      return;
    }
    const { ok, removed } = await cleanProjectGuests(pid);
    if (!ok) {
      showAppToast(t("projGuest.errRevoke"));
      return;
    }
    showAppToast(t("projGuest.cleanDone", { count: removed }));
    setCreds(null);
    reload();
  };

  const copyCreds = async () => {
    if (!creds) {
      return;
    }
    await copyOrPrompt(
      t("projGuest.copyCreds"),
      `${creds.login} / ${creds.password}`,
    );
    setCredsCopied(true);
    window.setTimeout(() => setCredsCopied(false), 2000);
  };

  return (
    <div className="mcm-roster">
      <p className="mcm-roster__hint">{t("projGuest.hint")}</p>

      {/* Issue form — project selector + display name (required) + optional
          real email. The selector only lists projects we can actually manage. */}
      <div className="mcm-roster__guestform">
        <label className="mcm-select" title={t("projGuest.pickProject")}>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label={t("projGuest.pickProject")}
          >
            <option value="" disabled>
              {t("projGuest.pickProject")}
            </option>
            {manageable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ""}
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void issue()}
          placeholder={t("projGuest.labelPlaceholder")}
          aria-label={t("projGuest.labelLabel")}
        />
        <input
          type="email"
          value={realEmail}
          onChange={(e) => setRealEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void issue()}
          placeholder={t("projGuest.realEmailPlaceholder")}
          aria-label={t("projGuest.realEmailLabel")}
        />
        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--sm"
          onClick={() => void issue()}
          disabled={issuing || !projectId || !label.trim()}
        >
          <UserPlus size={15} />{" "}
          {issuing ? t("projGuest.issuing") : t("projGuest.issue")}
        </button>
      </div>

      {/* Credentials shown ONCE after issue/reset. */}
      {creds && (
        <div className="mcm-guest-creds">
          <strong>{t("projGuest.issued")}</strong>
          <p>{t("projGuest.issuedHint")}</p>
          <code>
            {t("projGuest.loginLabel")}: {creds.login}
            {"\n"}
            {t("projGuest.passwordLabel")}: {creds.password}
          </code>
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary mcm-btn--sm"
            onClick={() => void copyCreds()}
          >
            {credsCopied ? <Check size={14} /> : <Copy size={14} />}
            {credsCopied ? t("projGuest.copied") : t("projGuest.copyCreds")}
          </button>
        </div>
      )}

      {/* Guests grouped by project. */}
      {groups.length === 0 ? (
        <p className="mcm-roster__empty">{t("projGuest.noneAll")}</p>
      ) : (
        groups.map((grp) => (
          <div key={grp.id} className="mcm-roster__group">
            <div className="mcm-roster__group-head">
              <h4 className="mcm-roster__group-title">{grp.name}</h4>
              <button
                type="button"
                className="mcm-btn mcm-btn--sm"
                onClick={() => void clean(grp.id)}
              >
                <Trash2 size={14} /> {t("projGuest.clean")}
              </button>
            </div>
            <ul className="mcm-roster__guests">
              {grp.guests.map((g) => (
                <li key={g.id} className="mcm-roster__guest">
                  <span className="mcm-roster__guest-main">
                    <UsersRound size={14} aria-hidden="true" />
                    <span className="mcm-roster__guest-name">
                      {g.label || g.login}
                    </span>
                    <span className="mcm-roster__guest-login">{g.login}</span>
                    {g.real_email && (
                      <span className="mcm-roster__guest-sub">
                        {g.real_email}
                      </span>
                    )}
                    <span className="mcm-roster__guest-sub">
                      {fmtDate(g.created_at)}
                    </span>
                  </span>
                  <span className="mcm-roster__guest-actions">
                    <button
                      type="button"
                      className="mcm-icon-btn mcm-icon-btn--sm"
                      title={t("projGuest.reset")}
                      aria-label={t("projGuest.reset")}
                      onClick={() => void reset(g)}
                      disabled={busyId === g.id}
                    >
                      <KeyRound size={14} />
                    </button>
                    <button
                      type="button"
                      className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
                      title={t("projGuest.revoke")}
                      aria-label={t("projGuest.revoke")}
                      onClick={() => void revoke(g)}
                      disabled={busyId === g.id}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
};

export default GuestManager;
