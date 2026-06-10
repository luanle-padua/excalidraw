import { CalendarClock, CircleSlash, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { collabAPIAtom, startGateAtom } from "../../collab/Collab";
import { getMeeting, updateMeeting } from "../../data/projects";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { normalizeMeetingStatus } from "./meetingStatus";

const POLL_MS = 5000;

/**
 * Full-screen "the meeting hasn't started yet" overlay — the UX half of the
 * Phase 4.5 state machine (docs/host-and-scheduling.md). Shown when a join
 * lands on a `scheduled` meeting (startGateAtom, set by startCollaboration):
 *
 *   • internal staff get a Start button — the acting-host rule says ANY
 *     internal user may start when the host is absent, and the real host
 *     reclaims control in-room via the existing host election;
 *   • guests wait, polling the registry until the meeting goes `live`
 *     (then auto-join) or `cancelled`;
 *   • a cancelled meeting shows a terminal notice.
 */
export const WaitingForStart = () => {
  const t = useT();
  const [gate, setGate] = useAtom(startGateAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const session = useAtomValue(sessionAtom);
  const [busy, setBusy] = useState(false);

  const canStart = isInternalEmail(session?.email);

  // Poll while parked on a scheduled meeting — EVERYONE polls (a guest joins
  // the moment the host starts; an internal user who waits instead of starting
  // follows along too). Cancelled mid-wait flips the card to the notice.
  useEffect(() => {
    if (!gate || gate.status !== "scheduled" || !collabAPI) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const m = await getMeeting(gate.roomId);
      if (cancelled) {
        return;
      }
      const st = normalizeMeetingStatus(m?.status);
      if (st === "live" || st === "finished") {
        setGate(null);
        await collabAPI.startCollaboration(
          { roomId: gate.roomId, roomKey: gate.roomKey },
          { viewOnly: st === "finished" },
        );
      } else if (st === "cancelled") {
        setGate({ ...gate, status: "cancelled" });
      }
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [gate, collabAPI, setGate]);

  if (!gate || !collabAPI) {
    return null;
  }

  const start = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // scheduled → live, then join like any other live meeting. The registry
      // write is what releases every polling guest in the waiting screen.
      const ok = await updateMeeting(gate.roomId, { status: "live" });
      if (!ok) {
        // The transition was refused (meeting finished/cancelled while we
        // were parked, or a concurrent transition won). Re-read the truth and
        // re-route instead of barging into the room editable.
        const m = await getMeeting(gate.roomId);
        const st = normalizeMeetingStatus(m?.status);
        if (st === "cancelled") {
          setGate({ ...gate, status: "cancelled" });
        } else if (st === "live" || st === "finished") {
          setGate(null);
          await collabAPI.startCollaboration(
            { roomId: gate.roomId, roomKey: gate.roomKey },
            { viewOnly: st === "finished" },
          );
        }
        return;
      }
      setGate(null);
      await collabAPI.startCollaboration({
        roomId: gate.roomId,
        roomKey: gate.roomKey,
      });
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setGate(null);
    // Drop the #room hash so the project home reappears (and a reload
    // doesn't re-enter the gate).
    window.history.pushState({}, "", window.location.pathname);
  };

  const when = gate.scheduledAt ? new Date(gate.scheduledAt) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null;

  return (
    <div className="mcm-gate" role="dialog" aria-modal="true">
      <div className="mcm-gate__card">
        {gate.status === "cancelled" ? (
          <>
            <CircleSlash size={34} className="mcm-gate__icon --cancelled" />
            <h2 className="mcm-gate__title">{t("gate.cancelledTitle")}</h2>
            {gate.title && <p className="mcm-gate__meeting">{gate.title}</p>}
            <p className="mcm-gate__desc">{t("gate.cancelledDesc")}</p>
          </>
        ) : (
          <>
            <CalendarClock size={34} className="mcm-gate__icon" />
            <h2 className="mcm-gate__title">{t("gate.notStarted")}</h2>
            {gate.title && <p className="mcm-gate__meeting">{gate.title}</p>}
            {whenLabel && (
              <p className="mcm-gate__desc">
                {t("gate.scheduledFor", { when: whenLabel })}
              </p>
            )}
            {canStart ? (
              <button
                type="button"
                className="mcm-btn mcm-btn--primary mcm-btn--block"
                onClick={() => void start()}
                disabled={busy}
              >
                <Play size={15} />{" "}
                {busy ? t("gate.starting") : t("gate.startNow")}
              </button>
            ) : (
              <p className="mcm-gate__waiting">
                <span className="mcm-gate__spinner" aria-hidden="true" />
                {t("gate.waitingHost")}
              </p>
            )}
          </>
        )}
        <button type="button" className="mcm-gate__back" onClick={back}>
          {t("gate.back")}
        </button>
      </div>
    </div>
  );
};

export default WaitingForStart;
