// AI-in-use indicator (PM decision, 06-18): a small, classy pill that fades in
// whenever the client is calling ANY AI endpoint — translate, translate-batch,
// chatbot, summarize, STT — so users always know when AI is working for them.
//
// "Sang và tinh tế": a single sparkle + "AI" label on a Glass Desk pill, with a
// soft shimmer while active. It reads from `aiInFlightAtom` (a reference-counted
// in-flight counter driven by every AI call site via data/aiActivity) — visible
// while that count is > 0, hidden otherwise. Pointer-events: none — purely
// informational, never in the way.
//
// We keep the node mounted briefly after the count drops to 0 so the fade-out
// can play, then unmount.

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { aiInFlightAtom } from "../../data/aiActivity";
import { useT } from "../../i18n/mcm";

import "./AiActivityIndicator.scss";

export const AiActivityIndicator = () => {
  const t = useT();
  const inFlight = useAtomValue(aiInFlightAtom);
  const active = inFlight > 0;

  // Keep the node around for one fade-out cycle after the last call settles.
  const [mounted, setMounted] = useState(active);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setMounted(true);
    } else if (mounted) {
      hideTimer.current = window.setTimeout(() => {
        setMounted(false);
        hideTimer.current = null;
      }, 320); // matches the CSS fade duration
    }
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [active, mounted]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className={`mcm-ai-pill${active ? " --active" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={t("ai.inUse")}
    >
      <Sparkles size={13} className="mcm-ai-pill__icon" aria-hidden="true" />
      <span className="mcm-ai-pill__label">{t("ai.label")}</span>
    </div>
  );
};

export default AiActivityIndicator;
