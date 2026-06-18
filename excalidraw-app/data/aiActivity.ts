// AI-in-use signal (PM decision, 06-18): a small, classy indicator surfaces
// whenever the client is calling ANY AI endpoint — translate, translate-batch,
// chatbot, summarize, STT — so users always know when AI is working for them.
//
// This is a reference-counted in-flight counter (several AI calls can overlap:
// a batch translation while the bot is thinking). `aiInFlightAtom` is > 0 while
// at least one call is open; the indicator reads it and fades itself in/out.
//
// Call sites wrap their request in `withAiActivity(...)` (async) or use the
// raw begin/end pair for non-promise lifecycles (e.g. the STT socket, which is
// open for the whole transcription session). Always pair begin → end in a
// finally so a thrown/aborted request can't pin the indicator on.

import { atom, appJotaiStore } from "../app-jotai";

/** Number of AI requests currently in flight. The indicator is visible while
 *  this is > 0. Module-level store so non-React callers (data/translation.ts)
 *  can drive it too. */
export const aiInFlightAtom = atom(0);

export const beginAiActivity = (): void => {
  appJotaiStore.set(aiInFlightAtom, appJotaiStore.get(aiInFlightAtom) + 1);
};

export const endAiActivity = (): void => {
  // Floor at 0 — a double-end (e.g. a retry that already settled) must never
  // drive the counter negative and wedge the indicator off.
  appJotaiStore.set(
    aiInFlightAtom,
    Math.max(0, appJotaiStore.get(aiInFlightAtom) - 1),
  );
};

/** Run an AI request with the in-use indicator held up for its duration.
 *  Begin/end are paired in a finally so a rejection still clears the counter. */
export const withAiActivity = async <T>(fn: () => Promise<T>): Promise<T> => {
  beginAiActivity();
  try {
    return await fn();
  } finally {
    endAiActivity();
  }
};
