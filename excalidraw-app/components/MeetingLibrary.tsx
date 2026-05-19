import { useCallback, useEffect, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  newElement,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { DXF_ANCHOR_KIND } from "./mcm/dxf/DXFCanvasOverlay";

import { useAtomValue } from "../app-jotai";
import { collabAPIAtom } from "../collab/Collab";
import {
  canDeleteFile,
  canUnlockFile,
  hydrateMeetingFiles,
  isDxfFile,
  isFileSeen,
  markFileSeen,
  meetingFilesAtom,
  probeImageDimensions,
} from "../data/meetingLibrary";

import "./MeetingLibrary.scss";

import type { MeetingFile } from "../data/meetingLibrary";

const newFileId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MAX_INSERT_DIMENSION = 480; // px (logical) — keeps images sane in viewport

// Custom MIME used when the user drags a library item onto the canvas.
// The browser would otherwise treat the dragged <img> as a generic image
// drop, and Excalidraw would re-ingest it with a fresh hash-based fileId,
// triggering the auto-detect onChange → publishLibraryFile loop that
// added a duplicate library entry (the original bug). We instead carry
// just the library file id; our capture-phase drop listener intercepts,
// reuses the existing fileId, and inserts at the drop coordinates.
const MCM_LIBRARY_DRAG_MIME = "application/x-mcm-library-file-id";

const readAsDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const extractRoomId = (link: string | null | undefined): string | null => {
  if (!link) {
    return null;
  }
  const m = link.match(/#room=([a-zA-Z0-9_-]+),/);
  return m ? m[1] : null;
};

export const MeetingLibrary = () => {
  const items = useAtomValue(meetingFilesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const excalidrawAPI = useExcalidrawAPI();

  const roomId = extractRoomId(collabAPI?.getActiveRoomLink() ?? null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // hydrate per-room library on mount / room switch
  useEffect(() => {
    void hydrateMeetingFiles(roomId);
  }, [roomId]);

  // observe canvas: when a file the user pasted/dropped onto canvas is
  // available, publish it through the collab API so peers also receive it
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const username = collabAPI?.getUsername() || "Local";
    const handle = (
      _elements: any,
      _appState: any,
      files: Record<string, BinaryFileData>,
    ) => {
      for (const [fileId, file] of Object.entries(files || {})) {
        if (isFileSeen(fileId)) {
          continue;
        }
        markFileSeen(fileId);
        const next: MeetingFile = {
          id: fileId,
          name: `canvas-${fileId.slice(0, 8)}`,
          ts: Date.now(),
          author: username,
          mimeType: file.mimeType,
          dataURL: file.dataURL as unknown as string,
        };
        const finalize = (extra: { width?: number; height?: number } = {}) => {
          const enriched = { ...next, ...extra };
          // collabAPI handles upsert + (when in a room) broadcast to peers
          if (collabAPI) {
            collabAPI.publishLibraryFile(enriched);
          }
        };
        if (file.mimeType?.startsWith("image/")) {
          probeImageDimensions(file.dataURL as unknown as string).then((d) =>
            finalize(d ?? {}),
          );
        } else {
          finalize();
        }
      }
    };
    const unsub = excalidrawAPI.onChange(handle);
    return unsub;
  }, [excalidrawAPI, collabAPI, roomId]);

  const ingestFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!excalidrawAPI || !collabAPI) {
        return;
      }
      const username = collabAPI.getUsername() || "Local";
      const list = Array.from(fileList);
      for (const file of list) {
        const isImage = file.type.startsWith("image/");
        const isDxf = isDxfFile(file);
        if (!isImage && !isDxf) {
          window.alert(
            `Tạm thời chỉ hỗ trợ ảnh và DXF. Bỏ qua: ${file.name}`,
          );
          continue;
        }
        try {
          const dataURL = await readAsDataURL(file);
          const id = newFileId();
          if (isDxf) {
            // DXF metadata (layers, bounds, thumbnail) is parsed
            // lazily when the file first renders — keep upload fast.
            // The browser sometimes hands DXF as octet-stream; we
            // pin it to a stable mimeType so peers detect it the
            // same way locally.
            collabAPI.publishLibraryFile({
              id,
              name: file.name,
              ts: Date.now(),
              author: username,
              mimeType: "image/vnd.dxf",
              dataURL,
            });
          } else {
            const dims = await probeImageDimensions(dataURL);
            collabAPI.publishLibraryFile({
              id,
              name: file.name,
              ts: Date.now(),
              author: username,
              mimeType: file.type,
              dataURL,
              width: dims?.width,
              height: dims?.height,
            });
          }
        } catch (error: any) {
          console.error("[meetingLibrary] failed to ingest file", error);
        }
      }
    },
    [excalidrawAPI, collabAPI],
  );

  const handlePickFiles = () => fileInputRef.current?.click();

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void ingestFiles(e.target.files);
      // reset input so picking the same file again still triggers change
      e.target.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void ingestFiles(e.dataTransfer.files);
    }
  };

  // Insert a DXF anchor at the given scene-space CENTER. We use a
  // plain rectangle element (transparent stroke + fill) with a
  // marker on customData — the <DXFCanvasOverlay /> picks these up
  // and paints the actual DXF on top. Default size matches a
  // landscape A4 ratio (480×320) which fits most floor plans; the
  // user resizes via Excalidraw's normal selection handles after.
  const DXF_DEFAULT_W = 480;
  const DXF_DEFAULT_H = 320;
  const insertDxfAt = useCallback(
    (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      // Use INCLUDING DELETED so we preserve the full fractional-index
      // sequence Excalidraw maintains for tombstoned elements. Passing
      // only the live subset to updateScene confused the later index
      // re-order pass (e.g. when the user moves the new element between
      // frames) and crashed with InvalidFractionalIndexError, freezing
      // every imported element. See packages/element/src/Scene.ts.
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const anchor = newElement({
        type: "rectangle",
        x: at.sceneX - DXF_DEFAULT_W / 2,
        y: at.sceneY - DXF_DEFAULT_H / 2,
        width: DXF_DEFAULT_W,
        height: DXF_DEFAULT_H,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        roundness: null,
        customData: {
          mcmType: DXF_ANCHOR_KIND,
          dxfFileId: file.id,
        },
      });
      // syncInvalidIndices fills in valid fractional indices for newly
      // added elements (newElement returns one with index=null). Without
      // this, Excalidraw's later index-reorder pass (triggered when the
      // user moves the element between frames) sees `null` and throws
      // InvalidFractionalIndexError, freezing the whole scene.
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, anchor]),
      });
    },
    [excalidrawAPI],
  );

  // Shared insert helper. `at` is the scene-space CENTER of the new
  // image; callers pick whether that's the viewport centre (click) or
  // the drop position (drag-from-library). Reusing this guarantees
  // both paths funnel through the SAME fileId — so the auto-detect
  // onChange handler always finds the file already-seen and never
  // creates a duplicate library entry.
  // Same INCLUDING-DELETED rationale as insertDxfAt — see the comment
  // there. Without it, freshly-inserted images crash the scene the
  // moment the user drags them across a frame boundary.
  const insertImageAt = useCallback(
    (file: MeetingFile, at: { sceneX: number; sceneY: number }) => {
      if (!excalidrawAPI) {
        return;
      }
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      // make sure the file is in the canvas's file map (re-add — addFiles
      // is idempotent for identical ids)
      excalidrawAPI.addFiles([
        {
          id: file.id as FileId,
          dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
          mimeType: file.mimeType as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);

      let w = file.width ?? 320;
      let h = file.height ?? 320;
      if (w > MAX_INSERT_DIMENSION || h > MAX_INSERT_DIMENSION) {
        const scale = MAX_INSERT_DIMENSION / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      const img = newImageElement({
        type: "image",
        x: at.sceneX - w / 2,
        y: at.sceneY - h / 2,
        width: w,
        height: h,
        fileId: file.id as FileId,
        status: "saved",
      });

      // syncInvalidIndices assigns a valid fractional index to the
      // freshly-minted image — see the explanation in insertDxfAt.
      excalidrawAPI.updateScene({
        elements: syncInvalidIndices([...elements, img]),
      });
    },
    [excalidrawAPI],
  );

  const handleInsert = (file: MeetingFile) => {
    if (!excalidrawAPI) {
      return;
    }
    const elements = excalidrawAPI.getSceneElements();
    const isDxf = isDxfFile(file);

    // If this file already lives on the canvas, scroll to it instead
    // of dropping a duplicate. For DXF we look for the matching anchor
    // rectangle (via customData.dxfFileId); for images we look for the
    // matching image element fileId.
    const existing = elements.find((el) => {
      if (isDxf) {
        const data = el.customData as Record<string, unknown> | undefined;
        return (
          el.type === "rectangle" &&
          data?.mcmType === DXF_ANCHOR_KIND &&
          data?.dxfFileId === file.id
        );
      }
      return el.type === "image" && (el as any).fileId === file.id;
    });
    if (existing) {
      excalidrawAPI.scrollToContent(existing, {
        animate: true,
        fitToContent: true,
      });
      return;
    }

    // Click-to-insert lands at the viewport centre.
    const appState = excalidrawAPI.getAppState();
    const at = {
      sceneX: -appState.scrollX + appState.width / 2 / appState.zoom.value,
      sceneY: -appState.scrollY + appState.height / 2 / appState.zoom.value,
    };
    if (isDxf) {
      insertDxfAt(file, at);
    } else {
      insertImageAt(file, at);
    }
  };

  // Drag-start on a library item: serialise just the file id. The
  // browser-default img drag is suppressed via `draggable={false}` on
  // the thumbnail so it can't compete.
  const handleItemDragStart = (
    file: MeetingFile,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    if (!e.dataTransfer) {
      return;
    }
    e.dataTransfer.setData(MCM_LIBRARY_DRAG_MIME, file.id);
    e.dataTransfer.setData("text/plain", file.name);
    e.dataTransfer.effectAllowed = "copy";
  };

  // Drop interceptor on the Excalidraw container. Registered in the
  // CAPTURE phase so it runs BEFORE Excalidraw's React onDrop handler;
  // when our custom MIME is present we stopPropagation + preventDefault
  // so Excalidraw never sees the event and never auto-ingests a new
  // file. Without our MIME we no-op and let Excalidraw handle normally
  // (paste/drop from outside the app still works as before).
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const container = document.querySelector(
      ".excalidraw-container",
    ) as HTMLElement | null;
    if (!container) {
      return undefined;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(MCM_LIBRARY_DRAG_MIME)) {
        // Tell the browser we accept this drop (otherwise the drop
        // event never fires on some platforms).
        e.preventDefault();
      }
    };

    const onDrop = (e: DragEvent) => {
      const id = e.dataTransfer?.getData(MCM_LIBRARY_DRAG_MIME);
      if (!id) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const file = items.find((f) => f.id === id);
      if (!file) {
        return;
      }
      const isDxf = isDxfFile(file);
      // Jump to existing canvas instance instead of duplicating.
      const elements = excalidrawAPI.getSceneElements();
      const existing = elements.find((el) => {
        if (isDxf) {
          const data = el.customData as Record<string, unknown> | undefined;
          return (
            el.type === "rectangle" &&
            data?.mcmType === DXF_ANCHOR_KIND &&
            data?.dxfFileId === file.id
          );
        }
        return el.type === "image" && (el as any).fileId === file.id;
      });
      if (existing) {
        excalidrawAPI.scrollToContent(existing, {
          animate: true,
          fitToContent: true,
        });
        return;
      }
      const rect = container.getBoundingClientRect();
      const appState = excalidrawAPI.getAppState();
      const at = {
        sceneX:
          -appState.scrollX + (e.clientX - rect.left) / appState.zoom.value,
        sceneY:
          -appState.scrollY + (e.clientY - rect.top) / appState.zoom.value,
      };
      if (isDxf) {
        insertDxfAt(file, at);
      } else {
        insertImageAt(file, at);
      }
    };

    container.addEventListener("dragover", onDragOver, true);
    container.addEventListener("drop", onDrop, true);
    return () => {
      container.removeEventListener("dragover", onDragOver, true);
      container.removeEventListener("drop", onDrop, true);
    };
  }, [excalidrawAPI, items, insertImageAt, insertDxfAt]);

  const me = collabAPI?.getUsername() || "Local";

  const handleDelete = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDeleteFile(file, me)) {
      window.alert(
        `File này đang bị khoá bởi ${file.lockedBy}. Yêu cầu họ mở khoá trước.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Xoá "${file.name}" khỏi thư viện phòng?\n\nMọi ảnh dùng file này trên canvas cũng bị xoá (cho cả người khác).`,
      )
    ) {
      return;
    }
    // collabAPI: removes canvas elements + library entry + broadcasts
    collabAPI?.publishLibraryFileDelete(file.id);
  };

  const handleToggleLock = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (file.lockedBy) {
      // unlock
      if (!canUnlockFile(file, me)) {
        window.alert(
          `Chỉ ${file.lockedBy} (người khoá) hoặc ${file.author} (người tải lên) có thể mở khoá.`,
        );
        return;
      }
      collabAPI?.publishLibraryFileLock(file.id, null);
    } else {
      collabAPI?.publishLibraryFileLock(file.id, me);
    }
  };

  const handleLinkText = (file: MeetingFile, e: React.MouseEvent) => {
    e.stopPropagation();
    collabAPI?.linkTextToFile(file);
  };

  return (
    <div
      className="MeetingLibrary"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="MeetingLibrary__toolbar">
        <button
          type="button"
          className={`MeetingLibrary__upload ${
            dragOver ? "MeetingLibrary__upload--dragover" : ""
          }`}
          onClick={handlePickFiles}
          disabled={!excalidrawAPI}
        >
          {dragOver
            ? "Thả file để tải lên"
            : "+ Tải ảnh / DXF lên · hoặc kéo thả"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.dxf,application/dxf,image/vnd.dxf"
          multiple
          aria-label="Chọn ảnh hoặc file DXF để tải lên thư viện phòng"
          className="MeetingLibrary__file-input"
          onChange={handleFileInputChange}
        />
        <div className="MeetingLibrary__hint-line">
          Hỗ trợ ảnh + DXF. Ảnh paste/kéo vào canvas tự xuất hiện ở đây.
        </div>
      </div>
      <div className="MeetingLibrary__grid">
        {items.length === 0 ? (
          <div className="MeetingLibrary__empty">
            Chưa có file nào trong phòng này.
            <br />
            Kéo ảnh vào đây hoặc paste/kéo lên canvas để bắt đầu.
          </div>
        ) : (
          items.map((file) => {
            const isImage = file.mimeType.startsWith("image/dxf")
              ? false
              : file.mimeType.startsWith("image/");
            const isDxf = isDxfFile(file);
            return (
              <div
                key={file.id}
                className={`MeetingLibrary__item${
                  isDxf ? " MeetingLibrary__item--dxf" : ""
                }`}
                onClick={() => handleInsert(file)}
                draggable
                onDragStart={(e) => handleItemDragStart(file, e)}
                title={`${file.name} — bấm hoặc kéo vào canvas`}
              >
                <div className="MeetingLibrary__item-thumb">
                  {isDxf && file.dxfMeta?.thumbnail ? (
                    <img
                      src={file.dxfMeta.thumbnail}
                      alt={file.name}
                      loading="lazy"
                      draggable={false}
                    />
                  ) : isDxf ? (
                    // DXF without a baked thumbnail yet — show a
                    // recognisable CAD glyph instead of the generic
                    // mime-type fallback so users can tell at a glance
                    // which library items are drawings.
                    <span
                      className="MeetingLibrary__item-fallback MeetingLibrary__item-fallback--dxf"
                      aria-hidden="true"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="32"
                        height="32"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 4h12l4 4v12H4z" />
                        <path d="M16 4v4h4" />
                        <path d="M7 12h10M7 15h6M7 18h8" />
                      </svg>
                      <span className="MeetingLibrary__item-fallback-label">
                        DXF
                      </span>
                    </span>
                  ) : isImage ? (
                    <img
                      src={file.dataURL}
                      alt={file.name}
                      loading="lazy"
                      // Suppress the browser-default img drag so it can't
                      // race our custom item-level drag (which carries the
                      // library file id via custom MIME).
                      draggable={false}
                    />
                  ) : (
                    <span className="MeetingLibrary__item-fallback">
                      {file.mimeType.split("/")[1] || "file"}
                    </span>
                  )}
                </div>
                <div className="MeetingLibrary__item-meta">
                  <div className="MeetingLibrary__item-name">{file.name}</div>
                  <div className="MeetingLibrary__item-author">
                    {file.author}
                    {file.lockedBy ? ` · 🔒 ${file.lockedBy}` : ""}
                  </div>
                </div>
                <div
                  className={`MeetingLibrary__item-actions ${
                    file.lockedBy ? "MeetingLibrary__item-actions--persist" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="MeetingLibrary__item-action"
                    aria-label="Link tới text element đang chọn"
                    title="Link tới text element đang chọn (mention từ canvas)"
                    onClick={(e) => handleLinkText(file, e)}
                  >
                    🔗
                  </button>
                  <button
                    type="button"
                    className={`MeetingLibrary__item-action ${
                      file.lockedBy ? "MeetingLibrary__item-action--locked" : ""
                    }`}
                    aria-label={file.lockedBy ? "Mở khoá" : "Khoá file"}
                    title={
                      file.lockedBy
                        ? `Khoá bởi ${file.lockedBy}. Bấm để mở khoá.`
                        : "Khoá file (chặn người khác xoá)"
                    }
                    onClick={(e) => handleToggleLock(file, e)}
                  >
                    {file.lockedBy ? "🔒" : "🔓"}
                  </button>
                  <button
                    type="button"
                    className="MeetingLibrary__item-action MeetingLibrary__item-action--danger"
                    aria-label="Xoá"
                    title={
                      canDeleteFile(file, me)
                        ? "Xoá khỏi thư viện và canvas"
                        : `File đang bị khoá bởi ${file.lockedBy}`
                    }
                    onClick={(e) => handleDelete(file, e)}
                    disabled={!canDeleteFile(file, me)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default MeetingLibrary;
