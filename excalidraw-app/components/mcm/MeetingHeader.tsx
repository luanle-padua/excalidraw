import { useEffect, useState } from "react";

import { MOCK_MEETING_TITLE, MOCK_MEETING_DURATION_S } from "./meetingMock";

const fmt = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

const Icon = ({
  d,
  ...rest
}: { d: string } & React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    {...rest}
  >
    <path d={d} />
  </svg>
);

export const MeetingHeader = ({
  participantCount,
  onInvite,
  onLeave,
}: {
  participantCount: number;
  onInvite?: () => void;
  onLeave?: () => void;
}) => {
  const [elapsed, setElapsed] = useState(MOCK_MEETING_DURATION_S);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="mcm-header">
      <div className="mcm-header__brand">
        <div className="mcm-header__brand-mark">M</div>
        <div className="mcm-header__brand-name">
          <strong>MAP CANVAS MEET</strong>
          <span>(MCM)</span>
        </div>
      </div>

      <div className="mcm-header__divider" />

      <button
        type="button"
        className="mcm-header__title"
        aria-label="Meeting menu"
      >
        <span>{MOCK_MEETING_TITLE}</span>
        <Icon d="M6 9l6 6 6-6" />
      </button>

      <div className="mcm-header__stat" title="Recording">
        <span className="mcm-header__stat-dot" />
        <span>{fmt(elapsed)}</span>
      </div>

      <div className="mcm-header__stat" title="Participants">
        <Icon d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" />
        <span>{participantCount} people</span>
      </div>

      <div className="mcm-header__actions">
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--ghost"
          title="Share"
        >
          <Icon d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8 M16 6l-4-4-4 4 M12 2v13" />
          Share
        </button>
        <button type="button" className="mcm-header__icon-btn" title="Layout">
          <Icon d="M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z" />
        </button>
        <button type="button" className="mcm-header__icon-btn" title="Present">
          <Icon d="M2 3h20v14H2z M8 21h8 M12 17v4" />
        </button>
        <button type="button" className="mcm-header__icon-btn" title="Settings">
          <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </button>
        <button type="button" className="mcm-header__icon-btn" title="More">
          <Icon d="M5 12h.01 M12 12h.01 M19 12h.01" />
        </button>
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--primary"
          onClick={onInvite}
        >
          <Icon d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M8.5 11a4 4 0 100-8 4 4 0 000 8 M20 8v6 M23 11h-6" />
          Invite
        </button>
        <button
          type="button"
          className="mcm-header__btn mcm-header__btn--ghost"
          onClick={onLeave}
        >
          <Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9" />
          Leave
        </button>
      </div>
    </header>
  );
};

export default MeetingHeader;
