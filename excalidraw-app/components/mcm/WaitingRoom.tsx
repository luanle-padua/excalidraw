import { CircleSlash, DoorOpen, Hand } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { collabAPIAtom, waitingRoomAtom } from "../../collab/Collab";
import { getMyKnock, knockToMeeting } from "../../data/invite";
import { getMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { normalizeMeetingStatus } from "./meetingStatus";

const POLL_MS = 5000;

/**
 * Full-screen WAITING ROOM overlay — the guest half of the knock-to-join flow
 * (docs/plans/waiting-room.md). Shown when an EXTERNAL guest joins a LIVE
 * meeting they haven't been admitted to (waitingRoomAtom, set by
 * startCollaboration after it knocks):
 *
 *   • the guest sees a "waiting for the host" card and polls their own knock
 *     status every POLL_MS;
 *   • on `admitted` → re-read the meeting status (finished-room race), then
 *     connect (entering muted — the Daily room has start_audio_off);
 *   • on `denied` → a soft in-card notice with Leave + a re-knock button
 *     (the 30s cooldown is server-enforced).
 *
 * Internal staff auto-admit and never park here.
 */
export const WaitingRoom = () => {
  const t = useT();
  const [waiting, setWaiting] = useAtom(waitingRoomAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const session = useAtomValue(sessionAtom);
  const [busy, setBusy] = useState(false);

  // Poll the guest's own knock status. On admit, double-check the meeting is
  // still live (it may have ended while we waited) before connecting.
  useEffect(() => {
    if (!waiting || waiting.status !== "invited" || !collabAPI) {
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      const knock = await getMyKnock(waiting.roomId);
      if (cancelled) {
        return;
      }
      if (knock?.status === "admitted") {
        // RE-READ the meeting before connecting — a host could have ended the
        // meeting between our admit and this tick (finished-room race). Don't
        // barge into a finished/cancelled room.
        const m = await getMeeting(waiting.roomId);
        if (cancelled) {
          return;
        }
        if (normalizeMeetingStatus(m?.status) !== "live") {
          // Meeting is no longer live — drop the waiting card; the next entry
          // path (reload / re-open) routes to the right gate.
          setWaiting(null);
          return;
        }
        const { roomId, roomKey } = waiting;
        setWaiting(null);
        await collabAPI.startCollaboration({ roomId, roomKey });
      } else if (knock?.status === "denied") {
        setWaiting({ ...waiting, status: "denied" });
      }
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [waiting, collabAPI, setWaiting]);

  if (!waiting || !collabAPI) {
    return null;
  }

  const back = () => {
    setWaiting(null);
    // Drop the #room hash so the project home reappears (and a reload
    // doesn't re-enter the waiting room).
    window.history.pushState({}, "", window.location.pathname);
  };

  const reknock = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await knockToMeeting(waiting.roomId, session?.name);
      // 429 = still inside the 30s cooldown → stay on the denied card. Any
      // accepted re-knock flips us back to "invited" so the poll resumes.
      if (res.knockStatus === "invited" || res.knockStatus === "admitted") {
        setWaiting({ ...waiting, status: "invited" });
      }
    } finally {
      setBusy(false);
    }
  };

  const when = waiting.scheduledAt ? new Date(waiting.scheduledAt) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null;
  const joiningAs = session?.name || session?.email || t("participants.guest");

  return (
    <div className="mcm-gate mcm-gate--client" role="dialog" aria-modal="true">
      {/* Same multinational backdrop as the client portal — the guest's
          first-impression theme carries into the waiting room (anh Luân 06-16). */}
      <div className="mcm-portal__bg" aria-hidden="true">
        <span className="mcm-portal__bg-layer mcm-portal__bg-layer--1" />
        <span className="mcm-portal__bg-layer mcm-portal__bg-layer--2" />
        <span className="mcm-portal__bg-layer mcm-portal__bg-layer--3" />
        <span className="mcm-portal__bg-scrim" />
        <img
          className="mcm-portal__watermark"
          src="/canvas-m.png"
          alt=""
          aria-hidden="true"
          decoding="async"
        />
      </div>
      <div className="mcm-gate__card">
        {waiting.status === "denied" ? (
          <>
            <CircleSlash size={34} className="mcm-gate__icon --cancelled" />
            <h2 className="mcm-gate__title">{t("gate.deniedTitle")}</h2>
            {waiting.title && (
              <p className="mcm-gate__meeting">{waiting.title}</p>
            )}
            <p className="mcm-gate__desc">{t("gate.deniedDesc")}</p>
            <button
              type="button"
              className="mcm-btn mcm-btn--primary mcm-btn--block"
              onClick={() => void reknock()}
              disabled={busy}
            >
              <Hand size={15} /> {busy ? t("gate.knocking") : t("gate.reknock")}
            </button>
          </>
        ) : (
          <>
            <DoorOpen size={34} className="mcm-gate__icon" />
            <h2 className="mcm-gate__title">{t("gate.waitingRoomTitle")}</h2>
            {waiting.title && (
              <p className="mcm-gate__meeting">{waiting.title}</p>
            )}
            {whenLabel && (
              <p className="mcm-gate__desc">
                {t("gate.scheduledFor", { when: whenLabel })}
              </p>
            )}
            <p className="mcm-gate__desc">
              {t("gate.joiningAs", { name: joiningAs })}
            </p>
            <p className="mcm-gate__waiting">
              <span className="mcm-gate__spinner" aria-hidden="true" />
              {t("gate.waitingAdmit")}
            </p>
          </>
        )}
        <button type="button" className="mcm-gate__back" onClick={back}>
          {t("gate.back")}
        </button>
      </div>
    </div>
  );
};

export default WaitingRoom;
