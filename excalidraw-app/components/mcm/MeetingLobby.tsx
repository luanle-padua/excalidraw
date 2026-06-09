import { PlayCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import {
  clearLastMeeting,
  getLastMeeting,
  type LastMeeting,
} from "../../data/lastMeeting";
import { getMeeting, IS_PROJECTS_CONFIGURED } from "../../data/projects";
import { authReadyAtom, sessionAtom, signOut } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { AdminConsole } from "./AdminConsole";
import { LangThemeSwitcher } from "./LangThemeSwitcher";
import { LoginScreen } from "./LoginScreen";
import { ProjectBrowser } from "./ProjectBrowser";

/**
 * Project-first home for MAP CanvasMeet.
 *
 * Shown as a full-screen overlay whenever the user is NOT in a meeting.
 * The center of gravity is PROJECTS: pick (or create) a project, then
 * reopen a past meeting or start a new one inside it — every meeting is
 * project-based. "Join via link" and "use the canvas solo" are side
 * options. (When storage isn't configured, falls back to a plain
 * ad-hoc "New meeting" button so the app still works offline.)
 */

/** Pull `{ roomId, roomKey }` out of whatever the user pasted: a full
 *  collab URL, a bare `#room=ID,KEY` fragment, or just `ID,KEY`. */
const parseJoinInput = (
  raw: string,
): { roomId: string; roomKey: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(
    /(?:#room=)?([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]{20,})/,
  );
  return match ? { roomId: match[1], roomKey: match[2] } : null;
};

export const MeetingLobby = () => {
  const t = useT();
  const collabAPI = useAtomValue(collabAPIAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const session = useAtomValue(sessionAtom);
  const authReady = useAtomValue(authReadyAtom);

  const [dismissed, setDismissed] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinValue, setJoinValue] = useState("");
  const [joinError, setJoinError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState<{
    room: LastMeeting;
    title: string;
  } | null>(null);

  // Offer "Resume" if the user left a meeting open (saved in localStorage)
  // and reopened the app on a clean URL. Drops the offer if that meeting
  // no longer exists in the registry.
  useEffect(() => {
    const last = getLastMeeting();
    if (!session || !last) {
      setResume(null);
      return;
    }
    let cancelled = false;
    void getMeeting(last.roomId).then((m) => {
      if (cancelled) {
        return;
      }
      if (!m) {
        clearLastMeeting();
        setResume(null);
      } else {
        setResume({ room: last, title: m.title ?? "" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Still resolving the Supabase session — render nothing for the brief check
  // so we don't flash the login screen at an already-authenticated user.
  if (!authReady) {
    return null;
  }

  // LOGIN REQUIRED FOR EVERYONE — including invite-link joiners (the #room hash
  // stays in the URL, so App auto-joins right after login). This closes the old
  // anonymous link-join path; meeting data is confidential. The Worker also
  // enforces auth server-side, so this is the UX half of the same gate.
  if (!session) {
    return <LoginScreen />;
  }

  // Admin = pure back-office: the admin account ONLY administers, it never
  // joins meetings — so the console always takes over (no exit to the app).
  if (session.isAdmin) {
    return <AdminConsole />;
  }

  // Authenticated: suppress the project home while in a meeting, auto-joining
  // from a link, gone solo, or before collab is ready. Live (NOT memoized) hash
  // check so leaving a meeting re-shows the home.
  const hasRoomInUrl = /#room=[a-zA-Z0-9_-]+,/.test(window.location.hash);
  if (isCollaborating || hasRoomInUrl || dismissed || !collabAPI) {
    return null;
  }

  const startAdHoc = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await collabAPI.startCollaboration(null);
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    if (!resume || busy) {
      return;
    }
    setBusy(true);
    try {
      window.history.pushState({}, "", getCollaborationLink(resume.room));
      await collabAPI.startCollaboration(resume.room);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (busy) {
      return;
    }
    const data = parseJoinInput(joinValue);
    if (!data) {
      setJoinError(true);
      return;
    }
    setJoinError(false);
    setBusy(true);
    try {
      window.history.pushState({}, "", getCollaborationLink(data));
      await collabAPI.startCollaboration(data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcm-lobby" role="dialog" aria-modal="true">
      <div className="mcm-lobby__home">
        <header className="mcm-lobby__top">
          <div className="mcm-lobby__brand">
            <span className="mcm-lobby__logo">◳</span>
            <span className="mcm-lobby__title">MAP CanvasMeet</span>
          </div>
          <div className="mcm-lobby__top-actions">
            <LangThemeSwitcher />
            <button
              type="button"
              className="mcm-lobby__join-toggle"
              onClick={() => setDismissed(true)}
            >
              {t("lobby.solo")}
            </button>
            <button
              type="button"
              className="mcm-lobby__join-toggle"
              onClick={() => setJoinOpen((v) => !v)}
            >
              {t("lobby.joinByLink")}
            </button>
            <button
              type="button"
              className="mcm-lobby__join-toggle"
              onClick={() => void signOut()}
              title={`${session.name} · ${session.email}`}
            >
              {t("login.signOut")}
            </button>
          </div>
        </header>

        {resume && (
          <button
            type="button"
            className="mcm-lobby__resume"
            onClick={handleResume}
            disabled={busy}
          >
            <PlayCircle size={19} />
            <span className="mcm-lobby__resume-text">
              <strong>{t("lobby.resume")}</strong>
              <span>{resume.title || t("folder.meetingFallbackTitle")}</span>
            </span>
          </button>
        )}

        {joinOpen && (
          <div className="mcm-lobby__join">
            <input
              type="text"
              className={`mcm-lobby__input${
                joinError ? " mcm-lobby__input--error" : ""
              }`}
              placeholder={t("lobby.joinPlaceholder")}
              value={joinValue}
              autoFocus
              onChange={(e) => {
                setJoinValue(e.target.value);
                setJoinError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void join();
                }
              }}
            />
            <button
              type="button"
              className="mcm-lobby__join-btn"
              onClick={join}
              disabled={busy || !joinValue.trim()}
            >
              {t("lobby.join")}
            </button>
          </div>
        )}
        {joinError && <p className="mcm-lobby__error">{t("lobby.joinError")}</p>}

        {IS_PROJECTS_CONFIGURED ? (
          <ProjectBrowser />
        ) : (
          <div className="mcm-lobby__fallback">
            <p className="mcm-lobby__tagline">{t("lobby.tagline")}</p>
            <button
              type="button"
              className="mcm-lobby__primary"
              onClick={startAdHoc}
              disabled={busy}
            >
              {t("lobby.newMeeting")}
            </button>
          </div>
        )}

      </div>
    </div>
  );
};

export default MeetingLobby;
