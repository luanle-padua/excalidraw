// "Quản lý khách" — CENTRALIZED project-guest manager (06-15). One place to
// see/manage guests ACROSS every project the caller can manage, instead of
// project-by-project. The list is grouped by project; per-guest Reset/Revoke,
// inline Edit of the contact card, and a per-project "Clean tất cả khách"
// reuse the per-project endpoints, and a single Issue form with a PROJECT
// SELECTOR issues into any project the caller owns/is a member of.
//
// A guest is a CONTACT, not just a login: alongside the synthetic credentials
// the host records representative / email / company / phone / address (CRM
// fields stored in D1, never part of the auth identity).
//
// CONFIDENTIALITY: the list comes from /v1/me/project-guests, which scopes
// SERVER-SIDE to the caller's project memberships (admin → all). The project
// selector is likewise restricted to owned/member projects (NOT invitee) — we
// never offer to manage a project the worker would 403 on.

import {
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "../../data/appToast";
import { COUNTRIES, countryFlag, countryName } from "../../data/countries";
import {
  cleanProjectGuests,
  fetchGuestLogo,
  issueProjectGuest,
  listMyProjectGuests,
  removeGuestLogo,
  resetProjectGuest,
  revokeProjectGuest,
  updateProjectGuest,
  uploadGuestLogo,
  type GuestContactInput,
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

const emptyContact = (): GuestContactInput => ({
  label: "",
  real_email: "",
  company: "",
  phone: "",
  address: "",
  country: "",
});

export const GuestManager = () => {
  const t = useT();
  const [guests, setGuests] = useState<MyProjectGuest[]>([]);
  // Projects the caller can ISSUE into — owned/member only (NOT invitee).
  const [manageable, setManageable] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  // Custom (themed) project dropdown — a native <select>'s option list can't
  // be styled, so it rendered as a bare white popup on the dark desk.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);
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
  // and createObjectURL it, like the roster). Revoked on reload/unmount.
  const [logoThumbs, setLogoThumbs] = useState<Record<string, string>>({});
  // The shared hidden <input type=file> we click for logo upload, plus the guest
  // it's currently targeting (so we know which project_id/id to POST to).
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const [logoTarget, setLogoTarget] = useState<MyProjectGuest | null>(null);

  const setFormField = (k: keyof GuestContactInput, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setEditField = (k: keyof GuestContactInput, v: string) =>
    setEditForm((f) => ({ ...f, [k]: v }));

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
    const g = logoTarget;
    setLogoTarget(null);
    if (!file || !g || busyId) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      showAppToast(t("projGuest.errLogo"));
      return;
    }
    setBusyId(g.id);
    const url = await uploadGuestLogo(g.project_id, g.id, file);
    setBusyId(null);
    if (!url) {
      showAppToast(t("projGuest.errLogo"));
      return;
    }
    // Drop the stale thumb so the effect re-fetches the new one after reload.
    setLogoThumbs((m) => {
      if (m[g.id]) {
        URL.revokeObjectURL(m[g.id]);
      }
      const { [g.id]: _drop, ...rest } = m;
      return rest;
    });
    showAppToast(t("projGuest.logoSaved"));
    reload();
  };

  const removeLogo = async (g: MyProjectGuest) => {
    if (busyId) {
      return;
    }
    setBusyId(g.id);
    const ok = await removeGuestLogo(g.project_id, g.id);
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
    if (!projectId || !form.label.trim() || issuing) {
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

  const startEdit = (g: MyProjectGuest) => {
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

  const saveEdit = async (g: MyProjectGuest) => {
    if (busyId || !editForm.label.trim()) {
      return;
    }
    setBusyId(g.id);
    const ok = await updateProjectGuest(g.project_id, g.id, {
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
    <div className="mcm-roster mcm-roster--manager mcm-roster--page">
      <p className="mcm-roster__hint">{t("projGuest.manageHint")}</p>

      {/* Shared hidden logo picker — `logoTarget` says which guest it's for. */}
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

      {/* Issue form — project + contact card. The selector only lists projects
          we can actually manage; representative name is the only required field. */}
      <div className="mcm-roster__issue">
        <div className="mcm-roster__field">
          <span className="mcm-roster__field-label">
            {t("projGuest.fieldProject")}
          </span>
          <div className="mcm-roster__project-picker" ref={pickerRef}>
            <button
              type="button"
              className="mcm-select mcm-roster__project-select"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title={t("projGuest.pickProject")}
            >
              <FolderOpen size={14} className="mcm-select__icon" />
              <span className="mcm-roster__project-current">
                {(() => {
                  const sel = manageable.find((p) => p.id === projectId);
                  return sel
                    ? `${sel.icon ? `${sel.icon} ` : ""}${sel.name || sel.id}`
                    : t("projGuest.pickProject");
                })()}
              </span>
              <ChevronDown size={14} className="mcm-roster__project-caret" />
            </button>
            {pickerOpen && (
              <ul className="mcm-roster__project-menu" role="listbox">
                {manageable.length === 0 ? (
                  <li className="mcm-roster__project-empty">
                    {t("projGuest.noneAll")}
                  </li>
                ) : (
                  manageable.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={p.id === projectId}
                        className={`mcm-roster__project-opt${
                          p.id === projectId
                            ? " mcm-roster__project-opt--active"
                            : ""
                        }`}
                        onClick={() => {
                          setProjectId(p.id);
                          setPickerOpen(false);
                        }}
                      >
                        <FolderOpen size={13} aria-hidden="true" />
                        <span className="mcm-roster__project-opt-name">
                          {p.icon ? `${p.icon} ` : ""}
                          {p.name || p.id}
                        </span>
                        {p.id === projectId && <Check size={13} />}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>

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
          disabled={issuing || !projectId || !form.label.trim()}
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

      {/* Guests grouped by project. */}
      {groups.length === 0 ? (
        <div className="mcm-roster__emptystate">
          <UsersRound size={26} aria-hidden="true" />
          <p>{t("projGuest.noneAll")}</p>
        </div>
      ) : (
        <div className="mcm-roster__groups">
          {groups.map((grp) => (
            <div key={grp.id} className="mcm-roster__group">
              <div className="mcm-roster__group-head">
                <h4 className="mcm-roster__group-title">
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{grp.name || grp.id}</span>
                  <span className="mcm-roster__group-count">
                    {grp.guests.length}
                  </span>
                </h4>
                <button
                  type="button"
                  className="mcm-btn mcm-btn--sm mcm-roster__clean"
                  onClick={() => void clean(grp.id)}
                >
                  <Trash2 size={14} /> {t("projGuest.clean")}
                </button>
              </div>
              <ul className="mcm-roster__guests">
                {grp.guests.map((g) =>
                  editId === g.id ? (
                    <li
                      key={g.id}
                      className="mcm-roster__guest mcm-roster__guest--editing"
                    >
                      <div className="mcm-roster__grid">
                        <input
                          className="mcm-roster__in"
                          value={editForm.label}
                          onChange={(e) =>
                            setEditField("label", e.target.value)
                          }
                          placeholder={t("projGuest.labelPlaceholder")}
                          aria-label={t("projGuest.labelLabel")}
                        />
                        <input
                          className="mcm-roster__in"
                          type="email"
                          value={editForm.real_email}
                          onChange={(e) =>
                            setEditField("real_email", e.target.value)
                          }
                          placeholder={t("projGuest.realEmailPlaceholder")}
                          aria-label={t("projGuest.realEmailLabel")}
                        />
                        <input
                          className="mcm-roster__in"
                          value={editForm.company}
                          onChange={(e) =>
                            setEditField("company", e.target.value)
                          }
                          placeholder={t("projGuest.companyPlaceholder")}
                          aria-label={t("projGuest.companyLabel")}
                        />
                        <input
                          className="mcm-roster__in"
                          value={editForm.phone}
                          onChange={(e) =>
                            setEditField("phone", e.target.value)
                          }
                          placeholder={t("projGuest.phonePlaceholder")}
                          aria-label={t("projGuest.phoneLabel")}
                        />
                        <input
                          className="mcm-roster__in mcm-roster__in--wide"
                          value={editForm.address}
                          onChange={(e) =>
                            setEditField("address", e.target.value)
                          }
                          placeholder={t("projGuest.addressPlaceholder")}
                          aria-label={t("projGuest.addressLabel")}
                        />
                        <select
                          className="mcm-roster__in"
                          value={editForm.country ?? ""}
                          onChange={(e) =>
                            setEditField("country", e.target.value)
                          }
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
                      {/* Company logo thumb (or a placeholder) — client's brand. */}
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
                        <span className="mcm-roster__guest-login">
                          {g.login}
                        </span>
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
                            setLogoTarget(g);
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default GuestManager;
