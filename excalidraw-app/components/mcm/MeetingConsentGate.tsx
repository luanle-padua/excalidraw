import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  CONSENT_VERSION,
  acceptMeetingConsent,
} from "../../data/meetingEventLog";
import { getMeeting } from "../../data/projects";
import { sessionAtom } from "../../data/session";
import { useT } from "../../i18n/mcm";

/**
 * Join-time consent gate (legally-important, disclosed record-keeping).
 *
 * When a logged-in user JOINS a real (registered) meeting, show a brief,
 * localized notice that the meeting may be recorded and processed by AI as
 * project data; continuing means they consent. On accept we POST the consent
 * (email + version + ts) and proceed.
 *
 * Shown the FIRST time per user per meeting (or once per consent VERSION) — the
 * server returns `viewer_consent_version`, so an already-accepted user is never
 * nagged again, and a wording bump (new CONSENT_VERSION) re-prompts once.
 *
 * Reviewing a finished meeting (`viewOnly`) is not attending → no gate. Anonymous
 * link-joins (no session) also skip it (there's no identity to record consent
 * against); the worker still records consent only for authenticated callers.
 */
export const MeetingConsentGate = ({
  roomId,
  viewOnly,
}: {
  roomId: string | null;
  viewOnly: boolean;
}) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  // null = not resolved yet (don't flash the gate); true/false once known.
  const [needsConsent, setNeedsConsent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Ask the registry whether THIS viewer already accepted the current version.
  useEffect(() => {
    if (!roomId || !session || viewOnly) {
      setNeedsConsent(null);
      return;
    }
    let cancelled = false;
    void getMeeting(roomId).then((m) => {
      if (cancelled) {
        return;
      }
      // No registry row (ad-hoc room) → nothing to consent against. Otherwise
      // prompt unless the stored version matches the current wording.
      const accepted = m?.viewer_consent_version;
      setNeedsConsent(!!m && accepted !== CONSENT_VERSION);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, session, viewOnly]);

  if (!roomId || !needsConsent) {
    return null;
  }

  const accept = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // Record acceptance, then proceed. Fail-soft: even if the POST fails we
      // dismiss the gate (the user DID consent on screen) — the worker will
      // re-prompt on next entry since no row was written.
      await acceptMeetingConsent(roomId, CONSENT_VERSION);
      setNeedsConsent(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcm-gate" role="dialog" aria-modal="true">
      <div className="mcm-gate__card">
        <ShieldCheck size={34} className="mcm-gate__icon" />
        <h2 className="mcm-gate__title">{t("consent.title")}</h2>
        <p className="mcm-gate__desc">{t("consent.body")}</p>
        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--block"
          onClick={() => void accept()}
          disabled={busy}
        >
          {busy ? t("consent.accepting") : t("consent.accept")}
        </button>
      </div>
    </div>
  );
};

export default MeetingConsentGate;
