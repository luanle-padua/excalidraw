// Translation utilities for the chat panel.
//
//   • `preferredLanguageAtom` — viewer's effective MCM language (vi / en / ko).
//     DERIVED from Excalidraw's `appLangCodeAtom` so the language picker
//     in the main menu is the single source of truth. Mapping:
//        vi-VN → vi, ko-KR → ko, everything else → en.
//     Add a key here when MCM dicts gain a new language (e.g. ja).
//
//   • `translationCacheAtom` — per-session in-memory cache of translated
//     strings keyed by `${targetLang}:${textHash}`. Also mirrored to
//     localStorage so brief reloads don't re-hit the API.
//
//   • `useTranslate(text, targetLang)` — returns the translated string
//     (or the original while loading / on error). Deduplicates concurrent
//     requests for the same text.
//
// The actual translation provider is server-side (Cloudflare Worker
// worker/src/ai.ts → Gemini, base = VITE_APP_STORAGE_URL); this module only
// fetches and caches. (Moved off room/src/index.ts in DO migration I-1.)

import { useEffect, useState } from "react";

import { appLangCodeAtom } from "../app-language/language-state";
import { atom, useAtomValue, appJotaiStore } from "../app-jotai";

import { beginAiActivity, endAiActivity } from "./aiActivity";
import { aiBackendUrl } from "./aiBackend";
import {
  CAPTION_BATCH_DEBOUNCE_MS,
  CaptionBatchAccumulator,
  CaptionSettledRegistry,
} from "./captionBatch";
import { fetchWithAuth } from "./fetchWithAuth";

export type SupportedLanguage = "vi" | "en" | "ko";

export const SUPPORTED_LANGUAGES: Array<{
  code: SupportedLanguage;
  label: string;
  nativeLabel: string;
}> = [
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
];

// Base localStorage key — the LIVE key is namespaced by identity (see
// translationLsKey) so two accounts sharing one browser can't read each
// other's cached chat translations.
const TRANSLATION_LS_KEY_BASE = "mcm:chatTranslations";
const TRANSLATION_CACHE_MAX = 500;
// Hard ceiling on the in-memory cache so a long-running session with lots of
// distinct chat lines can't grow the Map without bound. Slightly above the
// persisted cap (we keep a little extra hot in RAM before evicting).
const MEMORY_CACHE_MAX = 1000;

// Map an Excalidraw editor language code (e.g. "vi-VN", "ko-KR",
// "de-DE") down to one of the languages MCM chrome + Gemini chat
// translation support. Extend this map as the MCM dicts gain new
// languages — anything not listed falls back to English.
const APP_LANG_TO_MCM_LANG: Record<string, SupportedLanguage> = {
  "vi-VN": "vi",
  "ko-KR": "ko",
  en: "en",
};

const toMcmLang = (appLang: string): SupportedLanguage => {
  if (APP_LANG_TO_MCM_LANG[appLang]) {
    return APP_LANG_TO_MCM_LANG[appLang];
  }
  // Match by primary subtag too, in case Excalidraw ever introduces
  // region variants we haven't pinned (e.g. "vi" without "-VN").
  const primary = appLang.split("-")[0];
  return APP_LANG_TO_MCM_LANG[primary] ?? "en";
};

// Read-only derived atom — the Excalidraw language picker in
// AppMainMenu is the single source of truth, and it already
// persists via i18next-browser-languagedetector.
export const preferredLanguageAtom = atom<SupportedLanguage>((get) =>
  toMcmLang(get(appLangCodeAtom)),
);

// ---------------------------------------------------------------------
// Translation on/off toggle (driven by the AI Tools panel item). When
// off, useTranslate immediately returns the original text and skips the
// API entirely — useful for users who don't want extra latency or who
// just want to read the source language.
// ---------------------------------------------------------------------

const TRANSLATION_ENABLED_LS_KEY = "mcm:translationEnabled";

const guessInitialTranslationEnabled = (): boolean => {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const v = window.localStorage.getItem(TRANSLATION_ENABLED_LS_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};

export const translationEnabledAtom = atom<boolean>(
  guessInitialTranslationEnabled(),
);

export const setTranslationEnabled = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(
      TRANSLATION_ENABLED_LS_KEY,
      enabled ? "1" : "0",
    );
  } catch {
    // ignore
  }
};

// ---------------------------------------------------------------------
// Translation-degraded signal (plan §5 — surface overload, don't hide it).
//
// When the server replies 429 (rate limited) or 502 (Gemini overload/empty),
// the client still falls back to the ORIGINAL text — but silently doing so made
// "we're throttled" indistinguishable from "translation is broken". This flag
// lets the caption UI show a subtle "translation paused (overloaded)" hint.
//
// The flag is a language-NEUTRAL boolean (code, not copy); the component maps it
// to i18n at render. It is DEBOUNCED on the falling edge: any degraded response
// (re)arms a timer that clears it after a quiet window, so a single blip shows
// briefly and a sustained overload stays lit without per-response thrashing.
// Module-level store access so the non-React fetch helpers can drive it.
// ---------------------------------------------------------------------

export const translationDegradedAtom = atom<boolean>(false);

// How long the degraded hint lingers after the LAST degraded response before it
// clears itself. Long enough that a steady stream of 429s keeps it lit, short
// enough that it disappears soon after the overload passes.
const TRANSLATION_DEGRADED_LINGER_MS = 6000;
let degradedClearTimer: number | null = null;

/** Mark translation as degraded (overloaded). Idempotent + debounced: sets the
 *  flag and (re)arms the auto-clear timer. Non-fatal — purely a UI hint. */
const markTranslationDegraded = (): void => {
  try {
    appJotaiStore.set(translationDegradedAtom, true);
    if (typeof window !== "undefined") {
      if (degradedClearTimer !== null) {
        window.clearTimeout(degradedClearTimer);
      }
      degradedClearTimer = window.setTimeout(() => {
        degradedClearTimer = null;
        appJotaiStore.set(translationDegradedAtom, false);
      }, TRANSLATION_DEGRADED_LINGER_MS);
    }
  } catch {
    // jotai store unavailable (non-browser test) — the hint is best-effort.
  }
};

/** A degraded response is one the server returned because it is OVERLOADED, as
 *  opposed to a config/auth/validation error. 429 = rate limited, 502 = Gemini
 *  empty/overloaded. (503 = provider not configured is a different, persistent
 *  state and should NOT flash the transient overload hint.) */
const isDegradedStatus = (status: number): boolean =>
  status === 429 || status === 502;

// ---------------------------------------------------------------------
// Cache + in-flight deduplication
// ---------------------------------------------------------------------

const memoryCache = new Map<string, string>(); // key: `${lang}:${text}`
const inflight = new Map<string, Promise<string>>();

// localStorage key, namespaced by the logged-in identity. Defaults to the
// shared base (pre-login / no identity yet); switched in place by
// setTranslationCacheIdentity once we know who's signed in.
let translationLsKey = TRANSLATION_LS_KEY_BASE;

/** LRU-style set with a hard size cap: re-inserting moves a key to the
 *  "most recent" end (Map keeps insertion order), and once we exceed the
 *  cap we evict the oldest entry. Keeps the in-memory cache bounded. */
const cacheSet = (key: string, value: string): void => {
  // Delete-then-set so an existing key counts as freshly used (moved to end).
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  }
  memoryCache.set(key, value);
  while (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    memoryCache.delete(oldest);
  }
};

// Subscribers re-render when a new translation lands so React UI updates.
type Subscriber = () => void;
const subscribers = new Set<Subscriber>();
const notifySubscribers = () => {
  for (const s of subscribers) {
    s();
  }
};

const loadCacheFromStorage = (): void => {
  try {
    const raw = window.localStorage.getItem(translationLsKey);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          cacheSet(k, v);
        }
      }
    }
  } catch {
    // corrupt localStorage — ignore
  }
};

const persistCacheToStorage = (() => {
  let timer: number | null = null;
  return () => {
    if (timer !== null) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      try {
        // Capture the most recent TRANSLATION_CACHE_MAX entries.
        const entries = Array.from(memoryCache.entries()).slice(
          -TRANSLATION_CACHE_MAX,
        );
        const obj: Record<string, string> = {};
        for (const [k, v] of entries) {
          obj[k] = v;
        }
        window.localStorage.setItem(translationLsKey, JSON.stringify(obj));
      } catch {
        // quota exceeded or blocked — best-effort
      }
    }, 500);
  };
})();

if (typeof window !== "undefined") {
  loadCacheFromStorage();
}

/** Derive a safe per-identity localStorage suffix from an email. Lower-cased
 *  and stripped to a small charset so it can't break the key or collide. */
const identitySuffix = (email: string): string =>
  email.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");

/** Point the persisted translation cache at the signed-in identity's slot.
 *  Called on login so two accounts sharing a browser keep separate caches.
 *  Idempotent — re-setting the same identity is a no-op. */
export const setTranslationCacheIdentity = (email: string | null): void => {
  const nextKey = email
    ? `${TRANSLATION_LS_KEY_BASE}:${identitySuffix(email)}`
    : TRANSLATION_LS_KEY_BASE;
  if (nextKey === translationLsKey) {
    return;
  }
  translationLsKey = nextKey;
  // Swap to the new identity's persisted cache: drop the previous account's
  // hot entries, then hydrate this account's slot.
  memoryCache.clear();
  if (typeof window !== "undefined") {
    loadCacheFromStorage();
  }
};

/** Wipe the in-memory + persisted translation cache for the CURRENT identity.
 *  Called on logout so the next user on this browser starts clean. */
export const clearTranslationCache = (): void => {
  memoryCache.clear();
  try {
    window.localStorage.removeItem(translationLsKey);
  } catch {
    // ignore
  }
  translationLsKey = TRANSLATION_LS_KEY_BASE;
};

const cacheKey = (lang: string, text: string) => `${lang}:${text}`;

export const getCachedTranslation = (
  text: string,
  targetLang: SupportedLanguage,
): string | null => {
  return memoryCache.get(cacheKey(targetLang, text)) ?? null;
};

const fetchTranslation = async (
  text: string,
  targetLang: SupportedLanguage,
): Promise<string> => {
  const key = cacheKey(targetLang, text);
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    // Surface the AI-in-use indicator for the duration of the call.
    beginAiActivity();
    try {
      const res = await fetchWithAuth(`${aiBackendUrl()}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target: targetLang }),
      });
      if (!res.ok) {
        // 503 = provider not configured — fall back to original. 429/502 mean
        // the server is OVERLOADED: still fall back, but flash the degraded
        // hint so the user knows it's throttled, not broken (plan §5).
        if (isDegradedStatus(res.status)) {
          markTranslationDegraded();
        }
        return text;
      }
      const body = (await res.json()) as { translated?: string };
      const translated = body?.translated?.trim();
      return translated || text;
    } catch {
      return text;
    } finally {
      endAiActivity();
    }
  })();
  inflight.set(key, promise);
  try {
    const translated = await promise;
    cacheSet(key, translated);
    persistCacheToStorage();
    notifySubscribers();
    return translated;
  } finally {
    inflight.delete(key);
  }
};

// ---------------------------------------------------------------------
// Batch translation — one round trip pulls all languages. Used by the
// sender's client right before broadcasting a chat message so receivers
// don't each have to call /translate.
// ---------------------------------------------------------------------

const ALL_TARGETS: SupportedLanguage[] = ["vi", "en", "ko"];

/**
 * Fetch translations of `text` into every supported language in ONE
 * Gemini call. Returns null on failure / timeout so callers can
 * fall back gracefully (just broadcast without translations attached).
 */
export const fetchBatchTranslation = async (
  text: string,
  options?: { timeoutMs?: number },
): Promise<Record<SupportedLanguage, string> | null> => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  // 8s, not 4s: a cold Worker isolate + Gemini round trip for the batch of all
  // languages can exceed 4s, and aborting mid-flight made every sender silently
  // broadcast without translations (receivers then saw the original text).
  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = window.setTimeout(() => controller?.abort(), timeoutMs);
  beginAiActivity();
  try {
    const res = await fetchWithAuth(`${aiBackendUrl()}/translate-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, targets: ALL_TARGETS }),
      signal: controller?.signal,
    });
    if (!res.ok) {
      // Surface the failure instead of swallowing it — a batch error used to be
      // indistinguishable from "same language", so translation just looked dead.
      console.warn(`[translate] batch failed: ${res.status} ${res.statusText}`);
      // 429/502 = server overloaded → flash the degraded hint (plan §5).
      if (isDegradedStatus(res.status)) {
        markTranslationDegraded();
      }
      return null;
    }
    const body = (await res.json()) as {
      translations?: Record<string, string>;
    };
    const raw = body?.translations;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const result: Partial<Record<SupportedLanguage, string>> = {};
    for (const lang of ALL_TARGETS) {
      const v = raw[lang];
      if (typeof v === "string" && v.trim()) {
        result[lang] = v.trim();
        // Warm the per-(lang,text) memory cache so legacy useTranslate
        // calls on the same text resolve instantly without re-fetching.
        cacheSet(cacheKey(lang, trimmed), v.trim());
      }
    }
    if (Object.keys(result).length === 0) {
      return null;
    }
    persistCacheToStorage();
    notifySubscribers();
    return result as Record<SupportedLanguage, string>;
  } catch (err) {
    // Don't swallow silently — the abort/timeout path used to be invisible, so a
    // slow Gemini round trip looked identical to "translation disabled". Name it.
    const aborted = err instanceof DOMException && err.name === "AbortError";
    console.warn(
      `[translate] batch ${
        aborted ? `timed out (${timeoutMs}ms)` : "errored"
      }:`,
      err,
    );
    return null;
  } finally {
    window.clearTimeout(timer);
    endAiActivity();
  }
};

// ---------------------------------------------------------------------
// Caption translation batcher (plan §5). Live captions used to translate one
// /translate call per finalized line per viewer language — the flood that
// tripped the rate limit in a busy meeting. Instead, finalized caption lines
// are QUEUED here, deduped, and flushed together on a short debounce: each
// distinct line goes through /translate-batch ONCE (all languages, one round
// trip) which warms the per-(lang,text) cache that useTranslate reads. The
// per-line useTranslate hooks then resolve from cache via the subscriber
// notification — no per-line API call. Non-fatal throughout.
// ---------------------------------------------------------------------

// In-flight caption texts (a batch request is running for this text). Distinct
// from `inflight` (keyed by lang:text for the single /translate path).
const captionInflight = new Set<string>();

// Caption texts whose batch request SETTLED without producing a usable
// translation (429/502/timeout/network/empty). The batched useTranslate path
// keeps `loading` true until its subscriber fires; on success the cache fills
// and the subscriber resolves. On FAILURE nothing fills the cache, so without
// this the line would render the "Translating…" label forever instead of
// falling back to the original spoken text (violates LiveCaptionDock's "captions
// must never blank out" invariant + plan §5's "fall back to original on
// overload"). We record the failed text here and notify so the hook can clear
// loading and show `seg.text`. (Pure bounded registry — see captionBatch.ts.)
const captionSettled = new CaptionSettledRegistry();

/** True when this caption text's batch settled without a translation (so the
 *  batched useTranslate hook should stop "loading" and fall back to original). */
export const captionBatchSettledWithoutTranslation = (text: string): boolean =>
  captionSettled.has(text);

/** A caption text is "already handled" when a batch request is in flight for it
 *  OR it is already cached in EVERY target language (so every viewer can read
 *  it from cache and no batch is needed). */
const captionHandled = (text: string): boolean => {
  if (captionInflight.has(text)) {
    return true;
  }
  return ALL_TARGETS.every((lang) => memoryCache.has(cacheKey(lang, text)));
};

const captionAccumulator = new CaptionBatchAccumulator(captionHandled);
let captionFlushTimer: number | null = null;

const flushCaptionBatch = (): void => {
  captionFlushTimer = null;
  const texts = captionAccumulator.drain();
  for (const text of texts) {
    if (captionInflight.has(text)) {
      continue;
    }
    captionInflight.add(text);
    // fetchBatchTranslation warms the per-(lang,text) cache + notifies
    // subscribers on success, and marks degraded on 429/502 — all non-fatal.
    // On FAILURE (null) it warms nothing, so the batched useTranslate hooks for
    // this line would stay stuck on "Translating…". Record the failure + notify
    // so each hook clears `loading` and falls back to the original spoken text
    // (plan §5 / LiveCaptionDock "captions must never blank out").
    void fetchBatchTranslation(text)
      .then((result) => {
        if (result === null) {
          captionSettled.markFailed(text);
          notifySubscribers();
        } else {
          // A later retry succeeded — this text is no longer "failed" (the
          // success branch already warmed the cache + notified subscribers).
          captionSettled.forget(text);
        }
      })
      .finally(() => {
        captionInflight.delete(text);
      });
  }
  // If a burst overflowed the per-flush cap, re-arm to drain the rest.
  if (captionAccumulator.hasOverflow() && typeof window !== "undefined") {
    captionFlushTimer = window.setTimeout(
      flushCaptionBatch,
      CAPTION_BATCH_DEBOUNCE_MS,
    );
  }
};

/**
 * Queue a finalized caption line for batched translation. Safe to call on every
 * final segment render — deduped against the cache + in-flight set, debounced,
 * and a no-op when translation is disabled or the text is empty. Returns true
 * if the text was newly queued (mainly for tests/observability).
 */
export const requestCaptionTranslation = (text: string): boolean => {
  try {
    if (!appJotaiStore.get(translationEnabledAtom)) {
      return false;
    }
  } catch {
    // store unavailable — fall through and queue anyway (best-effort).
  }
  const queued = captionAccumulator.add(text);
  if (queued && typeof window !== "undefined" && captionFlushTimer === null) {
    captionFlushTimer = window.setTimeout(
      flushCaptionBatch,
      CAPTION_BATCH_DEBOUNCE_MS,
    );
  }
  return queued;
};

// ---------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------

/**
 * Translate `text` to the viewer's preferred language.
 *
 * Resolution order:
 *   1. Translation toggle off → return `text` unchanged.
 *   2. `options.preset[preferred]` set (sender pre-translated at send-time)
 *      → use that, zero API hits. This is the common path now.
 *   3. `options.assumedSource === preferred` → source already matches.
 *   4. Per-(text, lang) memory cache.
 *   5. On a miss: a translate request, returns original while loading.
 *      - default: per-(text,lang) `/translate`.
 *      - `options.batched` (live captions): queue the text into the debounced
 *        /translate-batch batcher instead of firing a per-line call. The cache
 *        is filled by the batch flush and we resolve via the subscriber. This
 *        is what stops a busy meeting flooding the API (plan §5).
 */
export const useTranslate = (
  text: string,
  options?: {
    assumedSource?: SupportedLanguage;
    preset?: Record<string, string>;
    /** Route cache-misses through the batched /translate-batch path instead of
     *  a per-line /translate. Used by the live caption dock. */
    batched?: boolean;
  },
): { translated: string; isSameLanguage: boolean; loading: boolean } => {
  const preferred = useAtomValue(preferredLanguageAtom);
  const enabled = useAtomValue(translationEnabledAtom);
  const preset = options?.preset;
  const assumedSource = options?.assumedSource;
  const batched = options?.batched ?? false;

  // If the sender already shipped a translation for our preferred lang,
  // take it and bail out — no fetch, no cache lookup, no API.
  const presetForPreferred = preset?.[preferred];
  const hasPreset =
    typeof presetForPreferred === "string" && presetForPreferred.length > 0;

  const sameLang = !enabled || assumedSource === preferred;
  const initialCached = sameLang
    ? text
    : hasPreset
    ? presetForPreferred!
    : getCachedTranslation(text, preferred);
  const [translated, setTranslated] = useState<string>(initialCached ?? text);
  const [loading, setLoading] = useState<boolean>(
    !sameLang && !hasPreset && initialCached === null,
  );

  useEffect(() => {
    let cancelled = false;
    if (sameLang) {
      setTranslated(text);
      setLoading(false);
      return;
    }
    if (hasPreset) {
      setTranslated(presetForPreferred!);
      setLoading(false);
      return;
    }
    const cached = getCachedTranslation(text, preferred);
    if (cached !== null) {
      setTranslated(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (batched) {
      // Captions: queue into the debounced /translate-batch batcher. The flush
      // fills the cache for every language + notifies subscribers; we resolve
      // below via onUpdate. While waiting we keep showing the original text.
      // If a previous window already tried this exact text and the batch FAILED
      // (overload/timeout), don't sit on "Translating…" forever — fall back to
      // the original immediately (plan §5). requestCaptionTranslation also won't
      // re-queue it, so onUpdate would never fire for it.
      if (captionBatchSettledWithoutTranslation(text)) {
        setLoading(false);
      } else {
        requestCaptionTranslation(text);
      }
    } else {
      fetchTranslation(text, preferred).then((result) => {
        if (cancelled) {
          return;
        }
        setTranslated(result);
        setLoading(false);
      });
    }

    const onUpdate = () => {
      if (cancelled) {
        return;
      }
      const next = getCachedTranslation(text, preferred);
      if (next !== null) {
        setTranslated(next);
        setLoading(false);
        return;
      }
      // Batched path only: the batch settled but warmed nothing for this text
      // (overload/timeout/empty). Stop loading so the line falls back to the
      // original spoken text instead of the stuck "Translating…" label.
      if (batched && captionBatchSettledWithoutTranslation(text)) {
        setLoading(false);
      }
    };
    subscribers.add(onUpdate);
    return () => {
      cancelled = true;
      subscribers.delete(onUpdate);
    };
  }, [text, preferred, sameLang, hasPreset, presetForPreferred, batched]);

  return {
    translated,
    isSameLanguage: translated === text || sameLang,
    loading,
  };
};
