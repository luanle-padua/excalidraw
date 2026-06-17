import { PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { clearPendingRoom, peekPendingRoom } from "../../data/pendingRoom";
import { getMeeting, IS_PROJECTS_CONFIGURED } from "../../data/projects";
import { isReviewRoom } from "../../data/reviewMode";
import { authReadyAtom, sessionAtom } from "../../data/session";
import { applyWallpaperToElement, wallpaperAtom } from "../../data/wallpaper";
import { useT } from "../../i18n/mcm";

import { ActivityLog } from "./ActivityLog";
import { AdminConsole } from "./AdminConsole";
import { ClientPortal } from "./ClientPortal";
import { LangSwitcher, ThemeToggle } from "./LangThemeSwitcher";
import { LoginScreen } from "./LoginScreen";
import { isFinishedStatus, normalizeMeetingStatus } from "./meetingStatus";
import { NotificationBell } from "./NotificationBell";
import { ProjectBrowser } from "./ProjectBrowser";
import { UserMenu } from "./UserMenu";
import { UserProfileModal } from "./UserProfileModal";
import { WallpaperPicker } from "./WallpaperPicker";

import "./Wallpaper.scss";

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
  // Wallpaper preference (localStorage-backed). Applied to the root via the
  // ref callback below — setWallpaper() also stamps live DOM directly, but
  // the ref covers the FIRST mount (and any remount) from the persisted value.
  const wallpaper = useAtomValue(wallpaperAtom);

  const [dismissed, setDismissed] = useState(false);
  // "Hồ sơ & avatar" from the user chip — the modal is shared with the
  // in-meeting shell but gets its own open state here so the dashboard
  // can edit the profile without entering a meeting.
  const [profileOpen, setProfileOpen] = useState(false);
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

  // AUTO-JOIN the invite room once authenticated. Someone who opened a
  // `#room=ID,KEY` share link logs in (password in-place, or a passwordless
  // round-trip that DROPS the hash) — afterwards nothing re-fires the join, so
  // they'd be stranded on the dashboard. We look in BOTH the live URL and the
  // pendingRoom stash (set before a hash-dropping login) and start collab.
  //   • App.initializeScene already joins for a user authenticated AT MOUNT —
  //     so only step in on the logged-out→in TRANSITION, or when a stash exists
  //     (the hash was dropped, so App.initializeScene never saw a room).
  //   • Guarded by a per-room ref so it fires once, not on every re-render.
  const prevSessionRef = useRef(session);
  const autoJoinKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const wasLoggedOut = !prevSessionRef.current;
    prevSessionRef.current = session;
    if (!authReady || !session || !collabAPI || isCollaborating || startGate) {
      return;
    }
    const stashed = peekPendingRoom();
    const m = window.location.hash.match(
      /#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]{20,})/,
    );
    const room = stashed ?? (m ? { roomId: m[1], roomKey: m[2] } : null);
    if (!room || (!stashed && !wasLoggedOut)) {
      return;
    }
    const key = `${room.roomId},${room.roomKey}`;
    if (autoJoinKeyRef.current === key || collabAPI.isCollaborating()) {
      return;
    }
    autoJoinKeyRef.current = key;
    clearPendingRoom();
    // Restore the canonical collab URL (a redirect may have stripped it), then
    // join — the same path the manual "Join via link" takes.
    window.history.pushState({}, "", getCollaborationLink(room));
    void collabAPI.startCollaboration(room);
  }, [authReady, session, collabAPI, isCollaborating, startGate]);

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
  // Owner (developer super-admin, spec §1.4) has ALL admin powers, so it lands
  // on the same AdminConsole as admin — a dedicated Owner console is future.
  if (session.isAdmin || session.isOwner) {
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

  // External project-scoped guest: a stripped-down "guest lobby" — NEVER the
  // staff ProjectBrowser. We keep the brand, LangSwitcher, ThemeToggle,
  // UserMenu and the resume banner, but drop the staff chrome (WallpaperPicker,
  // ActivityLog, NotificationBell, "use solo") and swap the dashboard for the
  // single-column ClientPortal. Security is server-side; this is UX only.
  const isGuest = session.isGuest;

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

  return (
    <div
      className="mcm-lobby"
      role="dialog"
      aria-modal="true"
      ref={(el) => {
        if (el) {
          applyWallpaperToElement(el, wallpaper);
        }
      }}
    >
      <div className="mcm-lobby__home">
        <header className="mcm-lobby__top">
          <div className="mcm-lobby__brand">
            <img
              src="/canvas-m.png"
              alt="Canvas M"
              className="mcm-lobby__logo-img"
            />
          </div>
          <div className="mcm-lobby__top-actions">
            {/* Cluster 1 — uniform 32px round icon buttons. Bell = pending
                invitations (to-do); History = personal action log (quyết
                định 06-11); Image = wallpaper picker (06-12); Moon = theme
                toggle. */}
            {/* Staff-only chrome — a guest gets none of it (bell/history/
                wallpaper/"use solo"). Theme toggle stays for everyone. */}
            <div className="mcm-lobby__top-cluster">
              {!isGuest && <NotificationBell />}
              {!isGuest && <ActivityLog />}
              {!isGuest && <WallpaperPicker />}
              <ThemeToggle />
            </div>
            <span className="mcm-lobby__top-sep" aria-hidden="true" />
            {/* Cluster 2 — VI/EN/KO mini segmented capsule. */}
            <LangSwitcher />
            <span className="mcm-lobby__top-sep" aria-hidden="true" />
            {/* Cluster 3 — secondary entries as matching ghost capsules.
                "Use solo" is a staff affordance; a guest only joins meetings
                they were invited to. */}
            {!isGuest && (
              <>
                <div className="mcm-lobby__top-cluster">
                  <button
                    type="button"
                    className="mcm-lobby__join-toggle"
                    onClick={() => setDismissed(true)}
                  >
                    {t("lobby.solo")}
                  </button>
                </div>
                <span className="mcm-lobby__top-sep" aria-hidden="true" />
              </>
            )}
            {/* Cluster 4 — signed-in identity: avatar chip → account menu
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

        {isGuest ? (
          // A guest must NEVER mount the staff ProjectBrowser — the minimal
          // ClientPortal lists only the meetings they were invited to.
          <ClientPortal session={session} />
        ) : IS_PROJECTS_CONFIGURED ? (
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
