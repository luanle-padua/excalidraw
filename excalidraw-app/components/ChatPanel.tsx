// MCM chat panel — "Threaded Quiet" design.
//
// Layout (top → bottom):
//   1. Header: title left, language picker + translate toggle right
//   2. Messages: grouped by author within ~3 min; first message in a
//      group carries the avatar + name + time, subsequent messages
//      are just bubbles indented under the name
//   3. Compose: Telegram-style 2-row card — textarea on top, action
//      icons (emoji-trigger, @-trigger, attach, send) on the bottom
//
// AI Tools card is GONE — Translate moved to the header (where it
// semantically belongs next to the language picker); Summarize is
// parked until the feature ships.

import { useEffect, useMemo, useRef, useState } from "react";

import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtom, useAtomValue } from "../app-jotai";
import {
  BOT_USERNAME,
  chatMessagesAtom,
  collabAPIAtom,
  isBotMessage,
} from "../collab/Collab";
import { meetingFilesAtom } from "../data/meetingLibrary";
import { findActiveMention, parseMessage } from "../data/mentions";
import {
  preferredLanguageAtom,
  setTranslationEnabled,
  translationEnabledAtom,
  useTranslate,
} from "../data/translation";

import { LanguagePicker } from "./LanguagePicker";

import "./ChatPanel.scss";

import type { ChatMessage } from "../collab/Collab";
import type { MeetingFile } from "../data/meetingLibrary";
import type { SupportedLanguage } from "../data/translation";

// -----------------------------------------------------------------------
// Localised UI labels — single language per viewer (no bilingual wrap).
// -----------------------------------------------------------------------
const HEADER_LABEL: Record<SupportedLanguage, string> = {
  vi: "Hội thoại",
  en: "Conversation",
  ko: "대화",
};
const EMPTY_TITLE: Record<SupportedLanguage, string> = {
  vi: "Chưa có tin nhắn",
  en: "No messages yet",
  ko: "메시지 없음",
};
const EMPTY_SUBTITLE: Record<SupportedLanguage, string> = {
  vi: "Gõ @ để mention file, @bot để hỏi AI",
  en: "Type @ to mention a file, @bot to ask AI",
  ko: "@로 파일 멘션, @bot으로 AI에게 질문",
};
const COMPOSE_PLACEHOLDER: Record<SupportedLanguage, string> = {
  vi: "Nhập tin nhắn…",
  en: "Type a message…",
  ko: "메시지 입력…",
};
const SEND_LABEL: Record<SupportedLanguage, string> = {
  vi: "Gửi",
  en: "Send",
  ko: "전송",
};
const TRANSLATING_LABEL: Record<SupportedLanguage, string> = {
  vi: "Đang dịch…",
  en: "Translating…",
  ko: "번역 중…",
};
const TRANSLATE_TOGGLE_LABEL: Record<SupportedLanguage, string> = {
  vi: "Tự động dịch",
  en: "Auto-translate",
  ko: "자동 번역",
};
const MENTION_TITLE = {
  vi: "Bấm để cuộn tới file trên canvas",
  en: "Click to scroll to file on canvas",
  ko: "캔버스의 파일로 이동",
};

// Apple-style "tapback" emoji set — broad coverage with the most
// useful expressions for design-review chat. Order matters: positive
// agreement on the left, attention/celebration in the middle,
// thoughtful reactions on the right.
const REACTION_PICKER_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "🎉",
  "🔥",
  "👀",
  "🙏",
  "💯",
  "✅",
  "🤔",
  "😢",
];

// Compose-side emoji palette — inserted into the textarea, NOT a
// message reaction. Kept separate so the two concerns don't drift.
const COMPOSE_EMOJI_PALETTE = [
  "👍",
  "❤️",
  "😂",
  "😄",
  "😮",
  "🎉",
  "🔥",
  "✨",
  "👀",
  "🙏",
  "💯",
  "✅",
  "🤔",
  "😢",
  "🚀",
  "💡",
];

// Avatar gradient is deterministic from the username so the same person
// reads as the same colour across the chat AND the participants strip.
const AVATAR_PALETTE: [string, string][] = [
  ["#34d399", "#0ea5e9"],
  ["#f472b6", "#ef4444"],
  ["#fbbf24", "#f97316"],
  ["#60a5fa", "#6366f1"],
  ["#a78bfa", "#ec4899"],
  ["#22d3ee", "#3b82f6"],
  ["#fb7185", "#f59e0b"],
  ["#84cc16", "#10b981"],
];
const avatarGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const [a, b] = AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
  return `linear-gradient(135deg,${a},${b})`;
};
const initials = (name: string): string =>
  name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

const formatTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
};

// -----------------------------------------------------------------------
// Inline SVG icons — small set, all 18×18 unless noted.
// -----------------------------------------------------------------------
const TranslateIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="16"
    height="16"
    aria-hidden="true"
  >
    <path d="M4 5h11" />
    <path d="M9 3v2" />
    <path d="M11 5a8 8 0 0 1-7 8" />
    <path d="M5 9c0 4 4 7 9 7" />
    <path d="M14 21l5-11 5 11" />
    <path d="M15.5 17.5h7" />
  </svg>
);
const SmileIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </svg>
);
const AtIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </svg>
);
const AttachIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);
const SendIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M2.5 11.6 21 3l-8.5 18.5-2-8z" />
  </svg>
);
// Curved-arrow reply icon, matches the iMessage / Slack reply glyph.
const ReplyIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="15"
    height="15"
    aria-hidden="true"
  >
    <polyline points="9 14 4 9 9 4" />
    <path d="M4 9h11a5 5 0 0 1 5 5v6" />
  </svg>
);

// Smiley with a tiny "+" — the canonical "add reaction" affordance
// across Slack, Discord, Linear, and iMessage.
const SmilePlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="15"
    height="15"
    aria-hidden="true"
  >
    <path d="M21 11.5A9 9 0 1 1 12.5 3" />
    <path d="M19 4v5" />
    <path d="M16.5 6.5h5" />
    <path d="M8 14.5s1.4 1.8 4 1.8 4-1.8 4-1.8" />
    <line x1="9" y1="10" x2="9.01" y2="10" />
    <line x1="14.5" y1="10" x2="14.51" y2="10" />
  </svg>
);
const EmptyChatIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="22"
    height="22"
    aria-hidden="true"
  >
    <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
  </svg>
);

// -----------------------------------------------------------------------
// Message grouping — consecutive messages from same socketId within
// 3 minutes form one visual group. Bot messages never merge with human
// (they get a clearly different bubble style anyway).
// -----------------------------------------------------------------------
const GROUP_WINDOW_MS = 3 * 60 * 1000;
type MessageGroup = {
  socketId: string;
  isBot: boolean;
  isMine: boolean;
  username: string;
  startTs: number;
  messages: ChatMessage[];
};

const groupMessages = (
  messages: readonly ChatMessage[],
  myUsername: string,
): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  for (const m of messages) {
    const bot = isBotMessage(m);
    const mine = !bot && m.username === myUsername;
    const last = groups[groups.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    if (
      last &&
      prev &&
      last.socketId === m.socketId &&
      last.isBot === bot &&
      m.ts - prev.ts < GROUP_WINDOW_MS
    ) {
      last.messages.push(m);
    } else {
      groups.push({
        socketId: m.socketId,
        isBot: bot,
        isMine: mine,
        username: m.username,
        startTs: m.ts,
        messages: [m],
      });
    }
  }
  return groups;
};

// -----------------------------------------------------------------------
// Single message bubble (within a group). Handles translation,
// reactions, and the floating quick-react picker.
// -----------------------------------------------------------------------
const MessageBubble = ({
  message,
  mySocketId,
  isBot,
  isMine,
  onMentionClick,
  onReact,
  onReply,
  onJumpToMessage,
}: {
  message: ChatMessage;
  mySocketId: string | null;
  isBot: boolean;
  isMine: boolean;
  onMentionClick: (fileId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onReply: (msg: ChatMessage) => void;
  onJumpToMessage: (messageId: string) => void;
}) => {
  const lang = useAtomValue(preferredLanguageAtom);
  // Pre-translated map shipped on the message (sender called
  // /translate-batch on send). When present, useTranslate returns
  // the matching entry with zero API hits.
  const { translated, isSameLanguage, loading } = useTranslate(message.text, {
    preset: message.translations,
  });
  const parts = parseMessage(message.text);

  // JS-driven hover state. CSS :hover is unreliable inside Excalidraw's
  // sidebar — between user-select toggles and nested stacking contexts
  // the descendant-selector approach was silently failing. Tracking
  // hover in React state makes it deterministic.
  //
  // The popover sits visually ABOVE the bubble (absolute-positioned,
  // bottom-overlapping by 2px). When the cursor moves from bubble up
  // into the popover, it briefly leaves the __msg bounding box. We
  // use a short close-delay so that traversal doesn't unmount the
  // popover; entering the popover cancels the close.
  const [hovered, setHovered] = useState(false);
  // Render the popover above by default, below when the bubble sits
  // too close to the top of the scrolling messages container (otherwise
  // overflow-y: auto would clip the popover invisibly).
  const [popoverSide, setPopoverSide] = useState<"above" | "below">("above");
  const msgRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const POPOVER_ESTIMATED_HEIGHT = 44; // grid 28px + padding + border

  const openPicker = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Measure available space above relative to the scrolling messages
    // container. When the bubble is near the top, flip the popover to
    // render below the bubble so it stays visible.
    if (msgRef.current) {
      const bubbleRect = msgRef.current.getBoundingClientRect();
      const scrollContainer = msgRef.current.closest(
        ".ChatView__messages",
      ) as HTMLElement | null;
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const spaceAbove = bubbleRect.top - containerRect.top;
        setPopoverSide(
          spaceAbove < POPOVER_ESTIMATED_HEIGHT + 6 ? "below" : "above",
        );
      }
    }
    setHovered(true);
  };
  const scheduleClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className={`ChatView__msg${hovered ? " ChatView__msg--hovered" : ""}`}
      data-msg-id={message.id}
      ref={msgRef}
      onMouseEnter={openPicker}
      onMouseLeave={scheduleClose}
    >
      {message.replyTo && (
        <button
          type="button"
          className="ChatView__quote"
          onClick={() => onJumpToMessage(message.replyTo!.id)}
          title="Cuộn đến tin nhắn gốc"
        >
          <span className="ChatView__quote-bar" aria-hidden="true" />
          <span className="ChatView__quote-body">
            <span className="ChatView__quote-author">
              {message.replyTo.author}
            </span>
            <span className="ChatView__quote-text">
              {message.replyTo.snippet}
            </span>
          </span>
        </button>
      )}

      <div className="ChatView__bubble">
        {parts.map((p, i) =>
          p.kind === "mention" ? (
            <span
              key={i}
              className="ChatView__mention"
              onClick={() => onMentionClick(p.fileId)}
              title={MENTION_TITLE[lang]}
            >
              @{p.name}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </div>

      {!isSameLanguage && (
        <div className="ChatView__translation">
          {loading ? TRANSLATING_LABEL[lang] : translated}
        </div>
      )}

      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div className="ChatView__reactions">
          {Object.entries(message.reactions).map(([emoji, reactors]) => {
            const reacted =
              mySocketId !== null && reactors.includes(mySocketId);
            return (
              <button
                type="button"
                key={emoji}
                className={`ChatView__reaction${
                  reacted ? " ChatView__reaction--mine" : ""
                }`}
                onClick={() => onReact(message.id, emoji)}
                title={`${reactors.length} người`}
              >
                <span className="ChatView__reaction-emoji">{emoji}</span>
                <span className="ChatView__reaction-count">
                  {reactors.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!isBot && hovered && (
        <div
          className={`ChatView__react-popover ChatView__react-popover--${popoverSide}`}
          role="toolbar"
          aria-label="Chọn cảm xúc"
          onMouseEnter={openPicker}
          onMouseLeave={scheduleClose}
        >
          {REACTION_PICKER_EMOJIS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              className="ChatView__react-popover-btn"
              onClick={() => onReact(message.id, emoji)}
              title={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
          <span
            className="ChatView__react-popover-divider"
            aria-hidden="true"
          />
          <button
            type="button"
            className="ChatView__react-popover-action"
            onClick={() => onReply(message)}
            title="Trả lời tin nhắn này"
            aria-label="Trả lời"
          >
            <ReplyIcon />
          </button>
        </div>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------
// One author-group (avatar + name + time header + 1-N bubbles below).
// -----------------------------------------------------------------------
const GroupRow = ({
  group,
  mySocketId,
  onMentionClick,
  onReact,
  onReply,
  onJumpToMessage,
}: {
  group: MessageGroup;
  mySocketId: string | null;
  onMentionClick: (fileId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onReply: (msg: ChatMessage) => void;
  onJumpToMessage: (messageId: string) => void;
}) => {
  const lang = useAtomValue(preferredLanguageAtom);
  const displayName = group.isBot
    ? BOT_USERNAME
    : group.isMine
    ? lang === "ko"
      ? "나"
      : lang === "en"
      ? "You"
      : "Bạn"
    : group.username || "Guest";

  return (
    <div
      className={`ChatView__group${group.isMine ? " ChatView__group--mine" : ""}${
        group.isBot ? " ChatView__group--bot" : ""
      }`}
    >
      {group.isBot ? (
        <div
          className="ChatView__avatar ChatView__avatar--bot"
          aria-hidden="true"
        >
          🤖
        </div>
      ) : (
        <div
          className="ChatView__avatar"
          // eslint-disable-next-line react/forbid-dom-props
          style={{ background: avatarGradient(displayName) }}
          aria-hidden="true"
        >
          {initials(displayName)}
        </div>
      )}

      <div className="ChatView__group-body">
        <div className="ChatView__group-meta">
          <span className="ChatView__group-author">{displayName}</span>
          <span className="ChatView__group-time">
            {formatTime(group.startTs)}
          </span>
        </div>
        {group.messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mySocketId={mySocketId}
            isBot={group.isBot}
            isMine={group.isMine}
            onMentionClick={onMentionClick}
            onReact={onReact}
            onReply={onReply}
            onJumpToMessage={onJumpToMessage}
          />
        ))}
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------
// ChatView — the whole panel.
// -----------------------------------------------------------------------
export const ChatView = () => {
  const messages = useAtomValue(chatMessagesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const files = useAtomValue(meetingFilesAtom);
  const excalidrawAPI = useExcalidrawAPI();
  const preferredLang = useAtomValue(preferredLanguageAtom);
  const [translationEnabled, setTransEnabledAtom] = useAtom(
    translationEnabledAtom,
  );

  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [botPending, setBotPending] = useState<string[]>([]);
  // Quoted-reply pointer set when the user picks "reply" on a message.
  // Compose shows a banner above the textarea; on send we attach it to
  // the outgoing message and the banner clears.
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isCollaborating = collabAPI?.isCollaborating() ?? false;
  const myUsername = collabAPI?.getUsername() ?? "";
  const mySocketId = collabAPI?.portal.socket?.id ?? null;

  const handleReact = (messageId: string, emoji: string) => {
    collabAPI?.toggleChatReaction(messageId, emoji);
  };

  const startReply = (msg: ChatMessage) => {
    setReplyingTo(msg);
    inputRef.current?.focus();
  };

  const cancelReply = () => setReplyingTo(null);

  const jumpToMessage = (messageId: string) => {
    if (!scrollRef.current) {
      return;
    }
    const el = scrollRef.current.querySelector<HTMLElement>(
      `[data-msg-id="${messageId}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ChatView__msg--flash");
      window.setTimeout(() => {
        el.classList.remove("ChatView__msg--flash");
      }, 1400);
    }
  };

  // Snippet kept short so the wire payload + the rendered quote stay
  // compact in narrow sidebars.
  const truncateForQuote = (text: string): string => {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > 100
      ? `${collapsed.slice(0, 100).trimEnd()}…`
      : collapsed;
  };

  const groups = useMemo(
    () => groupMessages(messages, myUsername),
    [messages, myUsername],
  );

  const filteredFiles = useMemo(() => {
    if (!mention) {
      return [];
    }
    const q = mention.query.toLowerCase();
    return files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, files]);

  const showBotOption = useMemo(() => {
    if (!mention) {
      return false;
    }
    if (!mention.query) {
      return true;
    }
    return "bot".startsWith(mention.query.toLowerCase());
  }, [mention]);

  const pickerLength = (showBotOption ? 1 : 0) + filteredFiles.length;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  useEffect(() => {
    setHighlight(0);
  }, [mention?.query, pickerLength]);

  // ---------------------------------------------------------------
  // Mention picker logic — unchanged from the previous version.
  // ---------------------------------------------------------------
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
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertBot = () => {
    if (!mention || !inputRef.current) {
      return;
    }
    const ta = inputRef.current;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(ta.selectionStart ?? draft.length);
    const token = `@bot `;
    const next = before + token + after;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const commitPickerHighlight = () => {
    if (!mention) {
      return;
    }
    if (showBotOption && highlight === 0) {
      insertBot();
      return;
    }
    const fileIndex = showBotOption ? highlight - 1 : highlight;
    const file = filteredFiles[fileIndex];
    if (file) {
      insertMention(file);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && pickerLength > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % pickerLength);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + pickerLength) % pickerLength);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitPickerHighlight();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ---------------------------------------------------------------
  // @bot detection + AI reply flow.
  // ---------------------------------------------------------------
  const detectBotInvocation = (text: string): boolean =>
    /(^|\s)@bot\b/i.test(text);

  const stripBotMentions = (text: string): string =>
    text
      .replace(/(^|\s)@bot\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

  const askBot = async (rawQuestion: string) => {
    if (!collabAPI || !rawQuestion) {
      return;
    }
    const placeholderId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `placeholder-${Date.now()}`;
    setBotPending((prev) => prev.concat(placeholderId));
    try {
      const recentContext = messages.slice(-10).map((m) => ({
        username: m.username,
        text: m.text,
      }));
      const res = await fetch("/chatbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: rawQuestion,
          language: preferredLang,
          recent: recentContext,
        }),
      });
      if (!res.ok) {
        throw new Error(`chatbot ${res.status}`);
      }
      const body = (await res.json()) as { answer?: string };
      const answer =
        body?.answer?.trim() ||
        "Xin lỗi, mình chưa trả lời được. Thử lại sau nhé.";
      collabAPI.sendBotMessage(answer);
    } catch (err) {
      console.warn("[@bot] failed", err);
      collabAPI.sendBotMessage(
        "Mình không thể trả lời lúc này (kết nối hoặc API có vấn đề).",
      );
    } finally {
      setBotPending((prev) => prev.filter((id) => id !== placeholderId));
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !collabAPI) {
      return;
    }
    const replyRef = replyingTo
      ? {
          id: replyingTo.id,
          author: replyingTo.username,
          snippet: truncateForQuote(replyingTo.text),
        }
      : undefined;
    collabAPI.sendChatMessage(text, replyRef);
    if (detectBotInvocation(text)) {
      const question = stripBotMentions(text);
      if (question) {
        void askBot(question);
      }
    }
    setDraft("");
    setMention(null);
    setReplyingTo(null);
    inputRef.current?.focus();
  };

  // ---------------------------------------------------------------
  // Inline @-trigger button — programmatically inserts an "@" and
  // forces the mention picker to open.
  // ---------------------------------------------------------------
  const triggerMentionPicker = () => {
    const ta = inputRef.current;
    if (!ta) {
      return;
    }
    const cur = ta.selectionStart ?? draft.length;
    const before = draft.slice(0, cur);
    const after = draft.slice(cur);
    const prefix = before && !before.endsWith(" ") ? " " : "";
    const next = `${before}${prefix}@${after}`;
    setDraft(next);
    requestAnimationFrame(() => {
      const pos = (before + prefix + "@").length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      refreshMention(next, pos);
    });
  };

  // Emoji button — for v1 it just opens the same reaction set as a
  // pop-up; we wire a small inline emoji-insert UI later. For now,
  // clicking it appends the most-used emoji "👍" as a quick win.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const insertEmoji = (e: string) => {
    const ta = inputRef.current;
    if (!ta) {
      setDraft((prev) => prev + e);
      return;
    }
    const cur = ta.selectionStart ?? draft.length;
    const next = draft.slice(0, cur) + e + draft.slice(cur);
    setDraft(next);
    requestAnimationFrame(() => {
      const pos = cur + e.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
    setEmojiPickerOpen(false);
  };

  // ---------------------------------------------------------------
  // File upload (same library pipeline as MeetingLibrary).
  // ---------------------------------------------------------------
  const newFileId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const readAsDataURL = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const probeImageDims = (
    dataURL: string,
  ): Promise<{ width: number; height: number } | null> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () =>
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = dataURL;
    });

  const handleFileSelect = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const fl = e.target.files;
    if (!fl || fl.length === 0 || !collabAPI) {
      return;
    }
    const username = collabAPI.getUsername() || "Guest";
    const tokens: string[] = [];
    for (const f of Array.from(fl)) {
      if (!f.type.startsWith("image/")) {
        window.alert(`Tạm thời chỉ hỗ trợ ảnh. Bỏ qua: ${f.name}`);
        continue;
      }
      try {
        const dataURL = await readAsDataURL(f);
        const id = newFileId();
        const dims = await probeImageDims(dataURL);
        collabAPI.publishLibraryFile({
          id,
          name: f.name,
          ts: Date.now(),
          author: username,
          mimeType: f.type,
          dataURL,
          width: dims?.width,
          height: dims?.height,
        });
        tokens.push(`[@${f.name}](file:${id})`);
      } catch (err) {
        console.warn("chat upload failed", err);
      }
    }
    if (tokens.length > 0) {
      setDraft((prev) => {
        const sep = prev && !prev.endsWith(" ") ? " " : "";
        return `${prev}${sep}${tokens.join(" ")} `;
      });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    e.target.value = "";
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

  const toggleTranslate = () => {
    const next = !translationEnabled;
    setTransEnabledAtom(next);
    setTranslationEnabled(next);
  };

  if (!isCollaborating) {
    return (
      <div className="ChatView">
        <div className="ChatView__header">
          <h2 className="ChatView__header-title">
            {HEADER_LABEL[preferredLang]}
          </h2>
        </div>
        <div className="ChatView__messages">
          <div className="ChatView__empty">
            <div className="ChatView__empty-icon" aria-hidden="true">
              <EmptyChatIcon />
            </div>
            <div className="ChatView__empty-title">
              {preferredLang === "ko"
                ? "라이브 협업을 활성화하세요"
                : preferredLang === "en"
                ? "Start a live collaboration session"
                : "Bật Live Collaboration để bắt đầu"}
            </div>
            <div className="ChatView__empty-subtitle">
              {preferredLang === "ko"
                ? "메시지는 룸 키로 종단간 암호화됩니다."
                : preferredLang === "en"
                ? "Messages are end-to-end encrypted with the room key."
                : "Tin nhắn được mã hoá đầu cuối bằng key của phòng."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const stopCopyHijack = (e: React.ClipboardEvent) => e.stopPropagation();

  return (
    <div
      className="ChatView"
      onCopy={stopCopyHijack}
      onCut={stopCopyHijack}
    >
      <div className="ChatView__header">
        <h2 className="ChatView__header-title">
          {HEADER_LABEL[preferredLang]}
        </h2>
        <div className="ChatView__header-controls">
          <button
            type="button"
            className={`ChatView__translate-toggle${
              translationEnabled ? " ChatView__translate-toggle--on" : ""
            }`}
            onClick={toggleTranslate}
            title={`${TRANSLATE_TOGGLE_LABEL[preferredLang]} ${
              translationEnabled ? "(on)" : "(off)"
            }`}
          >
            <TranslateIcon />
          </button>
          <LanguagePicker />
        </div>
      </div>

      <div className="ChatView__messages" ref={scrollRef}>
        {groups.length === 0 ? (
          <div className="ChatView__empty">
            <div className="ChatView__empty-icon" aria-hidden="true">
              <EmptyChatIcon />
            </div>
            <div className="ChatView__empty-title">
              {EMPTY_TITLE[preferredLang]}
            </div>
            <div className="ChatView__empty-subtitle">
              {EMPTY_SUBTITLE[preferredLang]}
            </div>
          </div>
        ) : (
          <>
            {groups.map((g, idx) => (
              <GroupRow
                key={`${g.socketId}-${g.startTs}-${idx}`}
                group={g}
                mySocketId={mySocketId}
                onMentionClick={handleMentionClick}
                onReact={handleReact}
                onReply={startReply}
                onJumpToMessage={jumpToMessage}
              />
            ))}
            {botPending.length > 0 && (
              <div className="ChatView__group ChatView__group--bot">
                <div
                  className="ChatView__avatar ChatView__avatar--bot"
                  aria-hidden="true"
                >
                  🤖
                </div>
                <div className="ChatView__group-body">
                  <div className="ChatView__group-meta">
                    <span className="ChatView__group-author">
                      {BOT_USERNAME}
                    </span>
                  </div>
                  <div className="ChatView__msg">
                    <div className="ChatView__bubble ChatView__bubble--bot-thinking">
                      <span className="ChatView__bot-dots">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="ChatView__form-wrap">
        {mention && pickerLength > 0 && (
          <div
            className="MentionPicker"
            aria-label="Chọn file hoặc bot để mention"
          >
            {showBotOption && (
              <button
                type="button"
                key="__bot__"
                className={`MentionPicker__item MentionPicker__item--bot ${
                  highlight === 0 ? "MentionPicker__item--active" : ""
                }`}
                onMouseEnter={() => setHighlight(0)}
                onClick={() => insertBot()}
              >
                <span className="MentionPicker__item-thumb MentionPicker__item-thumb--bot">
                  🤖
                </span>
                <span className="MentionPicker__item-name">
                  <strong>MCM Bot</strong>
                  <span className="MentionPicker__item-desc">
                    Hỏi AI về thiết kế / dự án
                  </span>
                </span>
              </button>
            )}
            {filteredFiles.map((f, i) => {
              const itemIndex = showBotOption ? i + 1 : i;
              return (
                <button
                  type="button"
                  key={f.id}
                  className={`MentionPicker__item ${
                    itemIndex === highlight
                      ? "MentionPicker__item--active"
                      : ""
                  }`}
                  onMouseEnter={() => setHighlight(itemIndex)}
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
              );
            })}
          </div>
        )}
        {mention && pickerLength === 0 && (
          <div className="MentionPicker">
            <div className="MentionPicker__empty">
              {files.length === 0
                ? "Chưa có file nào trong thư viện phòng."
                : `Không có file nào khớp "${mention.query}"`}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            aria-label="Đính kèm ảnh vào chat"
            title="Đính kèm ảnh"
            className="ChatView__file-input"
            onChange={handleFileSelect}
          />
          <div
            className={`ChatView__compose${
              draft.trim() ? " ChatView__compose--active" : ""
            }${replyingTo ? " ChatView__compose--replying" : ""}`}
          >
            {replyingTo && (
              <div className="ChatView__compose-reply">
                <ReplyIcon />
                <div className="ChatView__compose-reply-body">
                  <span className="ChatView__compose-reply-author">
                    {replyingTo.username}
                  </span>
                  <span className="ChatView__compose-reply-text">
                    {truncateForQuote(replyingTo.text)}
                  </span>
                </div>
                <button
                  type="button"
                  className="ChatView__compose-reply-close"
                  onClick={cancelReply}
                  aria-label="Huỷ trả lời"
                  title="Huỷ trả lời"
                >
                  ×
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              className="ChatView__compose-input"
              placeholder={COMPOSE_PLACEHOLDER[preferredLang]}
              value={draft}
              onChange={handleDraftChange}
              onClick={handleSelectionChange}
              onKeyUp={handleSelectionChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <div className="ChatView__compose-actions">
              <button
                type="button"
                className={`ChatView__compose-icon-btn${
                  emojiPickerOpen ? " ChatView__compose-icon-btn--on" : ""
                }`}
                onClick={() => setEmojiPickerOpen((v) => !v)}
                title="Emoji"
                aria-label="Emoji"
              >
                <SmileIcon />
              </button>
              <button
                type="button"
                className="ChatView__compose-icon-btn"
                onClick={triggerMentionPicker}
                title="Mention file / bot"
                aria-label="Mention"
              >
                <AtIcon />
              </button>
              <button
                type="button"
                className="ChatView__compose-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Đính kèm ảnh"
                aria-label="Attach"
              >
                <AttachIcon />
              </button>
              <div className="ChatView__compose-actions-spacer" />
              <button
                type="submit"
                className="ChatView__compose-send"
                disabled={!draft.trim()}
                aria-label={SEND_LABEL[preferredLang]}
                title={SEND_LABEL[preferredLang]}
              >
                <SendIcon />
              </button>
            </div>
          </div>
          {emojiPickerOpen && (
            <div
              className="ChatView__compose-emoji-popover"
              role="toolbar"
              aria-label="Quick emoji"
            >
              {COMPOSE_EMOJI_PALETTE.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="ChatView__compose-emoji-btn"
                  onClick={() => insertEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default ChatView;
