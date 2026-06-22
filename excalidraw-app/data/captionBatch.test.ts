// Unit tests for the PURE caption-batch accumulation (plan §5 — AI hardening).
//
// CaptionBatchAccumulator is the decision core that turns a flood of per-line
// caption translations into a few batched /translate-batch calls: it dedupes,
// drops already-cached/in-flight texts, caps each flush, and carries overflow.
// translation.ts wires it to the debounce timer + the actual fetch; this pins
// the pure logic so a regression can't silently re-introduce the per-line flood.
//
//   npx vitest run excalidraw-app/data/captionBatch.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  CAPTION_BATCH_MAX_PER_FLUSH,
  CaptionBatchAccumulator,
  CaptionSettledRegistry,
} from "./captionBatch";

const never = () => false;

describe("CaptionBatchAccumulator", () => {
  it("queues a distinct text once and reports it newly added", () => {
    const acc = new CaptionBatchAccumulator(never);
    expect(acc.add("hello")).toBe(true);
    expect(acc.size).toBe(1);
  });

  it("dedupes a repeated text within the same window (no second timer arm)", () => {
    const acc = new CaptionBatchAccumulator(never);
    expect(acc.add("hello")).toBe(true);
    expect(acc.add("hello")).toBe(false);
    expect(acc.size).toBe(1);
  });

  it("trims whitespace and ignores empty/blank lines", () => {
    const acc = new CaptionBatchAccumulator(never);
    expect(acc.add("   ")).toBe(false);
    expect(acc.add("")).toBe(false);
    expect(acc.add("  hi  ")).toBe(true);
    expect(acc.drain()).toEqual(["hi"]);
  });

  it("never queues a text the cache/in-flight predicate already handles", () => {
    const cached = new Set(["already"]);
    const acc = new CaptionBatchAccumulator((t) => cached.has(t));
    expect(acc.add("already")).toBe(false);
    expect(acc.add("fresh")).toBe(true);
    expect(acc.size).toBe(1);
  });

  it("drains in insertion order and empties the pending set", () => {
    const acc = new CaptionBatchAccumulator(never);
    acc.add("a");
    acc.add("b");
    acc.add("c");
    expect(acc.drain()).toEqual(["a", "b", "c"]);
    expect(acc.size).toBe(0);
    expect(acc.drain()).toEqual([]);
  });

  it("drops texts that became handled (cached) while waiting for the flush", () => {
    const cached = new Set<string>();
    const acc = new CaptionBatchAccumulator((t) => cached.has(t));
    acc.add("a");
    acc.add("b");
    cached.add("a"); // an overlapping flush resolved "a" meanwhile
    expect(acc.drain()).toEqual(["b"]);
  });

  it("caps a flush at CAPTION_BATCH_MAX_PER_FLUSH and carries the overflow", () => {
    const acc = new CaptionBatchAccumulator(never);
    const n = CAPTION_BATCH_MAX_PER_FLUSH + 3;
    for (let i = 0; i < n; i++) {
      acc.add(`line-${i}`);
    }
    const first = acc.drain();
    expect(first).toHaveLength(CAPTION_BATCH_MAX_PER_FLUSH);
    expect(acc.hasOverflow()).toBe(true);
    const second = acc.drain();
    expect(second).toHaveLength(3);
    expect(acc.hasOverflow()).toBe(false);
  });

  it("clear() empties the pending set", () => {
    const acc = new CaptionBatchAccumulator(never);
    acc.add("a");
    acc.clear();
    expect(acc.size).toBe(0);
  });
});

// CaptionSettledRegistry is the decision core for plan §5's "stuck Translating…"
// fix: a caption whose /translate-batch FAILED must fall back to the original
// spoken text, not render the "Translating…" label forever. This pins that
// failed/succeeded/bounded logic so the stuck-loading regression can't return.
describe("CaptionSettledRegistry", () => {
  it("reports a text as not-failed until it is marked", () => {
    const reg = new CaptionSettledRegistry();
    expect(reg.has("hello")).toBe(false);
    reg.markFailed("hello");
    expect(reg.has("hello")).toBe(true);
  });

  it("forget() clears the failed flag (retry succeeded path)", () => {
    const reg = new CaptionSettledRegistry();
    reg.markFailed("hello");
    reg.forget("hello");
    expect(reg.has("hello")).toBe(false);
  });

  it("markFailed is idempotent and does not double-count size", () => {
    const reg = new CaptionSettledRegistry();
    reg.markFailed("a");
    reg.markFailed("a");
    expect(reg.size).toBe(1);
  });

  it("evicts the oldest entry once the bound is exceeded (LRU)", () => {
    const reg = new CaptionSettledRegistry(2);
    reg.markFailed("a");
    reg.markFailed("b");
    reg.markFailed("c"); // evicts the oldest ("a")
    expect(reg.has("a")).toBe(false);
    expect(reg.has("b")).toBe(true);
    expect(reg.has("c")).toBe(true);
    expect(reg.size).toBe(2);
  });

  it("re-marking a text refreshes its recency so it survives eviction", () => {
    const reg = new CaptionSettledRegistry(2);
    reg.markFailed("a");
    reg.markFailed("b");
    reg.markFailed("a"); // "a" is now most-recent; "b" is oldest
    reg.markFailed("c"); // evicts "b", not "a"
    expect(reg.has("a")).toBe(true);
    expect(reg.has("b")).toBe(false);
    expect(reg.has("c")).toBe(true);
  });
});
