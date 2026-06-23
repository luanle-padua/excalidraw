// "Tài liệu dự án" — the PER-PROJECT SHARED document shelf, surfaced inside a
// project's view on the dashboard. Distinct from "My Files" (MyFilesPanel, the
// personal shelf): ANY member of the project uploads here and EVERY member sees
// the files. Mirrors MyFilesPanel's upload drop-zone + list/grid + lazy image
// thumbnails, minus the personal-shelf-only tag/visibility editors (a shared
// shelf is shared by definition). Delete is allowed for the uploader or a
// project manager; the Worker is the source of truth (a non-uploader member's
// delete just 403s and the file stays).

import {
  ArrowUpDown,
  Box,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
  PencilRuler,
  Trash2,
  UploadCloud,
  User as UserIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteProjectFile,
  fetchProjectFileThumb,
  listProjectFilesChecked,
  uploadProjectFile,
  type ProjectFile,
  type ProjectFileKind,
} from "../../data/projectFiles";
import { useT } from "../../i18n/mcm";

import type { LucideIcon } from "lucide-react";

const KIND_ICON: Record<ProjectFileKind, LucideIcon> = {
  pdf: FileText,
  dxf: PencilRuler,
  ifc: Box,
  image: ImageIcon,
  other: FileIcon,
};

const KIND_ORDER: ProjectFileKind[] = ["pdf", "dxf", "ifc", "image", "other"];

const KIND_LABEL_KEY = {
  pdf: "myfiles.kindPdf",
  dxf: "myfiles.kindDxf",
  ifc: "myfiles.kindIfc",
  image: "myfiles.kindImage",
  other: "myfiles.kindOther",
} as const;

type SortKey = "date" | "name" | "size";
type ViewMode = "list" | "grid";
type KindFilter = ProjectFileKind | "all";

const SORT_CMP: Record<SortKey, (a: ProjectFile, b: ProjectFile) => number> = {
  date: (a, b) => tsToMs(b.created_at) - tsToMs(a.created_at),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => b.size - a.size,
};

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

const tsToMs = (ts: number): number => (ts < 1e12 ? ts * 1000 : ts);

const fmtDate = (ts: number): string =>
  ts
    ? new Date(tsToMs(ts)).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

/** "alice@map.com" → "alice" — a compact uploader label for the card/row. */
const shortUploader = (email: string): string =>
  email ? email.split("@")[0] : "—";

/** Can the current viewer delete this file? A hint only — the Worker enforces
 *  (uploader OR project manager). We surface the delete affordance to the
 *  uploader and to managers; others don't see it (and would 403 anyway). */
const canDelete = (
  file: ProjectFile,
  myEmail: string | undefined,
  isManager: boolean,
): boolean =>
  isManager ||
  (!!myEmail && file.uploaded_by.toLowerCase() === myEmail.toLowerCase());

const ProjectFileRow = ({
  file,
  thumbUrl,
  thumbRef,
  deleting,
  showDelete,
  onDelete,
}: {
  file: ProjectFile;
  thumbUrl?: string | null;
  thumbRef?: (node: HTMLElement | null) => void;
  deleting: boolean;
  showDelete: boolean;
  onDelete: (file: ProjectFile) => void;
}) => {
  const t = useT();
  const [thumbBroken, setThumbBroken] = useState(false);
  const Icon = KIND_ICON[file.kind] ?? KIND_ICON.other;
  const showThumb = !!thumbUrl && !thumbBroken;

  return (
    <li className={`mcm-myfiles__row mcm-myfiles__row--${file.kind}`}>
      <span className="mcm-myfiles__icon" aria-hidden="true" ref={thumbRef}>
        {showThumb ? (
          <img
            className="mcm-myfiles__thumb-img"
            src={thumbUrl ?? undefined}
            alt=""
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <Icon size={17} />
        )}
      </span>
      <span className="mcm-myfiles__main">
        <span className="mcm-myfiles__name" title={file.name}>
          {file.name}
        </span>
        <span className="mcm-myfiles__meta">
          <span className="mcm-myfiles__kind">{file.kind.toUpperCase()}</span>
          <span>{humanSize(file.size)}</span>
          <span>{fmtDate(file.created_at)}</span>
          <span
            className="mcm-projfiles__uploader"
            title={file.uploaded_by || undefined}
          >
            <UserIcon size={11} aria-hidden="true" />
            {shortUploader(file.uploaded_by)}
          </span>
        </span>
      </span>
      {showDelete && (
        <button
          type="button"
          className="mcm-myfiles__delete"
          onClick={() => onDelete(file)}
          disabled={deleting}
          title={t("projFiles.delete")}
          aria-label={t("projFiles.delete")}
        >
          <Trash2 size={15} />
        </button>
      )}
    </li>
  );
};

const ProjectFileCard = ({
  file,
  thumbUrl,
  thumbRef,
  deleting,
  showDelete,
  onDelete,
}: {
  file: ProjectFile;
  thumbUrl?: string | null;
  thumbRef?: (node: HTMLElement | null) => void;
  deleting: boolean;
  showDelete: boolean;
  onDelete: (file: ProjectFile) => void;
}) => {
  const t = useT();
  const [thumbBroken, setThumbBroken] = useState(false);
  const Icon = KIND_ICON[file.kind] ?? KIND_ICON.other;
  const showThumb = !!thumbUrl && !thumbBroken;

  return (
    <li className={`mcm-myfiles__card mcm-myfiles__card--${file.kind}`}>
      <div className="mcm-myfiles__card-thumb" ref={thumbRef}>
        {showThumb ? (
          <img
            className="mcm-myfiles__card-thumb-img"
            src={thumbUrl ?? undefined}
            alt=""
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <Icon size={26} aria-hidden="true" />
        )}
        <span className="mcm-myfiles__kind mcm-myfiles__card-kind">
          {file.kind.toUpperCase()}
        </span>
        {showDelete && (
          <button
            type="button"
            className="mcm-myfiles__delete mcm-myfiles__card-delete"
            onClick={() => onDelete(file)}
            disabled={deleting}
            title={t("projFiles.delete")}
            aria-label={t("projFiles.delete")}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="mcm-myfiles__card-body">
        <span className="mcm-myfiles__name" title={file.name}>
          {file.name}
        </span>
        <span className="mcm-myfiles__meta">
          <span>{humanSize(file.size)}</span>
          <span>{fmtDate(file.created_at)}</span>
        </span>
        <span
          className="mcm-projfiles__uploader"
          title={file.uploaded_by || undefined}
        >
          <UserIcon size={11} aria-hidden="true" />
          {shortUploader(file.uploaded_by)}
        </span>
      </div>
    </li>
  );
};

export const ProjectFiles = ({
  projectId,
  myEmail,
  isManager,
}: {
  /** The owning project — every route is scoped to it. */
  projectId: string;
  /** Current viewer's email (delete-affordance hint; the Worker enforces). */
  myEmail?: string;
  /** Viewer manages this project (can delete any member's upload). */
  isManager: boolean;
}) => {
  const t = useT();
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestedIdsRef = useRef<Set<string>>(new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const refresh = useCallback(async () => {
    const r = await listProjectFilesChecked(projectId);
    setLoadFailed(!r.ok);
    if (r.ok) {
      setFiles(r.items);
    } else {
      setFiles((prev) => prev ?? []);
    }
  }, [projectId]);

  // Re-load whenever the open project changes (and on mount).
  useEffect(() => {
    setFiles(null);
    void refresh();
  }, [refresh]);

  // Fetch one image's thumbnail exactly once (dedup by the requestedIds ref so
  // resolving a thumb never re-triggers the loop). Loads the SMALL server thumb,
  // never the original (backfill path bakes-and-stores once for legacy images).
  const fetchThumb = useCallback(
    (id: string, hasThumb: boolean) => {
      if (requestedIdsRef.current.has(id)) {
        return;
      }
      requestedIdsRef.current.add(id);
      const controller = new AbortController();
      abortControllersRef.current.set(id, controller);
      void fetchProjectFileThumb(projectId, id, hasThumb, controller.signal).then(
        (url) => {
          abortControllersRef.current.delete(id);
          if (!url) {
            return;
          }
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          setThumbs((m) => {
            if (m[id]) {
              URL.revokeObjectURL(url);
              return m;
            }
            return { ...m, [id]: url };
          });
        },
      );
    },
    [projectId],
  );

  // IntersectionObserver: fetch an image's thumb only when its cell scrolls into
  // view, then unobserve (one-shot). Recreated per project so a project switch
  // doesn't carry stale observed nodes.
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (
    observerRef.current === null &&
    typeof IntersectionObserver !== "undefined"
  ) {
    observerRef.current = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            const id = el.dataset.fileId;
            const hasThumb = el.dataset.hasThumb === "1";
            observer.unobserve(entry.target);
            if (id) {
              fetchThumb(id, hasThumb);
            }
          }
        }
      },
      { rootMargin: "200px" },
    );
  }

  const registerThumbCell = useCallback(
    (id: string, hasThumb: boolean) => (node: HTMLElement | null) => {
      if (!node) {
        return;
      }
      node.dataset.fileId = id;
      node.dataset.hasThumb = hasThumb ? "1" : "0";
      const observer = observerRef.current;
      if (observer) {
        observer.observe(node);
      } else {
        fetchThumb(id, hasThumb);
      }
    },
    [fetchThumb],
  );

  useEffect(() => {
    const observer = observerRef.current;
    return () => observer?.disconnect();
  }, []);

  // Prune thumbs whose file disappeared (deleted, or project switched) so we
  // don't leak object URLs; abort any in-flight fetch for a gone id.
  useEffect(() => {
    if (!files) {
      return;
    }
    const live = new Set(files.map((file) => file.id));
    for (const id of [...requestedIdsRef.current]) {
      if (!live.has(id)) {
        abortControllersRef.current.get(id)?.abort();
        abortControllersRef.current.delete(id);
        requestedIdsRef.current.delete(id);
      }
    }
    setThumbs((m) => {
      const stale = Object.keys(m).filter((id) => !live.has(id));
      if (stale.length === 0) {
        return m;
      }
      const next = { ...m };
      for (const id of stale) {
        URL.revokeObjectURL(next[id]);
        delete next[id];
      }
      return next;
    });
  }, [files]);

  // On unmount: abort every in-flight fetch and revoke every thumb object URL.
  useEffect(() => {
    const abortControllers = abortControllersRef.current;
    return () => {
      for (const controller of abortControllers.values()) {
        controller.abort();
      }
      abortControllers.clear();
      setThumbs((m) => {
        Object.values(m).forEach((url) => URL.revokeObjectURL(url));
        return {};
      });
    };
  }, []);

  const handleUpload = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      if (arr.length === 0 || uploading) {
        return;
      }
      setUploading(true);
      try {
        for (const file of arr) {
          const result = await uploadProjectFile(projectId, file);
          if (!result.ok) {
            window.alert(
              t(
                result.reason === "too-large"
                  ? "projFiles.tooLarge"
                  : "projFiles.uploadFailed",
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
    [uploading, projectId, refresh, t],
  );

  const handleDelete = useCallback(
    async (file: ProjectFile) => {
      if (
        deletingId ||
        !window.confirm(t("projFiles.deleteConfirm", { name: file.name }))
      ) {
        return;
      }
      setDeletingId(file.id);
      try {
        await deleteProjectFile(projectId, file.id);
      } finally {
        setDeletingId(null);
        await refresh();
      }
    },
    [deletingId, projectId, refresh, t],
  );

  const kindCounts: Record<ProjectFileKind, number> = {
    pdf: 0,
    dxf: 0,
    ifc: 0,
    image: 0,
    other: 0,
  };
  for (const file of files ?? []) {
    const kind = (file.kind ?? "other") as ProjectFileKind;
    if (kind in kindCounts) {
      kindCounts[kind] += 1;
    }
  }
  const activeFilter: KindFilter =
    kindFilter !== "all" && kindCounts[kindFilter] === 0 ? "all" : kindFilter;
  const chipKinds: KindFilter[] = [
    "all",
    ...KIND_ORDER.filter((kind) => kindCounts[kind] > 0),
  ];

  const sections = files
    ? KIND_ORDER.filter(
        (kind) => activeFilter === "all" || kind === activeFilter,
      )
        .map((kind) => ({
          kind,
          files: files
            .filter((file) => (file.kind ?? "other") === kind)
            .sort(SORT_CMP[sortKey]),
        }))
        .filter((section) => section.files.length > 0)
    : null;

  return (
    <div className="mcm-myfiles mcm-projfiles">
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
            ? t("projFiles.uploading")
            : dragOver
            ? t("projFiles.dropActive")
            : t("projFiles.dropHint")}
        </span>
        <span className="mcm-myfiles__drop-sub">{t("projFiles.subtitle")}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="mcm-myfiles__input"
        aria-label={t("projFiles.dropHint")}
        onChange={(e) => {
          if (e.target.files?.length) {
            void handleUpload(e.target.files);
            e.target.value = "";
          }
        }}
      />

      {sections === null || files === null ? (
        <div className="mcm-myfiles__hint">…</div>
      ) : files.length === 0 && loadFailed ? (
        <div className="mcm-myfiles__empty">
          <span className="mcm-myfiles__empty-title">
            {t("errors.loadFailed")}
          </span>
          <button
            type="button"
            className="mcm-myfiles__retry"
            onClick={() => void refresh()}
          >
            {t("errors.retry")}
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="mcm-myfiles__empty">
          <span className="mcm-myfiles__empty-title">
            {t("projFiles.emptyTitle")}
          </span>
          <span className="mcm-myfiles__empty-desc">
            {t("projFiles.emptyDesc")}
          </span>
        </div>
      ) : (
        <>
          <div className="mcm-myfiles__toolbar">
            <div className="mcm-chips" role="group" aria-label={t("view.label")}>
              {chipKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`mcm-chip${
                    activeFilter === kind ? " mcm-chip--active" : ""
                  }`}
                  onClick={() => setKindFilter(kind)}
                  aria-pressed={activeFilter === kind ? "true" : "false"}
                >
                  {kind === "all"
                    ? t("proj.filterAll")
                    : t(KIND_LABEL_KEY[kind])}
                  <span className="mcm-myfiles__chip-count">
                    {kind === "all" ? files.length : kindCounts[kind]}
                  </span>
                </button>
              ))}
            </div>
            <div className="mcm-toolbar mcm-myfiles__toolbar-end">
              <div
                className="mcm-segmented"
                role="group"
                aria-label={t("view.label")}
              >
                <button
                  type="button"
                  className={`mcm-segmented__btn${
                    viewMode === "grid" ? " mcm-segmented__btn--active" : ""
                  }`}
                  onClick={() => setViewMode("grid")}
                  title={t("view.grid")}
                  aria-label={t("view.grid")}
                  aria-pressed={viewMode === "grid" ? "true" : "false"}
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  type="button"
                  className={`mcm-segmented__btn${
                    viewMode === "list" ? " mcm-segmented__btn--active" : ""
                  }`}
                  onClick={() => setViewMode("list")}
                  title={t("view.list")}
                  aria-label={t("view.list")}
                  aria-pressed={viewMode === "list" ? "true" : "false"}
                >
                  <ListIcon size={14} />
                </button>
              </div>
              <label className="mcm-select" title={t("myfiles.sortLabel")}>
                <ArrowUpDown size={13} className="mcm-select__icon" />
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  aria-label={t("myfiles.sortLabel")}
                >
                  <option value="date">{t("myfiles.sortDate")}</option>
                  <option value="name">{t("myfiles.sortName")}</option>
                  <option value="size">{t("myfiles.sortSize")}</option>
                </select>
              </label>
            </div>
          </div>
          {sections.map(({ kind, files: sectionFiles }) => (
            <section key={kind} className="mcm-myfiles__section">
              <div className="mcm-myfiles__section-head">
                {t(KIND_LABEL_KEY[kind])}
                <span className="mcm-myfiles__section-count">
                  {sectionFiles.length}
                </span>
              </div>
              <ul
                className={`mcm-myfiles__list${
                  viewMode === "grid" ? " mcm-myfiles__list--grid" : ""
                }`}
              >
                {sectionFiles.map((file) =>
                  viewMode === "grid" ? (
                    <ProjectFileCard
                      key={file.id}
                      file={file}
                      thumbUrl={thumbs[file.id]}
                      thumbRef={
                        file.kind === "image"
                          ? registerThumbCell(file.id, file.has_thumb)
                          : undefined
                      }
                      deleting={deletingId === file.id}
                      showDelete={canDelete(file, myEmail, isManager)}
                      onDelete={(target) => void handleDelete(target)}
                    />
                  ) : (
                    <ProjectFileRow
                      key={file.id}
                      file={file}
                      thumbUrl={thumbs[file.id]}
                      thumbRef={
                        file.kind === "image"
                          ? registerThumbCell(file.id, file.has_thumb)
                          : undefined
                      }
                      deleting={deletingId === file.id}
                      showDelete={canDelete(file, myEmail, isManager)}
                      onDelete={(target) => void handleDelete(target)}
                    />
                  ),
                )}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
};

export default ProjectFiles;
