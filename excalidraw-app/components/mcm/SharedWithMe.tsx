import { FileText, Inbox, Package } from "lucide-react";
import { useEffect, useState } from "react";

import {
  listMyPackages,
  type MeetingPackageListItem,
} from "../../data/packages";
import { useT } from "../../i18n/mcm";

import { MeetingPackageViewer } from "./MeetingPackageViewer";

const fmtWhen = (ms: number | null): string => {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

/**
 * "Shared with me" — the recipient-facing dashboard surface for the Meeting
 * Package feature. Lists the PUBLISHED recap packages addressed to the current
 * user across every meeting (worker GET /v1/me/packages → listMyPackages) and
 * opens the existing MeetingPackageViewer to read the recap + download the .zip.
 *
 * The list is already audience-gated server-side (canSeePackage); this only
 * ever shows what the host chose to share with this user. Empty state when none.
 */
export const SharedWithMe = () => {
  const t = useT();
  const [items, setItems] = useState<MeetingPackageListItem[] | null>(null);
  const [viewPkgId, setViewPkgId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listMyPackages().then((rows) => {
      if (alive) {
        setItems(rows);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Loading / empty state — a quiet glass card, never a hard error (the fetch
  // reads "nothing to show" on any failure, same as the other dashboard tabs).
  if (items !== null && items.length === 0) {
    return (
      <section className="mcm-shared" aria-label={t("pkg.sharedWithMe")}>
        <p className="mcm-shared__empty">
          <Inbox size={18} aria-hidden="true" /> {t("pkg.sharedEmpty")}
        </p>
      </section>
    );
  }

  return (
    <section className="mcm-shared" aria-label={t("pkg.sharedWithMe")}>
      <ul className="mcm-invited__list">
        {(items ?? []).map((p) => (
          <li key={p.id} className="mcm-invited__card">
            <span className="mcm-shared__icon" aria-hidden="true">
              <Package size={16} />
            </span>
            <div className="mcm-invited__meta">
              <strong>{p.title?.trim() || t("pkg.viewerTitle")}</strong>
              <span>
                {[
                  fmtWhen(p.published_at),
                  p.created_by ? `· ${p.created_by}` : "",
                  p.file_count
                    ? t("pkg.selectedCount", { count: p.file_count })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <button
              type="button"
              className="mcm-invited__join"
              onClick={() => setViewPkgId(p.id)}
            >
              <FileText size={15} /> {t("pkg.open")}
            </button>
          </li>
        ))}
      </ul>

      {viewPkgId && (
        <MeetingPackageViewer
          pkgId={viewPkgId}
          onClose={() => setViewPkgId(null)}
        />
      )}
    </section>
  );
};

export default SharedWithMe;
