import { Briefcase, Check, Copy, Search, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createPortal } from "react-dom";

import { getCollaborationLink } from "../../data";
import {
  getDirectory,
  inviteToMeeting,
  type DirectoryUser,
} from "../../data/invite";
import { listProjectGuests, type ProjectGuest } from "../../data/projectGuests";
import { getMeeting } from "../../data/projects";
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
  // PROJECT-SCOPED guests of THIS meeting's project — derive the project_id
  // from the meeting, then list its issued guests (replaces the old shared
  // cross-department client list). Guests are invited by their `login`.
  const [guests, setGuests] = useState<ProjectGuest[]>([]);
  const [guestQ, setGuestQ] = useState("");
  const [addToProject, setAddToProject] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getDirectory().then(setDir);
    void (async () => {
      const m = await getMeeting(roomId);
      if (m?.project_id) {
        setGuests(await listProjectGuests(m.project_id));
      }
    })();
  }, [roomId]);

  // Friendly display name for a guest: representative label + company.
  const guestName = (g: ProjectGuest) =>
    g.company ? `${g.label ?? g.login} · ${g.company}` : g.label ?? g.login;

  // Active project guests the user hasn't already selected, filtered by the
  // picker search — invites resolve to the guest's synthetic login identity.
  const guestMatches = useMemo(() => {
    const needle = guestQ.trim().toLowerCase();
    return guests
      .filter(
        (g) => g.status === "active" && !selected.has(g.login.toLowerCase()),
      )
      .filter(
        (g) =>
          !needle ||
          (g.label ?? "").toLowerCase().includes(needle) ||
          (g.company ?? "").toLowerCase().includes(needle) ||
          (g.real_email ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [guests, guestQ, selected]);

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

  // Add a project guest BY THEIR LOGIN (the JWT identity invites match on),
  // with a friendly display name.
  const addGuest = (g: ProjectGuest) =>
    addOne({ email: g.login.toLowerCase(), name: guestName(g), kind: "guest" });

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

          {/* This project's issued guests — invited by their login identity.
              No free-typed email: a guest must be issued in the project guest
              manager first (strict per-department confidentiality). */}
          <label className="mcm-invite__label">
            <Briefcase size={13} style={{ verticalAlign: "-2px" }} />{" "}
            {t("projGuest.pickFromList")}
          </label>
          <div className="mcm-invite__search">
            <Search size={14} />
            <input
              value={guestQ}
              onChange={(e) => setGuestQ(e.target.value)}
              placeholder={t("projGuest.pickSearch")}
            />
          </div>
          <ul className="mcm-invite__list">
            {guestMatches.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => addGuest(g)}>
                  <strong>{g.label ?? g.login}</strong>
                  <span>
                    {[g.company, g.real_email].filter(Boolean).join(" · ") ||
                      g.login}
                  </span>
                </button>
              </li>
            ))}
            {guestMatches.length === 0 && (
              <li className="mcm-invite__empty">{t("projGuest.pickEmpty")}</li>
            )}
          </ul>

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
