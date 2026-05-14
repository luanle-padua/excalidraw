// Single WebRTC peer wrapper. Owns one RTCPeerConnection plus the
// remote-side <audio> element that plays the inbound stream, and runs a
// lightweight Web Audio analyser so the UI can show a speaking ring
// without doing the work at every render.

export type AudioPeerEvents = {
  onSignal: (signal: { type: "offer" | "answer" | "ice"; data: unknown }) => void;
  onSpeaking?: (speaking: boolean) => void;
  onClosed?: () => void;
  /** fires once the remote MediaStream arrives — used by the recorder
   *  to add this peer's audio into the mix */
  onRemoteStream?: (stream: MediaStream) => void;
};

const SPEAKING_THRESHOLD = 22; // 0..255 — empirical, comfortably above silence
const SPEAKING_RELEASE_MS = 250; // hysteresis so brief gaps don't flicker

// All peer <audio> elements live in this hidden container so iOS Safari
// will actually play them — detached audio elements don't autoplay on
// iOS regardless of user gesture or attribute combinations.
let hiddenAudioRoot: HTMLDivElement | null = null;
const getHiddenAudioRoot = (): HTMLDivElement => {
  if (hiddenAudioRoot && hiddenAudioRoot.isConnected) {
    return hiddenAudioRoot;
  }
  const el = document.createElement("div");
  el.setAttribute("data-mcm-audio-root", "");
  el.style.position = "absolute";
  el.style.width = "0";
  el.style.height = "0";
  el.style.overflow = "hidden";
  el.style.pointerEvents = "none";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  hiddenAudioRoot = el;
  return el;
};

export class AudioPeer {
  readonly remoteSocketId: string;
  private readonly events: AudioPeerEvents;
  private readonly pc: RTCPeerConnection;
  private readonly audioEl: HTMLAudioElement;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;

  /** Exposed for the recorder so it can pick up streams that arrived
   *  before recording started. */
  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  // Speaking-detection state
  private analyser: AnalyserNode | null = null;
  private analyserCtx: AudioContext | null = null;
  // explicit ArrayBuffer-backed Uint8Array — getByteFrequencyData's
  // newer DOM lib typing rejects ArrayBufferLike (SharedArrayBuffer is
  // not allowed for Web Audio)
  private analyserBuffer: Uint8Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private speaking = false;
  private lastLoudAt = 0;
  /** queue ICE candidates that arrive before we've set the remote
   *  description (offer/answer); flush once remote description is set */
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(
    remoteSocketId: string,
    iceServers: RTCIceServer[],
    events: AudioPeerEvents,
  ) {
    this.remoteSocketId = remoteSocketId;
    this.events = events;
    this.pc = new RTCPeerConnection({ iceServers });

    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    this.audioEl.dataset.mcmPeer = remoteSocketId;
    // iOS Safari quirks: detached <audio> elements never autoplay even
    // with a user-gesture upstream, and `playsInline` is required for
    // streamed audio inside a regular tab. Attaching to a hidden root
    // also gives us a real <audio> element the user agent can show in
    // its tab indicator.
    // `playsInline` is a video-element prop in the TS DOM lib but iOS
    // Safari respects it on audio too — apply via attribute to bypass
    // the type narrowing.
    this.audioEl.setAttribute("playsinline", "");
    this.audioEl.controls = false;
    getHiddenAudioRoot().appendChild(this.audioEl);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.events.onSignal({ type: "ice", data: e.candidate.toJSON() });
      }
    };
    this.pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (!stream) {
        return;
      }
      console.info(
        `[audio] ontrack from ${remoteSocketId} — tracks=${stream
          .getTracks()
          .map((t) => t.kind)
          .join(",")}`,
      );
      this.remoteStream = stream;
      this.audioEl.srcObject = stream;
      // iOS Safari sometimes won't kick off playback from autoplay alone
      // for streamed sources — explicitly call play() and swallow the
      // resulting promise rejection (which happens if the gesture has
      // already expired; the AudioRoom warms a context up-front to keep
      // the gesture chain alive across the async signaling round-trip).
      const playPromise = this.audioEl.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((err) => {
          console.warn(
            `[audio] play() rejected for ${remoteSocketId}`,
            err,
          );
        });
      }
      this.attachSpeakingAnalyser(stream);
      this.events.onRemoteStream?.(stream);
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.info(`[audio] peer ${remoteSocketId} connection: ${state}`);
      // Only "failed" and "closed" are terminal. "disconnected" is a
      // transient hiccup (lost ICE keep-alive) and WebRTC will usually
      // recover within seconds — tearing the peer down on it is what
      // kept rejoins from reconnecting.
      if (state === "failed" || state === "closed") {
        this.events.onClosed?.();
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      console.info(
        `[audio] peer ${remoteSocketId} ICE: ${this.pc.iceConnectionState}`,
      );
    };
  }

  setLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        this.pc.addTrack(track, stream);
      }
    } else {
      // Listener-only mode (no mic on this device). Declare a recvonly
      // audio transceiver so the SDP still negotiates one media line
      // and the remote's audio can flow through `ontrack`.
      this.pc.addTransceiver("audio", { direction: "recvonly" });
    }
  }

  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
    await this.pc.setLocalDescription(offer);
    this.events.onSignal({ type: "offer", data: offer });
  }

  async handleRemoteOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.events.onSignal({ type: "answer", data: answer });
  }

  async handleRemoteAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  async handleRemoteIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  }

  private async flushPendingIce(): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn("queued addIceCandidate failed", err);
      }
    }
  }

  private attachSpeakingAnalyser(stream: MediaStream) {
    try {
      const ctx = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      src.connect(analyser);
      this.analyser = analyser;
      this.analyserCtx = ctx;
      this.analyserBuffer = new Uint8Array(
        new ArrayBuffer(analyser.frequencyBinCount),
      );
      this.tickSpeaking();
    } catch (err) {
      console.warn("speaking analyser failed", err);
    }
  }

  private tickSpeaking = () => {
    if (!this.analyser || !this.analyserBuffer) {
      return;
    }
    this.analyser.getByteFrequencyData(this.analyserBuffer);
    let sum = 0;
    for (let i = 0; i < this.analyserBuffer.length; i++) {
      sum += this.analyserBuffer[i];
    }
    const avg = sum / this.analyserBuffer.length;
    const now = performance.now();

    if (avg > SPEAKING_THRESHOLD) {
      this.lastLoudAt = now;
      if (!this.speaking) {
        this.speaking = true;
        this.events.onSpeaking?.(true);
      }
    } else if (
      this.speaking &&
      now - this.lastLoudAt > SPEAKING_RELEASE_MS
    ) {
      this.speaking = false;
      this.events.onSpeaking?.(false);
    }

    this.rafId = requestAnimationFrame(this.tickSpeaking);
  };

  close() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.analyserCtx) {
      this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    this.analyser = null;
    this.analyserBuffer = null;
    this.audioEl.pause();
    this.audioEl.srcObject = null;
    this.audioEl.remove();
    try {
      this.pc.close();
    } catch {
      // already closed
    }
  }
}
