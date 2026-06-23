// Meeting Package builder.
//
// Opened from the meeting detail view (a FINISHED meeting, by host / a project
// authority). Lets the curator: edit a summary (seeded from the meeting's AI
// recap), tick which meeting files to include, pick an audience, then either
// save a draft, publish, or export an offline zip.
//
// Packaging (publish/export) runs client-side because we hold the room key:
// each chosen file is fetched + decrypted, then re-uploaded as PLAINTEXT into
// the package's server-readable R2 prefix. The raw meeting is left untouched.

import { FileText, Image as ImageIcon, Package, Box } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  createPackage,
  decryptMeetingFile,
  exportPackageZip,
  listMeetingFiles,
  publishPackage,
  updatePackage,
  uploadPackageFile,
  uploadPackageRecap,
  type MeetingFileRow,
  type PackageAudience,
} from "../../data/packages";
import { useT } from "../../i18n/mcm";

// Reasonable byte size formatter for the file rows.
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

// Small per-kind glyph for the file picker rows. Mirrors MeetingLibrary's
// type buckets but keyed off the D1 `kind` column (the picker only has the
// index row, not the in-memory canvas file).
const KindIcon = ({ kind }: { kind: string | null }) => {
  if (kind === "image") {
    return <ImageIcon size={15} aria-hidden="true" />;
  }
  if (kind === "ifc" || kind === "glb") {
    return <Box size={15} aria-hidden="true" />;
  }
  return <FileText size={15} aria-hidden="true" />;
};

// HTML-escape for the recap render.
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Render the recap.html stored alongside the package (summary + file list +
// provenance link back to the meeting). Kept deliberately self-contained
// (inline styles) so it opens standalone, online or from the offline zip.
const renderRecapHtml = (args: {
  title: string;
  summary: string;
  files: MeetingFileRow[];
  meetingId: string;
}): string => {
  const fileLis = args.files
    .map((f) => `<li>${esc(f.name || f.id)} <span>${fmtSize(f.size)}</span></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(args.title)}</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; color: #1d1d1f;
    max-width: 720px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .summary { white-space: pre-wrap; margin: 24px 0; }
  ul { list-style: none; padding: 0; }
  li { padding: 8px 12px; border: 1px solid #e5e5ea; border-radius: 10px;
    margin-bottom: 6px; display: flex; justify-content: space-between; }
  li span { color: #8e8e93; font-size: 13px; }
  footer { margin-top: 40px; color: #8e8e93; font-size: 13px; }
</style>
</head>
<body>
  <h1>${esc(args.title)}</h1>
  <div class="summary">${esc(args.summary)}</div>
  ${args.files.length ? `<h2>Files</h2><ul>${fileLis}</ul>` : ""}
  <footer>Meeting: ${esc(args.meetingId)}</footer>
</body>
</html>`;
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

export const MeetingPackageBuilder = ({
  roomId,
  roomKey,
  meetingTitle,
  initialSummary,
  isConfidential,
  onClose,
}: {
  roomId: string;
  /** Room key for decrypting the chosen files client-side. May be null if the
   *  caller wasn't handed it (then file packaging is skipped, summary-only). */
  roomKey: string | null;
  meetingTitle: string;
  initialSummary: string | null;
  isConfidential: boolean;
  onClose: () => void;
}) => {
  const t = useT();
  const [title, setTitle] = useState(meetingTitle || "");
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [audience, setAudience] = useState<PackageAudience>("meeting");
  const [recipients, setRecipients] = useState("");
  const [files, setFiles] = useState<MeetingFileRow[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listMeetingFiles(roomId);
      if (!alive) {
        return;
      }
      setFiles(list);
      // Default: pre-select everything (the curator unticks what they don't
      // want — most packages share the bulk of the materials).
      setSelected(new Set(list.map((f) => f.id)));
      setFilesLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  // A confidential meeting can never target the whole project.
  const projectBlocked = isConfidential;
  useEffect(() => {
    if (projectBlocked && audience === "project") {
      setAudience("meeting");
    }
  }, [projectBlocked, audience]);

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected],
  );

  const parsedRecipients = useMemo(
    () =>
      recipients
        .split(/[,;\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes("@")),
    [recipients],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Create-or-reuse a draft, upload the chosen (decrypted) files + recap, and
  // return the package id. Shared by Publish and Export. Returns null on a
  // hard failure (caller surfaces the error).
  const buildPackage = async (): Promise<string | null> => {
    const fileIds = selectedFiles.map((f) => f.id);
    const pkgId = await createPackage(roomId, {
      title: title.trim(),
      summary_text: summary,
      audience_kind: audience,
      file_ids: fileIds,
      recipients: audience === "list" ? parsedRecipients : undefined,
    });
    if (!pkgId) {
      return null;
    }
    // Decrypt + upload each chosen file as a plaintext package copy.
    if (roomKey) {
      setPhase(t("pkg.packaging"));
      for (const f of selectedFiles) {
        const dec = await decryptMeetingFile(roomId, roomKey, f.id);
        if (dec) {
          await uploadPackageFile(
            pkgId,
            f.id,
            // ArrayBuffer copy of the decrypted bytes.
            dec.bytes.buffer.slice(
              dec.bytes.byteOffset,
              dec.bytes.byteOffset + dec.bytes.byteLength,
            ) as ArrayBuffer,
            dec.mimeType,
          );
        }
      }
    }
    await uploadPackageRecap(
      pkgId,
      renderRecapHtml({
        title: title.trim() || meetingTitle,
        summary,
        files: selectedFiles,
        meetingId: roomId,
      }),
    );
    return pkgId;
  };

  const onSaveDraft = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await createPackage(roomId, {
        title: title.trim(),
        summary_text: summary,
        audience_kind: audience,
        file_ids: selectedFiles.map((f) => f.id),
        recipients: audience === "list" ? parsedRecipients : undefined,
      });
      if (!pkgId) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      window.alert(t("pkg.draftSaved"));
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const onPublish = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await buildPackage();
      if (!pkgId || !(await publishPackage(pkgId))) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      window.alert(t("pkg.published"));
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const onExport = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await buildPackage();
      if (!pkgId) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      const blob = await exportPackageZip(pkgId);
      if (!blob) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      downloadBlob(`${title.trim() || "package"}.zip`, blob);
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const AUDIENCES: { value: PackageAudience; label: string; hint: string }[] = [
    {
      value: "meeting",
      label: t("pkg.audienceMeeting"),
      hint: t("pkg.audienceMeetingHint"),
    },
    {
      value: "project",
      label: t("pkg.audienceProject"),
      hint: t("pkg.audienceProjectHint"),
    },
    {
      value: "list",
      label: t("pkg.audienceList"),
      hint: t("pkg.audienceListHint"),
    },
  ];

  // Portal to <body>: the meeting detail view lives inside the Glass Desk
  // dashboard, whose backdrop-filter/transform ancestors trap `position:
  // fixed` — without the portal the backdrop renders BEHIND the calendar
  // instead of over the whole viewport.
  return createPortal(
    <div
      className="mcm-log-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("pkg.builderTitle")}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="mcm-log-modal mcm-pkg-modal">
        <div className="mcm-log-modal__header">
          <div className="mcm-log-modal__head-text">
            <h2 className="mcm-log-modal__title">
              <Package size={18} aria-hidden="true" /> {t("pkg.builderTitle")}
            </h2>
            <span className="mcm-log-modal__meta">{t("pkg.builderSubtitle")}</span>
          </div>
        </div>

        <div className="mcm-pkg-modal__body">
          <label className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.titleLabel")}</span>
            <input
              type="text"
              value={title}
              placeholder={t("pkg.titlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.summaryLabel")}</span>
            <textarea
              className="mcm-pkg-summary"
              rows={6}
              value={summary}
              placeholder={t("pkg.summaryPlaceholder")}
              onChange={(e) => setSummary(e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="mcm-pkg-field">
            <span className="mcm-invite__label">
              {t("pkg.filesLabel")}
              {" · "}
              {t("pkg.selectedCount", { count: selected.size })}
            </span>
            {filesLoading ? (
              <p className="mcm-pkg-empty">{t("pkg.filesLoading")}</p>
            ) : files.length === 0 ? (
              <p className="mcm-pkg-empty">{t("pkg.filesEmpty")}</p>
            ) : (
              <ul className="mcm-pkg-files">
                {files.map((f) => (
                  <li key={f.id} className="mcm-pkg-file">
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(f.id)}
                        onChange={() => toggle(f.id)}
                        disabled={busy}
                      />
                      <KindIcon kind={f.kind} />
                      <span className="mcm-pkg-file__name">
                        {f.name || f.id}
                      </span>
                      <span className="mcm-pkg-file__size">
                        {fmtSize(f.size)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.audienceLabel")}</span>
            <div className="mcm-pkg-audience">
              {AUDIENCES.map((a) => {
                const disabled = busy || (a.value === "project" && projectBlocked);
                return (
                  <label
                    key={a.value}
                    className={`mcm-pkg-aud${
                      audience === a.value ? " mcm-pkg-aud--on" : ""
                    }${disabled ? " mcm-pkg-aud--disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="pkg-audience"
                      checked={audience === a.value}
                      onChange={() => setAudience(a.value)}
                      disabled={disabled}
                    />
                    <span className="mcm-pkg-aud__label">{a.label}</span>
                    <span className="mcm-pkg-aud__hint">{a.hint}</span>
                  </label>
                );
              })}
            </div>
            {projectBlocked && (
              <p className="mcm-pkg-warn">{t("pkg.confidentialBlocked")}</p>
            )}
          </div>

          {audience === "list" && (
            <label className="mcm-pkg-field">
              <span className="mcm-invite__label">
                {t("pkg.recipientsLabel")}
              </span>
              <textarea
                rows={2}
                value={recipients}
                placeholder={t("pkg.recipientsPlaceholder")}
                onChange={(e) => setRecipients(e.target.value)}
                disabled={busy}
              />
            </label>
          )}

          {phase && <p className="mcm-pkg-phase">{phase}</p>}
        </div>

        <div className="mcm-log-modal__footer mcm-pkg-modal__footer">
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {t("pkg.cancel")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={() => void onSaveDraft()}
            disabled={busy}
          >
            {t("pkg.saveDraft")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={() => void onExport()}
            disabled={busy}
          >
            {t("pkg.exportZip")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--primary"
            onClick={() => void onPublish()}
            disabled={busy}
          >
            {t("pkg.publish")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
