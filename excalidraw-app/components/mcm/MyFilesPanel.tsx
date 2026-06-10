// "Tài liệu của tôi" — the personal document shelf panel on the dashboard
// (middle column of ProjectBrowser). INTERNAL users upload documents ONCE
// here, then copy them into any meeting from the in-meeting library's
// "Từ tủ của tôi" picker. Copies are snapshots: deleting a shelf file
// never touches a meeting that already ingested it.

import {
  Box,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  PencilRuler,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteMyFile,
  listMyFiles,
  uploadMyFile,
  type UserFile,
  type UserFileKind,
} from "../../data/userFiles";
import { useT } from "../../i18n/mcm";

const KIND_ICON: Record<UserFileKind, React.ReactNode> = {
  pdf: <FileText size={17} />,
  dxf: <PencilRuler size={17} />,
  ifc: <Box size={17} />,
  image: <ImageIcon size={17} />,
  other: <FileIcon size={17} />,
};

/** "1.2 MB" / "640 KB" / "87 B" — shelf files are documents, one decimal
 *  above KB is plenty. */
const humanSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Server timestamps may arrive as seconds or ms — normalise for Date. */
const tsToMs = (ts: number): number => (ts < 1e12 ? ts * 1000 : ts);

const fmtDate = (ts: number): string =>
  ts
    ? new Date(tsToMs(ts)).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

export const MyFilesPanel = () => {
  const t = useT();
  // null = first load in flight — render a quiet placeholder, not the
  // empty state (which would flash for users who DO have files).
  const [files, setFiles] = useState<UserFile[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setFiles(await listMyFiles());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpload = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      if (arr.length === 0 || uploading) {
        return;
      }
      setUploading(true);
      try {
        for (const file of arr) {
          const result = await uploadMyFile(file);
          if (!result.ok) {
            window.alert(
              t(
                result.reason === "too-large"
                  ? "myfiles.tooLarge"
                  : "myfiles.uploadFailed",
                { name: file.name },
              ),
            );
          }
        }
      } finally {
        setUploading(false);
        await refresh();
      }
    },
    [uploading, refresh, t],
  );

  const handleDelete = useCallback(
    async (file: UserFile) => {
      if (
        deletingId ||
        !window.confirm(t("myfiles.deleteConfirm", { name: file.name }))
      ) {
        return;
      }
      setDeletingId(file.id);
      try {
        await deleteMyFile(file.id);
      } finally {
        setDeletingId(null);
        await refresh();
      }
    },
    [deletingId, refresh, t],
  );

  const sorted = files
    ? [...files].sort((a, b) => tsToMs(b.created_at) - tsToMs(a.created_at))
    : null;

  return (
    <div className="mcm-myfiles">
      {/* Upload zone — drag-drop or click-to-pick, same affordance pair
          as the in-meeting library uploader. */}
      <button
        type="button"
        className={`mcm-myfiles__drop${
          dragOver ? " mcm-myfiles__drop--over" : ""
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) {
            void handleUpload(e.dataTransfer.files);
          }
        }}
        disabled={uploading}
      >
        <UploadCloud size={20} aria-hidden="true" />
        <span className="mcm-myfiles__drop-text">
          {uploading
            ? t("myfiles.uploading")
            : dragOver
            ? t("myfiles.dropActive")
            : t("myfiles.dropHint")}
        </span>
        <span className="mcm-myfiles__drop-sub">{t("myfiles.subtitle")}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="mcm-myfiles__input"
        aria-label={t("myfiles.dropHint")}
        onChange={(e) => {
          if (e.target.files?.length) {
            void handleUpload(e.target.files);
            e.target.value = "";
          }
        }}
      />

      {sorted === null ? (
        <div className="mcm-myfiles__hint">…</div>
      ) : sorted.length === 0 ? (
        <div className="mcm-myfiles__empty">
          <span className="mcm-myfiles__empty-title">
            {t("myfiles.emptyTitle")}
          </span>
          <span className="mcm-myfiles__empty-desc">
            {t("myfiles.emptyDesc")}
          </span>
        </div>
      ) : (
        <>
          <div className="mcm-myfiles__count">
            {t("myfiles.count", { count: sorted.length })}
          </div>
          <ul className="mcm-myfiles__list">
            {sorted.map((file) => (
              <li
                key={file.id}
                className={`mcm-myfiles__row mcm-myfiles__row--${file.kind}`}
              >
                <span className="mcm-myfiles__icon" aria-hidden="true">
                  {KIND_ICON[file.kind] ?? KIND_ICON.other}
                </span>
                <span className="mcm-myfiles__main">
                  <span className="mcm-myfiles__name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="mcm-myfiles__meta">
                    <span className="mcm-myfiles__kind">
                      {file.kind.toUpperCase()}
                    </span>
                    <span>{humanSize(file.size)}</span>
                    <span>{fmtDate(file.created_at)}</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="mcm-myfiles__delete"
                  onClick={() => void handleDelete(file)}
                  disabled={deletingId === file.id}
                  title={t("myfiles.delete")}
                  aria-label={t("myfiles.delete")}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export default MyFilesPanel;
