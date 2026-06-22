// Unit tests for the PURE data-URL → bytes decode used when re-uploading a
// decrypted meeting file as a server-readable package copy. `decryptMeetingFile`
// yields a `data:<mime>;base64,<payload>` URL (the same shape the canvas decodes
// from storage); `dataUrlToBytes` is the inverse — it turns that string back
// into the real binary + mime so the offline file is actually usable.
//
//   npx vitest run excalidraw-app/data/packages.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import { dataUrlToBytes } from "./packages";

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL back to the original bytes + mime", () => {
    // "hi" -> base64 "aGk=".
    const { bytes, mimeType } = dataUrlToBytes("data:image/png;base64,aGk=");
    expect(mimeType).toBe("image/png");
    expect(Array.from(bytes)).toEqual([0x68, 0x69]);
  });

  it("decodes a non-base64 (percent-encoded) data URL", () => {
    const { bytes, mimeType } = dataUrlToBytes(
      "data:text/plain,Hello%20World",
    );
    expect(mimeType).toBe("text/plain");
    expect(new TextDecoder().decode(bytes)).toBe("Hello World");
  });

  it("falls back to octet-stream when the mime is absent", () => {
    const { mimeType } = dataUrlToBytes("data:,x");
    expect(mimeType).toBe("application/octet-stream");
  });
});
