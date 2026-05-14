// Diagnostic helper: capture a few seconds of the local mic to a Blob
// and let the user play it back in the browser. The point is to prove
// — without leaving the page — that the *capture* half of the pipeline
// works, so when a remote peer hears nothing we can isolate whether
// it's a capture problem (mic broken / silent) or a transmission
// problem (signaling / TURN / decode).

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

const pickMimeType = (): string | undefined => {
  for (const t of PREFERRED_MIME_TYPES) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(t)
    ) {
      return t;
    }
  }
  return undefined;
};

export type MicRecording = {
  blob: Blob;
  url: string;
  mimeType: string;
  durationMs: number;
};

export const recordMic = (
  stream: MediaStream,
  durationMs: number,
): Promise<MicRecording> =>
  new Promise((resolve, reject) => {
    if (typeof MediaRecorder === "undefined") {
      reject(new Error("MediaRecorder không được hỗ trợ trên thiết bị này"));
      return;
    }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      reject(err as Error);
      return;
    }

    const chunks: BlobPart[] = [];
    const startedAt = performance.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };
    recorder.onerror = (e) => {
      reject((e as any)?.error ?? new Error("MediaRecorder error"));
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      const url = URL.createObjectURL(blob);
      resolve({
        blob,
        url,
        mimeType: blob.type,
        durationMs: performance.now() - startedAt,
      });
    };

    recorder.start();
    window.setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);
  });
