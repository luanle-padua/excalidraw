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
  Image as ImageIcon,
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
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "../../data/appToast";
import { COUNTRIES, countryFlag, countryName } from "../../data/countries";
import {
  cleanProjectGuests,
  fetchGuestLogo,
  issueProjectGuest,
  listProjectGuests,
  removeGuestLogo,
  resetProjectGuest,
  revokeProjectGuest,
  updateProjectGuest,
  uploadGuestLogo,
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
  country: "",
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
  // guest id → logo object URL (the logo route is auth-gated; we fetch the blob
  // and createObjectURL it, like the backdrop thumbs). Revoked on reload/unmount.
  const [logoThumbs, setLogoThumbs] = useState<Record<string, string>>({});
  // The per-guest hidden <input type=file> we click for logo upload.
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const [logoTargetId, setLogoTargetId] = useState<string | null>(null);

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

  // Fetch a logo thumbnail for every guest that has one (and we haven't yet).
  useEffect(() => {
    let cancelled = false;
    guests.forEach((g) => {
      if (g.logo_url && !logoThumbs[g.id]) {
        void fetchGuestLogo(g.logo_url).then((src) => {
          if (src && !cancelled) {
            setLogoThumbs((m) => ({ ...m, [g.id]: src }));
          } else if (src) {
            URL.revokeObjectURL(src);
          }
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [guests, logoThumbs]);

  // Revoke every logo object URL on unmount.
  useEffect(
    () => () => {
      setLogoThumbs((m) => {
        Object.values(m).forEach((u) => URL.revokeObjectURL(u));
        return {};
      });
    },
    [],
  );

  const onLogoPicked = async (file: File | null) => {
    const id = logoTargetId;
    setLogoTargetId(null);
    if (!file || !id || busyId) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      showAppToast(t("projGuest.errLogo"));
      return;
    }
    setBusyId(id);
    const url = await uploadGuestLogo(projectId, id, file);
    setBusyId(null);
    if (!url) {
      showAppToast(t("projGuest.errLogo"));
      return;
    }
    // Drop the stale thumb so the effect re-fetches the new one after reload.
    setLogoThumbs((m) => {
      if (m[id]) {
        URL.revokeObjectURL(m[id]);
      }
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    showAppToast(t("projGuest.logoSaved"));
    reload();
  };

  const removeLogo = async (g: ProjectGuest) => {
    if (busyId) {
      return;
    }
    setBusyId(g.id);
    const ok = await removeGuestLogo(projectId, g.id);
    setBusyId(null);
    if (!ok) {
      showAppToast(t("projGuest.errLogo"));
      return;
    }
    setLogoThumbs((m) => {
      if (m[g.id]) {
        URL.revokeObjectURL(m[g.id]);
      }
      const { [g.id]: _drop, ...rest } = m;
      return rest;
    });
    reload();
  };

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
      country: g.country ?? "",
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

      {/* Shared hidden logo picker — `logoTargetId` says which guest it's for. */}
      <input
        ref={logoInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void onLogoPicked(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />

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
            {/* Country → picks this client's entry-page backdrop. */}
            <select
              className="mcm-roster__in"
              value={form.country ?? ""}
              onChange={(e) => setFormField("country", e.target.value)}
              aria-label={t("projGuest.countryLabel")}
            >
              <option value="">{t("projGuest.countryNone")}</option>
              {COUNTRIES.map((co) => (
                <option key={co.code} value={co.code}>
                  {countryFlag(co.code)} {co.name}
                </option>
              ))}
            </select>
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
                  <select
                    className="mcm-roster__in"
                    value={editForm.country ?? ""}
                    onChange={(e) => setEditField("country", e.target.value)}
                    aria-label={t("projGuest.countryLabel")}
                  >
                    <option value="">{t("projGuest.countryNone")}</option>
                    {COUNTRIES.map((co) => (
                      <option key={co.code} value={co.code}>
                        {countryFlag(co.code)} {co.name}
                      </option>
                    ))}
                  </select>
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
                {/* Company logo thumb (or a placeholder) — the client's brand. */}
                <span
                  className="mcm-roster__guest-logo"
                  aria-hidden={!logoThumbs[g.id]}
                >
                  {logoThumbs[g.id] ? (
                    <img src={logoThumbs[g.id]} alt={g.company ?? ""} />
                  ) : (
                    <ImageIcon size={16} />
                  )}
                </span>
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
                    {g.country && (
                      <span className="mcm-roster__guest-country">
                        {countryFlag(g.country)} {countryName(g.country)}
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
                    title={
                      g.logo_url
                        ? t("projGuest.logoReplace")
                        : t("projGuest.logoUpload")
                    }
                    aria-label={
                      g.logo_url
                        ? t("projGuest.logoReplace")
                        : t("projGuest.logoUpload")
                    }
                    onClick={() => {
                      setLogoTargetId(g.id);
                      logoInputRef.current?.click();
                    }}
                    disabled={busyId === g.id}
                  >
                    <ImageIcon size={14} />
                  </button>
                  {g.logo_url && (
                    <button
                      type="button"
                      className="mcm-icon-btn mcm-icon-btn--sm"
                      title={t("projGuest.logoRemove")}
                      aria-label={t("projGuest.logoRemove")}
                      onClick={() => void removeLogo(g)}
                      disabled={busyId === g.id}
                    >
                      <X size={14} />
                    </button>
                  )}
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
