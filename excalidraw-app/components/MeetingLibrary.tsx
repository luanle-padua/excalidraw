import { useCallback, useEffect, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newImageElement } from "@excalidraw/element";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { useAtomValue } from "../app-jotai";
import { collabAPIAtom } from "../collab/Collab";
import {
  canDeleteFile,
  canUnlockFile,
  hydrateMeetingFiles,
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
        if (!file.type.startsWith("image/")) {
          window.alert(`Tạm thời chỉ hỗ trợ ảnh. Bỏ qua: ${file.name}`);
          continue;
        }
        try {
          const dataURL = await readAsDataURL(file);
          const id = newFileId();
          const dims = await probeImageDimensions(dataURL);
          // collabAPI handles: addFiles to canvas + persist + broadcast
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

  const handleInsert = (file: MeetingFile) => {
    if (!excalidrawAPI) {
      return;
    }
    // if the image is already on the canvas, jump to it instead of duplicating
    const elements = excalidrawAPI.getSceneElements();
    const existing = elements.find(
      (el) => el.type === "image" && (el as any).fileId === file.id,
    );
    if (existing) {
      excalidrawAPI.scrollToContent(existing, {
        animate: true,
        fitToContent: true,
      });
      return;
    }

    // make sure the file is in the canvas's file map (re-add — addFiles is
    // idempotent for identical ids)
    excalidrawAPI.addFiles([
      {
        id: file.id as FileId,
        dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
        mimeType: file.mimeType as BinaryFileData["mimeType"],
        created: Date.now(),
      },
    ]);

    const appState = excalidrawAPI.getAppState();
    let w = file.width ?? 320;
    let h = file.height ?? 320;
    if (w > MAX_INSERT_DIMENSION || h > MAX_INSERT_DIMENSION) {
      const scale = MAX_INSERT_DIMENSION / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const cx = -appState.scrollX + appState.width / 2 / appState.zoom.value;
    const cy = -appState.scrollY + appState.height / 2 / appState.zoom.value;

    const img = newImageElement({
      type: "image",
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      fileId: file.id as FileId,
      status: "saved",
    });

    excalidrawAPI.updateScene({
      elements: [...elements, img],
    });
  };

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
          {dragOver ? "Thả file để tải lên" : "+ Tải ảnh lên · hoặc kéo thả"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          aria-label="Chọn ảnh để tải lên thư viện phòng"
          className="MeetingLibrary__file-input"
          onChange={handleFileInputChange}
        />
        <div className="MeetingLibrary__hint-line">
          Ảnh paste/kéo vào canvas tự động xuất hiện ở đây.
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
            const isImage = file.mimeType.startsWith("image/");
            return (
              <div
                key={file.id}
                className="MeetingLibrary__item"
                onClick={() => handleInsert(file)}
                title={`${file.name} — bấm để chèn vào canvas`}
              >
                <div className="MeetingLibrary__item-thumb">
                  {isImage ? (
                    <img src={file.dataURL} alt={file.name} loading="lazy" />
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
