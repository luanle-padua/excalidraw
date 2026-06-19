import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { compressData } from "@excalidraw/excalidraw/data/encode";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";

import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
  InitializedExcalidrawImageElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  ExcalidrawImperativeAPI,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

type FileVersion = Required<BinaryFileData>["version"];

/**
 * Max number of times a single (fileId@version) is allowed to be PUT again
 * after a save error before we give up and leave it errored.
 *
 * WHY retry at all: in MCM a guest who hasn't been admitted yet gets a 403
 * from the R2 file PUT, so their image/sticker bytes never reach storage and
 * peers render an empty box forever. The fix is to let a previously-errored
 * file be re-uploaded on a later save pass (e.g. the next scene broadcast
 * AFTER the guest is admitted), at which point the PUT succeeds and the
 * element flips to "saved" so peers can fetch it.
 *
 * WHY a cap (and not unconditional retry): `queueFileUpload` runs on every
 * scene broadcast, so an unconditional retry would re-encode + re-PUT a
 * genuinely-broken file (too big, corrupt, permanently forbidden) on every
 * single edit for the whole meeting — wasted bandwidth and console noise.
 * A small cap gives admit-races plenty of room (admit happens within seconds
 * → a handful of broadcasts) while bounding the damage from real failures.
 */
const MAX_SAVE_RETRIES = 10;

export class FileManager {
  /** files being fetched */
  private fetchingFiles = new Map<ExcalidrawImageElement["fileId"], true>();
  private erroredFiles_fetch = new Map<
    ExcalidrawImageElement["fileId"],
    true
  >();
  /** files being saved */
  private savingFiles = new Map<
    ExcalidrawImageElement["fileId"],
    FileVersion
  >();
  /* files already saved to persistent storage */
  private savedFiles = new Map<ExcalidrawImageElement["fileId"], FileVersion>();
  private erroredFiles_save = new Map<
    ExcalidrawImageElement["fileId"],
    FileVersion
  >();
  /**
   * How many times each (fileId@version) has been re-attempted after a save
   * error. Keyed by `${fileId}@${version}` so a NEW version of the same file
   * (e.g. user re-edits the image) starts its retry budget fresh.
   */
  private saveRetryCounts = new Map<string, number>();

  private _getFiles;
  private _saveFiles;
  private _onFileStatusChange;

  constructor({
    getFiles,
    saveFiles,
    onFileStatusChange,
  }: {
    getFiles: (fileIds: FileId[]) => Promise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>;
    saveFiles: (data: { addedFiles: Map<FileId, BinaryFileData> }) => Promise<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }>;
    onFileStatusChange?: (
      updates: Array<[FileId, "loading" | "loaded" | "error"]>,
    ) => void;
  }) {
    this._getFiles = getFiles;
    this._saveFiles = saveFiles;
    this._onFileStatusChange = onFileStatusChange;
  }

  /**
   * returns whether file is saved/errored, or being processed
   */
  isFileTracked = (id: FileId) => {
    return (
      this.savedFiles.has(id) ||
      this.savingFiles.has(id) ||
      this.fetchingFiles.has(id) ||
      this.erroredFiles_fetch.has(id) ||
      this.erroredFiles_save.has(id)
    );
  };

  isFileSavedOrBeingSaved = (file: BinaryFileData) => {
    const fileVersion = this.getFileVersion(file);
    return (
      this.savedFiles.get(file.id) === fileVersion ||
      this.savingFiles.get(file.id) === fileVersion
    );
  };

  getFileVersion = (file: BinaryFileData) => {
    return file.version ?? 1;
  };

  /** Stable key per (fileId, version) for retry bookkeeping. */
  private getSaveRetryKey = (file: BinaryFileData) =>
    `${file.id}@${this.getFileVersion(file)}`;

  /**
   * True once a (fileId@version) has errored MAX_SAVE_RETRIES times and we
   * should stop re-attempting it. Until then an errored file is eligible to
   * be picked up again by the next `saveFiles` pass (the admit-race retry).
   */
  private hasExhaustedSaveRetries = (file: BinaryFileData) =>
    (this.saveRetryCounts.get(this.getSaveRetryKey(file)) ?? 0) >=
    MAX_SAVE_RETRIES;

  saveFiles = async ({
    elements,
    files,
  }: {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
  }) => {
    const addedFiles: Map<FileId, BinaryFileData> = new Map();

    for (const element of elements) {
      const fileData =
        isInitializedImageElement(element) && files[element.fileId];

      if (
        fileData &&
        // Skip files that are already saved or currently uploading.
        !this.isFileSavedOrBeingSaved(fileData) &&
        // RETRY: a previously-errored file is eligible again UNLESS it has
        // burned through its retry budget. This is what unsticks a guest's
        // image/sticker once they get admitted — the earlier 403-errored
        // upload is re-attempted on a later save pass and now succeeds.
        // `erroredFiles_save` is intentionally NOT consulted as a hard block
        // anymore; the cap below is the only thing that stops retries.
        !this.hasExhaustedSaveRetries(fileData)
      ) {
        addedFiles.set(element.fileId, files[element.fileId]);
        this.savingFiles.set(element.fileId, this.getFileVersion(fileData));
        // A fresh attempt is starting; clear any stale "errored" marker so
        // the file isn't reported as permanently failed while we retry.
        this.erroredFiles_save.delete(element.fileId);
      }
    }

    try {
      const { savedFiles, erroredFiles } = await this._saveFiles({
        addedFiles,
      });

      for (const [fileId, fileData] of savedFiles) {
        this.savedFiles.set(fileId, this.getFileVersion(fileData));
        // Success — drop retry bookkeeping so the map can't grow unbounded.
        this.saveRetryCounts.delete(this.getSaveRetryKey(fileData));
      }

      for (const [fileId, fileData] of erroredFiles) {
        const retryKey = this.getSaveRetryKey(fileData);
        const attempts = (this.saveRetryCounts.get(retryKey) ?? 0) + 1;
        this.saveRetryCounts.set(retryKey, attempts);
        // Only flip to the permanent "errored" state (which surfaces the
        // image as broken to the user/peers) once retries are exhausted.
        // While under the cap we leave it untracked so the next save pass
        // re-attempts it — the admit-race recovery path.
        if (attempts >= MAX_SAVE_RETRIES) {
          this.erroredFiles_save.set(fileId, this.getFileVersion(fileData));
        }
      }

      return {
        savedFiles,
        erroredFiles,
      };
    } finally {
      for (const [fileId] of addedFiles) {
        this.savingFiles.delete(fileId);
      }
    }
  };

  getFiles = async (
    ids: FileId[],
  ): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }> => {
    if (!ids.length) {
      return {
        loadedFiles: [],
        erroredFiles: new Map(),
      };
    }
    for (const id of ids) {
      this.fetchingFiles.set(id, true);
    }

    this._onFileStatusChange?.(ids.map((id) => [id, "loading"]));

    try {
      const { loadedFiles, erroredFiles } = await this._getFiles(ids);

      for (const file of loadedFiles) {
        this.savedFiles.set(file.id, this.getFileVersion(file));
      }
      for (const [fileId] of erroredFiles) {
        this.erroredFiles_fetch.set(fileId, true);
      }

      this._onFileStatusChange?.([
        ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
        ...[...erroredFiles.keys()].map(
          (id) => [id, "error"] as [FileId, "error"],
        ),
      ]);

      return { loadedFiles, erroredFiles };
    } finally {
      for (const id of ids) {
        this.fetchingFiles.delete(id);
      }
    }
  };

  /** a file element prevents unload only if it's being saved regardless of
   *  its `status`. This ensures that elements who for any reason haven't
   *  beed set to `saved` status don't prevent unload in future sessions.
   *  Technically we should prevent unload when the origin client haven't
   *  yet saved the `status` update to storage, but that should be taken care
   *  of during regular beforeUnload unsaved files check.
   */
  shouldPreventUnload = (elements: readonly ExcalidrawElement[]) => {
    return elements.some((element) => {
      return (
        isInitializedImageElement(element) &&
        !element.isDeleted &&
        this.savingFiles.has(element.fileId)
      );
    });
  };

  /**
   * helper to determine if image element status needs updating
   */
  shouldUpdateImageElementStatus = (
    element: ExcalidrawElement,
  ): element is InitializedExcalidrawImageElement => {
    return (
      isInitializedImageElement(element) &&
      this.savedFiles.has(element.fileId) &&
      element.status === "pending"
    );
  };

  reset() {
    if (this._onFileStatusChange && this.fetchingFiles.size) {
      this._onFileStatusChange(
        [...this.fetchingFiles.keys()].map(
          (id) => [id, "error"] as [FileId, "error"],
        ),
      );
    }
    this.fetchingFiles.clear();
    this.savingFiles.clear();
    this.savedFiles.clear();
    this.erroredFiles_fetch.clear();
    this.erroredFiles_save.clear();
    this.saveRetryCounts.clear();
  }
}

export const encodeFilesForUpload = async ({
  files,
  maxBytes,
  encryptionKey,
}: {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
  encryptionKey: string;
}) => {
  const processedFiles: {
    id: FileId;
    buffer: Uint8Array;
  }[] = [];

  for (const [id, fileData] of files) {
    const buffer = new TextEncoder().encode(fileData.dataURL);

    const encodedFile = await compressData<BinaryFileMetadata>(buffer, {
      encryptionKey,
      metadata: {
        id,
        mimeType: fileData.mimeType,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    });

    if (buffer.byteLength > maxBytes) {
      throw new Error(
        t("errors.fileTooBig", {
          maxSize: `${Math.trunc(maxBytes / 1024 / 1024)}MB`,
        }),
      );
    }

    processedFiles.push({
      id,
      buffer: encodedFile,
    });
  }

  return processedFiles;
};

export const updateStaleImageStatuses = (params: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  erroredFiles: Map<FileId, true>;
  elements: readonly ExcalidrawElement[];
}) => {
  if (!params.erroredFiles.size) {
    return;
  }
  params.excalidrawAPI.updateScene({
    elements: params.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (
          isInitializedImageElement(element) &&
          params.erroredFiles.has(element.fileId)
        ) {
          return newElementWith(element, {
            status: "error",
          });
        }
        return element;
      }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};
