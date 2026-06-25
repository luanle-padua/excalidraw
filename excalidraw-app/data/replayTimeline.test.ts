// Unit tests for the PURE "who spoke when" builder (unified-replay-ux.md §2/§2.1).
//
// Pins the grouping / merge / width / sort / many-people shaping so the
// SpeakerLanes strip can stay a thin renderer over this model.
//
//   npx vitest run excalidraw-app/data/replayTimeline.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  buildConversationRibbon,
  buildSpeakerTimeline,
  partitionSpeakers,
} from "./replayTimeline";

import type { TranscriptSegment } from "./transcription";

const seg = (
  socketId: string,
  username: string,
  ts: number,
  text = "hello there friend",
): TranscriptSegment => ({
  id: `${socketId}-${ts}`,
  socketId,
  username,
  text,
  ts,
});

describe("buildSpeakerTimeline", () => {
  it("returns an empty model for an empty / nullish log", () => {
    expect(buildSpeakerTimeline([]).speakers).toEqual([]);
    expect(buildSpeakerTimeline(null).speakerCount).toBe(0);
    expect(buildSpeakerTimeline(undefined).transcriptT0).toBe(0);
  });

  it("groups by socketId and uses the latest username", () => {
    const model = buildSpeakerTimeline([
      seg("a", "Alice", 1000),
      seg("b", "Bob", 2000),
      seg("a", "Alice Renamed", 3000),
    ]);
    expect(model.speakerCount).toBe(2);
    const a = model.speakers.find((s) => s.id === "a")!;
    expect(a.name).toBe("Alice Renamed");
  });

  it("merges same-speaker segments within the gap threshold into one block", () => {
    const model = buildSpeakerTimeline(
      [seg("a", "Alice", 0), seg("a", "Alice", 1000), seg("a", "Alice", 2000)],
      { mergeGapMs: 4000 },
    );
    const a = model.speakers[0];
    expect(a.intervals).toHaveLength(1);
    expect(a.intervals[0].segmentCount).toBe(3);
    expect(a.intervals[0].startMs).toBe(0);
  });

  it("splits same-speaker segments separated by a long silence", () => {
    const model = buildSpeakerTimeline(
      [seg("a", "Alice", 0), seg("a", "Alice", 60000)],
      { mergeGapMs: 4000 },
    );
    expect(model.speakers[0].intervals).toHaveLength(2);
  });

  it("sorts lanes by talk time descending", () => {
    // Bob speaks twice (more talk time) -> should sort ahead of Alice.
    const model = buildSpeakerTimeline([
      seg("a", "Alice", 0),
      seg("b", "Bob", 10000),
      seg("b", "Bob", 80000),
    ]);
    expect(model.speakers[0].id).toBe("b");
  });

  it("tolerates an unsorted log and non-finite ts", () => {
    const bad = { ...seg("a", "Alice", Number.NaN) };
    const model = buildSpeakerTimeline([seg("b", "Bob", 5000), seg("a", "Alice", 1000), bad]);
    expect(model.speakerCount).toBe(2);
    // first interval start is the earliest valid ts
    expect(model.transcriptT0).toBe(1000);
  });

  it("gives a lone short segment a clickable minimum width", () => {
    const model = buildSpeakerTimeline([seg("a", "Alice", 1000, "hi")], {
      minWidthMs: 1200,
    });
    const iv = model.speakers[0].intervals[0];
    expect(iv.endMs - iv.startMs).toBeGreaterThanOrEqual(1200);
  });
});

describe("buildConversationRibbon", () => {
  it("produces ordered turn-taking blocks coloured by the current speaker", () => {
    const model = buildSpeakerTimeline([
      seg("a", "Alice", 0),
      seg("b", "Bob", 60000),
      seg("a", "Alice", 120000),
    ]);
    const ribbon = buildConversationRibbon(model);
    expect(ribbon.map((b) => b.id)).toEqual(["a", "b", "a"]);
    expect(ribbon.every((b) => b.startMs <= b.endMs)).toBe(true);
  });

  it("flags overlapping talk", () => {
    // Alice 0..(wide) and Bob starting inside her block -> overlap.
    const model = buildSpeakerTimeline(
      [seg("a", "Alice", 0, "a".repeat(200)), seg("b", "Bob", 500)],
      { maxSegmentWidthMs: 6000, minWidthMs: 1200 },
    );
    const ribbon = buildConversationRibbon(model);
    expect(ribbon.some((b) => b.overlap)).toBe(true);
  });

  it("returns [] for an empty model", () => {
    expect(buildConversationRibbon(buildSpeakerTimeline([]))).toEqual([]);
  });
});

describe("partitionSpeakers", () => {
  it("returns others: null when within topN", () => {
    const model = buildSpeakerTimeline([seg("a", "Alice", 0), seg("b", "Bob", 1000)]);
    expect(partitionSpeakers(model, 6).others).toBeNull();
  });

  it("folds the long tail into an aggregated others lane with merged intervals", () => {
    const segs: TranscriptSegment[] = [];
    for (let i = 0; i < 10; i++) {
      // give earlier speakers more talk so the cut is deterministic
      segs.push(seg(`p${i}`, `P${i}`, i * 100000));
      if (i < 4) {
        segs.push(seg(`p${i}`, `P${i}`, i * 100000 + 50000));
      }
    }
    const model = buildSpeakerTimeline(segs);
    const { top, others } = partitionSpeakers(model, 6);
    expect(top).toHaveLength(6);
    expect(others).not.toBeNull();
    expect(others!.members.length).toBe(4);
    // merged intervals are ascending and non-overlapping
    for (let i = 1; i < others!.intervals.length; i++) {
      expect(others!.intervals[i].startMs).toBeGreaterThan(
        others!.intervals[i - 1].startMs,
      );
    }
  });
});
