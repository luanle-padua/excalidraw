// Real "people in this meeting" strip. Pulls collaborators out of
// Excalidraw via the imperative API (we live outside Excalidraw's
// internal context tree, so `useUIAppState` isn't available here) and
// overlays the live audio status from AudioRoom — speaking ring,
// mic-off badge, "you" highlight. Falls back to the mock cast when the
// user isn't in a collab room yet so the design demo still looks
// populated.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { Mic, MicOff, UserCheck, UserX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import type {
  Collaborator,
  SocketId,
  UserToFollow,
} from "@excalidraw/excalidraw/types";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import {
  floatingPresenterAtom,
  pinnedSocketIdAtom,
  resolveFocusedId,
  togglePinnedSocketId,
} from "../../audio/videoFocus";
import { activeSpeakerAtom } from "../../audio/videoPerf";
import { videoLayoutAtom } from "../../audio/videoLayout";
import { galleryOpenAtom, videoTilesAtom } from "../../audio/videoState";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingReactionsAtom,
  meetingViewOnlyAtom,
  participantsPanelOpenAtom,
  raisedHandsAtom,
  screenShareStateAtom,
} from "../../collab/Collab";
import {
  getDirectory,
  listInvitees,
  listParticipants,
  type DirectoryUser,
  type MeetingInvitee,
  type MeetingParticipant,
} from "../../data/invite";
import { listKnocks, patchKnock, type WaitingKnock } from "../../data/knock";
import { sessionAtom } from "../../data/session";
import {
  hostSocketIdAtom,
  meetingViewerAuthorityAtom,
  peerAudioAtom,
  peerProfilesAtom,
  resolveAvatarUrl,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { FloatingPresenter } from "./FloatingPresenter";
import { KnockBanner } from "./KnockBanner";
import { usePickVideoLayout } from "./LayoutSwitcher";
import { MeetingGallery } from "./MeetingGallery";
import { VideoFilmstrip } from "./VideoFilmstrip";
import { shortDisplayName } from "./animalEmoji";
import { MOCK_PARTICIPANTS } from "./meetingMock";

import type { HTMLAttributes } from "react";

import type { MeetingReactionEvent } from "../../collab/Collab";
import type { MockParticipant } from "./meetingMock";

// Deterministic gradient from any string so peers without an assigned
// Excalidraw color still get a stable, distinguishable avatar tile.
const stringHash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};
const PALETTE: [string, string][] = [
  ["#34d399", "#0ea5e9"],
  ["#f472b6", "#ef4444"],
  ["#fbbf24", "#f97316"],
  ["#60a5fa", "#6366f1"],
  ["#a78bfa", "#ec4899"],
  ["#22d3ee", "#3b82f6"],
  ["#fb7185", "#f59e0b"],
  ["#84cc16", "#10b981"],
];
const gradientFor = (key: string): string => {
  const [a, b] = PALETTE[stringHash(key) % PALETTE.length];
  return `linear-gradient(135deg,${a},${b})`;
};

const MicOffIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="9"
    height="9"
  >
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
    <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23" />
  </svg>
);

const PeopleIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="13"
    height="13"
    aria-hidden="true"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const MicOnIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="13"
    height="13"
    aria-hidden="true"
  >
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M19 10a7 7 0 0 1-14 0" />
    <path d="M12 19v3" />
  </svg>
);

export type Tile = {
  id: string;
  name: string;
  avatar: string;
  /** Login email (lower-cased) when known — lets us match a present tile to an
   *  invitee row so the "invited but not here yet" list excludes who's online. */
  email?: string | null;
  isMe?: boolean;
  speaking: boolean;
  micOn: boolean;
  /** they're in the room but haven't joined the audio call yet */
  inCall: boolean;
  /** "raise hand" indicator — set by the participant via the call
   *  controls reactions popover; broadcast over WS_SUBTYPES.RAISE_HAND. */
  handRaised: boolean;
  /** any floating reactions currently animating over this avatar */
  reactions: MeetingReactionEvent[];
  /** true when the local user is currently following this participant
   *  (their viewport is locked to ours via Excalidraw's userToFollow).
   *  Drives the eye badge on the avatar tile. */
  isFollowed?: boolean;
  /** Company line from the user's profile — if present we render it
   *  underneath the display name. Empty / undefined skips the line. */
  company?: string;
  /** Resolved URL to an avatar image (library or uploaded) — only when the
   *  user actually PICKED one. When set, the tile shows that picture; when
   *  null the shared <MCMAvatar> falls back to identity initials. Drives the
   *  `--image` class so the gradient ring only shows behind a real photo. */
  avatarUrl?: string | null;
  /** Raw stored avatar value (`"lib:NN.png"` / `data:…`) passed straight to
   *  the shared <MCMAvatar>, which resolves an image or renders initials. */
  avatarRaw?: string | null;
  /** True for the participant currently elected as host (the
   *  link-sharer in steady state). Drives the small "Host" pill that
   *  sits above the avatar so everyone in the room sees who's host
   *  without needing to interact with the recording feature. */
  isHost?: boolean;
  /** True when this person holds the designated CO-HOST meeting role (a
   *  meeting_invitee row with role='cohost'). Drives a "Co-host" badge next to
   *  the host crown — a meeting-ROLE badge (anh Luân 06-16). */
  isCohost?: boolean;
  /** Org 직급 / title (chức vụ) resolved from the staff directory — display
   *  only, shown as a neutral chip. Separate axis from host/co-host role. */
  title?: string | null;
  /** True while this participant is sharing their screen (presence over
   *  WS_SUBTYPES.SCREEN_SHARE). Drives the 📺 badge on their avatar. */
  sharingScreen?: boolean;
  /** Live CAMERA stream (same Daily call object as audio) when this person's
   *  camera is ON. When present the tile renders a <video> in place of the
   *  MCMAvatar; absent ⇒ the avatar shows (default). */
  videoStream?: MediaStream | null;
};

// Renders a participant's live camera into their tile, in place of the avatar.
// Mirrored for self (front camera reads more naturally mirrored). If the track
// fails to attach we render nothing here and the avatar shows through — never
// a black tile. Muted/autoPlay/playsInline keeps it as a silent thumbnail
// (audio plays via Daily separately).
export const TileVideo = ({
  stream,
  mirror,
}: {
  stream: MediaStream;
  mirror: boolean;
}) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }
    setFailed(false);
    el.srcObject = stream;
    const play = () => el.play().catch(() => undefined);
    play();
    return () => {
      // Detach so the element releases the track on unmount / stream swap.
      el.srcObject = null;
    };
  }, [stream]);
  if (failed) {
    return null;
  }
  return (
    <video
      ref={ref}
      className={`mcm-person__video${
        mirror ? " mcm-person__video--mirror" : ""
      }`}
      muted
      autoPlay
      playsInline
      onError={() => setFailed(true)}
    />
  );
};

// Display rules:
//   - Show name ONLY for `me` and the current speaker; everyone else is
//     avatar-only with the name in the native tooltip on hover.
//   - Bottom-right corner indicator:
//       · mic-on + in-call → small green dot (no icon)
//       · mic-off + in-call → red mic-strikethrough badge (existing glyph)
//       · not in call → no indicator; avatar is dimmed via `--idle`
//   - Top-right ✋ badge when their hand is up (sticky, broadcast).
//   - Floating reactions (👍 ❤️ 🎉 …) animate over the avatar for ~3s.
// Reactions are NOT rendered inside the Person/avatar tree because
// the surrounding .mcm-people-bar__list has overflow-x:auto (which
// implicitly clips both axes). Instead we tag the row with a
// data-socket-id and a separate MeetingReactionsOverlay portals
// floating emojis onto <body> at the avatar's screen position.
const Person = ({
  p,
  onFollowToggle,
  onOpenProfile,
  onKick,
  onMute,
  hostMuted,
}: {
  p: Tile;
  onFollowToggle?: (tile: Tile) => void;
  /** Click handler used ONLY for the self tile — opens the profile
   *  editor (avatar / name / company). For other people the click
   *  routes through `onFollowToggle` instead. */
  onOpenProfile?: () => void;
  /** Host-only moderation, provided only when the local user is the host and
   *  this tile is a kickable peer (not me, not the host). */
  onKick?: (tile: Tile) => void;
  onMute?: (tile: Tile) => void;
  /** Whether the host has muted this participant — toggles the mute button to
   *  an "un-mute" affordance. */
  hostMuted?: boolean;
}) => {
  const t = useT();
  // Full name for the tooltip — always the original so user-set
  // names ("Mai", "Park Junho") are preserved verbatim on hover.
  const fullName = p.name.replace(/\s*\(.*?\)\s*$/, "");
  const displayName = shortDisplayName(p.name);
  // Always show the short name now — the bar is in 2-row vertical
  // layout (avatar on top, name below). Speaker / me still get
  // their own visual accents via colour modifiers.
  //
  // Two distinct click affordances on the tile:
  //   • Own tile (`isMe`) → open profile editor (avatar / name /
  //     company). Nothing to follow; the only meaningful action is
  //     "fix my own info".
  //   • Anyone else → toggle viewport follow.
  // The tip + the click handler swap accordingly.
  const selfClickable = !!p.isMe && !!onOpenProfile;
  const followable = !p.isMe && !!onFollowToggle;
  const clickable = selfClickable || followable;
  const tipSelf = `${fullName} — ${t("profile.openSettings")}`;
  const tipFollow = p.isFollowed
    ? `${fullName} — ${t("participants.unfollowHint")}`
    : `${fullName} — ${t("participants.followHint")}`;
  const tip = selfClickable ? tipSelf : followable ? tipFollow : fullName;
  // Spread the interactive attributes only when the tile is clickable.
  // The static role="button" literal is required by the
  // jsx-a11y/aria-role rule — passing it through a ternary makes the
  // rule reject the expression as "not a valid ARIA role" even though
  // "button" is.
  const handleClick = selfClickable
    ? () => onOpenProfile?.()
    : followable
    ? () => onFollowToggle?.(p)
    : undefined;
  const interactiveProps: HTMLAttributes<HTMLDivElement> =
    clickable && handleClick
      ? {
          role: "button",
          tabIndex: 0,
          onClick: handleClick,
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleClick();
            }
          },
        }
      : {};
  return (
    <div
      className={`mcm-person${p.isMe ? " mcm-person--me" : ""}${
        p.speaking ? " mcm-person--speaking" : ""
      }${!p.inCall ? " mcm-person--idle" : ""}${
        p.handRaised ? " mcm-person--raised" : ""
      }${p.isFollowed ? " mcm-person--followed" : ""}${
        followable ? " mcm-person--followable" : ""
      }${
        p.isHost ? " mcm-person--host" : ""
      } mcm-person--named mcm-person--emoji`}
      title={tip}
      data-socket-id={p.id}
      {...interactiveProps}
    >
      <div
        className={`mcm-person__avatar${
          p.avatarUrl ? " mcm-person__avatar--image" : ""
        }${p.videoStream ? " mcm-person__avatar--video" : ""}`}
      >
        {p.videoStream ? (
          <TileVideo stream={p.videoStream} mirror={!!p.isMe} />
        ) : (
          <MCMAvatar
            className="mcm-person__avatar-fill"
            avatar={p.avatarRaw}
            name={p.name}
            email={p.email}
            identityKey={p.email ?? p.id}
          />
        )}
        {p.isHost && (
          <span
            className="mcm-person__host-badge"
            aria-label={t("participants.host")}
            title={t("participants.host")}
          >
            <svg
              viewBox="0 0 24 24"
              width="10"
              height="10"
              fill="currentColor"
              aria-hidden="true"
            >
              {/* Small crown — reads as "host" instantly without
                  needing a tooltip on touch devices. */}
              <path d="M3 7l4.5 3L12 5l4.5 5L21 7l-1.5 11h-15z" />
            </svg>
          </span>
        )}
        {p.isCohost && !p.isHost && (
          <span
            className="mcm-person__host-badge mcm-person__host-badge--cohost"
            aria-label={t("participants.cohost")}
            title={t("participants.cohost")}
          >
            {/* Half-crown reading for the co-host — same shape, quieter tint. */}
            <svg
              viewBox="0 0 24 24"
              width="10"
              height="10"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M3 7l4.5 3L12 5l4.5 5L21 7l-1.5 11h-15z" />
            </svg>
          </span>
        )}
        {p.handRaised && (
          <span
            className="mcm-person__raise-badge"
            aria-label={t("participants.raiseHandAria")}
          >
            ✋
          </span>
        )}
        {p.sharingScreen && (
          <span
            className="mcm-person__share-badge"
            aria-label={t("participants.screenSharingAria")}
            title={t("participants.screenSharingAria")}
          >
            📺
          </span>
        )}
        {p.isFollowed && (
          <span
            className="mcm-person__follow-badge"
            aria-label={t("participants.followingAria")}
          >
            👁
          </span>
        )}
        {p.inCall && p.micOn && (
          <span className="mcm-person__live-dot" aria-hidden="true" />
        )}
        {p.inCall && !p.micOn && (
          <span
            className="mcm-person__mic-off"
            aria-label={t("participants.micOffAria")}
          >
            <MicOffIcon />
          </span>
        )}
      </div>
      <span className="mcm-person__name">{displayName}</span>
      {p.company && (
        <span className="mcm-person__company" title={p.company}>
          {p.company}
        </span>
      )}
      {(onMute || onKick) && (
        <div className="mcm-person__host-actions">
          {onMute && (
            <button
              type="button"
              className="mcm-person__ha-btn"
              title={
                hostMuted
                  ? t("participants.unmute")
                  : t("participants.muteHint")
              }
              aria-label={
                hostMuted
                  ? t("participants.unmute")
                  : t("participants.muteHint")
              }
              onClick={(e) => {
                e.stopPropagation();
                onMute(p);
              }}
            >
              {hostMuted ? <Mic size={11} /> : <MicOff size={11} />}
            </button>
          )}
          {onKick && (
            <button
              type="button"
              className="mcm-person__ha-btn mcm-person__ha-btn--danger"
              title={t("participants.kickHint")}
              aria-label={t("participants.kickHint")}
              onClick={(e) => {
                e.stopPropagation();
                onKick(p);
              }}
            >
              <UserX size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const mockTile = (p: MockParticipant): Tile => ({
  id: p.id,
  name: p.name,
  avatar: p.avatar,
  isMe: p.isMe,
  speaking: p.speaking,
  micOn: p.micOn,
  inCall: true,
  handRaised: false,
  reactions: [],
});

const REACTION_TTL_MS = 3200;

// Local 24h "HH:MM" formatter for attendance join times (review mode). Takes an
// explicit epoch-ms argument — never reads Date.now() — so it's pure and safe to
// call during render. Bad/zero timestamps render as an em dash.
const formatJoinTime = (ms: number): string => {
  if (!ms || Number.isNaN(ms)) {
    return "—";
  }
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

/** A person who ACTUALLY joined the finished meeting (review-mode roster).
 *  Sourced from listParticipants(); host/co-host/title merged in by email from
 *  the invitee + directory lookups where available. */
type AttendedRow = {
  email: string;
  name: string;
  joinedAt: number;
  isHost: boolean;
  isCohost: boolean;
  kind: "internal" | "guest";
  title?: string | null;
};

/** A person who was invited but isn't currently in the room. */
type InvitedRow = {
  email: string;
  name: string;
  kind: "internal" | "guest";
  /** Org 직급 / title (chức vụ) from the directory — display-only chip. */
  title?: string | null;
  /** They accepted the invite (vs merely invited) — a softer "expected" hint. */
  accepted: boolean;
};

// Zoom-style participant management panel — a right-side drawer that lists, in
// two clear sections, who's IN THE ROOM (online, with host actions) and who was
// INVITED but hasn't joined yet. Moderation lives here; the avatar-bar hover
// buttons are just a shortcut.
const ParticipantsPanel = ({
  tiles,
  invited,
  iAmHost,
  waitingKnocks,
  onKnockAction,
  onClose,
  onMute,
  onKick,
  viewOnly,
  attended,
}: {
  tiles: Tile[];
  invited: InvitedRow[];
  iAmHost: boolean;
  /** Guests knocking to enter (host-only; empty for non-hosts). */
  waitingKnocks: WaitingKnock[];
  onKnockAction: (email: string, action: "admit" | "deny") => void;
  onClose: () => void;
  onMute: (tile: Tile) => void;
  onKick: (tile: Tile) => void;
  /** Review mode (finished meeting): swap the live presence panel for a static
   *  ATTENDANCE roster (who joined + who was invited but didn't). */
  viewOnly: boolean;
  /** Who actually joined — only populated in review mode. */
  attended: AttendedRow[];
}) => {
  const t = useT();
  // REVIEW MODE: a finished meeting has no live presence (the collaborators map
  // is empty), so showing "in room / mic / kick" is meaningless. Instead render
  // a static attendance roster: who joined ("Đã tham gia") and who was invited
  // but never showed ("Đã mời"). No moderation, no mic state, no knocks.
  if (viewOnly) {
    return createPortal(
      <div className="mcm-pp-overlay" onClick={onClose} role="presentation">
        <aside
          className="mcm-pp"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={t("participants.panelTitle")}
        >
          <header className="mcm-pp__head">
            <strong>
              {t("participants.panelTitle")} ({attended.length})
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

          <div className="mcm-pp__section">Đã tham gia ({attended.length})</div>
          <ul className="mcm-pp__list">
            {attended.map((a) => (
              <li key={a.email} className="mcm-pp__row">
                <MCMAvatar
                  className="mcm-pp__avatar"
                  name={a.name}
                  email={a.email}
                />
                <div className="mcm-pp__meta">
                  <span className="mcm-pp__name">
                    {a.name}
                    {a.isHost && (
                      <span className="mcm-pp__tag">
                        {t("participants.host")}
                      </span>
                    )}
                    {a.isCohost && !a.isHost && (
                      <span className="mcm-pp__tag mcm-pp__tag--cohost">
                        {t("participants.cohost")}
                      </span>
                    )}
                    {a.kind === "guest" && (
                      <span className="mcm-pp__tag">
                        {t("participants.guestTag")}
                      </span>
                    )}
                    {a.title && (
                      <span className="mcm-pp__title-chip">{a.title}</span>
                    )}
                  </span>
                  <span className="mcm-pp__company">{a.email}</span>
                </div>
                <span className="mcm-pp__invited-status">
                  Tham gia {formatJoinTime(a.joinedAt)}
                </span>
              </li>
            ))}
          </ul>

          {invited.length > 0 && (
            <>
              <div className="mcm-pp__section">
                Đã mời ({invited.length})
              </div>
              <ul className="mcm-pp__list mcm-pp__list--invited">
                {invited.map((iv) => (
                  <li
                    key={iv.email}
                    className="mcm-pp__row mcm-pp__row--invited"
                  >
                    <MCMAvatar
                      className="mcm-pp__avatar"
                      name={iv.name}
                      email={iv.email}
                    />
                    <div className="mcm-pp__meta">
                      <span className="mcm-pp__name">
                        {iv.name}
                        {iv.kind === "guest" && (
                          <span className="mcm-pp__tag">
                            {t("participants.guestTag")}
                          </span>
                        )}
                        {iv.title && (
                          <span className="mcm-pp__title-chip">
                            {iv.title}
                          </span>
                        )}
                      </span>
                      <span className="mcm-pp__company">{iv.email}</span>
                    </div>
                    <span className="mcm-pp__invited-status">
                      {iv.accepted
                        ? t("participants.statusAccepted")
                        : t("participants.statusInvited")}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div className="mcm-pp-overlay" onClick={onClose} role="presentation">
      <aside
        className="mcm-pp"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("participants.panelTitle")}
      >
        <header className="mcm-pp__head">
          <strong>
            {t("participants.panelTitle")} ({tiles.length})
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
        {invited.length > 0 && (
          <div className="mcm-pp__section">{t("participants.inRoom")}</div>
        )}
        <ul className="mcm-pp__list">
          {tiles.map((p) => {
            const fullName = p.name.replace(/\s*\(.*?\)\s*$/, "");
            const canModerate = iAmHost && !p.isMe && !p.isHost;
            return (
              <li key={p.id} className="mcm-pp__row">
                <MCMAvatar
                  className="mcm-pp__avatar"
                  avatar={p.avatarRaw}
                  name={p.name}
                  email={p.email}
                  identityKey={p.email ?? p.id}
                />
                <div className="mcm-pp__meta">
                  <span className="mcm-pp__name">
                    {fullName}
                    {p.isMe && ` (${t("participants.you")})`}
                    {p.isHost && (
                      <span className="mcm-pp__tag">
                        {t("participants.host")}
                      </span>
                    )}
                    {p.isCohost && !p.isHost && (
                      <span className="mcm-pp__tag mcm-pp__tag--cohost">
                        {t("participants.cohost")}
                      </span>
                    )}
                    {p.title && (
                      <span className="mcm-pp__title-chip">{p.title}</span>
                    )}
                  </span>
                  {p.company && (
                    <span className="mcm-pp__company">{p.company}</span>
                  )}
                </div>
                <span
                  className={`mcm-pp__mic${
                    p.inCall && !p.micOn ? " mcm-pp__mic--off" : ""
                  }`}
                  aria-hidden="true"
                >
                  {p.inCall ? p.micOn ? <MicOnIcon /> : <MicOffIcon /> : "—"}
                </span>
                {canModerate && (
                  <div className="mcm-pp__actions">
                    <button
                      type="button"
                      className="mcm-pp__btn"
                      onClick={() => onMute(p)}
                    >
                      {p.inCall && !p.micOn ? (
                        <>
                          <Mic size={13} /> {t("participants.unmute")}
                        </>
                      ) : (
                        <>
                          <MicOff size={13} /> {t("participants.mute")}
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="mcm-pp__btn mcm-pp__btn--danger"
                      onClick={() => onKick(p)}
                    >
                      <UserX size={13} /> {t("participants.kick")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {iAmHost && waitingKnocks.length > 0 && (
          <>
            <div className="mcm-pp__section">
              {t("participants.waitingSection", {
                count: waitingKnocks.length,
              })}
            </div>
            <ul className="mcm-pp__list mcm-pp__list--waiting">
              {waitingKnocks.map((k) => {
                const fullName = k.name || k.email;
                return (
                  <li
                    key={k.email}
                    className="mcm-pp__row mcm-pp__row--invited"
                  >
                    <MCMAvatar
                      className="mcm-pp__avatar"
                      name={fullName}
                      email={k.email}
                    />
                    <div className="mcm-pp__meta">
                      <span className="mcm-pp__name">
                        {fullName}
                        <span className="mcm-pp__tag">
                          {t("participants.guestTag")}
                        </span>
                      </span>
                      <span className="mcm-pp__company">{k.email}</span>
                    </div>
                    <div className="mcm-pp__actions">
                      <button
                        type="button"
                        className="mcm-pp__btn"
                        onClick={() => onKnockAction(k.email, "admit")}
                      >
                        <UserCheck size={13} /> {t("participants.admit")}
                      </button>
                      <button
                        type="button"
                        className="mcm-pp__btn mcm-pp__btn--danger"
                        onClick={() => onKnockAction(k.email, "deny")}
                      >
                        <UserX size={13} /> {t("participants.deny")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {invited.length > 0 && (
          <>
            <div className="mcm-pp__section">
              {t("participants.invited")} ({invited.length})
            </div>
            <ul className="mcm-pp__list mcm-pp__list--invited">
              {invited.map((iv) => (
                <li key={iv.email} className="mcm-pp__row mcm-pp__row--invited">
                  <MCMAvatar
                    className="mcm-pp__avatar"
                    name={iv.name}
                    email={iv.email}
                  />
                  <div className="mcm-pp__meta">
                    <span className="mcm-pp__name">
                      {iv.name}
                      {iv.kind === "guest" && (
                        <span className="mcm-pp__tag">
                          {t("participants.guestTag")}
                        </span>
                      )}
                      {iv.title && (
                        <span className="mcm-pp__title-chip">{iv.title}</span>
                      )}
                    </span>
                    <span className="mcm-pp__company">{iv.email}</span>
                  </div>
                  <span className="mcm-pp__invited-status">
                    {iv.accepted
                      ? t("participants.statusAccepted")
                      : t("participants.statusInvited")}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
};

type ParticipantsBarProps = {
  /** Open the local user's profile editor — wired from MeetingShell
   *  so a click on your own avatar tile pops the same modal that the
   *  header gear icon does. */
  onOpenProfile?: () => void;
};

export const ParticipantsBar = ({
  onOpenProfile,
}: ParticipantsBarProps = {}) => {
  const t = useT();
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  // REVIEW MODE flag — true for a finished, read-only meeting. When set, the
  // participants UI switches from live presence (empty/stale here) to a static
  // attendance roster, and all live-only moderation/knock/count affordances are
  // suppressed below.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const audioState = useAtomValue(audioStateAtom);
  // Live camera streams keyed by socket.id (same call object as audio). A tile
  // whose socket.id is present here renders a <video>; otherwise the avatar.
  const videoTiles = useAtomValue(videoTilesAtom);
  // Which video SURFACE to render (minimal strip / bottom filmstrip / full
  // gallery). Persisted per-user. We keep galleryOpenAtom in sync so any other
  // caller that toggles it (or reads it) still works — "gallery" mode IS the
  // gallery being open.
  const videoLayout = useAtomValue(videoLayoutAtom);
  // Shared "pick surface" action (drives videoLayoutAtom + keeps galleryOpenAtom
  // in sync) — same hook the header switcher uses, so both agree.
  const pickLayout = usePickVideoLayout();
  const galleryOpen = useAtomValue(galleryOpenAtom);
  const setGalleryOpen = useSetAtom(galleryOpenAtom);
  const raisedHands = useAtomValue(raisedHandsAtom);
  const screenSharePresence = useAtomValue(screenShareStateAtom);
  // ONE shared focus concept (pin > screenshare > active-speaker > host >
  // first) reused by the gallery-speaker big tile, the filmstrip ring and the
  // floating PiP — computed HERE because this is where the tiles already exist.
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  const pinnedSocketId = useAtomValue(pinnedSocketIdAtom);
  const floatingPresenter = useAtomValue(floatingPresenterAtom);
  const liveReactions = useAtomValue(meetingReactionsAtom);
  // Local + peer UserProfiles drive the company line + custom avatar
  // image on each tile. Self reads its own profile directly (no
  // round-trip through the socket); peers come from broadcasts.
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  // Project authority (leader / division head) gets host moderation too.
  const viewerAuthority = useAtomValue(meetingViewerAuthorityAtom);
  // Per-peer audio state (in-call + muted), broadcast over AUDIO_STATE — lets
  // every tile show the real mic on/off/idle icon, including a peer's
  // self-mute (which Daily's track drop alone renders as plain "idle").
  const peerAudio = useAtomValue(peerAudioAtom);
  // Single source of truth for "who is host" — derived from the
  // smallest joinedAt across self + every peer's USER_PROFILE
  // payload. The link-sharer's sentinel `joinedAt = 1` ensures they
  // always win the election.
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  // A project-scoped guest is never a moderator — even if socket host-election
  // momentarily lands on them, kick/mute stay hidden (the worker also refuses
  // the host command server-side).
  const session = useAtomValue(sessionAtom);

  // We live outside Excalidraw's internal provider tree, so we can't
  // call useUIAppState() — instead we subscribe to the imperative
  // onChange stream and keep a local copy of just the collaborator
  // map. (Lightweight: only re-renders this strip when the map's
  // identity changes, which is on join/leave.)
  const [collaborators, setCollaborators] = useState<
    ReadonlyMap<SocketId, Collaborator>
  >(() => new Map());
  // Mirror of Excalidraw's appState.userToFollow so we can highlight
  // the avatar currently being followed AND render the "Đang follow X
  // — Esc để thoát" banner.
  const [userToFollow, setUserToFollow] = useState<UserToFollow | null>(null);
  const panelOpen = useAtomValue(participantsPanelOpenAtom);
  const setPanelOpen = useSetAtom(participantsPanelOpenAtom);

  // The meeting's INVITEE roster (who was asked) — so the panel can show
  // "invited but not here yet" next to who's online (anh Luân 06-15: "show
  // người được mời, và người online một cách khoa học"). Internal-only (the
  // worker 403s guests); refreshed when the panel opens. roomId is parsed from
  // the live share link.
  const roomId = activeRoomLink?.split("#room=")[1]?.split(",")[0] ?? null;
  const [invitees, setInvitees] = useState<MeetingInvitee[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  // WAITING ROOM (host side): guests knocking to enter. Host-only — the poll
  // below is gated on iAmHost, so a non-host keeps this empty.
  const [waitingKnocks, setWaitingKnocks] = useState<WaitingKnock[]>([]);
  // ATTENDANCE roster (review mode only): who ACTUALLY joined the finished
  // meeting (vs invitees = who was asked). Empty during live meetings — only
  // fetched when viewOnly, so live behavior is untouched.
  const [attendance, setAttendance] = useState<MeetingParticipant[]>([]);
  useEffect(() => {
    if (!roomId || session?.isGuest) {
      setInvitees([]);
      return;
    }
    let alive = true;
    void listInvitees(roomId).then((iv) => alive && setInvitees(iv));
    void getDirectory().then((u) => alive && setDirectory(u));
    return () => {
      alive = false;
    };
  }, [roomId, session?.isGuest, panelOpen]);

  // Fetch the attendance roster ONLY in review mode. When live (!viewOnly) we
  // keep it empty and skip the call entirely — the live presence path is the
  // source of truth there.
  useEffect(() => {
    if (!roomId || !viewOnly) {
      setAttendance([]);
      return;
    }
    let alive = true;
    void listParticipants(roomId).then((rows) => alive && setAttendance(rows));
    return () => {
      alive = false;
    };
  }, [roomId, viewOnly, panelOpen]);

  // Host identity — computed HERE (above the early return below) so the
  // knock-poll hook runs UNCONDITIONALLY (Rules of Hooks). selfSocketId/iAmHost
  // are plain derivations reused for tile building + moderation further down.
  const selfSocketId = collabAPI?.portal.socket?.id ?? "me";
  const iAmHost =
    !session?.isGuest &&
    ((!!hostSocketId && hostSocketId === selfSocketId) || viewerAuthority);
  // WAITING ROOM (host side): poll who's knocking every 5s. Gate on the
  // SERVER-confirmed authority (viewerAuthority), NOT the client iAmHost — the
  // latter ORs in a joinedAt "acting host" election, but the worker's /knocks
  // gate only accepts the organizer/host/cohost/authority (isMeetingManager), so
  // an acting-host who isn't the organizer used to 403-loop every 5s (06-18).
  useEffect(() => {
    if (!viewerAuthority || !roomId) {
      setWaitingKnocks([]);
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      const rows = await listKnocks(roomId);
      if (alive) {
        setWaitingKnocks(rows);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // Depend on viewerAuthority (the actual gate), NOT iAmHost: viewerAuthority
    // resolves ASYNC after a getMeeting() round-trip, while iAmHost is often
    // already true via the socket host-election. Keying on iAmHost meant that
    // when authority flipped true the effect didn't re-run, so the knock poll
    // never started and the host never saw anyone waiting (06-18).
  }, [viewerAuthority, roomId]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    setCollaborators(excalidrawAPI.getAppState().collaborators);
    setUserToFollow(excalidrawAPI.getAppState().userToFollow ?? null);
    const unsub = excalidrawAPI.onChange((_elements, appState) => {
      // referential check — the collab layer constructs a new Map on
      // every roster change, so this is a cheap O(1) gate.
      setCollaborators((prev) =>
        prev === appState.collaborators ? prev : appState.collaborators,
      );
      setUserToFollow((prev) => {
        const next = appState.userToFollow ?? null;
        if (
          prev?.socketId === next?.socketId &&
          prev?.username === next?.username
        ) {
          return prev;
        }
        return next;
      });
    });
    return unsub;
  }, [excalidrawAPI]);

  /** Toggle local follow of a peer. Setting appState.userToFollow
   *  triggers Excalidraw's `onUserFollow` callback, which Collab
   *  broadcasts via USER_FOLLOW_CHANGE — the followed peer then
   *  streams its visible scene bounds back over the room's existing
   *  USER_VISIBLE_SCENE_BOUNDS channel and our viewport auto-zooms
   *  to match. All of that is built in to the Excalidraw + Collab
   *  pipeline; this handler just flips the appState bit. */
  const handleFollowToggle = (tile: Tile) => {
    if (!excalidrawAPI || tile.isMe) {
      return;
    }
    const alreadyFollowing = userToFollow?.socketId === tile.id;
    excalidrawAPI.updateScene({
      appState: alreadyFollowing
        ? { userToFollow: null }
        : {
            userToFollow: {
              socketId: tile.id as SocketId,
              username: tile.name,
            },
          },
    });
  };

  // Esc-to-stop. Mirrors the keyboard shortcut Excalidraw uses for
  // most overlays, and makes the badge dismissable without reaching
  // for the avatar again.
  useEffect(() => {
    if (!userToFollow || !excalidrawAPI) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        excalidrawAPI.updateScene({ appState: { userToFollow: null } });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [userToFollow, excalidrawAPI]);

  // Auto-expire floating reactions after their animation finishes. We
  // schedule one timeout per reaction id; cleanup on unmount or when
  // a reaction is replaced.
  useEffect(() => {
    if (!collabAPI || liveReactions.length === 0) {
      return undefined;
    }
    const timers: number[] = [];
    for (const r of liveReactions) {
      const elapsed = Date.now() - r.ts;
      const remaining = Math.max(0, REACTION_TTL_MS - elapsed);
      const tid = window.setTimeout(() => {
        collabAPI.removeMeetingReaction(r.id);
      }, remaining);
      timers.push(tid);
    }
    return () => {
      for (const t of timers) {
        window.clearTimeout(t);
      }
    };
  }, [liveReactions, collabAPI]);

  // Are we mid-join into a REAL room? The URL carries the room hash the instant
  // the user opens a meeting link, but `activeRoomLink` only flips once the
  // collab handshake completes. In that async gap we must NOT fall through to
  // the mock cast — showing 4 fake strangers in a real meeting (the "guest ma"
  // flash, 06-19) is worse than an honest empty bar. Detect the hash directly.
  const joiningRealRoom =
    typeof window !== "undefined" &&
    window.location.hash.includes("#room=");

  // Not in a collab room AND not joining one → showcase/empty-state. Show the
  // design-mock cast so the empty shell still has something for stakeholders to
  // look at. Trimmed to 4 entries so the preview doesn't look misleadingly
  // populated.
  if (!activeRoomLink && !joiningRealRoom) {
    const previewTiles = MOCK_PARTICIPANTS.slice(0, 4).map(mockTile);
    return (
      <>
        <footer className="mcm-people-bar" aria-label={t("participants.label")}>
          <CountChip
            inRoom={previewTiles.length}
            inCall={previewTiles.filter((t) => t.inCall).length}
            previewMode
          />
          <div className="mcm-people-bar__list">
            {previewTiles.map((p) => (
              <Person key={p.id} p={p} onOpenProfile={onOpenProfile} />
            ))}
          </div>
        </footer>
        <MeetingReactionsOverlay />
      </>
    );
  }

  // Joining a real room but the collab layer hasn't handed us a roster yet →
  // honest "Joining…" placeholder instead of fake mock tiles. Zeroed count so
  // the header (which also keys off the live roster) never disagrees with us.
  if (!activeRoomLink) {
    return (
      <>
        <footer className="mcm-people-bar" aria-label={t("participants.label")}>
          <CountChip inRoom={0} inCall={0} />
          <div className="mcm-people-bar__list mcm-people-bar__list--joining">
            <span className="mcm-people-bar__joining">
              {t("participants.joining")}
            </span>
          </div>
        </footer>
        <MeetingReactionsOverlay />
      </>
    );
  }

  const tiles: Tile[] = [];

  // Meeting-ROLE + org-TITLE lookups (anh Luân 06-16). cohostEmails = who holds
  // the designated co-host role; titleFor = each person's 직급 from the staff
  // directory. Both keyed by lower-cased email; empty for guests (no invitee /
  // directory fetch).
  const cohostEmails = new Set(
    invitees
      .filter((iv) => iv.role === "cohost" && iv.status !== "revoked")
      .map((iv) => iv.email.toLowerCase()),
  );
  const titleFor = (email?: string | null): string | null => {
    if (!email) {
      return null;
    }
    const lo = email.toLowerCase();
    return directory.find((d) => d.email.toLowerCase() === lo)?.title ?? null;
  };

  // Bucket pending reactions by sender so we can attach them to the
  // matching tile in one O(n) pass.
  const reactionsBySocket = new Map<string, MeetingReactionEvent[]>();
  for (const r of liveReactions) {
    const list = reactionsBySocket.get(r.socketId);
    if (list) {
      list.push(r);
    } else {
      reactionsBySocket.set(r.socketId, [r]);
    }
  }

  // Self first (selfSocketId hoisted above the early return for the host poll)
  // Profile name wins over Collab's stored username so that renaming
  // through the profile modal reflects locally even before the
  // collabAPI.setUsername round-trip lands.
  const selfName =
    myProfile?.username || collabAPI?.getUsername() || t("participants.you");
  const selfInCall = audioState.status === "live";
  tiles.push({
    id: selfSocketId,
    name: selfName,
    avatar: gradientFor(selfSocketId),
    email: myProfile?.email ?? null,
    isMe: true,
    speaking: false, // local speaking not analysed in Phase 1
    micOn: selfInCall && !audioState.muted,
    inCall: selfInCall,
    handRaised: raisedHands.has(selfSocketId),
    reactions: reactionsBySocket.get(selfSocketId) ?? [],
    company: myProfile?.company,
    // Only a REAL pick yields an image; otherwise the tile shows identity
    // initials (keyed off EMAIL when logged in, socketId for anonymous).
    avatarUrl: resolveAvatarUrl(myProfile?.avatar),
    avatarRaw: myProfile?.avatar ?? null,
    isHost: !!hostSocketId && hostSocketId === selfSocketId,
    isCohost: cohostEmails.has((myProfile?.email ?? "").toLowerCase()),
    title: titleFor(myProfile?.email),
    sharingScreen: screenSharePresence.has(selfSocketId),
    videoStream: videoTiles.get(selfSocketId) ?? null,
  });

  // Everyone else
  for (const [socketId, c] of collaborators.entries()) {
    if (socketId === selfSocketId) {
      continue;
    }
    const peer = audioState.peers.get(socketId);
    const peerProfile = peerProfiles.get(socketId);
    // Profile name wins over Collab's username so peer renames show
    // up immediately. Falls back to the Excalidraw username or a
    // generic "Guest" while we wait for their first USER_PROFILE
    // broadcast.
    const name = peerProfile?.username || c.username || t("participants.guest");
    const avatar = c.color?.background
      ? `linear-gradient(135deg,${c.color.background},${
          c.color.stroke ?? c.color.background
        })`
      : gradientFor(socketId);
    const isFollowed = userToFollow?.socketId === socketId;
    // Prefer the broadcast audio state (knows muted-but-in-call); fall back to
    // Daily track presence before the first AUDIO_STATE arrives.
    const pa = peerAudio.get(socketId);
    const inCall = pa ? pa.inCall : !!peer;
    const micOn = pa ? pa.inCall && !pa.muted : !!peer;
    tiles.push({
      id: socketId,
      name,
      avatar,
      email: peerProfile?.email ?? null,
      speaking: peer?.speaking ?? false,
      micOn,
      inCall,
      handRaised: raisedHands.has(socketId),
      reactions: reactionsBySocket.get(socketId) ?? [],
      isFollowed,
      company: peerProfile?.company,
      // Only a REAL pick yields an image; otherwise identity initials.
      avatarUrl: resolveAvatarUrl(peerProfile?.avatar),
      avatarRaw: peerProfile?.avatar ?? null,
      isHost: !!hostSocketId && hostSocketId === socketId,
      isCohost: cohostEmails.has((peerProfile?.email ?? "").toLowerCase()),
      title: titleFor(peerProfile?.email),
      sharingScreen: screenSharePresence.has(socketId),
      videoStream: videoTiles.get(socketId) ?? null,
    });
  }

  const inCallCount = tiles.filter((t) => t.inCall).length;

  // Invited people NOT currently in the room (matched by email to online tiles)
  // — the panel lists them under a separate "đã mời · chưa vào" section so it's
  // clear who's expected vs who's actually here. Revoked/declined drop out.
  const onlineEmails = new Set(
    tiles.map((p) => p.email?.toLowerCase()).filter(Boolean) as string[],
  );
  // Everyone actively invited (joined OR not) — the DENOMINATOR for the header
  // "joined / invited" ratio. Revoked/declined drop out.
  const invitedActive = invitees.filter(
    (iv) => iv.status === "invited" || iv.status === "accepted",
  );
  const invitedOffline: InvitedRow[] = invitedActive
    .filter((iv) => !!iv.email && !onlineEmails.has(iv.email.toLowerCase()))
    .map((iv) => ({
      email: iv.email,
      name:
        directory.find((d) => d.email.toLowerCase() === iv.email.toLowerCase())
          ?.name ?? iv.email.split("@")[0],
      kind: iv.kind,
      title: titleFor(iv.email),
      accepted: iv.status === "accepted",
    }));
  // Header ratio = people in the room / total invited (guests can't fetch the
  // invitee roster → undefined hides the denominator rather than showing "/0").
  const invitedTotal =
    !session?.isGuest && invitees.length > 0 ? invitedActive.length : undefined;

  // REVIEW MODE attendance derivation. attendance[] (who actually joined) is the
  // source of truth; merge host/co-host/title/kind by email from the invitee +
  // directory lookups already computed above. Then split invitees into "did NOT
  // attend" for the secondary "Đã mời" list. All empty when !viewOnly (the
  // fetch effect doesn't run live), so this is inert during live meetings.
  const attendedEmails = new Set(
    attendance.map((p) => p.user_email.toLowerCase()),
  );
  const hostEmail = (() => {
    // The HOST tile's email in review (collaborators map is empty) — fall back
    // to the host election email when a present tile happens to exist, else the
    // first attendee. Cheap heuristic; host badge is informational here.
    const hostTile = tiles.find((p) => p.isHost);
    return hostTile?.email?.toLowerCase() ?? null;
  })();
  const attendedRows: AttendedRow[] = attendance.map((p) => {
    const lo = p.user_email.toLowerCase();
    const inv = invitees.find((iv) => iv.email.toLowerCase() === lo);
    const dirName = directory.find(
      (d) => d.email.toLowerCase() === lo,
    )?.name;
    return {
      email: p.user_email,
      name: p.name || dirName || p.user_email.split("@")[0],
      joinedAt: p.joined_at,
      isHost: !!hostEmail && lo === hostEmail,
      isCohost: cohostEmails.has(lo),
      kind: inv?.kind ?? "internal",
      title: titleFor(p.user_email),
    };
  });
  // Invitees who were asked but never joined (review-mode "Đã mời").
  const invitedNotAttended: InvitedRow[] = invitedActive
    .filter((iv) => !!iv.email && !attendedEmails.has(iv.email.toLowerCase()))
    .map((iv) => ({
      email: iv.email,
      name:
        directory.find((d) => d.email.toLowerCase() === iv.email.toLowerCase())
          ?.name ?? iv.email.split("@")[0],
      kind: iv.kind,
      title: titleFor(iv.email),
      accepted: iv.status === "accepted",
    }));

  // NB: we deliberately do NOT render a custom "Đang follow X" banner
  // here — Excalidraw's UI layer already paints its own follow
  // indicator (purple pill near the top toolbar with a × to stop), so
  // a second banner would be duplicate/competing UI. The avatar eye
  // badge + Esc handler give us our extra affordances; Excalidraw owns
  // the textual confirmation strip.
  // Host moderation: only the host can mute/kick, and only OTHER participants.
  // (iAmHost is computed above the early return so the knock-poll hook is
  // unconditional — a project authority / leader / division head qualifies too.)
  // fromAuthority lets peers accept a KICK from a project authority (leader /
  // head — deputy dropped 06-16) even when socket host-election landed on
  // someone else.
  const doKick = (tile: Tile) =>
    collabAPI?.portal.broadcastHostCommand({
      action: "KICK",
      target: tile.id as SocketId,
      fromAuthority: viewerAuthority,
    });
  const doMute = (tile: Tile) => {
    // Drive off the REAL broadcast state (peerAudio → tile.micOn/inCall), not a
    // host-local guess: in-call + mic off ⇒ already muted ⇒ send UNMUTE.
    const muted = tile.inCall && !tile.micOn;
    collabAPI?.portal.broadcastHostCommand({
      action: muted ? "UNMUTE" : "MUTE",
      target: tile.id as SocketId,
      fromAuthority: viewerAuthority,
    });
  };

  // Admit / deny a waiting guest: optimistically drop the row, refetch on error
  // so a failed call doesn't silently lose the knock.
  const onKnockAction = async (email: string, action: "admit" | "deny") => {
    if (!roomId) {
      return;
    }
    setWaitingKnocks((prev) => prev.filter((k) => k.email !== email));
    const ok = await patchKnock(roomId, email, action);
    if (!ok) {
      const rows = await listKnocks(roomId);
      setWaitingKnocks(rows);
    }
  };

  // The ONE focused/presenter person — resolved with strict precedence from
  // pin > screen-sharer > active-speaker > host > first tile. The screen-sharer
  // is the FIRST key of the presence map (single-sharer lock). Passed down to
  // every video surface so gallery-speaker, the filmstrip ring and the floating
  // PiP all agree.
  const sharerId = Array.from(screenSharePresence.keys())[0] ?? null;
  const hostId = hostSocketId ?? null;
  const focusedSocketId = resolveFocusedId(tiles, {
    pinned: pinnedSocketId,
    activeSpeaker,
    sharerId,
    hostId,
  });
  // Clicking any tile (gallery-speaker strip, gallery grid, filmstrip) toggles
  // the local pin — click an unpinned tile → pin it; click the pinned tile →
  // unpin (falls back down the precedence chain). Per-viewer, ephemeral.
  const handlePick = (id: string) => togglePinnedSocketId(id);

  return (
    <>
      {/* High-visibility, persistent knock alert — top-center over the canvas
          so the host can't miss someone asking to enter, and can Admit / Deny
          inline without first opening the participants drawer. Host-only;
          renders null when nobody is knocking. Reuses the SAME waitingKnocks
          state + onKnockAction handler as the drawer (no second poller). */}
      {iAmHost && !viewOnly && (
        <KnockBanner
          knocks={waitingKnocks}
          onAction={onKnockAction}
          onOpenPanel={() => setPanelOpen(true)}
        />
      )}
      <footer
        className={`mcm-people-bar${
          videoLayout === "filmstrip" ? " mcm-people-bar--filmstrip" : ""
        }`}
        aria-label={t("participants.label")}
      >
        <CountChip
          inRoom={viewOnly ? attendedRows.length : tiles.length}
          invited={invitedTotal}
          inCall={viewOnly ? undefined : inCallCount}
          waiting={iAmHost && !viewOnly ? waitingKnocks.length : 0}
          onOpen={() => setPanelOpen(true)}
        />
        <div className="mcm-people-bar__list">
          {tiles.map((p) => {
            const canModerate = iAmHost && !viewOnly && !p.isMe && !p.isHost;
            return (
              <Person
                key={p.id}
                p={p}
                onFollowToggle={handleFollowToggle}
                onOpenProfile={onOpenProfile}
                onKick={canModerate ? doKick : undefined}
                onMute={canModerate ? doMute : undefined}
                hostMuted={p.inCall && !p.micOn}
              />
            );
          })}
        </div>
        {/* The video-surface switcher now lives in the HEADER (MeetingHeader)
            — the strip no longer owns a layout control. */}
      </footer>
      {/* Render the chosen surface. "minimal" keeps just the strip above. The
          gallery also honours the legacy galleryOpenAtom so any other caller
          that toggles it still opens the grid. */}
      {videoLayout === "filmstrip" && (
        <VideoFilmstrip
          tiles={tiles}
          selfSocketId={selfSocketId}
          focusedSocketId={focusedSocketId}
          onPick={handlePick}
        />
      )}
      {(videoLayout === "gallery" || galleryOpen) && (
        <MeetingGallery
          tiles={tiles}
          selfSocketId={selfSocketId}
          focusedSocketId={focusedSocketId}
          pinnedSocketId={pinnedSocketId}
          onPick={handlePick}
          onClose={() => {
            setGalleryOpen(false);
            if (videoLayout === "gallery") {
              pickLayout("minimal");
            }
          }}
        />
      )}
      {/* Floating presenter PiP over the canvas — explicit opt-in, shows the
          SAME focused person. Auto-hidden in gallery (redundant — the gallery
          already shows everyone full-screen); only over minimal / filmstrip. */}
      {floatingPresenter && videoLayout !== "gallery" && !galleryOpen && (
        <FloatingPresenter
          tiles={tiles}
          selfSocketId={selfSocketId}
          focusedSocketId={focusedSocketId}
        />
      )}
      {panelOpen && (
        <ParticipantsPanel
          tiles={tiles}
          // Review mode shows the static "Đã mời" (invited-but-didn't-attend)
          // list; live mode shows "invited but not in the room right now".
          invited={viewOnly ? invitedNotAttended : invitedOffline}
          // No moderation / knocks in review — pin iAmHost false there so the
          // panel can never render mute/kick/admit even if authority lingers.
          iAmHost={iAmHost && !viewOnly}
          waitingKnocks={iAmHost && !viewOnly ? waitingKnocks : []}
          onKnockAction={onKnockAction}
          onClose={() => setPanelOpen(false)}
          onMute={doMute}
          onKick={doKick}
          viewOnly={viewOnly}
          attended={attendedRows}
        />
      )}
      <MeetingReactionsOverlay />
    </>
  );
};

// Floating-reactions layer rendered via a portal to <body>. Each active
// reaction is positioned at fixed screen coordinates derived from the
// sender's avatar (looked up by `data-socket-id`), so the float-up
// animation is not clipped by any ancestor's `overflow` — including
// the participants list which has horizontal scroll.
//
// The avatar position is snapshotted once when the reaction first
// renders; if the user scrolls the participants list while a reaction
// is in flight the emoji finishes its animation at the original spot
// (acceptable — reactions are 3-second affordances, not pinned UI).
const MeetingReactionsOverlay = () => {
  const reactions = useAtomValue(meetingReactionsAtom);
  const [origins, setOrigins] = useState<
    Record<string, { x: number; y: number }>
  >({});

  useEffect(() => {
    if (reactions.length === 0) {
      if (Object.keys(origins).length !== 0) {
        setOrigins({});
      }
      return;
    }
    // Compute positions for any reactions we don't yet have an origin
    // for. We mutate immutably so React notices the change.
    let updated: typeof origins | null = null;
    for (const r of reactions) {
      if (origins[r.id]) {
        continue;
      }
      const node = document.querySelector(
        `[data-socket-id="${r.socketId}"] .mcm-person__avatar`,
      ) as HTMLElement | null;
      if (!node) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (!updated) {
        updated = { ...origins };
      }
      updated[r.id] = { x, y };
    }
    if (updated) {
      setOrigins(updated);
    }
    // Drop entries for reactions that have already expired.
    const liveIds = new Set(reactions.map((r) => r.id));
    const filtered: typeof origins = {};
    let pruned = false;
    for (const id of Object.keys(origins)) {
      if (liveIds.has(id)) {
        filtered[id] = origins[id];
      } else {
        pruned = true;
      }
    }
    if (pruned) {
      setOrigins(filtered);
    }
  }, [reactions, origins]);

  if (typeof document === "undefined" || reactions.length === 0) {
    return null;
  }
  return createPortal(
    <div className="mcm-reactions-layer" aria-hidden="true">
      {reactions.map((r) => {
        const origin = origins[r.id];
        if (!origin) {
          return null;
        }
        return (
          <span
            key={r.id}
            className="mcm-reactions-layer__emoji"
            // Per-reaction position is data-driven (the sender's
            // avatar center, captured at render time).
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: origin.x, top: origin.y }}
          >
            {r.emoji}
          </span>
        );
      })}
    </div>,
    document.body,
  );
};

// Subtle left-side stats: people in the room + people currently in the
// audio call. Keeps the strip glanceable without needing to count
// avatars. `previewMode` adds a "Preview" badge in the mock fallback so
// stakeholders don't mistake the mock cast for the real roster.
const CountChip = ({
  inRoom,
  invited,
  inCall,
  waiting = 0,
  previewMode = false,
  onOpen,
}: {
  inRoom: number;
  /** Total people INVITED to the meeting — when set, the people cell reads as
   *  "joined / invited" (anh Luân 06-16). Undefined (e.g. a guest who can't
   *  fetch the roster) shows just the joined count. */
  invited?: number;
  /** People currently in the audio call. Undefined in REVIEW mode (finished
   *  meeting has no live call) — the mic cell + divider are then hidden. */
  inCall?: number;
  /** Guests currently knocking (host-only). Renders a "N waiting" badge. */
  waiting?: number;
  previewMode?: boolean;
  /** When provided, the chip becomes a button that opens the participant
   *  management panel (Zoom-style). */
  onOpen?: () => void;
}) => {
  const t = useT();
  const inner = (
    <>
      <span
        className="mcm-people-bar__chip-cell"
        title={t("participants.invitedCountLabel")}
      >
        <PeopleIcon />
        <span className="mcm-people-bar__chip-num">
          {invited === undefined ? inRoom : `${inRoom}/${invited}`}
        </span>
      </span>
      {inCall !== undefined && (
        <>
          <span className="mcm-people-bar__chip-divider" />
          <span className="mcm-people-bar__chip-cell">
            <MicOnIcon />
            <span className="mcm-people-bar__chip-num">{inCall}</span>
          </span>
        </>
      )}
      {waiting > 0 && (
        <span className="mcm-people-bar__chip-waiting mcm-knock-badge">
          {t("participants.waitingCount", { count: waiting })}
        </span>
      )}
      {previewMode && (
        <span className="mcm-people-bar__chip-preview">
          {t("participants.previewBadge")}
        </span>
      )}
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        className="mcm-people-bar__chip mcm-people-bar__chip--btn"
        onClick={onOpen}
        title={t("participants.panelTitle")}
        aria-label={t("participants.panelTitle")}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="mcm-people-bar__chip" aria-hidden="true">
      {inner}
    </div>
  );
};

export default ParticipantsBar;
