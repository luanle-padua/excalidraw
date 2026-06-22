// ConnectionBanner — the visual half of Phase 1 (network resilience). Reads
// connectionStateAtom (populated by AudioRoomController off DailyAudio's
// "network-connection" / "network-quality-change" events) and renders:
//   1. a top-center BANNER when the call is reconnecting (amber) or unstable
//      (red) — so a user whose SFU/signaling path dropped isn't left staring at
//      a frozen frame with no idea why (the multi-country demo failure mode).
//   2. a brief "reconnected" confirmation banner (green) that auto-hides, shown
//      only after we were actually reconnecting/unstable.
//   3. a small QUALITY CHIP (green/amber/red dot) with a reasons tooltip.
//
// State carries CODES only (ConnectionLifecycle / ConnectionQuality + raw reason
// codes); we map every code to an i18n string HERE at render time — never bake a
// localized string into state (mirrors AudioErrorKind / NonfatalKind).

import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  connectionStateAtom,
  type ConnectionLifecycle,
  type ConnectionQuality,
} from "../../audio/connectionState";
import { useT } from "../../i18n/mcm";

import "./ConnectionBanner.scss";

import type { McmKey } from "../../i18n/mcm";

/** How long the green "reconnected" confirmation stays up before auto-hiding. */
const RECONNECTED_HIDE_MS = 3000;

/** Map a raw Daily reason code to an i18n label, falling back to the raw code
 *  itself (loud, never silently dropped) when it's an unknown/future code. */
const reasonLabel = (
  t: (key: McmKey, params?: Record<string, string | number>) => string,
  code: string,
): string => {
  const key = `connection.reason.${code}` as McmKey;
  const label = t(key);
  // useT returns the key path itself when a string is missing — detect that and
  // show the raw machine code instead of a useless "connection.reason.foo".
  return label === key ? code : label;
};

export const ConnectionBanner = () => {
  const t = useT();
  const { lifecycle, quality, reasons, statsTooltip } =
    useAtomValue(connectionStateAtom);

  // Show a transient "Reconnected" confirmation, but ONLY after we were in a
  // degraded state — otherwise the very first "connected" event on a healthy
  // join would flash a pointless banner. Tracked via a ref of the previous
  // lifecycle so a plain re-render never re-triggers it.
  const prevLifecycleRef = useRef<ConnectionLifecycle>(lifecycle);
  const [showReconnected, setShowReconnected] = useState(false);
  useEffect(() => {
    const prev = prevLifecycleRef.current;
    prevLifecycleRef.current = lifecycle;
    if (lifecycle === "connected" && prev !== "connected") {
      setShowReconnected(true);
      const timer = window.setTimeout(
        () => setShowReconnected(false),
        RECONNECTED_HIDE_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (lifecycle !== "connected" && showReconnected) {
      // Re-entered a degraded state before the confirmation auto-hid — drop it.
      setShowReconnected(false);
    }
    return undefined;
    // showReconnected intentionally omitted: this effect reacts to lifecycle
    // transitions, and including it would re-run the timer on its own toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycle]);

  const reasonText =
    reasons.length > 0
      ? reasons.map((r) => reasonLabel(t, r)).join(" · ")
      : undefined;

  // Phase 4 — the chip tooltip combines the reason CODES (translated) with the
  // latest real-numbers stats suffix (rtt / loss / kbps), so a degraded link
  // shows both WHY (codes) and HOW BAD (numbers). statsTooltip is already
  // formatted + language-neutral; empty until the first getNetworkStats sample.
  const chipDetail = [reasonText, statsTooltip || undefined]
    .filter(Boolean)
    .join(" · ");

  // Pick the active banner (reconnecting / unstable / reconnected) if any.
  const banner: {
    tone: "reconnecting" | "unstable" | "reconnected";
    text: string;
  } | null =
    lifecycle === "reconnecting"
      ? { tone: "reconnecting", text: t("connection.reconnecting") }
      : lifecycle === "unstable"
      ? { tone: "unstable", text: t("connection.unstable") }
      : showReconnected
      ? { tone: "reconnected", text: t("connection.reconnected") }
      : null;

  // The chip is shown only when the link is actually degraded (low/bad) — a
  // healthy "good" connection needs no nagging indicator.
  const showChip: boolean = quality !== "good";

  if (!banner && !showChip) {
    return null;
  }

  const qualityLabel = (q: ConnectionQuality): string =>
    t(`connection.quality.${q}` as McmKey);

  return (
    <div className="mcm-connection" aria-live="polite">
      {banner && (
        <div
          className={`mcm-connection__banner mcm-connection__banner--${banner.tone}`}
          role={banner.tone === "unstable" ? "alert" : "status"}
        >
          <span className="mcm-connection__dot" aria-hidden="true" />
          <span className="mcm-connection__text">{banner.text}</span>
          {reasonText && banner.tone !== "reconnected" && (
            <span className="mcm-connection__detail"> · {reasonText}</span>
          )}
        </div>
      )}
      {showChip && (
        <span
          className={`mcm-connection__chip mcm-connection__chip--${quality}`}
          title={
            chipDetail
              ? `${qualityLabel(quality)} — ${chipDetail}`
              : qualityLabel(quality)
          }
          aria-label={t("connection.qualityLabel")}
        >
          <span className="mcm-connection__dot" aria-hidden="true" />
          <span className="mcm-connection__chip-label">
            {qualityLabel(quality)}
          </span>
        </span>
      )}
    </div>
  );
};

export default ConnectionBanner;
