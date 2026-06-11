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
  Lock,
  PencilRuler,
  Trash2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteMyFile,
  listMyFiles,
  updateMyFile,
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

// Section order on the shelf — documents first (the formats meetings care
// about most), images next, catch-all last. Empty sections are hidden.
const KIND_ORDER: UserFileKind[] = ["pdf", "dxf", "ifc", "image", "other"];

const KIND_LABEL_KEY = {
  pdf: "myfiles.kindPdf",
  dxf: "myfiles.kindDxf",
  ifc: "myfiles.kindIfc",
  image: "myfiles.kindImage",
  other: "myfiles.kindOther",
} as const;

type SortKey = "date" | "name" | "size";

const SORT_CMP: Record<SortKey, (a: UserFile, b: UserFile) => number> = {
  date: (a, b) => tsToMs(b.created_at) - tsToMs(a.created_at),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => b.size - a.size,
};

/** "a,b,c" → ["a","b","c"] (trimmed, empties dropped). */
const parseTags = (tags: string | null): string[] =>
  tags
    ? tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];

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

/** One shelf row — name/meta plus the metadata editors (tag chips and the
 *  private/sharable toggle). Owns only the tag-input draft; persisted
 *  metadata flows through `onUpdate` (PATCH + list refresh upstream). */
const MyFileRow = ({
  file,
  saving,
  deleting,
  onUpdate,
  onDelete,
}: {
  file: UserFile;
  saving: boolean;
  deleting: boolean;
  onUpdate: (file: UserFile, patch: Parameters<typeof updateMyFile>[1]) => void;
  onDelete: (file: UserFile) => void;
}) => {
  const t = useT();
  const [tagDraft, setTagDraft] = useState("");
  const tags = parseTags(file.tags);
  const isPrivate = file.visibility === "private";

  const addTag = () => {
    // Commas are the storage separator — swap them out of user input.
    const tag = tagDraft.replace(/,/g, " ").trim();
    setTagDraft("");
    if (tag && !tags.includes(tag)) {
      onUpdate(file, { tags: [...tags, tag].join(",") });
    }
  };

  const removeTag = (tag: string) => {
    const next = tags.filter((existing) => existing !== tag);
    onUpdate(file, { tags: next.length ? next.join(",") : null });
  };

  return (
    <li className={`mcm-myfiles__row mcm-myfiles__row--${file.kind}`}>
      <span className="mcm-myfiles__icon" aria-hidden="true">
        {KIND_ICON[file.kind] ?? KIND_ICON.other}
      </span>
      <span className="mcm-myfiles__main">
        <span className="mcm-myfiles__name" title={file.name}>
          {file.name}
        </span>
        <span className="mcm-myfiles__meta">
          <span className="mcm-myfiles__kind">{file.kind.toUpperCase()}</span>
          <span>{humanSize(file.size)}</span>
          <span>{fmtDate(file.created_at)}</span>
        </span>
        <span className="mcm-myfiles__tags">
          {tags.map((tag) => (
            <span key={tag} className="mcm-myfiles__tag">
              {tag}
              <button
                type="button"
                className="mcm-myfiles__tag-x"
                onClick={() => removeTag(tag)}
                disabled={saving}
                title={t("myfiles.delete")}
                aria-label={`${t("myfiles.delete")}: ${tag}`}
              >
                <X size={9} />
              </button>
            </span>
          ))}
          <input
            type="text"
            className="mcm-myfiles__tag-input"
            value={tagDraft}
            placeholder={t("myfiles.tagsPlaceholder")}
            aria-label={t("myfiles.tagsPlaceholder")}
            disabled={saving}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
        </span>
      </span>
      <button
        type="button"
        className={`mcm-myfiles__vis mcm-myfiles__vis--${file.visibility}`}
        onClick={() =>
          onUpdate(file, { visibility: isPrivate ? "sharable" : "private" })
        }
        disabled={saving}
        title={t(isPrivate ? "myfiles.visPrivate" : "myfiles.visSharable")}
      >
        {isPrivate ? (
          <Lock size={11} aria-hidden="true" />
        ) : (
          <Users size={11} aria-hidden="true" />
        )}
        {t(isPrivate ? "myfiles.visPrivate" : "myfiles.visSharable")}
      </button>
      <button
        type="button"
        className="mcm-myfiles__delete"
        onClick={() => onDelete(file)}
        disabled={deleting}
        title={t("myfiles.delete")}
        aria-label={t("myfiles.delete")}
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
};

export const MyFilesPanel = () => {
  const t = useT();
  // null = first load in flight — render a quiet placeholder, not the
  // empty state (which would flash for users who DO have files).
  const [files, setFiles] = useState<UserFile[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
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

  // Tag / visibility edits — PATCH then re-list so the row reflects what
  // the server actually stored (a failed save quietly reverts).
  const handleUpdate = useCallback(
    async (file: UserFile, patch: Parameters<typeof updateMyFile>[1]) => {
      if (savingId) {
        return;
      }
      setSavingId(file.id);
      try {
        await updateMyFile(file.id, patch);
      } finally {
        setSavingId(null);
        await refresh();
      }
    },
    [savingId, refresh],
  );

  // Group by kind (fixed section order, empty sections hidden), then sort
  // within each section by the user's pick.
  const sections = files
    ? KIND_ORDER.map((kind) => ({
        kind,
        files: files
          .filter((file) => (file.kind ?? "other") === kind)
          .sort(SORT_CMP[sortKey]),
      })).filter((section) => section.files.length > 0)
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

      {sections === null || files === null ? (
        <div className="mcm-myfiles__hint">…</div>
      ) : files.length === 0 ? (
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
          <div className="mcm-myfiles__toolbar">
            <div className="mcm-myfiles__count">
              {t("myfiles.count", { count: files.length })}
            </div>
            <label className="mcm-myfiles__sort">
              {t("myfiles.sortLabel")}
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                <option value="date">{t("myfiles.sortDate")}</option>
                <option value="name">{t("myfiles.sortName")}</option>
                <option value="size">{t("myfiles.sortSize")}</option>
              </select>
            </label>
          </div>
          {sections.map(({ kind, files: sectionFiles }) => (
            <section key={kind} className="mcm-myfiles__section">
              <div className="mcm-myfiles__section-head">
                {t(KIND_LABEL_KEY[kind])}
                <span className="mcm-myfiles__section-count">
                  {sectionFiles.length}
                </span>
              </div>
              <ul className="mcm-myfiles__list">
                {sectionFiles.map((file) => (
                  <MyFileRow
                    key={file.id}
                    file={file}
                    saving={savingId === file.id}
                    deleting={deletingId === file.id}
                    onUpdate={(target, patch) =>
                      void handleUpdate(target, patch)
                    }
                    onDelete={(target) => void handleDelete(target)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
};

export default MyFilesPanel;
