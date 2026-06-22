// Unit tests for the pre-join "green room" camera-preview TEARDOWN RACE
// (Item 6, docs/plans/meeting-bugs-and-ux-fixes.md §3).
//
// The bug these lock down: if the user toggles the camera OFF (or the modal
// unmounts) WHILE previewCamera()'s getUserMedia permission prompt is still
// pending, the modal cleanup calls stopPreview() — which used to be a no-op
// because previewStream was still null — and then getUserMedia resolves and
// stores the now-orphaned stream. Nothing tore it down, so the camera light
// stayed ON while the UI showed camera OFF. The fix gives previewCamera() an
// AbortController that stopPreview() aborts, so a late-resolving acquisition
// stops its OWN tracks instead of storing a leaked camera.
//
//   npx vitest run excalidraw-app/audio/previewCamera.test.ts   (from repo root)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyAudio } from "./DailyAudio";

/** A fake MediaStreamTrack that records whether stop() was called — the proxy
 *  for "is the camera light still on". */
const makeTrack = () => {
  const track = { stop: vi.fn() };
  return track as unknown as MediaStreamTrack & {
    stop: ReturnType<typeof vi.fn>;
  };
};

/** A fake MediaStream wrapping one video track. */
const makeStream = () => {
  const track = makeTrack();
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
};

/** A getUserMedia we can resolve on demand, so we can interleave a stopPreview()
 *  BETWEEN the call and its resolution (the teardown race window). */
const makeDeferredGUM = () => {
  let resolve!: (s: MediaStream) => void;
  const promise = new Promise<MediaStream>((r) => {
    resolve = r;
  });
  const getUserMedia = vi.fn(() => promise);
  return { getUserMedia, resolve };
};

const makeAudio = () =>
  new DailyAudio({
    roomId: "room",
    userName: "tester",
    getSocketId: () => "socket-1",
    getToken: async () => null,
    // previewCamera/stopPreview touch no events; onState is the only required
    // member, so a no-op satisfies the type without exercising the call path.
    events: { onState: () => undefined },
  });

let originalMediaDevices: MediaDevices | undefined;

beforeEach(() => {
  originalMediaDevices = navigator.mediaDevices;
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    value: originalMediaDevices,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

const setGUM = (getUserMedia: MediaDevices["getUserMedia"]) => {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia, enumerateDevices: vi.fn() },
    configurable: true,
    writable: true,
  });
};

describe("DailyAudio.previewCamera / stopPreview teardown race", () => {
  it("normal acquire then stopPreview stops the camera tracks", async () => {
    const { stream, track } = makeStream();
    setGUM(vi.fn(async () => stream));

    const audio = makeAudio();
    const got = await audio.previewCamera();

    expect(got).toBe(stream);
    expect(track.stop).not.toHaveBeenCalled();

    audio.stopPreview();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stopPreview WHILE getUserMedia is pending → late stream is stopped, NOT leaked", async () => {
    const { stream, track } = makeStream();
    const { getUserMedia, resolve } = makeDeferredGUM();
    setGUM(getUserMedia);

    const audio = makeAudio();
    // Start the acquisition but do NOT await yet — the permission prompt is
    // "pending".
    const pending = audio.previewCamera();

    // User toggles camera OFF / modal unmounts: cleanup fires stopPreview()
    // while the stream is still pending (previewStream is still null here).
    audio.stopPreview();

    // Now the permission prompt resolves — the late stream must stop its own
    // tracks instead of being stored.
    resolve(stream);
    const got = await pending;

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(got).toBeNull();
    // No leaked stream retained: a follow-up stopPreview is a harmless no-op
    // (nothing more to stop).
    track.stop.mockClear();
    audio.stopPreview();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("re-acquiring after a cancelled-in-flight preview works (controller reset)", async () => {
    // First acquisition is aborted mid-flight…
    const first = makeStream();
    const firstGUM = makeDeferredGUM();
    setGUM(firstGUM.getUserMedia);
    const audio = makeAudio();
    const pending1 = audio.previewCamera();
    audio.stopPreview();
    firstGUM.resolve(first.stream);
    expect(await pending1).toBeNull();
    expect(first.track.stop).toHaveBeenCalledTimes(1);

    // …a subsequent (camera toggled back ON) acquisition must succeed and be
    // retained — proving stopPreview cleared the previous abort controller.
    const second = makeStream();
    setGUM(vi.fn(async () => second.stream));
    const got2 = await audio.previewCamera();
    expect(got2).toBe(second.stream);
    expect(second.track.stop).not.toHaveBeenCalled();
  });

  it("idempotent: a second previewCamera returns the existing stream", async () => {
    const { stream } = makeStream();
    setGUM(vi.fn(async () => stream));
    const audio = makeAudio();
    const a = await audio.previewCamera();
    const b = await audio.previewCamera();
    expect(a).toBe(stream);
    expect(b).toBe(stream);
  });

  it("returns null (non-fatal) when getUserMedia rejects (no device / denied)", async () => {
    setGUM(vi.fn(async () => Promise.reject(new Error("NotAllowedError"))));
    const audio = makeAudio();
    await expect(audio.previewCamera()).resolves.toBeNull();
  });
});
