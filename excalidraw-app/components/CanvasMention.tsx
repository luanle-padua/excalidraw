import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtomValue } from "../app-jotai";
import { collabAPIAtom } from "../collab/Collab";
import { meetingFilesAtom } from "../data/meetingLibrary";
import { findActiveMention } from "../data/mentions";

import "./CanvasMention.scss";

import type { MeetingFile } from "../data/meetingLibrary";

type PickerState = {
  /** the textarea Excalidraw mounts while the user is editing a text */
  textarea: HTMLTextAreaElement;
  /** index of the `@` character in `textarea.value` */
  startIdx: number;
  /** what the user has typed after the `@` */
  query: string;
  /** screen-fixed position to anchor the picker (just below the textarea) */
  position: { left: number; top: number };
};

/**
 * Inline `@`-mention popover that hooks into Excalidraw's text editor (the
 * `<textarea data-type="wysiwyg">` it mounts during text edit). Typing `@`
 * opens a list of files from the Meeting Library; selecting one inserts a
 * `[@filename](file:ID)` token at the cursor and remembers the file so that
 * once the user finishes editing, we attach an element link from the text
 * to the file's image (via `linkTextToFile`) — same effect as clicking the
 * library's 🔗 button, but without leaving the keyboard.
 */
export const CanvasMention = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const files = useAtomValue(meetingFilesAtom);

  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** when set, applies a link from the editing text to this file once edit
   *  ends */
  const pendingLinkRef = useRef<{
    elementId: string;
    file: MeetingFile;
  } | null>(null);

  const filteredFiles = useMemo(() => {
    if (!picker) {
      return [];
    }
    const q = picker.query.toLowerCase();
    return files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [picker, files]);

  useEffect(() => {
    setHighlight(0);
  }, [picker?.query, filteredFiles.length]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    let attached: HTMLTextAreaElement | null = null;
    let lastEditingId: string | null = null;
    let cleanup: (() => void) | null = null;

    const detach = () => {
      cleanup?.();
      cleanup = null;
      attached = null;
      setPicker(null);
    };

    const refreshFromTextarea = (ta: HTMLTextAreaElement) => {
      const cursor = ta.selectionStart ?? ta.value.length;
      const m = findActiveMention(ta.value, cursor);
      if (m) {
        const rect = ta.getBoundingClientRect();
        setPicker({
          textarea: ta,
          startIdx: m.start,
          query: m.query,
          position: { left: rect.left, top: rect.bottom + 6 },
        });
      } else {
        setPicker(null);
      }
    };

    const attachTo = (ta: HTMLTextAreaElement) => {
      attached = ta;
      const onInput = () => refreshFromTextarea(ta);
      const onSel = () => refreshFromTextarea(ta);
      ta.addEventListener("input", onInput);
      ta.addEventListener("click", onSel);
      ta.addEventListener("keyup", onSel);
      cleanup = () => {
        ta.removeEventListener("input", onInput);
        ta.removeEventListener("click", onSel);
        ta.removeEventListener("keyup", onSel);
      };
    };

    const unsub = excalidrawAPI.onChange((_e, appState) => {
      const editingId = appState.editingTextElement?.id ?? null;
      if (editingId === lastEditingId) {
        return;
      }
      const wasEditing = lastEditingId;
      lastEditingId = editingId;

      if (wasEditing && !editingId) {
        // edit ended — apply pending link if any. Pass the element id
        // explicitly because the user may not have left the text selected,
        // and updateScene's appState change isn't synchronous anyway.
        const pending = pendingLinkRef.current;
        if (pending && pending.elementId === wasEditing) {
          collabAPI?.linkTextToFile(pending.file, pending.elementId);
          pendingLinkRef.current = null;
        }
        detach();
        return;
      }

      if (!wasEditing && editingId) {
        // edit started — find the textarea after Excalidraw mounts it
        requestAnimationFrame(() => {
          const ta = document.querySelector(
            'textarea[data-type="wysiwyg"]',
          ) as HTMLTextAreaElement | null;
          if (ta) {
            attachTo(ta);
          }
        });
      }
    });

    return () => {
      unsub();
      detach();
      // ESLint: allow attached used cross-render
      void attached;
    };
  }, [excalidrawAPI, collabAPI]);

  const insertMention = (file: MeetingFile) => {
    if (!picker) {
      return;
    }
    const ta = picker.textarea;
    const cursor = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, picker.startIdx);
    const after = ta.value.slice(cursor);
    // Plain `@filename ` — Excalidraw text elements render as plain text on
    // the canvas, so storing the markdown-like `[@name](file:id)` form would
    // show up as raw characters. The fileId association is tracked via the
    // element's `link` property (set after edit ends in pendingLinkRef).
    const token = `@${file.name} `;
    const next = before + token + after;
    ta.value = next;
    // tell Excalidraw the text changed so it updates the underlying element
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const newPos = (before + token).length;
    ta.setSelectionRange(newPos, newPos);
    ta.focus();

    if (excalidrawAPI) {
      const editingId = excalidrawAPI.getAppState().editingTextElement?.id;
      if (editingId) {
        // last @-pick wins as the link target (Excalidraw element link can
        // only point to one element)
        pendingLinkRef.current = { elementId: editingId, file };
      }
    }
    setPicker(null);
  };

  // Intercept arrow nav / enter / escape on the textarea while picker open
  useEffect(() => {
    if (!picker) {
      return;
    }
    const ta = picker.textarea;
    const onKeyDown = (e: KeyboardEvent) => {
      if (filteredFiles.length === 0) {
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (h + 1) % filteredFiles.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight(
          (h) => (h - 1 + filteredFiles.length) % filteredFiles.length,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        insertMention(filteredFiles[highlight]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPicker(null);
      }
    };
    ta.addEventListener("keydown", onKeyDown, true);
    return () => ta.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, filteredFiles, highlight]);

  if (!picker) {
    return null;
  }

  return createPortal(
    <div
      className="CanvasMentionPicker"
      // dynamic position relative to the cursor — has to be inline
      // eslint-disable-next-line react/forbid-dom-props
      style={{ left: picker.position.left, top: picker.position.top }}
      // mousedown rather than click so the textarea doesn't lose focus
      // (which would end the edit before insertion completes)
      onMouseDown={(e) => e.preventDefault()}
    >
      {filteredFiles.length === 0 ? (
        <div className="CanvasMentionPicker__empty">
          {files.length === 0
            ? "Chưa có file nào trong thư viện phòng."
            : `Không có file khớp "${picker.query}"`}
        </div>
      ) : (
        filteredFiles.map((f, i) => (
          <button
            key={f.id}
            type="button"
            className={`CanvasMentionPicker__item ${
              i === highlight ? "CanvasMentionPicker__item--active" : ""
            }`}
            onMouseEnter={() => setHighlight(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              insertMention(f);
            }}
          >
            {f.mimeType.startsWith("image/") ? (
              <img
                src={f.dataURL}
                alt=""
                className="CanvasMentionPicker__item-thumb"
              />
            ) : (
              <span className="CanvasMentionPicker__item-thumb" />
            )}
            <span className="CanvasMentionPicker__item-name">{f.name}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
};

export default CanvasMention;
