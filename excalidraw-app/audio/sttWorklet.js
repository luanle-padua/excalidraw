// AudioWorkletProcessor that converts the browser's native audio
// (Float32, 48kHz typically) to the format Deepgram expects:
// 16-bit signed little-endian PCM at 16kHz, mono.
//
// Runs on the audio thread (not main JS) so it's resilient to UI
// jank — no dropped samples even when the React tree re-renders.
//
// Output flow:
//   process() is called every render quantum (128 frames @ native rate)
//     ↓
//   downsample stride (e.g. 48000/16000 = 3) → pick every 3rd frame
//     ↓
//   Float32 [-1.0, 1.0]  →  Int16 [-32768, 32767]
//     ↓
//   Pack into ArrayBuffer, post to main thread every ~250ms worth of audio
//
// The main thread relays the ArrayBuffer to the STT WebSocket.
//
// IMPORTANT: this MUST stay PLAIN JAVASCRIPT (no TypeScript syntax). It is
// loaded as a Worklet via `import './sttWorklet.js?url'` in sttSession.ts —
// Vite emits the file VERBATIM as a static asset (it is NOT transpiled or
// bundled, because the worklet runs in its own isolated global scope and
// imports nothing). A `.ts` version worked in `vite dev` (the dev server
// transpiles on the fly) but the production build copied the raw `.ts`, which
// (a) contains un-parseable TS syntax and (b) is served as `video/mp2t` by the
// host — both make `audioWorklet.addModule()` fail with "Unable to load a
// worklet's module". Keeping this as `.js` makes the emitted asset valid JS
// served with a JavaScript MIME type.

const TARGET_SAMPLE_RATE = 16000;
// Buffer ~250ms of 16kHz mono before posting → 4 messages/sec.
// Smaller = lower latency, larger = fewer postMessage calls.
const TARGET_BUFFER_SAMPLES = 16000 / 4;

class STTDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.downsampleOffset = 0;
    this.outputCursor = 0;
    // AudioWorkletGlobalScope.sampleRate is the AudioContext's rate.
    this.downsampleStride = Math.max(
      1,
      Math.round(sampleRate / TARGET_SAMPLE_RATE),
    );
    this.outputBuffer = new Int16Array(TARGET_BUFFER_SAMPLES);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true; // no mic data this tick, keep alive
    }
    // Mic input is mono — take channel 0 (or average if multi-channel
    // somehow gets through).
    const channel = input[0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      if (this.downsampleOffset === 0) {
        // Clamp Float32 to [-1, 1] then scale to Int16 range.
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this.outputBuffer[this.outputCursor++] =
          sample < 0 ? sample * 0x8000 : sample * 0x7fff;

        if (this.outputCursor >= this.outputBuffer.length) {
          // Copy out (transferable) — re-use the same Int16Array slot
          // and re-allocate a fresh one for next batch so the main
          // thread owns its copy.
          const out = this.outputBuffer.buffer.slice(0);
          this.port.postMessage(out, [out]);
          this.outputBuffer = new Int16Array(TARGET_BUFFER_SAMPLES);
          this.outputCursor = 0;
        }
      }
      this.downsampleOffset =
        (this.downsampleOffset + 1) % this.downsampleStride;
    }
    return true;
  }
}

registerProcessor("stt-downsampler", STTDownsampler);
