// High-visibility waiting-room KNOCK banner (host-only). When one or more
// guests are knocking to enter, this renders a persistent, top-center alert
// over the meeting canvas — name + Admit / Deny inline — so the host can act
// without first opening the participants drawer.
//
// IT OWNS NO STATE OR POLLING. The single knock poller lives in
// ParticipantsBar (gated on viewerAuthority); ParticipantsBar passes the live
// `knocks` list + the same admit/deny handler it uses for the drawer. This is
// purely a presentation layer over that state, rendered as a sibling of the
// people-bar inside .mcm-shell__canvas-area (so its absolute positioning is
// relative to the canvas area, exactly like .mcm-connection).
//
// Design: amber (--mcm-warning) tone to match the existing "N waiting" chip,
// solid-green Admit (the obvious action), quiet outlined Deny, a pulsing
// beacon, and a "+N more · open list" affordance when a queue forms. All
// --mcm-* tokens so it tracks every theme.

import { UserCheck, UserX } from "lucide-react";

import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";

import type { WaitingKnock } from "../../data/knock";

import "./KnockBanner.scss";

export const KnockBanner = ({
  knocks,
  onAction,
  onOpenPanel,
}: {
  /** Guests currently knocking (host-only; already gated upstream). */
  knocks: WaitingKnock[];
  /** Admit / deny a specific knocker by email — the SAME handler the drawer
   *  uses, so both surfaces stay in sync (optimistic drop + refetch on error). */
  onAction: (email: string, action: "admit" | "deny") => void;
  /** Open the participants drawer to triage the rest of the queue. */
  onOpenPanel: () => void;
}) => {
  const t = useT();

  if (knocks.length === 0) {
    return null;
  }

  // Surface the OLDEST knocker inline (they've waited longest); the rest are
  // summarised in the "+N more" affordance that routes to the full drawer.
  const head = knocks[0];
  const more = knocks.length - 1;
  const headName = head.name || head.email.split("@")[0];

  return (
    <div
      className="mcm-knock"
      role="alertdialog"
      aria-live="assertive"
      aria-label={t("knock.bannerTitle", { count: knocks.length })}
    >
      <div className="mcm-knock__head">
        <span className="mcm-knock__beacon" aria-hidden="true" />
        <span className="mcm-knock__title">
          {t("knock.bannerTitle", { count: knocks.length })}
        </span>
        {knocks.length > 1 && (
          <span className="mcm-knock__count" aria-hidden="true">
            {knocks.length}
          </span>
        )}
      </div>

      <div className="mcm-knock__row">
        <MCMAvatar
          className="mcm-knock__avatar"
          name={headName}
          email={head.email}
        />
        <div className="mcm-knock__person">
          <span className="mcm-knock__name" title={headName}>
            {headName}
          </span>
          <span className="mcm-knock__email" title={head.email}>
            {head.email}
          </span>
        </div>
        <div className="mcm-knock__actions">
          <button
            type="button"
            className="mcm-knock__btn mcm-knock__btn--admit"
            onClick={() => onAction(head.email, "admit")}
          >
            <UserCheck size={14} strokeWidth={2.2} />
            {t("knock.admit")}
          </button>
          <button
            type="button"
            className="mcm-knock__btn mcm-knock__btn--deny"
            onClick={() => onAction(head.email, "deny")}
          >
            <UserX size={14} strokeWidth={2.2} />
            {t("knock.deny")}
          </button>
        </div>
      </div>

      {more > 0 && (
        <button
          type="button"
          className="mcm-knock__more"
          onClick={onOpenPanel}
        >
          {t("knock.moreWaiting", { count: more })}
        </button>
      )}
    </div>
  );
};

export default KnockBanner;
