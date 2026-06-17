// DailyAudio — voice call backed by Daily.co's SFU, a DROP-IN replacement for
// the mesh AudioRoom. Same public surface (start/stop/toggleMute/isMuted/
// isActive/getLocalStream/getPeerStreams) and the same AudioRoomEvents
// (onState{peers,muted,canTransmit} + onPeerStream/onPeerRemoved/onError), so
// AudioRoomController, MeetingCallControls, the recorder and STT all keep
// working unchanged.
//
// Why move off the mesh: a full mesh has each client upload N-1 streams, which
// breaks past ~6-8 people. Daily is an SFU (upload once, server fans out) so it
// scales to enterprise meetings.
//
// Identity bridge: the app keys participants by the socket.io socket.id, but
// Daily keys by session_id. We tag our Daily participant with userData.socketId
// (setUserData) so we can map remote Daily participants back to socket.id and
// keep ParticipantsBar's speaking rings / mic dots on the right avatars.
//
// Audio playback: daily-js call-object mode plays remote audio automatically —
// we do NOT attach <audio> elements (that would double the audio). We only tap
// each remote track into a (speaker-disconnected) analyser for speaking
// detection and expose it as a MediaStream for the recorder.
//
// Audio runs in its OWN Daily room ("<roomId>-audio") so it never collides with
// the screen-share room ("<roomId>"). Merging both into one room/session (for
// unified recording) is a later optimization.

import Daily from "@daily-co/daily-js";

import type {
  DailyCall,
  DailyEventObjectTrack,
  DailyEventObjectParticipant,
  DailyEventObjectParticipantLeft,
  DailyEventObjectFatalError,
  DailyParticipant,
} from "@daily-co/daily-js";

import type { AudioRoomEvents, PeerState } from "./audioTypes";

export type DailyTokenFetcher = (
  roomId: string,
  userName: string,
  userId?: string,
) => Promise<{ url: string; token: string } | null>;

const SPEAKING_THRESHOLD = 22; // 0..255, matches AudioPeer
const SPEAKING_RELEASE_MS = 250;

const log = (...a: unknown[]) => console.info("[audio]", ...a);
const warn = (...a: unknown[]) => console.warn("[audio]", ...a);

type RemotePeer = {
  socketId: string;
  sessionId: string;
  stream: MediaStream;
  /** hidden <audio> element that actually plays this peer's voice to the
   *  speakers. call-object mode does NOT auto-play remote audio, so without
   *  this the peer is recorded but inaudible live (see playPeerAudio). */
  audioEl: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  buffer: Uint8Array<ArrayBuffer> | null;
  raf: number | null;
  speaking: boolean;
  lastLoudAt: number;
};

export class DailyAudio {
  private readonly roomId: string;
  private readonly userName: string;
  /** read lazily: the socket.id may not be assigned when the manager is
   *  constructed (socket connects async), but it always is by start() time. */
  private readonly getSocketId: () => string | null;
  private readonly getToken: DailyTokenFetcher;
  private readonly events: AudioRoomEvents;

  private call: DailyCall | null = null;
  private localStream: MediaStream | null = null;
  private muted = false;
  private active = false;
  /** local camera is publishing (default OFF — opt-in via toggleCamera) */
  private cameraOn = false;
  /** the local self-view MediaStream while the camera is on (mirrored in UI) */
  private localVideoStream: MediaStream | null = null;
  /** session_id → socket.id for VIDEO tracks specifically, so a
   *  participant-left / track-stopped that only carries a session can still
   *  resolve the tile to drop (video peers may differ from audio peers — a
   *  listener-only participant with camera on has no audio RemotePeer). */
  private videoSessionToSocket = new Map<string, string>();
  /** socket.ids that currently have a published remote video track, so we can
   *  clean up on stop()/leave without re-deriving from Daily state. */
  private videoSockets = new Set<string>();

  /** keyed by socket.id, like the mesh */
  private peers = new Map<string, RemotePeer>();
  /** session_id → socket.id, for participant-left (which only gives session) */
  private sessionToSocket = new Map<string, string>();
  private analyserCtx: AudioContext | null = null;

  constructor(opts: {
    roomId: string;
    userName: string;
    getSocketId: () => string | null;
    getToken: DailyTokenFetcher;
    events: AudioRoomEvents;
  }) {
    this.roomId = `${opts.roomId}-audio`;
    this.userName = opts.userName;
    this.getSocketId = opts.getSocketId;
    this.getToken = opts.getToken;
    this.events = opts.events;
  }

  // ---- lifecycle (mirrors AudioRoom) -------------------------------------

  async start(): Promise<void> {
    if (this.active) {
      log("DailyAudio.start() called but already active");
      return;
    }
    this.active = true;

    // 1) Acquire mic (or fall back to listener-only on no-mic, like the mesh).
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      log(`got mic (tracks=${this.localStream.getAudioTracks().length})`);
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        log("no mic — joining as listener");
        this.localStream = null;
      } else {
        this.active = false;
        this.events.onError?.(err as Error);
        throw err;
      }
    }

    // 2) Token for the audio room — tag it with our socket.id (Daily user_id)
    //    so peers can map us back to the collab identity.
    const cfg = await this.getToken(
      this.roomId,
      this.userName,
      this.getSocketId() ?? undefined,
    );
    if (!this.active) {
      // stopped while awaiting
      this.releaseMic();
      return;
    }
    if (!cfg) {
      this.active = false;
      this.releaseMic();
      // Message is dev-facing detail only — the UI shows an i18n string
      // mapped from audioState.errorKind, never this text.
      const err = new Error("could not fetch the call token (Daily)");
      this.events.onError?.(err);
      throw err;
    }

    // 3) Join Daily with our mic as the audio source. Camera is DEFAULT OFF
    //    (videoSource:false at join) — the user opts in later via
    //    toggleCamera(), which calls setLocalVideo(true) / startCamera() on the
    //    same call object. Identity is tagged so peers map us to collab.
    const micTrack = this.localStream?.getAudioTracks()[0] ?? null;
    const call = Daily.createCallObject({
      audioSource: micTrack ?? false,
      videoSource: false,
      subscribeToTracksAutomatically: true,
      // audio + screen share are two separate call objects on the same page
      allowMultipleCallInstances: true,
    });
    this.call = call;
    try {
      call.setUserData({ socketId: this.getSocketId() ?? "" });
    } catch (err) {
      warn("setUserData failed", err);
    }
    this.wire(call);

    try {
      await call.join({
        url: cfg.url,
        token: cfg.token,
        userName: this.userName,
        startVideoOff: true,
      });
    } catch (err) {
      warn("join failed", err);
      this.active = false;
      await call.destroy().catch(() => undefined);
      this.call = null;
      this.releaseMic();
      const e =
        err instanceof Error ? err : new Error("could not join the call");
      this.events.onError?.(e);
      throw e;
    }
    if (!this.active) {
      // stopped during join
      await call.leave().catch(() => undefined);
      await call.destroy().catch(() => undefined);
      this.call = null;
      this.releaseMic();
      return;
    }
    // If muted was toggled before join finished, honour it.
    if (this.muted && micTrack) {
      call.setLocalAudio(false);
    }
    this.emitState();
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    // Tear down every remote video tile + the local self-view.
    for (const socketId of Array.from(this.videoSockets)) {
      this.events.onVideoRemoved?.(socketId);
    }
    this.videoSockets.clear();
    this.videoSessionToSocket.clear();
    this.releaseLocalVideo();
    this.cameraOn = false;
    for (const peer of this.peers.values()) {
      this.teardownPeer(peer);
    }
    this.peers.clear();
    this.sessionToSocket.clear();
    if (this.analyserCtx) {
      this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    const call = this.call;
    this.call = null;
    if (call) {
      call.leave().catch(() => undefined);
      call.destroy().catch(() => undefined);
    }
    this.releaseMic();
    this.muted = false;
    this.emitState();
  }

  private releaseMic() {
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        t.stop();
      }
      this.localStream = null;
    }
  }

  toggleMute(): boolean {
    if (!this.localStream) {
      this.muted = true; // listener mode — stays "muted"
      this.emitState();
      return true;
    }
    this.muted = !this.muted;
    for (const t of this.localStream.getAudioTracks()) {
      t.enabled = !this.muted;
    }
    this.call?.setLocalAudio(!this.muted);
    this.emitState();
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  isActive(): boolean {
    return this.active;
  }

  /** The local mic stream — consumed by STT (unchanged binding). */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** Remote audio streams for the recorder mixer (keyed by socket.id). */
  getPeerStreams(): Array<{ socketId: string; stream: MediaStream }> {
    const out: Array<{ socketId: string; stream: MediaStream }> = [];
    for (const [socketId, peer] of this.peers) {
      out.push({ socketId, stream: peer.stream });
    }
    return out;
  }

  // ---- camera (opt-in video on the SAME call object) --------------------

  /** Whether the local camera is currently publishing. */
  isCameraOn(): boolean {
    return this.cameraOn;
  }

  /**
   * Turn the local camera on/off on the EXISTING call object — no new Daily
   * room. Default is OFF; this is only ever called from a user toggle.
   *
   * Returns the resulting camera state. Throws on permission denial (the UI
   * surfaces a toast and stays OFF). Requires an active call (mic joined).
   */
  async setCamera(on: boolean): Promise<boolean> {
    const call = this.call;
    if (!call || !this.active) {
      // Can't publish video before joining the call.
      return this.cameraOn;
    }
    if (on === this.cameraOn) {
      return this.cameraOn;
    }
    if (on) {
      // Acquire a reasonably-sized camera (NOT full HD) to keep Daily/egress
      // cost down; Daily applies simulcast/quality defaults on top.
      let camStream: MediaStream;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 24, max: 30 },
            facingMode: "user",
          },
          audio: false,
        });
      } catch (err) {
        // Re-thrown for the caller (the camera toggle) to surface via the
        // cameraStateAtom toast — deliberately NOT routed through
        // events.onError, which is the AUDIO call's error channel and would
        // wrongly flip the whole call into an error state.
        warn("camera getUserMedia failed", err);
        throw err;
      }
      if (!this.active || this.call !== call) {
        // toggled off / left while awaiting the permission prompt
        for (const t of camStream.getTracks()) {
          t.stop();
        }
        return this.cameraOn;
      }
      const camTrack = camStream.getVideoTracks()[0] ?? null;
      this.releaseLocalVideo();
      this.localVideoStream = camStream;
      try {
        await call.setInputDevicesAsync({ videoSource: camTrack ?? false });
        call.setLocalVideo(true);
      } catch (err) {
        warn("setLocalVideo(on) failed", err);
        this.releaseLocalVideo();
        throw err;
      }
      this.cameraOn = true;
      // Self-view: surface the local camera stream to our own tile (mirrored
      // in the UI). The local track does NOT arrive via track-started for the
      // local participant in a way we subscribe to, so we publish it here.
      const selfSocketId = this.getSocketId();
      if (selfSocketId && camTrack) {
        this.videoSockets.add(selfSocketId);
        this.events.onVideoTrack?.(selfSocketId, new MediaStream([camTrack]));
      }
    } else {
      try {
        call.setLocalVideo(false);
      } catch (err) {
        warn("setLocalVideo(off) failed", err);
      }
      this.cameraOn = false;
      const selfSocketId = this.getSocketId();
      if (selfSocketId && this.videoSockets.has(selfSocketId)) {
        this.videoSockets.delete(selfSocketId);
        this.events.onVideoRemoved?.(selfSocketId);
      }
      this.releaseLocalVideo();
    }
    return this.cameraOn;
  }

  private releaseLocalVideo() {
    if (this.localVideoStream) {
      for (const t of this.localVideoStream.getTracks()) {
        t.stop();
      }
      this.localVideoStream = null;
    }
  }

  // ---- Daily events ------------------------------------------------------

  private wire(call: DailyCall) {
    call.on("track-started", this.onTrackStarted);
    call.on("track-stopped", this.onTrackStopped);
    call.on("track-started", this.onVideoStarted);
    call.on("track-stopped", this.onVideoStopped);
    call.on("participant-updated", this.onParticipantUpdated);
    call.on("participant-left", this.onParticipantLeft);
    call.on("error", this.onFatalError);
  }

  // ---- remote camera video tracks → ParticipantsBar tiles ----------------

  private onVideoStarted = (e: DailyEventObjectTrack) => {
    // Only CAMERA tracks (type "video"); screen share is "screenVideo" and
    // lives on a different call object entirely.
    if (e.type !== "video" || !e.participant) {
      return;
    }
    // The local self-view is published directly in setCamera(); ignore the
    // local echo here so we don't double-emit (and to keep the mirror flag
    // purely a UI concern keyed on isMe).
    if (e.participant.local) {
      return;
    }
    const socketId = this.socketIdOf(e.participant);
    if (!socketId) {
      return; // userData not propagated yet — participant-updated retries
    }
    this.videoSessionToSocket.set(e.participant.session_id, socketId);
    this.videoSockets.add(socketId);
    this.events.onVideoTrack?.(socketId, new MediaStream([e.track]));
    log(`remote video from ${e.participant.user_name} (${socketId})`);
  };

  private onVideoStopped = (e: DailyEventObjectTrack) => {
    if (e.type !== "video" || !e.participant || e.participant.local) {
      return;
    }
    const socketId =
      this.socketIdOf(e.participant) ??
      this.videoSessionToSocket.get(e.participant.session_id);
    if (socketId) {
      this.dropVideo(socketId);
    }
  };

  private dropVideo(socketId: string) {
    if (!this.videoSockets.has(socketId)) {
      return;
    }
    this.videoSockets.delete(socketId);
    for (const [sid, sock] of this.videoSessionToSocket) {
      if (sock === socketId) {
        this.videoSessionToSocket.delete(sid);
      }
    }
    this.events.onVideoRemoved?.(socketId);
  }

  private socketIdOf(p: DailyParticipant | null | undefined): string | null {
    // Primary: the Daily user_id we baked into the token (= our socket.id).
    // Fallback: userData.socketId (set via setUserData).
    if (p?.user_id) {
      return p.user_id;
    }
    const data = p?.userData as { socketId?: string } | undefined;
    return data?.socketId ?? null;
  }

  private onTrackStarted = (e: DailyEventObjectTrack) => {
    if (e.type !== "audio" || !e.participant || e.participant.local) {
      return;
    }
    const socketId = this.socketIdOf(e.participant);
    const sessionId = e.participant.session_id;
    if (!socketId) {
      // userData not propagated yet — participant-updated will retry.
      return;
    }
    this.sessionToSocket.set(sessionId, socketId);
    if (this.peers.has(socketId)) {
      return;
    }
    const stream = new MediaStream([e.track]);
    const peer: RemotePeer = {
      socketId,
      sessionId,
      stream,
      audioEl: null,
      analyser: null,
      buffer: null,
      raf: null,
      speaking: false,
      lastLoudAt: 0,
    };
    this.peers.set(socketId, peer);
    this.attachAnalyser(peer);
    this.playPeerAudio(peer);
    this.setPeerState(socketId, {
      socketId,
      speaking: false,
      hasRemoteStream: true,
    });
    this.events.onPeerStream?.(socketId, stream);
    log(`remote audio from ${e.participant.user_name} (${socketId})`);
  };

  private onTrackStopped = (e: DailyEventObjectTrack) => {
    if (e.type !== "audio" || !e.participant || e.participant.local) {
      return;
    }
    const socketId =
      this.socketIdOf(e.participant) ??
      this.sessionToSocket.get(e.participant.session_id);
    if (socketId) {
      this.dropPeer(socketId);
    }
  };

  private onParticipantUpdated = (e: DailyEventObjectParticipant) => {
    // Catch userData that arrived after the track did.
    const p = e.participant;
    if (p.local) {
      return;
    }
    const socketId = this.socketIdOf(p);
    if (!socketId) {
      return;
    }
    // Camera: a remote video track became playable after userData arrived
    // (or after the camera was toggled on mid-call). onVideoStarted may have
    // bailed for want of a socketId; reconcile here.
    const vTrack = p.tracks.video.persistentTrack;
    if (
      vTrack &&
      p.tracks.video.state === "playable" &&
      !this.videoSockets.has(socketId)
    ) {
      this.videoSessionToSocket.set(p.session_id, socketId);
      this.videoSockets.add(socketId);
      this.events.onVideoTrack?.(socketId, new MediaStream([vTrack]));
    } else if (
      this.videoSockets.has(socketId) &&
      p.tracks.video.state !== "playable" &&
      p.tracks.video.state !== "loading"
    ) {
      // camera turned off mid-call without a clean track-stopped
      this.dropVideo(socketId);
    }
    if (this.peers.has(socketId)) {
      return;
    }
    const track = p.tracks.audio.persistentTrack;
    if (track && p.tracks.audio.state === "playable") {
      this.sessionToSocket.set(p.session_id, socketId);
      const stream = new MediaStream([track]);
      const peer: RemotePeer = {
        socketId,
        sessionId: p.session_id,
        stream,
        audioEl: null,
        analyser: null,
        buffer: null,
        raf: null,
        speaking: false,
        lastLoudAt: 0,
      };
      this.peers.set(socketId, peer);
      this.attachAnalyser(peer);
      this.playPeerAudio(peer);
      this.setPeerState(socketId, {
        socketId,
        speaking: false,
        hasRemoteStream: true,
      });
      this.events.onPeerStream?.(socketId, stream);
    }
  };

  private onParticipantLeft = (e: DailyEventObjectParticipantLeft) => {
    const sessionId = e.participant.session_id;
    const socketId =
      this.socketIdOf(e.participant) ??
      this.sessionToSocket.get(sessionId) ??
      this.videoSessionToSocket.get(sessionId);
    if (socketId) {
      this.dropPeer(socketId);
      this.dropVideo(socketId);
    }
    this.sessionToSocket.delete(sessionId);
    this.videoSessionToSocket.delete(sessionId);
  };

  private onFatalError = (e: DailyEventObjectFatalError) => {
    warn("fatal error", e.errorMsg);
    this.events.onError?.(new Error(e.errorMsg || "call error"));
  };

  // ---- peer state + speaking analyser ------------------------------------

  private dropPeer(socketId: string) {
    const peer = this.peers.get(socketId);
    if (!peer) {
      return;
    }
    this.teardownPeer(peer);
    this.peers.delete(socketId);
    this.sessionToSocket.delete(peer.sessionId);
    this.emitState();
    this.events.onPeerRemoved?.(socketId);
  }

  private teardownPeer(peer: RemotePeer) {
    if (peer.raf !== null) {
      cancelAnimationFrame(peer.raf);
      peer.raf = null;
    }
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
      peer.audioEl = null;
    }
    peer.analyser = null;
    peer.buffer = null;
  }

  /** Play a remote peer's voice to the speakers. daily-js in call-object mode
   *  does NOT auto-play remote audio (that is a Prebuilt/iframe feature), so we
   *  attach the track to a hidden <audio> element ourselves — exactly like
   *  DailyScreenShare.playRemoteScreenAudio does for screen-share audio. Without
   *  this the remote track only reaches the speaking analyser (disconnected from
   *  the speakers) and the recorder mixer, so the meeting is RECORDED but nobody
   *  hears anyone live. */
  private playPeerAudio(peer: RemotePeer) {
    if (peer.audioEl) {
      return;
    }
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.srcObject = peer.stream;
    el.style.display = "none";
    document.body.appendChild(el);
    peer.audioEl = el;
    const tryPlay = () => el.play();
    tryPlay().catch((err) => {
      // Autoplay policy may block until a user gesture — retry once on the next
      // click/keydown anywhere in the page.
      warn("peer audio autoplay blocked; will resume on next gesture", err);
      const resume = () => {
        tryPlay().catch(() => undefined);
        window.removeEventListener("pointerdown", resume);
        window.removeEventListener("keydown", resume);
      };
      window.addEventListener("pointerdown", resume, { once: true });
      window.addEventListener("keydown", resume, { once: true });
    });
  }

  /** Speaking detection via a speaker-disconnected analyser. Playback is handled
   *  separately by playPeerAudio (call-object mode does NOT auto-play), so this
   *  analyser stays disconnected from the destination. Mirrors AudioPeer. */
  private attachAnalyser(peer: RemotePeer) {
    try {
      if (!this.analyserCtx) {
        this.analyserCtx = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
      }
      const ctx = this.analyserCtx;
      const src = ctx.createMediaStreamSource(peer.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      src.connect(analyser); // NOT connected to destination → no double audio
      peer.analyser = analyser;
      peer.buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      const tick = () => {
        if (!peer.analyser || !peer.buffer) {
          return;
        }
        peer.analyser.getByteFrequencyData(peer.buffer);
        let sum = 0;
        for (let i = 0; i < peer.buffer.length; i++) {
          sum += peer.buffer[i];
        }
        const avg = sum / peer.buffer.length;
        const nowMs = performance.now();
        if (avg > SPEAKING_THRESHOLD) {
          peer.lastLoudAt = nowMs;
          if (!peer.speaking) {
            peer.speaking = true;
            this.setPeerSpeaking(peer.socketId, true);
          }
        } else if (
          peer.speaking &&
          nowMs - peer.lastLoudAt > SPEAKING_RELEASE_MS
        ) {
          peer.speaking = false;
          this.setPeerSpeaking(peer.socketId, false);
        }
        peer.raf = requestAnimationFrame(tick);
      };
      peer.raf = requestAnimationFrame(tick);
    } catch (err) {
      warn("analyser failed", err);
    }
  }

  // ---- state emission (peers Map keyed by socket.id) ---------------------

  private peerStates = new Map<string, PeerState>();

  private setPeerState(socketId: string, state: PeerState) {
    this.peerStates.set(socketId, state);
    this.emitState();
  }

  private setPeerSpeaking(socketId: string, speaking: boolean) {
    const prev = this.peerStates.get(socketId);
    if (prev) {
      this.peerStates.set(socketId, { ...prev, speaking });
      this.emitState();
    }
  }

  private emitState() {
    // prune peerStates for peers that no longer exist
    for (const id of Array.from(this.peerStates.keys())) {
      if (!this.peers.has(id)) {
        this.peerStates.delete(id);
      }
    }
    this.events.onState({
      peers: new Map(this.peerStates),
      muted: this.muted,
      canTransmit: !!this.localStream,
    });
  }
}
