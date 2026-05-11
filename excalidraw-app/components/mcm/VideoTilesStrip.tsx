// Compact "people in this meeting" strip — circular avatars only, no
// video boxes yet. Will become real video tiles when WebRTC is wired up,
// but for the dev shell we just need a presence indicator.

import { MOCK_PARTICIPANTS } from "./meetingMock";

import type { MockParticipant } from "./meetingMock";

const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

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

const Person = ({ p }: { p: MockParticipant }) => (
  <div
    className={`mcm-person${p.isMe ? " mcm-person--me" : ""}${
      p.speaking ? " mcm-person--speaking" : ""
    }`}
    title={`${p.name} (${p.country})`}
  >
    <div
      className="mcm-person__avatar"
      // gradient per-participant — has to be inline
      // eslint-disable-next-line react/forbid-dom-props
      style={{ background: p.avatar }}
    >
      {initials(p.name)}
      {!p.micOn && (
        <span className="mcm-person__mic-off" aria-label="Muted">
          <MicOffIcon />
        </span>
      )}
    </div>
    <span className="mcm-person__name">
      {p.name.replace(/\s*\(.*?\)\s*$/, "")}
    </span>
  </div>
);

export const VideoTilesStrip = () => (
  <footer className="mcm-people-bar" aria-label="Participants">
    {MOCK_PARTICIPANTS.map((p) => (
      <Person key={p.id} p={p} />
    ))}
  </footer>
);

export default VideoTilesStrip;
