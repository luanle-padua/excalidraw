import { Check, Copy, Search, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createPortal } from "react-dom";

import { getCollaborationLink } from "../../data";
import {
  getDirectory,
  inviteToMeeting,
  type DirectoryUser,
} from "../../data/invite";
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
  const [addToProject, setAddToProject] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getDirectory().then(setDir);
  }, []);

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
    if (!e.includes("@") || selected.has(e)) {
      return;
    }
    addOne({ email: e, name: e, kind: "guest" });
    setClientEmail("");
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
    const list = [...selected.values()];
    const internalEmails = list
      .filter((s) => s.kind === "internal")
      .map((s) => s.email);
    const ok = await inviteToMeeting(
      roomId,
      list.map((s) => ({ email: s.email })),
      addToProject ? internalEmails : [],
    );
    setSending(false);
    if (ok) {
      setSelected(new Map());
      setSent(true);
      window.setTimeout(() => setSent(false), 2500);
    }
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
              className="mcm-invite__link"
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

          {/* External client */}
          <label className="mcm-invite__label">{t("invite.client")}</label>
          <div className="mcm-invite__client">
            <input
              type="email"
              value={clientEmail}
              onChange={(e) => setClientEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addClient()}
              placeholder={t("invite.clientPlaceholder")}
            />
            <button type="button" onClick={addClient}>
              {t("invite.add")}
            </button>
          </div>

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

        <footer className="mcm-invite__foot">
          <button
            type="button"
            className="mcm-invite__send"
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
