import { Check, Search, Users, X } from "lucide-react";
import { useMemo, useState } from "react";

import { createPortal } from "react-dom";

import { type DirectoryUser } from "../../data/invite";
import { useT } from "../../i18n/mcm";

const norm = (s: string) =>
  s.toLowerCase().replace(/[.\s]+/g, " ").trim();

/** A popup to pick internal members in bulk — grouped by division, with a
 *  per-division "select all" and multi-select checkboxes, so you add a whole
 *  team at once instead of clicking people one by one. */
export const MemberPicker = ({
  directory,
  disabledEmails,
  onConfirm,
  onClose,
}: {
  directory: DirectoryUser[];
  /** Emails already invited — shown checked + disabled. */
  disabledEmails: Set<string>;
  onConfirm: (emails: string[]) => void;
  onClose: () => void;
}) => {
  const t = useT();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Group the (search-filtered) directory by division, divisions sorted.
  const groups = useMemo(() => {
    const n = norm(q);
    const map = new Map<string, DirectoryUser[]>();
    for (const u of directory) {
      if (
        n &&
        !norm(u.name).includes(n) &&
        !norm(u.email).includes(n) &&
        !norm(u.division ?? "").includes(n) &&
        !norm(u.title ?? "").includes(n)
      ) {
        continue;
      }
      const div = u.division || "—";
      const arr = map.get(div);
      if (arr) {
        arr.push(u);
      } else {
        map.set(div, [u]);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [directory, q]);

  const toggle = (email: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });

  const toggleDivision = (members: DirectoryUser[]) => {
    const emails = members
      .map((m) => m.email)
      .filter((e) => !disabledEmails.has(e));
    const allOn = emails.length > 0 && emails.every((e) => picked.has(e));
    setPicked((p) => {
      const next = new Set(p);
      emails.forEach((e) => (allOn ? next.delete(e) : next.add(e)));
      return next;
    });
  };

  return createPortal(
    <div className="mcm-cmodal-ov" onClick={onClose} role="presentation">
      <div
        className="mcm-mpick"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("invite.pickTitle")}
      >
        <header className="mcm-pp__head">
          <strong>
            <Users size={16} /> {t("invite.pickTitle")}
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

        <div className="mcm-mpick__search">
          <Search size={14} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("invite.search")}
          />
        </div>

        <div className="mcm-mpick__body mcm-scroll">
          {groups.length === 0 && (
            <p className="mcm-mpick__empty">{t("invite.empty")}</p>
          )}
          {groups.map(([div, members]) => {
            const pickable = members.filter((m) => !disabledEmails.has(m.email));
            const onCount = pickable.filter((m) => picked.has(m.email)).length;
            const allOn = pickable.length > 0 && onCount === pickable.length;
            return (
              <div className="mcm-mpick__group" key={div}>
                <button
                  type="button"
                  className="mcm-mpick__group-head"
                  onClick={() => toggleDivision(members)}
                >
                  <span
                    className={`mcm-mpick__check${
                      allOn ? " mcm-mpick__check--on" : ""
                    }`}
                  >
                    {allOn && <Check size={11} />}
                  </span>
                  <span className="mcm-mpick__group-name">{div}</span>
                  <span className="mcm-mpick__group-count">
                    {onCount > 0 ? `${onCount}/` : ""}
                    {members.length}
                  </span>
                </button>
                {members.map((u) => {
                  const disabled = disabledEmails.has(u.email);
                  const on = disabled || picked.has(u.email);
                  return (
                    <button
                      type="button"
                      key={u.email}
                      className="mcm-mpick__row"
                      disabled={disabled}
                      onClick={() => toggle(u.email)}
                    >
                      <span
                        className={`mcm-mpick__check${
                          on ? " mcm-mpick__check--on" : ""
                        }`}
                      >
                        {on && <Check size={11} />}
                      </span>
                      <span className="mcm-mpick__name">{u.name}</span>
                      <span className="mcm-mpick__sub">
                        {u.title || u.email}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <footer className="mcm-mpick__foot">
          <button
            type="button"
            className="mcm-btn mcm-btn--primary mcm-btn--block"
            disabled={picked.size === 0}
            onClick={() => {
              onConfirm([...picked]);
              onClose();
            }}
          >
            {t("invite.addSelected", { count: picked.size })}
          </button>
        </footer>
      </div>
    </div>,
    document.querySelector(".mcm-shell") ?? document.body,
  );
};

export default MemberPicker;
