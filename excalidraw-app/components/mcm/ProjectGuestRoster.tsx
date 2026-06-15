// "Khách dự án" — project-scoped guest management (new guest-access model,
// 06-15). Guest access is INDEPENDENT per project (strict confidentiality
// between departments): the host issues a SYNTHETIC login (never the guest's
// real email) + temp password scoped to THIS project, and the guest follows it
// across every meeting. A guest is a CONTACT, not just a login: alongside the
// credentials the host records representative / email / company / phone /
// address (CRM fields stored in D1, never part of the auth identity). Lists the
// project's active guests, issues new ones (credentials shown ONCE), edits the
// contact card, resets / revokes one, and "cleans" all when the project is done.
// The worker gates every route to admin OR a project member/owner; an invitee
// detail never renders this (the worker would 403).

import {
  Check,
  Copy,
  KeyRound,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Trash2,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { showAppToast } from "../../data/appToast";
import {
  cleanProjectGuests,
  issueProjectGuest,
  listProjectGuests,
  resetProjectGuest,
  revokeProjectGuest,
  updateProjectGuest,
  type GuestContactInput,
  type ProjectGuest,
} from "../../data/projectGuests";
import { useT } from "../../i18n/mcm";

import "./ProjectMemberRoster.scss";

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString() : "—";

const emptyContact = (): GuestContactInput => ({
  label: "",
  real_email: "",
  company: "",
  phone: "",
  address: "",
});

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
  // The issue form's contact card (representative + email + company/phone/addr).
  const [form, setForm] = useState<GuestContactInput>(emptyContact);
  const [issuing, setIssuing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline edit — which guest's contact card is open, and its draft.
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<GuestContactInput>(emptyContact);
  // The just-issued (or just-reset) credentials — shown ONCE, copyable.
  const [creds, setCreds] = useState<{
    login: string;
    password: string;
  } | null>(null);
  const [credsCopied, setCredsCopied] = useState(false);

  const setFormField = (k: keyof GuestContactInput, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setEditField = (k: keyof GuestContactInput, v: string) =>
    setEditForm((f) => ({ ...f, [k]: v }));

  const reload = useCallback(() => {
    void listProjectGuests(projectId).then(setGuests);
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const issue = async () => {
    if (!form.label.trim() || issuing) {
      return;
    }
    setIssuing(true);
    const r = await issueProjectGuest(projectId, {
      ...form,
      label: form.label.trim(),
    });
    setIssuing(false);
    if (!r) {
      showAppToast(t("projGuest.errIssue"));
      return;
    }
    setForm(emptyContact());
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

  const startEdit = (g: ProjectGuest) => {
    setEditId(g.id);
    setEditForm({
      label: g.label ?? "",
      real_email: g.real_email ?? "",
      company: g.company ?? "",
      phone: g.phone ?? "",
      address: g.address ?? "",
    });
  };

  const saveEdit = async (g: ProjectGuest) => {
    if (busyId || !editForm.label.trim()) {
      return;
    }
    setBusyId(g.id);
    const ok = await updateProjectGuest(projectId, g.id, {
      ...editForm,
      label: editForm.label.trim(),
    });
    setBusyId(null);
    if (!ok) {
      showAppToast(t("projGuest.errUpdate"));
      return;
    }
    showAppToast(t("projGuest.updated"));
    setEditId(null);
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
    <div className="mcm-roster mcm-roster--manager">
      <p className="mcm-roster__hint">{t("projGuest.hint")}</p>

      {/* Issue form — contact card. Representative name is the only required
          field; email/company/phone/address are optional reference details. */}
      <div className="mcm-roster__issue">
        <div className="mcm-roster__field">
          <span className="mcm-roster__field-label">
            {t("projGuest.fieldContact")}
          </span>
          <div className="mcm-roster__grid">
            <input
              className="mcm-roster__in"
              value={form.label}
              onChange={(e) => setFormField("label", e.target.value)}
              placeholder={t("projGuest.labelPlaceholder")}
              aria-label={t("projGuest.labelLabel")}
            />
            <input
              className="mcm-roster__in"
              type="email"
              value={form.real_email}
              onChange={(e) => setFormField("real_email", e.target.value)}
              placeholder={t("projGuest.realEmailPlaceholder")}
              aria-label={t("projGuest.realEmailLabel")}
            />
            <input
              className="mcm-roster__in"
              value={form.company}
              onChange={(e) => setFormField("company", e.target.value)}
              placeholder={t("projGuest.companyPlaceholder")}
              aria-label={t("projGuest.companyLabel")}
            />
            <input
              className="mcm-roster__in"
              value={form.phone}
              onChange={(e) => setFormField("phone", e.target.value)}
              placeholder={t("projGuest.phonePlaceholder")}
              aria-label={t("projGuest.phoneLabel")}
            />
            <input
              className="mcm-roster__in mcm-roster__in--wide"
              value={form.address}
              onChange={(e) => setFormField("address", e.target.value)}
              placeholder={t("projGuest.addressPlaceholder")}
              aria-label={t("projGuest.addressLabel")}
            />
          </div>
        </div>

        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--sm mcm-roster__issue-btn"
          onClick={() => void issue()}
          disabled={issuing || !form.label.trim()}
        >
          <UserPlus size={15} />{" "}
          {issuing ? t("projGuest.issuing") : t("projGuest.issue")}
        </button>

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
      </div>

      {/* Active guests */}
      {guests.length === 0 ? (
        <p className="mcm-roster__empty">{t("projGuest.none")}</p>
      ) : (
        <ul className="mcm-roster__guests">
          {guests.map((g) =>
            editId === g.id ? (
              <li
                key={g.id}
                className="mcm-roster__guest mcm-roster__guest--editing"
              >
                <div className="mcm-roster__grid">
                  <input
                    className="mcm-roster__in"
                    value={editForm.label}
                    onChange={(e) => setEditField("label", e.target.value)}
                    placeholder={t("projGuest.labelPlaceholder")}
                    aria-label={t("projGuest.labelLabel")}
                  />
                  <input
                    className="mcm-roster__in"
                    type="email"
                    value={editForm.real_email}
                    onChange={(e) => setEditField("real_email", e.target.value)}
                    placeholder={t("projGuest.realEmailPlaceholder")}
                    aria-label={t("projGuest.realEmailLabel")}
                  />
                  <input
                    className="mcm-roster__in"
                    value={editForm.company}
                    onChange={(e) => setEditField("company", e.target.value)}
                    placeholder={t("projGuest.companyPlaceholder")}
                    aria-label={t("projGuest.companyLabel")}
                  />
                  <input
                    className="mcm-roster__in"
                    value={editForm.phone}
                    onChange={(e) => setEditField("phone", e.target.value)}
                    placeholder={t("projGuest.phonePlaceholder")}
                    aria-label={t("projGuest.phoneLabel")}
                  />
                  <input
                    className="mcm-roster__in mcm-roster__in--wide"
                    value={editForm.address}
                    onChange={(e) => setEditField("address", e.target.value)}
                    placeholder={t("projGuest.addressPlaceholder")}
                    aria-label={t("projGuest.addressLabel")}
                  />
                </div>
                <div className="mcm-roster__edit-actions">
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--primary mcm-btn--sm"
                    onClick={() => void saveEdit(g)}
                    disabled={busyId === g.id || !editForm.label.trim()}
                  >
                    <Check size={14} /> {t("projGuest.save")}
                  </button>
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--sm"
                    onClick={() => setEditId(null)}
                    disabled={busyId === g.id}
                  >
                    <X size={14} /> {t("projGuest.cancel")}
                  </button>
                </div>
              </li>
            ) : (
              <li key={g.id} className="mcm-roster__guest">
                <span className="mcm-roster__guest-main">
                  <span className="mcm-roster__guest-head">
                    <UsersRound size={14} aria-hidden="true" />
                    <span className="mcm-roster__guest-name">
                      {g.label || g.login}
                    </span>
                    {g.company && (
                      <span className="mcm-roster__guest-company">
                        {g.company}
                      </span>
                    )}
                  </span>
                  <span className="mcm-roster__guest-login">{g.login}</span>
                  <span className="mcm-roster__guest-contacts">
                    {g.real_email && (
                      <span className="mcm-roster__guest-sub">
                        <Mail size={12} aria-hidden="true" />
                        {g.real_email}
                      </span>
                    )}
                    {g.phone && (
                      <span className="mcm-roster__guest-sub">
                        <Phone size={12} aria-hidden="true" />
                        {g.phone}
                      </span>
                    )}
                    {g.address && (
                      <span className="mcm-roster__guest-sub">
                        <MapPin size={12} aria-hidden="true" />
                        {g.address}
                      </span>
                    )}
                    <span className="mcm-roster__guest-sub">
                      {fmtDate(g.created_at)}
                    </span>
                  </span>
                </span>
                <span className="mcm-roster__guest-actions">
                  <button
                    type="button"
                    className="mcm-icon-btn mcm-icon-btn--sm"
                    title={t("projGuest.edit")}
                    aria-label={t("projGuest.edit")}
                    onClick={() => startEdit(g)}
                    disabled={busyId === g.id}
                  >
                    <Pencil size={14} />
                  </button>
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
            ),
          )}
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
