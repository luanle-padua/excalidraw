// Current-user chip + account menu for the lobby header.
//
// Shows WHO is signed in at a glance (avatar, name, title/division) and
// opens a small dropdown with a read-only identity block (name, email,
// org line) plus two actions: "Profile & avatar" (the shared
// UserProfileModal — open state is owned by MeetingLobby so the modal
// renders above the whole lobby) and "Sign out". Language/theme settings
// keep living in LangThemeSwitcher next door, so this menu stays strictly
// about identity.
//
// Identity sources, layered:
//   - sessionAtom (via the `session` prop) — the verified login: name,
//     email, company, branch. Always present here (the lobby renders the
//     chip only when authenticated).
//   - userProfileAtom — the user's self-styled display name + avatar
//     (editable through the profile modal); wins over the session name.
//   - getDirectory() — internal staff directory; best-effort lookup of
//     our own row for title/division. The chip simply shows less when
//     the directory is unavailable (guests, offline).

import { ChevronDown, LogOut, UserRoundPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { getDirectory } from "../../data/invite";
import { signOut } from "../../data/session";
import {
  resolveAvatarUrlWithDefault,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { personColor } from "./meetingColors";

import type { DirectoryUser } from "../../data/invite";
import type { Session } from "../../data/session";

/** Avatar with graceful degradation: the resolved library / uploaded
 *  image first, and — should that file ever fail to load — the same
 *  identity-hued initial badge every other person surface uses. */
const UserAvatar = ({
  url,
  name,
  email,
  large,
}: {
  url: string;
  name: string;
  email: string;
  large?: boolean;
}) => {
  const [failed, setFailed] = useState(false);

  // A new avatar pick deserves a fresh load attempt.
  useEffect(() => {
    setFailed(false);
  }, [url]);

  const cls = `mcm-user__ava${large ? " mcm-user__ava--lg" : ""}`;
  if (failed) {
    return (
      <span
        className={cls}
        style={{ ["--pa" as string]: personColor(email || name) }}
        aria-hidden="true"
      >
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <span className={cls} aria-hidden="true">
      <img src={url} alt="" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
};

type Props = {
  session: Session;
  /** Open the shared UserProfileModal (state lives in MeetingLobby). */
  onOpenProfile: () => void;
};

export const UserMenu = ({ session, onOpenProfile }: Props) => {
  const t = useT();
  const profile = useAtomValue(userProfileAtom);

  const [open, setOpen] = useState(false);
  const [dirSelf, setDirSelf] = useState<DirectoryUser | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Title/division come from the staff directory — the session only
  // carries company/branch. Best-effort: getDirectory() already returns
  // [] on any failure, so the chip just shows less in that case.
  useEffect(() => {
    let cancelled = false;
    void getDirectory().then((users) => {
      if (cancelled) {
        return;
      }
      const email = session.email.toLowerCase();
      setDirSelf(users.find((u) => u.email.toLowerCase() === email) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [session.email]);

  // Close on outside click / Esc while the dropdown is open.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Self-styled profile name wins over the directory/login name — it's
  // what peers see in meetings, so the chip should agree with it.
  const displayName = profile?.username || session.name;
  const title = dirSelf?.title;
  const division = dirSelf?.division ?? session.branch;
  // Chip second line: the single most specific descriptor we have.
  const chipSub = title ?? division ?? session.company;
  // Dropdown org line: everything we know, quietly joined.
  const orgLine = [title, division, session.company]
    .filter(Boolean)
    .join(" · ");
  const avatarUrl = resolveAvatarUrlWithDefault(profile?.avatar, session.email);

  return (
    <div className="mcm-user" ref={rootRef}>
      <button
        type="button"
        className="mcm-user__chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("user.menuAria")}
        title={`${displayName} · ${session.email}`}
      >
        <UserAvatar url={avatarUrl} name={displayName} email={session.email} />
        <span className="mcm-user__id">
          <span className="mcm-user__name">{displayName}</span>
          {chipSub && <span className="mcm-user__sub">{chipSub}</span>}
        </span>
        <ChevronDown size={14} className="mcm-user__chev" aria-hidden />
      </button>

      {open && (
        <div
          className="mcm-user__menu"
          role="menu"
          aria-label={t("user.menuAria")}
        >
          <div className="mcm-user__menu-eyebrow">{t("user.signedInAs")}</div>
          <div className="mcm-user__menu-head">
            <UserAvatar
              url={avatarUrl}
              name={displayName}
              email={session.email}
              large
            />
            <div className="mcm-user__menu-id">
              <div className="mcm-user__menu-name">{displayName}</div>
              <div className="mcm-user__menu-email">{session.email}</div>
              {orgLine && <div className="mcm-user__menu-org">{orgLine}</div>}
            </div>
          </div>
          <div className="mcm-user__menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="mcm-user__menu-item"
            onClick={() => {
              setOpen(false);
              onOpenProfile();
            }}
          >
            <UserRoundPen size={15} aria-hidden />
            {t("user.profile")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="mcm-user__menu-item mcm-user__menu-item--danger"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            <LogOut size={15} aria-hidden />
            {t("login.signOut")}
          </button>
        </div>
      )}
    </div>
  );
};

export default UserMenu;
