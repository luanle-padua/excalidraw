// Canvas text extractor — pulls human-meaningful text out of the live
// Excalidraw scene so the AI features (chatbot, summary) can reason over what
// people WROTE on the canvas, not just what they said or typed in chat.
//
// People frequently discuss by writing notes directly ON the canvas, so a
// labeled note like "luan: cần thêm kính không?" is real meeting content and
// must reach the recap. This is the SHARED implementation behind the @bot
// canvas/chat paths (ChatPanel, CanvasBotTool) and the /summarize callers
// (MeetingHeader auto-recap, MeetingLogModal on-demand) — keep it in one place
// so the "what counts as canvas text" rule and the size caps don't drift.

import { BOT_SOCKET_ID } from "../collab/Collab";

// Minimal structural view of the public Excalidraw imperative API we need.
// Typed locally (not imported) so this util has no React/type-package coupling
// and stays trivially callable from anywhere holding an excalidrawAPI. Kept
// deliberately loose (`customData?: Record<string, any>`) so the real
// `ExcalidrawImperativeAPI` is structurally assignable — we narrow the
// mcmAuthor shape inside the function instead.
type SceneElement = {
  type: string;
  isDeleted?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  text?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customData?: Record<string, any>;
};
type SceneAPI = {
  getSceneElements: () => readonly SceneElement[];
};

type McmAuthor = { id?: string; name?: string };
const readAuthor = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customData: Record<string, any> | undefined,
): McmAuthor | undefined => {
  const author = customData?.mcmAuthor;
  return author && typeof author === "object"
    ? (author as McmAuthor)
    : undefined;
};

// Caps mirror the worker-side validation (/summarize + /chatbot both slice to
// 40 items × 200 chars): keep the prompt bounded so a canvas full of notes
// can't blow maxOutputTokens. ~40×200 ≈ 8KB of canvas text, well under 16KB.
const MAX_ITEMS = 40;
const MAX_CHARS_PER_ITEM = 200;

/**
 * Collect human-meaningful text from the current Excalidraw scene.
 *
 * Returns an array of strings — one per text element — author-prefixed as
 * "Name: text" when the element carries an mcmAuthor (so the AI can attribute
 * canvas notes to the person who wrote them). The bot's own Q&A blocks
 * (authored by BOT_SOCKET_ID) are SKIPPED so the model never receives its
 * previous answers back as "canvas text" (that feedback loop made it parrot
 * its own "no info" replies). Deduped, count-capped, and per-item truncated.
 *
 * Pass extra strings (e.g. material/file names) via `extra` to fold them into
 * the same dedup + cap. Safe to call with a null/undefined api → returns [].
 */
export const collectCanvasText = (
  api: SceneAPI | null | undefined,
  extra: readonly string[] = [],
): string[] => {
  const texts: string[] = [];
  if (api) {
    for (const el of api.getSceneElements()) {
      const body = typeof el.text === "string" ? el.text.trim() : "";
      const author = readAuthor(el.customData);
      if (
        el.type === "text" &&
        !el.isDeleted &&
        body &&
        author?.id !== BOT_SOCKET_ID
      ) {
        const name = author?.name?.trim();
        texts.push(name ? `${name}: ${body}` : body);
      }
    }
  }
  for (const name of extra) {
    if (name?.trim()) {
      texts.push(name.trim());
    }
  }
  return Array.from(new Set(texts))
    .slice(0, MAX_ITEMS)
    .map((s) => s.slice(0, MAX_CHARS_PER_ITEM));
};
