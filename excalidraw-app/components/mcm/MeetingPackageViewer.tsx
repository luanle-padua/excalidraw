// Meeting Package VIEWER — the recipient-facing half of the Package feature.
//
// A host publishes a package (MeetingPackageBuilder); the audience opens it
// here. It renders the server-stored recap.html (the curator's summary + file
// list) and offers a one-click offline download (.zip) plus the included-file
// list. The raw meeting stays E2E — this only ever shows the curated,
// server-readable copy the host chose to share.
//
// recap_html is APP-generated HTML (renderRecapHtml in MeetingPackageBuilder),
// but it's stored in R2 and could in principle be tampered with, so we render
// it inside a SANDBOXED iframe (no scripts, no same-origin) — it can paint but
// can't reach this page, cookies, or the network.

import { Download, FileText, Image as ImageIcon, Box, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  exportPackageZip,
  getPackage,
  type MeetingFileRow,
  type PackageDetail,
} from "../../data/packages";
import { useT } from "../../i18n/mcm";

const fmtSize = (n: number | null | undefined): string => {
  if (!n) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const KindIcon = ({ kind }: { kind: string | null }) => {
  if (kind === "image") {
    return <ImageIcon size={15} aria-hidden="true" />;
  }
  if (kind === "ifc" || kind === "glb") {
    return <Box size={15} aria-hidden="true" />;
  }
  return <FileText size={15} aria-hidden="true" />;
};

const downloadBlob = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const MeetingPackageViewer = ({
  pkgId,
  onClose,
}: {
  pkgId: string;
  onClose: () => void;
}) => {
  const t = useT();
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const d = await getPackage(pkgId);
      if (!alive) {
        return;
      }
      setDetail(d);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [pkgId]);

  const onDownload = async () => {
    setBusy(true);
    try {
      const blob = await exportPackageZip(pkgId);
      if (!blob) {
        window.alert(t("pkg.downloadFailed"));
        return;
      }
      const base = detail?.package.title?.trim() || "package";
      downloadBlob(`${base}.zip`, blob);
    } finally {
      setBusy(false);
    }
  };

  const files: MeetingFileRow[] = detail?.files ?? [];

  return createPortal(
    <div
      className="mcm-log-modal-backdrop mcm-pkg-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("pkg.viewerTitle")}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="mcm-log-modal mcm-pkg-modal mcm-pkgv-modal">
        <div className="mcm-log-modal__header">
          <div className="mcm-log-modal__head-text">
            <h2 className="mcm-log-modal__title">
              <Package size={18} aria-hidden="true" />{" "}
              {detail?.package.title?.trim() || t("pkg.viewerTitle")}
            </h2>
            <span className="mcm-log-modal__meta">{t("pkg.viewerSubtitle")}</span>
          </div>
        </div>

        <div className="mcm-pkg-modal__body mcm-pkgv-body">
          {loading ? (
            <p className="mcm-pkg-empty">{t("pkg.viewerLoading")}</p>
          ) : !detail ? (
            <p className="mcm-pkg-empty">{t("pkg.viewerUnavailable")}</p>
          ) : (
            <>
              {detail.recap_html ? (
                <iframe
                  className="mcm-pkgv-recap"
                  title={t("pkg.recapFrameTitle")}
                  // sandbox with NO allow-* tokens: the recap can render but is
                  // fully isolated (no scripts, no same-origin, no forms).
                  sandbox=""
                  srcDoc={detail.recap_html}
                />
              ) : detail.package.summary_text ? (
                // Fallback when no recap.html was stored (e.g. summary-only
                // package): show the plain summary text.
                <p className="mcm-pkgv-summary">{detail.package.summary_text}</p>
              ) : (
                <p className="mcm-pkg-empty">{t("pkg.viewerNoRecap")}</p>
              )}

              {files.length > 0 && (
                <div className="mcm-pkg-field">
                  <span className="mcm-invite__label">
                    {t("pkg.filesLabel")}
                    {" · "}
                    {t("pkg.selectedCount", { count: files.length })}
                  </span>
                  <ul className="mcm-pkg-files">
                    {files.map((f) => (
                      <li key={f.id} className="mcm-pkg-file">
                        <span className="mcm-pkgv-file-row">
                          <KindIcon kind={f.kind} />
                          <span className="mcm-pkg-file__name">
                            {f.name || f.id}
                          </span>
                          <span className="mcm-pkg-file__size">
                            {fmtSize(f.size)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="mcm-log-modal__footer mcm-pkg-modal__footer">
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {t("pkg.close")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--primary"
            onClick={() => void onDownload()}
            disabled={busy || loading || !detail}
          >
            <Download size={15} aria-hidden="true" /> {t("pkg.download")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default MeetingPackageViewer;
