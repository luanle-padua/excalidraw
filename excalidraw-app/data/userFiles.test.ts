import { describe, expect, it } from "vitest";

import { thumbDimensions, USER_FILE_THUMB_MAX_EDGE } from "./userFiles";

describe("thumbDimensions", () => {
  it("never upscales a small image", () => {
    expect(thumbDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it("downscales a wide image to the max edge, preserving aspect", () => {
    const { width, height } = thumbDimensions(1920, 1080);
    expect(width).toBe(USER_FILE_THUMB_MAX_EDGE);
    expect(height).toBe(Math.round((1080 / 1920) * USER_FILE_THUMB_MAX_EDGE));
  });

  it("downscales a tall image by its longest (height) edge", () => {
    const { width, height } = thumbDimensions(1000, 4000);
    expect(height).toBe(USER_FILE_THUMB_MAX_EDGE);
    expect(width).toBe(Math.round((1000 / 4000) * USER_FILE_THUMB_MAX_EDGE));
  });

  it("respects a custom max edge", () => {
    expect(thumbDimensions(2000, 1000, 256)).toEqual({ width: 256, height: 128 });
  });

  it("clamps to at least 1px and never returns 0 for extreme ratios", () => {
    const { width, height } = thumbDimensions(10000, 1, 384);
    expect(width).toBe(384);
    expect(height).toBe(1);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("handles a zero-sized source without dividing by zero", () => {
    expect(thumbDimensions(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
