// "Tài liệu của tôi" — the personal document shelf panel on the dashboard
// (middle column of ProjectBrowser). INTERNAL users upload documents ONCE
// here, then copy them into any meeting from the in-meeting library's
// "Từ tủ của tôi" picker. Copies are snapshots: deleting a shelf file
// never touches a meeting that already ingested it.

import {
  ArrowUpDown,
  Box,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
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
  fetchMyFileThumb,
  listMyFilesChecked,
  updateMyFile,
  uploadMyFile,
  type UserFile,
  type UserFileKind,
} from "../../data/userFiles";
import { useT } from "../../i18n/mcm";

import type { LucideIcon } from "lucide-react";

// Kind → icon component — list rows render it small (17), grid cards big
// (26) as the thumbnail stand-in.
const KIND_ICON: Record<UserFileKind, LucideIcon> = {
  pdf: FileText,
  dxf: PencilRuler,
  ifc: Box,
  image: ImageIcon,
  other: FileIcon,
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
type ViewMode = "list" | "grid";
type KindFilter = UserFileKind | "all";

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
  thumbUrl,
  thumbRef,
  saving,
  deleting,
  onUpdate,
  onDelete,
}: {
  file: UserFile;
  /** Object URL for an image thumbnail, or null/undefined to use the icon. */
  thumbUrl?: string | null;
  /** Callback ref for the thumb cell — set only on image rows so the
   *  IntersectionObserver fetches the thumb when it scrolls into view. */
  thumbRef?: (node: HTMLElement | null) => void;
  saving: boolean;
  deleting: boolean;
  onUpdate: (file: UserFile, patch: Parameters<typeof updateMyFile>[1]) => void;
  onDelete: (file: UserFile) => void;
}) => {
  const t = useT();
  const [tagDraft, setTagDraft] = useState("");
  // A thumb that 404s/decodes-bad falls back to the kind icon (no broken img).
  const [thumbBroken, setThumbBroken] = useState(false);
  const tags = parseTags(file.tags);
  const isPrivate = file.visibility === "private";
  const Icon = KIND_ICON[file.kind] ?? KIND_ICON.other;
  const showThumb = !!thumbUrl && !thumbBroken;

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

/** GRID-mode card — thumbnail-first: a big kind icon on a kind-tinted well,
 *  name + size + date below, kind badge top-left and the visibility toggle
 *  top-right of the thumb, hover-reveal delete bottom-right. Tag editing
 *  stays in LIST mode — the grid is for scanning, not metadata work. */
const MyFileCard = ({
  file,
  thumbUrl,
  thumbRef,
  saving,
  deleting,
  onUpdate,
  onDelete,
}: {
  file: UserFile;
  /** Object URL for an image thumbnail, or null/undefined to use the icon. */
  thumbUrl?: string | null;
  /** Callback ref for the thumb cell — set only on image cards so the
   *  IntersectionObserver fetches the thumb when it scrolls into view. */
  thumbRef?: (node: HTMLElement | null) => void;
  saving: boolean;
  deleting: boolean;
  onUpdate: (file: UserFile, patch: Parameters<typeof updateMyFile>[1]) => void;
  onDelete: (file: UserFile) => void;
}) => {
  const t = useT();
  // A thumb that 404s/decodes-bad falls back to the kind icon (no broken img).
  const [thumbBroken, setThumbBroken] = useState(false);
  const isPrivate = file.visibility === "private";
  const Icon = KIND_ICON[file.kind] ?? KIND_ICON.other;
  const visLabel = t(isPrivate ? "myfiles.visPrivate" : "myfiles.visSharable");
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
        <button
          type="button"
          className={`mcm-myfiles__card-vis mcm-myfiles__card-vis--${file.visibility}`}
          onClick={() =>
            onUpdate(file, { visibility: isPrivate ? "sharable" : "private" })
          }
          disabled={saving}
          title={visLabel}
          aria-label={visLabel}
        >
          {isPrivate ? (
            <Lock size={11} aria-hidden="true" />
          ) : (
            <Users size={11} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="mcm-myfiles__delete mcm-myfiles__card-delete"
          onClick={() => onDelete(file)}
          disabled={deleting}
          title={t("myfiles.delete")}
          aria-label={t("myfiles.delete")}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="mcm-myfiles__card-body">
        <span className="mcm-myfiles__name" title={file.name}>
          {file.name}
        </span>
        <span className="mcm-myfiles__meta">
          <span>{humanSize(file.size)}</span>
          <span>{fmtDate(file.created_at)}</span>
        </span>
      </div>
    </li>
  );
};

export const MyFilesPanel = () => {
  const t = useT();
  // null = first load in flight — render a quiet placeholder, not the
  // empty state (which would flash for users who DO have files).
  const [files, setFiles] = useState<UserFile[] | null>(null);
  // Last list fetch failed (offline / worker error) — show "couldn't
  // load + retry" instead of the lying "no files yet" empty state.
  const [loadFailed, setLoadFailed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  // Lazy image thumbnails, keyed by file.id. The content route is JWT-gated,
  // so we fetch bytes via fetchWithAuth and hold an object URL per image —
  // revoked on prune (file deleted) and on unmount to avoid leaking blobs.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ids we've already started (or finished) fetching — a *ref*, not state, so
  // resolving one thumb can't re-run the fetch loop and re-issue fetches for
  // every other image (the old O(N^2) re-fetch storm). Each image is fetched
  // at most once for the life of the panel.
  const requestedIdsRef = useRef<Set<string>>(new Set());
  // In-flight AbortControllers keyed by file.id, so we can cancel the network
  // request (not just discard the result) on unmount or when a file leaves the
  // list before its bytes arrive.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const refresh = useCallback(async () => {
    const r = await listMyFilesChecked();
    setLoadFailed(!r.ok);
    if (r.ok) {
      setFiles(r.items);
    } else {
      // Keep whatever we already showed (stale beats blank); only the
      // never-loaded case falls through to the error block below.
      setFiles((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch one image's thumbnail exactly once. Dedup is by the requestedIds
  // *ref* (not `thumbs` state) so resolving a thumb never re-triggers the loop
  // and re-fetches the rest. Only images get here (the IntersectionObserver
  // only observes image cells), and only when the cell scrolls into view, so
  // we never pull originals the user can't see. The in-flight request is
  // abortable via a per-id AbortController.
  //
  // Bandwidth-optimal: we load the SMALL server-stored thumb (…/thumb,
  // tens of KB), never the full-resolution original. `hasThumb` (from the
  // list's has_thumb flag) picks the path: present ⇒ cheap thumb route;
  // absent ⇒ fetchMyFileThumb backfills once (pull original → bake → store →
  // render the baked thumb) so the next panel load takes the cheap path.
  // Visible-only + fetch-once still bounds the (now one-time) backfill cost to
  // what the user actually looks at.
  const fetchThumb = useCallback((id: string, hasThumb: boolean) => {
    if (requestedIdsRef.current.has(id)) {
      return;
    }
    requestedIdsRef.current.add(id);
    const controller = new AbortController();
    abortControllersRef.current.set(id, controller);
    void fetchMyFileThumb(id, hasThumb, controller.signal).then((url) => {
      abortControllersRef.current.delete(id);
      if (!url) {
        return;
      }
      if (controller.signal.aborted) {
        // Raced an abort (unmount / left the list) — don't store, don't leak.
        URL.revokeObjectURL(url);
        return;
      }
      setThumbs((m) => {
        // Belt-and-braces: never overwrite (and leak) an existing URL.
        if (m[id]) {
          URL.revokeObjectURL(url);
          return m;
        }
        return { ...m, [id]: url };
      });
    });
  }, []);

  // IntersectionObserver: fetch an image's thumb only when its cell scrolls
  // into view, then unobserve it (one-shot). Image cells register their DOM
  // node via the `registerThumbCell` callback ref below. rootMargin pre-loads
  // a little before the cell is fully on-screen for a smoother reveal.
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (observerRef.current === null && typeof IntersectionObserver !== "undefined") {
    observerRef.current = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            const id = el.dataset.fileId;
            // hasThumb is threaded through the DOM dataset (same pattern as
            // fileId) so the observer keeps its id-only contract.
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

  // Callback ref handed to each IMAGE cell. On mount: stamp the id and observe
  // (or, if observers are unsupported, fetch eagerly so thumbs still appear).
  // On unmount (node === null): React calls this with the previous node, but
  // we can't read it then — unobserve happens implicitly when the node leaves
  // the DOM, and an already-fetched cell is unobserved on intersect anyway.
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

  // Tear down the observer on unmount.
  useEffect(() => {
    const observer = observerRef.current;
    return () => observer?.disconnect();
  }, []);

  // Prune thumbs whose file disappeared (deleted upstream) so we don't leak
  // the object URL after refresh() rebuilds the list without that id. Also
  // abort any in-flight fetch for the gone id and drop it from the requested
  // set so a re-added file can be fetched again later.
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
  // The abort runs first so a request that resolves mid-teardown sees
  // signal.aborted and revokes its own URL instead of leaking it.
  useEffect(
    () => {
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
    },
    [],
  );

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

  // Per-kind counts feed the filter chips (kinds with no files get no chip).
  const kindCounts: Record<UserFileKind, number> = {
    pdf: 0,
    dxf: 0,
    ifc: 0,
    image: 0,
    other: 0,
  };
  for (const file of files ?? []) {
    const kind = (file.kind ?? "other") as UserFileKind;
    // Unknown kinds never render a section (the grouping below matches by
    // equality), so they must not count toward a chip either.
    if (kind in kindCounts) {
      kindCounts[kind] += 1;
    }
  }
  // Deleting the last file of the filtered kind would strand an empty view
  // (its chip disappears with it) — quietly fall back to "all".
  const activeFilter: KindFilter =
    kindFilter !== "all" && kindCounts[kindFilter] === 0 ? "all" : kindFilter;
  const chipKinds: KindFilter[] = [
    "all",
    ...KIND_ORDER.filter((kind) => kindCounts[kind] > 0),
  ];

  // Filter by the active chip, group by kind (fixed section order, empty
  // sections hidden), then sort within each section by the user's pick.
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
            {t("myfiles.emptyTitle")}
          </span>
          <span className="mcm-myfiles__empty-desc">
            {t("myfiles.emptyDesc")}
          </span>
        </div>
      ) : (
        <>
          {/* One toolbar row: [kind filter chips] … [view toggle + sort].
              Chip counts double as the shelf inventory, so no extra
              "N tệp" label. */}
          <div className="mcm-myfiles__toolbar">
            <div className="mcm-chips" role="group" aria-label="Lọc theo loại">
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
                    <MyFileCard
                      key={file.id}
                      file={file}
                      thumbUrl={thumbs[file.id]}
                      thumbRef={
                        file.kind === "image"
                          ? registerThumbCell(file.id, file.has_thumb)
                          : undefined
                      }
                      saving={savingId === file.id}
                      deleting={deletingId === file.id}
                      onUpdate={(target, patch) =>
                        void handleUpdate(target, patch)
                      }
                      onDelete={(target) => void handleDelete(target)}
                    />
                  ) : (
                    <MyFileRow
                      key={file.id}
                      file={file}
                      thumbUrl={thumbs[file.id]}
                      thumbRef={
                        file.kind === "image"
                          ? registerThumbCell(file.id, file.has_thumb)
                          : undefined
                      }
                      saving={savingId === file.id}
                      deleting={deletingId === file.id}
                      onUpdate={(target, patch) =>
                        void handleUpdate(target, patch)
                      }
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

export default MyFilesPanel;
