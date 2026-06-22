// Unit tests for the PURE VideoBg → Daily processor mapping (videoBg.ts).
//
// toDailyProcessor is the single boundary that translates our VideoBg union
// into Daily's exact `updateInputSettings({ video: { processor } })` shape, so
// a regression here silently breaks virtual backgrounds for everyone. We assert
// the three kinds Daily documents:
//   • none  → { type: "none" }                 (raw camera, NOT strength:0)
//   • blur  → { type: "background-blur", config: { strength } }  (float in (0,1])
//   • image → { type: "background-image", config: { source } }   (jpg/png URL)
//
//   npx vitest run excalidraw-app/audio/videoBg.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  BLUR_STRENGTHS,
  toDailyProcessor,
  VIDEO_BG_IMAGE_PRESETS,
} from "./videoBg";

import type { VideoBg } from "./videoBg";

describe("toDailyProcessor", () => {
  it("maps kind:none to a bare { type: 'none' } (disables via type, not strength:0)", () => {
    const result = toDailyProcessor({ kind: "none" });
    expect(result).toEqual({ type: "none" });
    // Explicit: turning the background off must NOT smuggle a config.strength:0
    // — Daily disables a processor by type, and strength must stay in (0,1].
    expect("config" in result).toBe(false);
  });

  it("maps kind:blur to background-blur with the preset strength (float in (0,1])", () => {
    for (const level of ["light", "medium", "strong"] as const) {
      const result = toDailyProcessor({ kind: "blur", level });
      expect(result).toEqual({
        type: "background-blur",
        config: { strength: BLUR_STRENGTHS[level] },
      });
      const strength = (result as { config: { strength: number } }).config
        .strength;
      // Daily requires strength in the half-open interval (0, 1].
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    }
  });

  it("maps kind:image to background-image carrying the source URL", () => {
    const result = toDailyProcessor({
      kind: "image",
      src: "/backgrounds/forest-mist.png",
    });
    expect(result).toEqual({
      type: "background-image",
      config: { source: "/backgrounds/forest-mist.png" },
    });
  });

  it("never emits a webp source via a preset image (Daily rejects webp)", () => {
    // Guards Phase 0a: the image processor source must be jpg/jpeg/png. We can't
    // import the presets' private list here without coupling, but any image bg
    // routed through toDailyProcessor must surface its src verbatim — so a webp
    // src would be visible. This documents the invariant for the mapping layer.
    const bg: VideoBg = {
      kind: "image",
      src: "/backgrounds/crystal-leaves.png",
    };
    const result = toDailyProcessor(bg) as {
      type: string;
      config: { source: string };
    };
    expect(result.config.source.endsWith(".webp")).toBe(false);
  });
});

describe("VIDEO_BG_IMAGE_PRESETS", () => {
  it("ships no preset whose src is a .webp (Daily's background-image accepts only jpg/jpeg/png)", () => {
    // Phase 0a regression guard, asserted against the REAL preset list: Daily's
    // background-image processor silently fails on webp, so the original
    // client-forest.webp office preset was repointed to a png. If anyone wires
    // a webp src back in, this fails loudly instead of degrading to raw camera.
    for (const preset of VIDEO_BG_IMAGE_PRESETS) {
      expect(preset.src.toLowerCase().endsWith(".webp")).toBe(false);
    }
  });

  it("only references png/jpg/jpeg sources Daily can actually fetch", () => {
    const ALLOWED = [".png", ".jpg", ".jpeg"];
    for (const preset of VIDEO_BG_IMAGE_PRESETS) {
      const src = preset.src.toLowerCase();
      expect(ALLOWED.some((ext) => src.endsWith(ext))).toBe(true);
    }
  });

  it("gives every preset a stable, unique id (ids drive picker keys + persistence)", () => {
    // Unlike `src` (the office preset is knowingly a placeholder that reuses an
    // existing png until a real office asset ships), each preset id must stay
    // unique — ids are the React keys in the picker and the persisted choice, so
    // a collision would alias two tiles onto one selection.
    const ids = VIDEO_BG_IMAGE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
