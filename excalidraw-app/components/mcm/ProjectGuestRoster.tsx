// "Khách dự án" — project-scoped guest management (new guest-access model,
// 06-15). Guest access is INDEPENDENT per project (strict confidentiality
// between departments): the host issues a SYNTHETIC login (never the guest's
// real email) + temp password scoped to THIS project, and the guest follows it
// across every meeting. Lists the project's active guests, issues new ones
// (credentials shown ONCE), resets / revokes one, and "cleans" all when the
// project is done. The worker gates every route to admin OR a project
// member/owner; an invitee detail never renders this (the worker would 403).

import {
  Check,
  Copy,
  KeyRound,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { showAppToast } from "../../data/appToast";
import {
  cleanProjectGuests,
  issueProjectGuest,
  listProjectGuests,
  resetProjectGuest,
  revokeProjectGuest,
  type ProjectGuest,
} from "../../data/projectGuests";
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

export const ProjectGuestRoster = ({ projectId }: { projectId: string }) => {
  const t = useT();
  const [guests, setGuests] = useState<ProjectGuest[]>([]);
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
    void listProjectGuests(projectId).then(setGuests);
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const issue = async () => {
    if (!label.trim() || issuing) {
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

  const reset = async (g: ProjectGuest) => {
    if (busyId) {
      return;
    }
    setBusyId(g.id);
    const r = await resetProjectGuest(projectId, g.id);
    setBusyId(null);
    if (!r) {
      showAppToast(t("projGuest.errReset"));
      return;
    }
    setCreds({ login: r.login, password: r.password });
    setCredsCopied(false);
  };

  const revoke = async (g: ProjectGuest) => {
    if (
      busyId ||
      !window.confirm(
        t("projGuest.revokeConfirm", { label: g.label || g.login }),
      )
    ) {
      return;
    }
    setBusyId(g.id);
    const ok = await revokeProjectGuest(projectId, g.id);
    setBusyId(null);
    if (!ok) {
      showAppToast(t("projGuest.errRevoke"));
      return;
    }
    reload();
  };

  const clean = async () => {
    if (!window.confirm(t("projGuest.cleanConfirm"))) {
      return;
    }
    const { ok, removed } = await cleanProjectGuests(projectId);
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

      {/* Issue form — display name (required) + optional real email. */}
      <div className="mcm-roster__guestform">
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
          disabled={issuing || !label.trim()}
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

      {/* Active guests */}
      {guests.length === 0 ? (
        <p className="mcm-roster__empty">{t("projGuest.none")}</p>
      ) : (
        <ul className="mcm-roster__guests">
          {guests.map((g) => (
            <li key={g.id} className="mcm-roster__guest">
              <span className="mcm-roster__guest-main">
                <UsersRound size={14} aria-hidden="true" />
                <span className="mcm-roster__guest-name">
                  {g.label || g.login}
                </span>
                <span className="mcm-roster__guest-login">{g.login}</span>
                {g.real_email && (
                  <span className="mcm-roster__guest-sub">{g.real_email}</span>
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
      )}

      {guests.length > 0 && (
        <button
          type="button"
          className="mcm-btn mcm-btn--sm mcm-roster__clean"
          onClick={() => void clean()}
        >
          <Trash2 size={14} /> {t("projGuest.clean")}
        </button>
      )}
    </div>
  );
};

export default ProjectGuestRoster;
