import { useEffect, useMemo, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtomValue } from "../app-jotai";
import { chatMessagesAtom, collabAPIAtom } from "../collab/Collab";
import { meetingFilesAtom } from "../data/meetingLibrary";
import { findActiveMention, parseMessage } from "../data/mentions";

import { AIToolsPanel } from "./mcm/AIToolsPanel";
import { MCMAssistant } from "./mcm/MCMAssistant";

import "./ChatPanel.scss";
import "./mcm/MeetingShell.scss";

import type { MeetingFile } from "../data/meetingLibrary";

const formatTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
};

export const ChatView = () => {
  const messages = useAtomValue(chatMessagesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const files = useAtomValue(meetingFilesAtom);
  const excalidrawAPI = useExcalidrawAPI();

  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const isCollaborating = collabAPI?.isCollaborating() ?? false;
  const myUsername = collabAPI?.getUsername() ?? "";

  const filteredFiles = useMemo(() => {
    if (!mention) {
      return [];
    }
    const q = mention.query.toLowerCase();
    return files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, files]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  useEffect(() => {
    setHighlight(0);
  }, [mention?.query, filteredFiles.length]);

  const refreshMention = (value: string, cursor: number) => {
    const next = findActiveMention(value, cursor);
    setMention(next);
  };

  const handleDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setDraft(v);
    refreshMention(v, e.target.selectionStart ?? v.length);
  };

  const handleSelectionChange = (
    e:
      | React.MouseEvent<HTMLTextAreaElement>
      | React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const t = e.currentTarget;
    refreshMention(t.value, t.selectionStart ?? t.value.length);
  };

  const insertMention = (file: MeetingFile) => {
    if (!mention || !inputRef.current) {
      return;
    }
    const ta = inputRef.current;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(ta.selectionStart ?? draft.length);
    const token = `[@${file.name}](file:${file.id}) `;
    const next = before + token + after;
    setDraft(next);
    setMention(null);
    // restore cursor position after the inserted token
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filteredFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % filteredFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight(
          (h) => (h - 1 + filteredFiles.length) % filteredFiles.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filteredFiles[highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !collabAPI) {
      return;
    }
    collabAPI.sendChatMessage(text);
    setDraft("");
    setMention(null);
    inputRef.current?.focus();
  };

  const handleMentionClick = (fileId: string) => {
    if (!excalidrawAPI) {
      return;
    }
    const target = excalidrawAPI
      .getSceneElements()
      .find((el) => el.type === "image" && (el as any).fileId === fileId);
    if (target) {
      excalidrawAPI.scrollToContent(target, {
        animate: true,
        fitToContent: true,
      });
    } else {
      window.alert(
        "File này chưa nằm trên canvas. Mở thư viện và bấm vào file đó để chèn lên trước.",
      );
    }
  };

  if (!isCollaborating) {
    return (
      <div className="ChatView">
        <div className="ChatView__hint">
          Bật <strong>Live Collaboration</strong> để chat với người trong phòng.
          <br />
          <br />
          Tin nhắn được mã hoá đầu cuối bằng key của phòng.
        </div>
      </div>
    );
  }

  return (
    <div className="ChatView">
      <div className="ChatView__messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="ChatView__empty">
            Chưa có tin nhắn.
            <br />
            Gõ <kbd>@</kbd> để mention file trong thư viện phòng.
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.username === myUsername;
            const parts = parseMessage(m.text);
            return (
              <div
                key={m.id}
                className={`ChatView__msg ${mine ? "ChatView__msg--mine" : ""}`}
              >
                <div className="ChatView__msg-meta">
                  <span>{mine ? "Bạn" : m.username || "Ẩn danh"}</span>
                  <span>{formatTime(m.ts)}</span>
                </div>
                <div className="ChatView__msg-bubble">
                  {parts.map((p, i) =>
                    p.kind === "mention" ? (
                      <span
                        key={i}
                        className="ChatView__mention"
                        onClick={() => handleMentionClick(p.fileId)}
                        title="Bấm để cuộn tới file trên canvas"
                      >
                        @{p.name}
                      </span>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="ChatView__form-wrap">
        {mention && filteredFiles.length > 0 && (
          <div className="MentionPicker" aria-label="Chọn file để mention">
            {filteredFiles.map((f, i) => (
              <button
                type="button"
                key={f.id}
                className={`MentionPicker__item ${
                  i === highlight ? "MentionPicker__item--active" : ""
                }`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => insertMention(f)}
              >
                {f.mimeType.startsWith("image/") ? (
                  <img
                    src={f.dataURL}
                    alt=""
                    className="MentionPicker__item-thumb"
                  />
                ) : (
                  <span className="MentionPicker__item-thumb" />
                )}
                <span className="MentionPicker__item-name">{f.name}</span>
              </button>
            ))}
          </div>
        )}
        {mention && filteredFiles.length === 0 && (
          <div className="MentionPicker">
            <div className="MentionPicker__empty">
              {files.length === 0
                ? "Chưa có file nào trong thư viện phòng."
                : `Không có file nào khớp "${mention.query}"`}
            </div>
          </div>
        )}
        <form className="ChatView__form" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="ChatView__input"
            placeholder="Tin nhắn… (gõ @ để mention file)"
            value={draft}
            onChange={handleDraftChange}
            onClick={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            type="submit"
            className="ChatView__send"
            disabled={!draft.trim()}
          >
            Gửi
          </button>
        </form>
      </div>
      <AIToolsPanel />
      <MCMAssistant />
    </div>
  );
};

export default ChatView;
