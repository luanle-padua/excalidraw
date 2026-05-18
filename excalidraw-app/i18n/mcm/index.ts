// MCM-specific i18n.
//
// Why a separate i18n from Excalidraw's built-in one?
//   - Excalidraw's `t()` only knows the editor's own strings (toolbar,
//     dialogs, settings) and ships them as JSON locale files per
//     package. MCM strings live in our app layer.
//   - We want runtime switching tied to `preferredLanguageAtom`
//     (which already drives chat translation), not to Excalidraw's
//     internal AppState locale. Decoupling them avoids weird "chat
//     in Vietnamese, header in Korean" mismatches when Excalidraw's
//     locale doesn't agree with the user's translation pick.
//
// Architecture
//   - One TS dictionary per language (vi.ts / en.ts / ko.ts), all
//     typed against the `vi` baseline (vi is the source-of-truth —
//     adding a key in vi turns into compile errors in en/ko until
//     translated, so nothing silently drifts).
//   - `useT()` returns the translator bound to the viewer's current
//     preferred lang. Use this from React components.
//   - `t(lang, key)` is the pure non-hook form for spots that need
//     translation outside React (e.g. titles for native confirm()).
//
// Adding a new string:
//   1. Add the key + Vietnamese text to vi.ts.
//   2. The TS error in en.ts/ko.ts is the to-do list — fill them in.
//   3. Call `t("path.to.key")` from the component.
//
// Adding a new language:
//   1. Add the 2-letter code to `SupportedLanguage` (data/translation).
//   2. Create `<code>.ts` mirroring vi.ts.
//   3. Register it in the `LOCALES` map below.

import { useAtomValue } from "../../app-jotai";
import { preferredLanguageAtom } from "../../data/translation";

import { vi } from "./vi";
import { en } from "./en";
import { ko } from "./ko";

import type { SupportedLanguage } from "../../data/translation";

/** Widens `vi`'s readonly literal types to plain strings so en/ko can
 *  hold their own translations while structurally matching vi. TS
 *  still flags any missing key in a sibling locale. */
export type Widened<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends Record<string, unknown>
    ? Widened<T[K]>
    : T[K];
};

// Source-of-truth shape — every locale dictionary must extend this.
export type McmStrings = Widened<typeof vi>;
type McmKey = NestedKeyOf<McmStrings>;

/** All "dot-path" keys reachable in the nested dictionary, e.g.
 *  "header.invite". Computed from the vi dictionary so TS catches
 *  typos at the call site. */
type NestedKeyOf<T, Prefix extends string = ""> = {
  [K in keyof T]: T[K] extends string
    ? `${Prefix}${K & string}`
    : T[K] extends Record<string, unknown>
    ? NestedKeyOf<T[K], `${Prefix}${K & string}.`>
    : never;
}[keyof T];

const LOCALES: Record<SupportedLanguage, McmStrings> = { vi, en, ko };

/** Walks the dictionary by the dot-path. Returns the key itself as
 *  fallback when missing (loud failure mode — easy to spot in the UI). */
const resolve = (dict: McmStrings, key: string): string => {
  const parts = key.split(".");
  let cursor: unknown = dict;
  for (const part of parts) {
    if (cursor && typeof cursor === "object" && part in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  return typeof cursor === "string" ? cursor : key;
};

/** Optional `{name}` placeholder substitution — useful for messages
 *  like "Đang trả lời {name}". */
const interpolate = (
  template: string,
  params?: Record<string, string | number>,
): string => {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, name) =>
    params[name] != null ? String(params[name]) : `{${name}}`,
  );
};

/** Pure form — translate `key` to `lang`. Falls back to `vi` if the
 *  requested language is unknown. */
export const t = (
  lang: SupportedLanguage | undefined,
  key: McmKey,
  params?: Record<string, string | number>,
): string => {
  const dict = LOCALES[lang ?? "vi"] ?? LOCALES.vi;
  return interpolate(resolve(dict, key), params);
};

/** Hook form — returns a translator bound to the viewer's current
 *  preferred language. Re-renders the component when the user picks
 *  a new language. */
export const useT = (): ((
  key: McmKey,
  params?: Record<string, string | number>,
) => string) => {
  const lang = useAtomValue(preferredLanguageAtom);
  return (key, params) => t(lang, key, params);
};

/** Read the current locale dictionary directly — handy when you need
 *  to pass a whole sub-object (e.g. list of placeholder messages).
 *  Components should prefer `useT()` for individual keys. */
export const useLocale = (): McmStrings => {
  const lang = useAtomValue(preferredLanguageAtom);
  return LOCALES[lang] ?? LOCALES.vi;
};
