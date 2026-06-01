import { useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../../collab/Collab";
import { getCollaborationLink } from "../../data";
import { useT } from "../../i18n/mcm";

/**
 * Zoom-style front door for MAP CanvasMeet.
 *
 * Shown as a full-screen overlay whenever the user is NOT in a meeting
 * (no `#room=` in the URL and `startCollaboration` hasn't run). Two
 * actions, mirroring Zoom's home screen:
 *
 *   • "Cuộc họp mới"  → `startCollaboration(null)` mints a fresh
 *     roomId+roomKey, pushes `#room=…` into the URL, and drops the user
 *     straight into a new room (the invite link is then copyable from
 *     the header). The lobby auto-hides once `isCollaborating` flips.
 *   • "Tham gia"      → parse a pasted link / ID+key and join it.
 *
 * Auth is intentionally link-only for the test phase (anyone with the
 * link joins — exactly Zoom's default). The name is collected by the
 * existing UserProfileModal that auto-opens on entering a room, so the
 * lobby itself stays minimal.
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

  const [dismissed, setDismissed] = useState(false);
  const [joinValue, setJoinValue] = useState("");
  const [joinError, setJoinError] = useState(false);
  const [busy, setBusy] = useState(false);

  // Don't even flash the lobby when the page was opened via an invite
  // link — App's initial flow will call startCollaboration for us.
  const hasRoomInUrl = useMemo(
    () => /#room=[a-zA-Z0-9_-]+,/.test(window.location.hash),
    [],
  );

  if (isCollaborating || hasRoomInUrl || dismissed || !collabAPI) {
    return null;
  }

  const startNew = async () => {
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
      <div className="mcm-lobby__card">
        <div className="mcm-lobby__brand">
          <span className="mcm-lobby__logo">◳</span>
          <span className="mcm-lobby__title">MAP CanvasMeet</span>
        </div>

        <p className="mcm-lobby__tagline">{t("lobby.tagline")}</p>

        <button
          type="button"
          className="mcm-lobby__primary"
          onClick={startNew}
          disabled={busy}
        >
          {t("lobby.newMeeting")}
        </button>

        <div className="mcm-lobby__divider">
          <span>{t("lobby.or")}</span>
        </div>

        <div className="mcm-lobby__join">
          <input
            type="text"
            className={`mcm-lobby__input${
              joinError ? " mcm-lobby__input--error" : ""
            }`}
            placeholder={t("lobby.joinPlaceholder")}
            value={joinValue}
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
            className="mcm-lobby__secondary"
            onClick={join}
            disabled={busy || !joinValue.trim()}
          >
            {t("lobby.join")}
          </button>
        </div>
        {joinError && (
          <p className="mcm-lobby__error">{t("lobby.joinError")}</p>
        )}

        <button
          type="button"
          className="mcm-lobby__solo"
          onClick={() => setDismissed(true)}
        >
          {t("lobby.solo")}
        </button>
      </div>
    </div>
  );
};

export default MeetingLobby;
