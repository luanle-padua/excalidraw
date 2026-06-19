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
//   anti-alias decimation: AVERAGE each stride-window of frames (box filter)
//   instead of picking every Nth sample raw → suppresses the aliasing that
//   raw decimation folds back into the 0-8kHz speech band
//     ↓
//   Float32 [-1.0, 1.0]  →  Int16 [-32768, 32767]
//     ↓
//   Pack into ArrayBuffer, post to main thread every ~100ms worth of audio
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
// Buffer ~100ms of 16kHz mono before posting → ~10 messages/sec (was 250ms/4).
// WHY smaller: the PM asked to "speed up delivery" of text. A smaller chunk is
// flushed to Deepgram sooner, so interim hypotheses come back sooner (lower
// time-to-first-word). Trade-off: ~10 postMessage + WS frames/sec instead of 4
// — still trivial (each frame is ~1600 samples = 3.2KB), so the extra framing
// cost is negligible next to the latency win. We don't go below ~100ms because
// sub-chunk WS frames add overhead without a perceptible latency gain (Deepgram
// batches internally) and inflate frame count on slow uplinks.
const TARGET_BUFFER_SAMPLES = 16000 / 10;

class STTDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputCursor = 0;
    // AudioWorkletGlobalScope.sampleRate is the AudioContext's rate.
    this.downsampleStride = Math.max(
      1,
      Math.round(sampleRate / TARGET_SAMPLE_RATE),
    );
    this.outputBuffer = new Int16Array(TARGET_BUFFER_SAMPLES);
    // Anti-alias accumulator state (see process()). We average the input
    // samples that fall in each output sample's stride-window — a moving box
    // filter — instead of decimating raw. `accSum`/`accCount` carry a partial
    // window ACROSS process() calls, since a 128-frame quantum rarely divides
    // evenly by the stride (e.g. 128 / 3 leaves a remainder), so the last
    // window of one quantum continues into the next.
    this.accSum = 0;
    this.accCount = 0;
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

    const stride = this.downsampleStride;
    for (let i = 0; i < channel.length; i++) {
      // ANTI-ALIASING: accumulate every input sample, then emit one output
      // sample per stride-window as the window AVERAGE. Raw decimation (taking
      // only every Nth sample) lets energy above the 8kHz Nyquist of the 16kHz
      // target fold back as aliasing distortion — worst exactly when there is
      // background noise, which is broadband. A box-filter average is a cheap
      // low-pass that attenuates that out-of-band energy before we drop the
      // rate, giving Deepgram cleaner 16k PCM. Cost: one add per input sample
      // + one divide per output sample (~16k divides/sec) — negligible on the
      // audio thread, and no per-sample branch/modulo.
      this.accSum += channel[i];
      this.accCount++;
      if (this.accCount >= stride) {
        // Window average → clamp to [-1, 1] → scale to Int16.
        const avg = this.accSum / this.accCount;
        const sample = avg < -1 ? -1 : avg > 1 ? 1 : avg;
        this.outputBuffer[this.outputCursor++] =
          sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        this.accSum = 0;
        this.accCount = 0;

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
    }
    return true;
  }
}

registerProcessor("stt-downsampler", STTDownsampler);
