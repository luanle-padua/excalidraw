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

import { LangSwitcher } from "./LangThemeSwitcher";

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
  // null = CHECKING (we cover the canvas with a frosted backdrop so the board
  // never flashes before the decision); true = show the consent card; false =
  // no gate. Seed from the per-device cache SYNCHRONOUSLY so a returning user
  // starts at false and never even flashes the backdrop.
  const [needsConsent, setNeedsConsent] = useState<boolean | null>(() => {
    if (!roomId || viewOnly) {
      return false;
    }
    try {
      if (
        window.localStorage.getItem(`mcm-consent:${roomId}:${CONSENT_VERSION}`)
      ) {
        return false;
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [busy, setBusy] = useState(false);
  // Drives the fade-out: on accept we mark closing (CSS fades the gate) and
  // unmount after the transition, instead of a hard cut that "jumps" the canvas.
  const [closing, setClosing] = useState(false);

  // Per-device UX cache: once this meeting's CURRENT consent version is accepted
  // on this device, skip the gate INSTANTLY — no canvas→consent flash and no
  // re-prompt if the server read is slow/flaky. The server row stays the
  // compliance record; this only governs whether we show the gate.
  const consentKey = roomId ? `mcm-consent:${roomId}:${CONSENT_VERSION}` : null;

  // Ask the registry whether THIS viewer already accepted the current version.
  useEffect(() => {
    if (!roomId || !session || viewOnly) {
      setNeedsConsent(null);
      return;
    }
    try {
      if (consentKey && window.localStorage.getItem(consentKey)) {
        setNeedsConsent(false);
        return;
      }
    } catch {
      // localStorage blocked (private mode) → fall through to the server check.
    }
    let cancelled = false;
    void getMeeting(roomId).then((m) => {
      if (cancelled) {
        return;
      }
      // No registry row (ad-hoc room) → nothing to consent against. Otherwise
      // prompt unless the stored version matches the current wording.
      const accepted = m?.viewer_consent_version;
      const need = !!m && accepted !== CONSENT_VERSION;
      setNeedsConsent(need);
      // Mirror an already-accepted server state into the cache so future entries
      // skip the async check (and its flash) entirely.
      if (!need) {
        try {
          if (consentKey) {
            window.localStorage.setItem(consentKey, "1");
          }
        } catch {
          // ignore
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, session, viewOnly, consentKey]);

  // Render NOTHING only once we've resolved to "no consent needed". While
  // checking (null) OR when consent IS needed (true) we render the backdrop so
  // the board never flashes uncovered before the decision (owner: "thấy canvas
  // rồi mới hiện consent").
  if (!roomId || needsConsent === false) {
    return null;
  }

  const accept = async () => {
    if (busy || closing) {
      return;
    }
    setBusy(true);
    try {
      // Record acceptance. Fail-soft: even if the POST fails we dismiss the gate
      // (the user DID consent on screen) — the worker re-prompts on next entry
      // since no row was written.
      await acceptMeetingConsent(roomId, CONSENT_VERSION);
    } catch {
      // swallow — proceed to dismiss either way (fail-soft, as above).
    }
    // Remember on THIS device so re-entry never re-prompts/flashes — even if the
    // POST above failed (the server row is the compliance record; this is UX).
    try {
      if (consentKey) {
        window.localStorage.setItem(consentKey, "1");
      }
    } catch {
      // ignore
    }
    // Fade the gate out, then unmount, so the board it was covering eases into
    // view rather than snapping in.
    setClosing(true);
    window.setTimeout(() => setNeedsConsent(false), 220);
  };

  return (
    <div
      className={`mcm-gate mcm-gate--consent${
        closing ? " mcm-gate--closing" : ""
      }`}
      role="dialog"
      aria-modal={needsConsent === true}
    >
      {/* While CHECKING (needsConsent === null) we render only this frosted
          backdrop so the canvas never flashes uncovered before the decision;
          the card appears once we know consent is actually needed. */}
      {needsConsent === true && (
      <div className="mcm-gate__card">
        {/* Read the terms in your language. Drives the app-wide
            `preferredLanguageAtom` (via appLangCodeAtom) so the choice persists
            and stays consistent everywhere — not a local-only toggle. The
            consent.* copy already exists in vi/en/ko; switching the lang just
            flips which renders. */}
        <div className="mcm-gate__lang">
          <LangSwitcher />
        </div>
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
      )}
    </div>
  );
};

export default MeetingConsentGate;
