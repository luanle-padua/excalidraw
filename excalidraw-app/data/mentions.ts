// Helpers shared by the chat input and the canvas-text editor for the
// @-mention popup behaviour.

/** `[@filename](file:FILEID)` — encodes a file mention inside chat text.
 *  Same syntax is reused for the link target on canvas text elements. */
export const MENTION_RE = /\[@([^\]]+)\]\(file:([^)]+)\)/g;

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; fileId: string };

export const parseMessage = (text: string): MessagePart[] => {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index! > last) {
      parts.push({ kind: "text", text: text.slice(last, m.index!) });
    }
    parts.push({ kind: "mention", name: m[1], fileId: m[2] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: "text", text: text.slice(last) });
  }
  return parts;
};

/** Find an open `@xxx` token at or just before the cursor in a textarea.
 *  Returns the start index of `@` and the partial query, or null if there
 *  is no active mention context. */
export const findActiveMention = (
  value: string,
  cursor: number,
): { start: number; query: string } | null => {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : "";
      if (i === 0 || /\s/.test(prev)) {
        const query = value.slice(i + 1, cursor);
        if (/\s/.test(query)) {
          return null;
        }
        return { start: i, query };
      }
      return null;
    }
    if (/\s/.test(ch)) {
      return null;
    }
    i--;
  }
  return null;
};
