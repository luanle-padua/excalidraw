// Real "people in this meeting" strip. Pulls collaborators out of
// Excalidraw via the imperative API (we live outside Excalidraw's
// internal context tree, so `useUIAppState` isn't available here) and
// overlays the live audio status from AudioRoom — speaking ring,
// mic-off badge, "you" highlight. Falls back to the mock cast when the
// user isn't in a collab room yet so the design demo still looks
// populated.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useAtomValue } from "../../app-jotai";
import { audioStateAtom } from "../../audio/audioState";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingReactionsAtom,
  raisedHandsAtom,
} from "../../collab/Collab";

import { MOCK_PARTICIPANTS } from "./meetingMock";

import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";

import type { MockParticipant } from "./meetingMock";
import type { MeetingReactionEvent } from "../../collab/Collab";

const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

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

type Tile = {
  id: string;
  name: string;
  avatar: string;
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
const Person = ({ p }: { p: Tile }) => {
  const displayName = p.name.replace(/\s*\(.*?\)\s*$/, "");
  const showName = p.isMe || p.speaking || p.handRaised;
  return (
    <div
      className={`mcm-person${p.isMe ? " mcm-person--me" : ""}${
        p.speaking ? " mcm-person--speaking" : ""
      }${!p.inCall ? " mcm-person--idle" : ""}${
        showName ? " mcm-person--named" : ""
      }${p.handRaised ? " mcm-person--raised" : ""}`}
      title={displayName}
      data-socket-id={p.id}
    >
      <div
        className="mcm-person__avatar"
        // gradient per-participant — has to be inline since the colour
        // mix is data-driven
        // eslint-disable-next-line react/forbid-dom-props
        style={{ background: p.avatar }}
      >
        {initials(p.name)}
        {p.handRaised && (
          <span
            className="mcm-person__raise-badge"
            aria-label="Đang giơ tay"
          >
            ✋
          </span>
        )}
        {p.inCall && p.micOn && (
          <span className="mcm-person__live-dot" aria-hidden="true" />
        )}
        {p.inCall && !p.micOn && (
          <span className="mcm-person__mic-off" aria-label="Muted">
            <MicOffIcon />
          </span>
        )}
      </div>
      {showName && (
        <span className="mcm-person__name">{displayName}</span>
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

export const VideoTilesStrip = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const audioState = useAtomValue(audioStateAtom);
  const raisedHands = useAtomValue(raisedHandsAtom);
  const liveReactions = useAtomValue(meetingReactionsAtom);

  // We live outside Excalidraw's internal provider tree, so we can't
  // call useUIAppState() — instead we subscribe to the imperative
  // onChange stream and keep a local copy of just the collaborator
  // map. (Lightweight: only re-renders this strip when the map's
  // identity changes, which is on join/leave.)
  const [collaborators, setCollaborators] = useState<
    ReadonlyMap<SocketId, Collaborator>
  >(() => new Map());

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    setCollaborators(excalidrawAPI.getAppState().collaborators);
    const unsub = excalidrawAPI.onChange((_elements, appState) => {
      // referential check — the collab layer constructs a new Map on
      // every roster change, so this is a cheap O(1) gate.
      setCollaborators((prev) =>
        prev === appState.collaborators ? prev : appState.collaborators,
      );
    });
    return unsub;
  }, [excalidrawAPI]);

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

  // Not in a collab room yet → show the design-mock cast so the empty
  // shell still has something for stakeholders to look at. Trimmed to
  // 4 entries so the preview doesn't look misleadingly populated.
  if (!activeRoomLink) {
    const previewTiles = MOCK_PARTICIPANTS.slice(0, 4).map(mockTile);
    return (
      <>
        <footer className="mcm-people-bar" aria-label="Participants">
          <CountChip
            inRoom={previewTiles.length}
            inCall={previewTiles.filter((t) => t.inCall).length}
            previewMode
          />
          <div className="mcm-people-bar__list">
            {previewTiles.map((p) => (
              <Person key={p.id} p={p} />
            ))}
          </div>
        </footer>
        <MeetingReactionsOverlay />
      </>
    );
  }

  const tiles: Tile[] = [];

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

  // Self first
  const selfSocketId = collabAPI?.portal.socket?.id ?? "me";
  const selfName = collabAPI?.getUsername() || "You";
  const selfInCall = audioState.status === "live";
  tiles.push({
    id: selfSocketId,
    name: selfName,
    avatar: gradientFor(selfSocketId),
    isMe: true,
    speaking: false, // local speaking not analysed in Phase 1
    micOn: selfInCall && !audioState.muted,
    inCall: selfInCall,
    handRaised: raisedHands.has(selfSocketId),
    reactions: reactionsBySocket.get(selfSocketId) ?? [],
  });

  // Everyone else
  for (const [socketId, c] of collaborators.entries()) {
    if (socketId === selfSocketId) {
      continue;
    }
    const peer = audioState.peers.get(socketId);
    const name = c.username || "Khách";
    const avatar = c.color?.background
      ? `linear-gradient(135deg,${c.color.background},${
          c.color.stroke ?? c.color.background
        })`
      : gradientFor(socketId);
    tiles.push({
      id: socketId,
      name,
      avatar,
      speaking: peer?.speaking ?? false,
      // we don't know remote mute state yet — assume on when we hear
      // any audio from them
      micOn: !!peer,
      inCall: !!peer,
      handRaised: raisedHands.has(socketId),
      reactions: reactionsBySocket.get(socketId) ?? [],
    });
  }

  const inCallCount = tiles.filter((t) => t.inCall).length;

  return (
    <>
      <footer className="mcm-people-bar" aria-label="Participants">
        <CountChip inRoom={tiles.length} inCall={inCallCount} />
        <div className="mcm-people-bar__list">
          {tiles.map((p) => (
            <Person key={p.id} p={p} />
          ))}
        </div>
      </footer>
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
  inCall,
  previewMode = false,
}: {
  inRoom: number;
  inCall: number;
  previewMode?: boolean;
}) => (
  <div className="mcm-people-bar__chip" aria-hidden="true">
    <span className="mcm-people-bar__chip-cell">
      <PeopleIcon />
      <span className="mcm-people-bar__chip-num">{inRoom}</span>
    </span>
    <span className="mcm-people-bar__chip-divider" />
    <span className="mcm-people-bar__chip-cell">
      <MicOnIcon />
      <span className="mcm-people-bar__chip-num">{inCall}</span>
    </span>
    {previewMode && (
      <span className="mcm-people-bar__chip-preview">Preview</span>
    )}
  </div>
);

export default VideoTilesStrip;
