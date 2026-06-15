import {
  Briefcase,
  Check,
  Copy,
  Mail,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createPortal } from "react-dom";

import { getCollaborationLink } from "../../data";
import { listClients, type Client } from "../../data/clients";
import { createGuest, sendGuestInvite } from "../../data/guests";
import {
  getDirectory,
  inviteToMeeting,
  type DirectoryUser,
} from "../../data/invite";
import { isInternalEmail } from "../../data/session";
import { useT } from "../../i18n/mcm";

type Selected = { email: string; name: string; kind: "internal" | "guest" };

/** Invite people to a meeting: copy the link, pick internal colleagues from the
 *  directory, and/or add external client emails. Internal invitees can also be
 *  granted whole-folder project membership; clients stay meeting-scoped. */
export const InvitePanel = ({
  roomId,
  roomKey,
  onClose,
}: {
  roomId: string;
  roomKey?: string;
  onClose: () => void;
}) => {
  const t = useT();
  const [dir, setDir] = useState<DirectoryUser[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [clientEmail, setClientEmail] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientQ, setClientQ] = useState("");
  const [addToProject, setAddToProject] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guest-account provisioning: credentials shown ONCE after a successful
  // create so the host can paste them to the external guest.
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestCreds, setGuestCreds] = useState<{
    email: string;
    password?: string;
    existed: boolean;
  } | null>(null);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestCopied, setGuestCopied] = useState(false);
  // Optional Resend send of the link + credentials straight to the guest.
  const [guestSending, setGuestSending] = useState(false);
  const [guestSent, setGuestSent] = useState(false);
  const [guestSendErr, setGuestSendErr] = useState<string | null>(null);

  useEffect(() => {
    void getDirectory().then(setDir);
    void listClients().then(setClients);
  }, []);

  // Saved clients (with an email) the user hasn't already selected, filtered by
  // the picker search — so inviting pulls from the synced list, not retyping.
  const clientMatches = useMemo(() => {
    const needle = clientQ.trim().toLowerCase();
    return clients
      .filter((c) => c.email && !selected.has(c.email.toLowerCase()))
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          (c.company ?? "").toLowerCase().includes(needle) ||
          (c.email ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [clients, clientQ, selected]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return dir
      .filter((u) => !selected.has(u.email))
      .filter(
        (u) =>
          !needle ||
          u.name.toLowerCase().includes(needle) ||
          u.email.toLowerCase().includes(needle) ||
          (u.division ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [dir, q, selected]);

  const addOne = (s: Selected) =>
    setSelected((prev) => {
      const next = new Map(prev);
      next.set(s.email, s);
      return next;
    });
  const remove = (email: string) =>
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(email);
      return next;
    });

  const addClient = () => {
    const e = clientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || selected.has(e)) {
      return;
    }
    addOne({ email: e, name: e, kind: "guest" });
    setClientEmail("");
  };

  // The email currently typed in the external-client field, if it's a valid
  // EXTERNAL address — the only case a guest login account can be provisioned.
  const guestCandidate = useMemo(() => {
    const e = clientEmail.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !isInternalEmail(e) ? e : "";
  }, [clientEmail]);

  const makeGuest = async () => {
    if (!guestCandidate || guestBusy) {
      return;
    }
    setGuestBusy(true);
    setGuestError(null);
    setGuestCreds(null);
    setGuestCopied(false);
    const r = await createGuest(guestCandidate);
    setGuestBusy(false);
    if (!r.ok) {
      setGuestError(
        r.status === 403
          ? t("guest.errForbidden")
          : r.status === 400
          ? t("guest.errInvalid")
          : t("guest.errNetwork"),
      );
      return;
    }
    setGuestCreds({
      email: r.email,
      password: r.existed ? undefined : r.password,
      existed: r.existed,
    });
    // Convenience: also queue the guest as an invitee so the host can send
    // access in the same flow.
    addOne({ email: guestCandidate, name: guestCandidate, kind: "guest" });
  };

  const copyGuestCreds = async () => {
    if (!guestCreds) {
      return;
    }
    const line = guestCreds.password
      ? `${guestCreds.email} / ${guestCreds.password}`
      : guestCreds.email;
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      window.prompt(t("guest.copyAll"), line);
    }
    setGuestCopied(true);
    window.setTimeout(() => setGuestCopied(false), 2000);
  };

  // Email the guest their meeting link (+ password) via Resend. Needs the room
  // link, so only offered when a roomKey is present.
  const sendGuestEmail = async () => {
    if (!guestCreds || !roomKey || guestSending) {
      return;
    }
    setGuestSending(true);
    setGuestSendErr(null);
    const link = getCollaborationLink({ roomId, roomKey });
    const r = await sendGuestInvite(guestCreds.email, link, {
      password: guestCreds.password,
    });
    setGuestSending(false);
    if (r.ok) {
      setGuestSent(true);
    } else {
      setGuestSendErr(t("guest.sendErr"));
    }
  };

  const copyLink = async () => {
    if (!roomKey) {
      return;
    }
    const link = getCollaborationLink({ roomId, roomKey });
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt(t("invite.copyLink"), link);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const send = async () => {
    if (selected.size === 0 || sending) {
      return;
    }
    setSending(true);
    setError(null);
    const list = [...selected.values()];
    const internalEmails = list
      .filter((s) => s.kind === "internal")
      .map((s) => s.email);
    const { ok, status } = await inviteToMeeting(
      roomId,
      list.map((s) => ({ email: s.email })),
      addToProject ? internalEmails : [],
    );
    setSending(false);
    if (!ok) {
      // Worker refusals get specific copy: 403 = not allowed to invite,
      // 409 = meeting already finished/cancelled; everything else = network.
      setError(
        status === 403
          ? t("invite.errForbidden")
          : status === 409
          ? t("invite.errFinished")
          : t("invite.errNetwork"),
      );
      return;
    }
    setSelected(new Map());
    setSent(true);
    window.setTimeout(() => setSent(false), 2500);
    // Access granted ≠ notified (no invite emails yet) — put the room link
    // on the clipboard so the organizer can paste it to the invitees.
    void copyLink();
  };

  const hasInternal = [...selected.values()].some((s) => s.kind === "internal");

  return createPortal(
    <div className="mcm-pp-overlay" onClick={onClose} role="presentation">
      <aside
        className="mcm-invite"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("invite.title")}
      >
        <header className="mcm-pp__head">
          <strong>
            <UserPlus size={16} /> {t("invite.title")}
          </strong>
          <button
            type="button"
            className="mcm-pp__close"
            onClick={onClose}
            aria-label={t("header.leave")}
          >
            <X size={18} />
          </button>
        </header>

        <div className="mcm-invite__body">
          {roomKey && (
            <button
              type="button"
              className="mcm-btn mcm-btn--secondary mcm-invite__link"
              onClick={() => void copyLink()}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? t("header.inviteCopied") : t("invite.copyLink")}
            </button>
          )}

          {/* Selected chips */}
          {selected.size > 0 && (
            <div className="mcm-invite__chips">
              {[...selected.values()].map((s) => (
                <span
                  key={s.email}
                  className={`mcm-invite__chip${
                    s.kind === "guest" ? " --guest" : ""
                  }`}
                >
                  {s.name}
                  <button
                    type="button"
                    onClick={() => remove(s.email)}
                    aria-label={t("admin.delete")}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Internal directory */}
          <label className="mcm-invite__label">{t("invite.internal")}</label>
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
                    addOne({ email: u.email, name: u.name, kind: "internal" })
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

          {/* Pick from the saved client list (synced) */}
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
                    addOne({
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

          {/* External client — raw email */}
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

          {/* Provision a guest login account for the typed external email so
              the guest can sign in without any invite email. */}
          {guestCandidate && (
            <button
              type="button"
              className="mcm-btn mcm-btn--secondary mcm-btn--sm"
              onClick={() => void makeGuest()}
              disabled={guestBusy}
              style={{ marginTop: "0.25rem" }}
            >
              <UserPlus size={14} />
              {guestBusy ? t("guest.creating") : t("guest.create")}
            </button>
          )}
          {guestError && (
            <p
              role="alert"
              style={{
                color: "#d04545",
                fontSize: "0.78rem",
                margin: "0.4rem 0 0",
              }}
            >
              {guestError}
            </p>
          )}
          {guestCreds && (
            <div className="mcm-guest-creds">
              <strong>{t("guest.title")}</strong>
              {guestCreds.existed ? (
                <p style={{ fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
                  {t("guest.existed")}
                </p>
              ) : (
                <>
                  <p style={{ fontSize: "0.75rem", margin: "0.3rem 0 0.4rem" }}>
                    {t("guest.hint")}
                  </p>
                  <code
                    style={{
                      display: "block",
                      userSelect: "all",
                      wordBreak: "break-all",
                      fontSize: "0.8rem",
                      padding: "0.4rem 0.5rem",
                      borderRadius: 6,
                      background: "rgba(0,0,0,0.06)",
                    }}
                  >
                    {t("guest.emailLabel")}: {guestCreds.email}
                    {"\n"}
                    {t("guest.passwordLabel")}: {guestCreds.password}
                  </code>
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                    onClick={() => void copyGuestCreds()}
                    style={{ marginTop: "0.4rem" }}
                  >
                    {guestCopied ? <Check size={14} /> : <Copy size={14} />}
                    {guestCopied ? t("guest.copied") : t("guest.copyAll")}
                  </button>
                  {roomKey && (
                    <button
                      type="button"
                      className="mcm-btn mcm-btn--primary mcm-btn--sm"
                      onClick={() => void sendGuestEmail()}
                      disabled={guestSending}
                      style={{ marginTop: "0.4rem", marginLeft: "0.4rem" }}
                    >
                      {guestSent ? <Check size={14} /> : <Mail size={14} />}
                      {guestSending
                        ? t("guest.sending")
                        : guestSent
                        ? t("guest.sent")
                        : t("guest.sendEmail")}
                    </button>
                  )}
                  {guestSendErr && (
                    <p
                      style={{
                        fontSize: "0.75rem",
                        margin: "0.35rem 0 0",
                        color: "var(--mcm-danger, #d33)",
                      }}
                    >
                      {guestSendErr}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

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
        </div>

        {error && (
          <p
            role="alert"
            style={{
              color: "#d04545",
              fontSize: "0.78rem",
              margin: "0 1rem 0.25rem",
            }}
          >
            {error}
          </p>
        )}
        <footer className="mcm-invite__foot">
          <button
            type="button"
            className="mcm-btn mcm-btn--primary mcm-btn--block"
            onClick={() => void send()}
            disabled={selected.size === 0 || sending}
          >
            {sent
              ? t("invite.sent")
              : `${t("invite.send")}${
                  selected.size ? ` (${selected.size})` : ""
                }`}
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
};

export default InvitePanel;
