import { PlayCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  collabAPIAtom,
  isCollaboratingAtom,
  startGateAtom,
} from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import {
  clearLastMeeting,
  getLastMeeting,
  type LastMeeting,
} from "../../data/lastMeeting";
import { getMeeting, IS_PROJECTS_CONFIGURED } from "../../data/projects";
import { isReviewRoom } from "../../data/reviewMode";
import { authReadyAtom, sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { AdminConsole } from "./AdminConsole";
import { LangThemeSwitcher } from "./LangThemeSwitcher";
import { LoginScreen } from "./LoginScreen";
import { isFinishedStatus, normalizeMeetingStatus } from "./meetingStatus";
import { ProjectBrowser } from "./ProjectBrowser";
import { UserMenu } from "./UserMenu";
import { UserProfileModal } from "./UserProfileModal";

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
  // Subscribing matters even though the WaitingForStart overlay covers us:
  // when the user backs out of the start gate (clearing the #room hash), this
  // re-render is what re-evaluates hasRoomInUrl below so the home reappears.
  const startGate = useAtomValue(startGateAtom);

  const [dismissed, setDismissed] = useState(false);
  // "Hồ sơ & avatar" from the user chip — the modal is shared with the
  // in-meeting shell but gets its own open state here so the dashboard
  // can edit the profile without entering a meeting.
  const [profileOpen, setProfileOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinValue, setJoinValue] = useState("");
  const [joinError, setJoinError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState<{
    room: LastMeeting;
    title: string;
  } | null>(null);

  // Offer "Resume" if the user left a meeting open (saved in localStorage)
  // and reopened the app on a clean URL. Resume is ONLY for meetings that are
  // actually resumable — `live`, or a legacy/ad-hoc row with no status:
  //   • missing row            → stale pointer, clear it.
  //   • finished / cancelled   → terminal (review-only lifecycle): the pointer
  //     outlived "End meeting for all" — the ender's clearLastMeeting() can't
  //     reach OTHER participants' localStorage, so every browser must re-check
  //     the registry status here and drop the dead pointer itself.
  //   • scheduled              → not started yet; joining goes through the
  //     start gate (WaitingForStart), never a "Resume" shortcut. Keep the
  //     pointer (it becomes resumable once the host Starts) but don't offer.
  useEffect(() => {
    if (!session) {
      setResume(null);
      return;
    }
    let cancelled = false;
    const revalidate = () => {
      const last = getLastMeeting();
      if (!last) {
        setResume(null);
        return;
      }
      void getMeeting(last.roomId).then((m) => {
        if (cancelled) {
          return;
        }
        if (!m || isFinishedStatus(m.status)) {
          clearLastMeeting();
          setResume(null);
        } else if (normalizeMeetingStatus(m.status) === "scheduled") {
          setResume(null);
        } else {
          setResume({ room: last, title: m.title ?? "" });
        }
      });
    };
    revalidate();
    // The check above is point-in-time — if the host "End for all"s while
    // this user is parked at the lobby, the banner would go stale and offer
    // a resume into a finished meeting. Re-validate whenever the user comes
    // back to the tab (the moment they'd actually click it).
    window.addEventListener("focus", revalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", revalidate);
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
  // SOLE exception (quyết định 06-10 #1): COMPLIANCE REVIEW. When the admin
  // opened a meeting's content from the console, the #room hash AND the
  // per-tab review mark (markReviewRoom, set before joining) are both
  // present — let the read-only canvas show through. Leaving the meeting
  // clears the hash, so the console takes over again. A raw #room link
  // WITHOUT the review mark never bypasses the console.
  const adminReviewRoomId =
    window.location.hash.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;
  if (session.isAdmin) {
    if (adminReviewRoomId && isReviewRoom(adminReviewRoomId)) {
      return null;
    }
    return <AdminConsole />;
  }

  // Authenticated: suppress the project home while in a meeting, auto-joining
  // from a link, gone solo, or before collab is ready. Live (NOT memoized) hash
  // check so leaving a meeting re-shows the home.
  const hasRoomInUrl = /#room=[a-zA-Z0-9_-]+,/.test(window.location.hash);
  if (isCollaborating || hasRoomInUrl || startGate || dismissed || !collabAPI) {
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
      // Last-second status check: the banner may have gone stale since the
      // focus revalidation (host ended the meeting seconds ago). A finished
      // meeting must never be "resumed" — drop the pointer and the banner.
      const m = await getMeeting(resume.room.roomId);
      if (!m || isFinishedStatus(m.status)) {
        clearLastMeeting();
        setResume(null);
        return;
      }
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
            {/* Signed-in identity: avatar + name chip → account menu
                (read-only info, profile editor, sign out). */}
            <UserMenu
              session={session}
              onOpenProfile={() => setProfileOpen(true)}
            />
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
        {joinError && (
          <p className="mcm-lobby__error">{t("lobby.joinError")}</p>
        )}

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

      {/* Profile editor reached from the user chip. The login name
          pre-fills the username on first open (no saved profile yet). */}
      <UserProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        defaultUsername={session.name}
      />
    </div>
  );
};

export default MeetingLobby;
