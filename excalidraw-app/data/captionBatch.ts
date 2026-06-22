// Caption translation BATCHER (plan §5 — AI hardening).
//
// PROBLEM: live captions translated one /translate call PER finalized line PER
// viewer language. In a busy meeting that is a flood of tiny requests — exactly
// the load that tripped the (then per-IP) rate limit and made translation
// "die when the meeting is busy". See worker/src/ai.ts and translation.ts.
//
// FIX: accumulate the distinct caption texts that need translating over a short
// debounce window (~300ms) and flush them together — each distinct text goes
// through /translate-batch ONCE (which returns every language in a single round
// trip AND warms the per-(lang,text) cache), instead of one /translate per
// (line, viewer). Rapid finals from the same speaker coalesce; duplicates are
// dropped; an already-cached text is never re-requested.
//
// This module is the PURE accumulation/decision core — no fetch, no atoms, no
// DOM — so it is trivially unit-testable. translation.ts owns the timer + the
// actual /translate-batch call and feeds this its dependencies.

// Default debounce window. Long enough to coalesce a burst of finals, short
// enough that captions still translate near-instantly. Deepgram finals already
// lag the audio ~1s, so a few hundred ms more is imperceptible.
export const CAPTION_BATCH_DEBOUNCE_MS = 300;

// Hard cap on how many distinct texts one flush carries, so a pathological
// burst (e.g. a backlog dumped at once) can't fan out into an unbounded number
// of /translate-batch calls in a single tick.
export const CAPTION_BATCH_MAX_PER_FLUSH = 12;

/**
 * Accumulates distinct caption texts to translate, deduplicating against both
 * the pending set AND a caller-supplied "already have it" predicate (the
 * translation cache / in-flight set). PURE: it only decides WHAT to flush;
 * the caller performs the side effects (timers, fetch).
 */
export class CaptionBatchAccumulator {
  // Insertion-ordered set of distinct texts awaiting a flush.
  private pending = new Set<string>();

  constructor(
    /** True when `text` is already translated/in-flight and must NOT be
     *  queued again (cache hit, or a request is already running for it). */
    private readonly alreadyHandled: (text: string) => boolean,
  ) {}

  /** Queue a caption text for the next flush. Returns true if it was newly
   *  added (caller may then (re)arm the debounce timer), false if it was a
   *  duplicate or already handled (no timer change needed). */
  add(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (this.pending.has(trimmed) || this.alreadyHandled(trimmed)) {
      return false;
    }
    this.pending.add(trimmed);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Drain up to CAPTION_BATCH_MAX_PER_FLUSH texts that are STILL un-handled
   *  (a text may have been cached/served by an overlapping flush since it was
   *  queued — drop those). Returns the texts to translate now; any overflow
   *  beyond the cap stays pending for the next flush. */
  drain(): string[] {
    const out: string[] = [];
    const remaining = new Set<string>();
    for (const text of this.pending) {
      if (this.alreadyHandled(text)) {
        continue; // resolved while waiting — skip
      }
      if (out.length < CAPTION_BATCH_MAX_PER_FLUSH) {
        out.push(text);
      } else {
        remaining.add(text); // overflow — keep for the next flush
      }
    }
    this.pending = remaining;
    return out;
  }

  /** True when a drain would still leave texts queued (caller re-arms timer). */
  hasOverflow(): boolean {
    return this.pending.size > 0;
  }

  clear(): void {
    this.pending.clear();
  }
}

/**
 * Tracks caption texts whose /translate-batch request SETTLED without producing
 * a usable translation (429 / 502 / timeout / network / empty body). PURE: a
 * bounded insertion-ordered set with LRU eviction — no fetch, no atoms, no DOM.
 *
 * Why it exists (plan §5): the batched useTranslate path shows the "Translating…"
 * label while `loading` is true and only clears it when a subscriber fires after
 * the cache fills. On FAILURE nothing fills the cache, so the line would render
 * "Translating…" forever instead of falling back to the original spoken text
 * (LiveCaptionDock's "captions must never blank out" invariant). translation.ts
 * records a failure here + notifies, and the hook reads `has()` to stop loading
 * and fall back. A later successful retry warms the cache and `forget()`s the
 * text, so it's no longer considered failed.
 */
export class CaptionSettledRegistry {
  private failed = new Set<string>();

  // Default ceiling so a long meeting can't grow the set without bound.
  constructor(private readonly max = 500) {}

  /** Record `text` as settled-without-translation (caller then notifies). */
  markFailed(text: string): void {
    // Re-insert moves it to the most-recent end (Map/Set keep insertion order).
    this.failed.delete(text);
    this.failed.add(text);
    while (this.failed.size > this.max) {
      const oldest = this.failed.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.failed.delete(oldest);
    }
  }

  /** Clear the failed flag — call when a retry of `text` finally succeeds. */
  forget(text: string): void {
    this.failed.delete(text);
  }

  /** True when `text`'s batch settled without a translation. */
  has(text: string): boolean {
    return this.failed.has(text);
  }

  get size(): number {
    return this.failed.size;
  }
}
