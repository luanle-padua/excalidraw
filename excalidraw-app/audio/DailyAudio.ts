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

import { appJotaiStore } from "../app-jotai";

import { callRoomName } from "./callRoom";
import { fatalErrorKindFor } from "./audioState";
import {
  lifecycleFromConnectionEvent,
  qualityFromNetworkEvent,
} from "./connectionState";
import {
  extractStatsSample,
  formatStatsLine,
  type NetworkStatsSample,
} from "./dailyTelemetry";
import { cameraErrorAffectsVideo, cameraErrorKindFor } from "./videoState";
import { getVideoBg, toDailyProcessor, type VideoBg } from "./videoBg";
import {
  clampQuality,
  maxVideoSubscribeFor,
  QUALITY_TIERS,
  receiveBaseForTileCount,
  videoQualityAtom,
  videoQualityCapAtom,
  type QualityCap,
  type QualityLevel,
} from "./videoQuality";
import {
  computeSubscriptions,
  countSubscribed,
  remoteCamerasFromRoster,
  shouldPaginate,
  toDailyVideoSub,
  type RosterCamera,
} from "./videoSubscription";
import { visibleTilesAtom } from "./videoPerf";
import {
  isDecodeUnderPressure,
  minTier,
  nextSendTier,
  type CpuReason,
  type CpuState,
  type GovernorQuality,
  type GovernorSignals,
} from "./videoGovernor";

import type { AudioRoomEvents, NonfatalKind, PeerState } from "./audioTypes";
import type {
  DailyCall,
  DailyEventObjectTrack,
  DailyEventObjectParticipant,
  DailyEventObjectParticipantLeft,
  DailyEventObjectFatalError,
  DailyEventObjectActiveSpeakerChange,
  DailyEventObjectCameraError,
  DailyEventObjectNonFatalError,
  DailyEventObjectInputSettingsUpdated,
  DailyEventObjectNetworkConnectionEvent,
  DailyEventObjectNetworkQualityEvent,
  DailyEventObjectCpuLoadEvent,
  DailyEventObjectMeetingSessionSummaryUpdated,
  DailyEventObjectBase,
  DailyParticipant,
} from "@daily-co/daily-js";

// Map our tier.sendSetting (the videoQuality vocabulary) to Daily's exact
// updateSendSettings preset literals. We CAN'T touch videoQuality.ts, and its
// medium tier is named "balanced", whereas Daily's matching preset is spelled
// "bandwidth-and-quality-balanced" — so the translation lives here, at the one
// boundary that talks to the SDK. "quality-optimized"/"bandwidth-optimized"
// pass through unchanged. Every target preset is a 3-layer adaptive simulcast,
// so ABR keeps scaling DOWN under load on all tiers — we only move the ceiling.
const SEND_PRESET: Record<
  typeof QUALITY_TIERS[keyof typeof QUALITY_TIERS]["sendSetting"],
  "quality-optimized" | "bandwidth-and-quality-balanced" | "bandwidth-optimized"
> = {
  "quality-optimized": "quality-optimized",
  balanced: "bandwidth-and-quality-balanced",
  "bandwidth-optimized": "bandwidth-optimized",
};

export type DailyTokenFetcher = (
  roomId: string,
  userName: string,
  userId?: string,
) => Promise<{ url: string; token: string } | null>;

const SPEAKING_THRESHOLD = 22; // 0..255, matches AudioPeer
const SPEAKING_RELEASE_MS = 250;

// A tiny valid silent WAV. Played (unmuted) inside the Join click grants the
// page audio "media engagement" so a no-mic listener's later peer <audio>
// play() isn't blocked by the autoplay policy (06-18). Silent → inaudible.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// Simulcast receive layers for the CPU/bandwidth saver. Daily cameras publish
// up to 3 spatial layers (0 = lowest res, 1 = medium, 2 = highest); we default
// non-speakers to the MIDDLE layer and promote only the active speaker to the
// top. "inherit" hands a tile back to Daily's own adaptive picker (used when
// demoting the previous speaker).
//
// Base was layer 0 (lowest), which made every non-speaking tile look blurry —
// for a small internal meeting that read as "bad video" across the board. Layer
// 1 keeps idle tiles legibly sharp while still saving meaningful CPU/bandwidth
// vs. decoding everyone at full 720p; the speaker still gets the crisp top layer.
//
// Phase 5: the base is now ADAPTIVE — receiveBaseForTileCount(n) keeps layer 1
// for small grids and drops non-speakers to layer 0 once the grid is large
// (> RECEIVE_BASE_LAYER_CUTOFF), per Daily's big-grid guidance. The speaker is
// always promoted to RECEIVE_LAYER_ACTIVE regardless.
const RECEIVE_LAYER_ACTIVE = 2;

// Phase 4 — observability cadence. We PULL getNetworkStats() because Daily has
// no live-quality webhook. ~2s keeps the chip tooltip + governor inputs fresh
// without flooding the main thread; the telemetry stats line is throttled to
// ~10s so the structured console sink stays low-noise (only ~1 line / 10s).
const STATS_POLL_MS = 2000;
const TELEMETRY_STATS_THROTTLE_MS = 10000;

// Phase 3 — adaptive quality GOVERNOR timing. The governor unifies
// cpu-load-change + network-quality-change into a single send-tier ceiling
// (and a receive-base nudge), only ever moving the TEMPORARY ceiling BELOW
// clampQuality(userPref, adminCap) — never above it.
//
// COOLDOWN keeps the governor from "pumping" the tier on every event: after any
// move (up or down) it ignores further moves for this long. RECOVERY_DWELL is
// how long conditions must stay CALM (CPU low + link not bad) before we step the
// ceiling back UP one notch — recovery is deliberately slower than degradation
// so a brief calm patch doesn't yo-yo the quality. All timing uses
// performance.now() (monotonic), never Date.now().
const GOVERNOR_COOLDOWN_MS = 6000;
const GOVERNOR_RECOVERY_DWELL_MS = 15000;

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
  /** speaking-detection source node — kept so teardown can disconnect() it;
   *  otherwise the MediaStreamSource leaks (the AudioContext holds a ref). */
  sourceNode: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  buffer: Uint8Array<ArrayBuffer> | null;
  raf: number | null;
  /** removes the one-shot autoplay-resume gesture listeners (pointerdown/
   *  keydown) if the peer is torn down before the gesture ever fires. */
  removeResumeListeners: (() => void) | null;
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
  /** A standalone PREVIEW camera stream owned by the pre-join "green room"
   *  modal (Item 6). Acquired via getUserMedia OUTSIDE the call object (no Daily
   *  room, no publish) purely so the user can see themselves before joining; the
   *  modal renders it into a mirrored <video>. Kept here (not in the modal) so
   *  stop()/teardown can guarantee the camera light goes off even if the modal
   *  unmounts without calling stopPreview(). */
  private previewStream: MediaStream | null = null;
  /** Cancels an in-flight previewCamera() getUserMedia. Without this, a
   *  stopPreview() issued WHILE the permission prompt is still pending is a
   *  no-op (previewStream not yet set), then getUserMedia resolves and stores a
   *  now-orphaned camera that nothing tears down — the camera light stays ON
   *  while the modal shows camera OFF (Item 6 teardown race). stopPreview()
   *  aborts this so the late-resolving acquisition stops its own tracks. */
  private previewAbort: AbortController | null = null;
  /** session_id → socket.id for VIDEO tracks specifically, so a
   *  participant-left / track-stopped that only carries a session can still
   *  resolve the tile to drop (video peers may differ from audio peers — a
   *  listener-only participant with camera on has no audio RemotePeer). */
  private videoSessionToSocket = new Map<string, string>();
  /** socket.ids that currently have a published remote video track, so we can
   *  clean up on stop()/leave without re-deriving from Daily state. */
  private videoSockets = new Set<string>();

  /** session_id of the participant Daily currently reports as active speaker —
   *  kept so the receive-layer optimisation can DEMOTE the previous speaker
   *  back to base before promoting the new one. */
  private activeSpeakerSession: string | null = null;
  /** whether this call is on an SFU (simulcast layers exist). null = unknown /
   *  not yet probed; false = P2P (updateReceiveSettings is a no-op / unsafe, so
   *  we skip the optimisation entirely to never risk breaking video). */
  private isSfu: boolean | null = null;

  /** last connectivity lifecycle we emitted (Daily "network-connection"),
   *  so a duplicate event (e.g. two paths reporting the same state) doesn't
   *  re-fire the banner, and stop() can reset it. */
  private connectionLifecycle: "connected" | "reconnecting" | "unstable" =
    "connected";

  /** Phase 4 — getNetworkStats() poll handle (started after join, cleared in
   *  stop()). null when no poll is running. */
  private statsTimer: number | null = null;
  /** Latest narrowed network-stats sample, or null before the first pull. Read
   *  by getLatestStats() (chip tooltip / governor confirm). */
  private latestStats: NetworkStatsSample | null = null;
  /** performance.now() of the last telemetry STATS line we logged — used to
   *  throttle the structured console sink to ~1 line / TELEMETRY_STATS_THROTTLE_MS
   *  so observability never floods the console. */
  private lastStatsLogAt = 0;
  /** The Daily meeting SESSION id captured from meetingSessionSummary(), so a
   *  post-meeting log/recording can be cross-referenced. Emitted once via
   *  onSessionId; reset in stop(). */
  private sessionId: string | null = null;

  /** Phase 5 — manual subscription + pagination. `paginating` is true once the
   *  remote camera count exceeded the device threshold and we switched Daily off
   *  automatic subscription; it flips back false when the count drops back at or
   *  below the threshold (we re-enable automatic). `unsub` removes the
   *  visibleTilesAtom jotai-store subscription on teardown. `maxVideoSubscribe`
   *  is the per-device threshold, resolved once at construction. */
  private paginating = false;
  private unsubVisibleTiles: (() => void) | null = null;
  private readonly maxVideoSubscribe: number;

  /** Phase 3 — adaptive quality governor state. `governorCpuState` /
   *  `governorCpuReason` hold the LAST cpu-load-change we saw; `governorNetwork`
   *  the LAST link-quality grade (good/low/bad) from network-quality-change. The
   *  governor reads these two latched signals on every evaluation rather than
   *  acting only on the event that fired, so a stale CPU reading isn't lost when
   *  a network event arrives (and vice-versa). */
  private governorCpuState: CpuState = "low";
  private governorCpuReason: CpuReason = "none";
  private governorNetwork: GovernorQuality = "good";
  /** The TEMPORARY send-tier ceiling the governor currently holds. Starts at
   *  "high" (no restriction): the effective tier applied to Daily is
   *  minTier(governorCeiling, clampQuality(userPref, adminCap)), so while this is
   *  "high" the governor is a no-op and the user/admin cap rules. */
  private governorCeiling: QualityCap = "high";
  /** performance.now() of the last ceiling MOVE (up or down) — drives the
   *  cooldown so the tier can't pump on every event. -Infinity = never moved. */
  private governorLastChangeAt = Number.NEGATIVE_INFINITY;
  /** performance.now() since which conditions have been continuously CALM (CPU
   *  low + link not bad), or null when not currently calm. Recovery (stepping
   *  the ceiling back up) is gated on this dwell reaching RECOVERY_DWELL_MS. */
  private governorCalmSince: number | null = null;
  /** A pending recovery timer (governor wants to step UP but is still inside the
   *  recovery dwell): a single deferred re-evaluation so recovery happens even
   *  if no further Daily event arrives while conditions stay calm. Cleared in
   *  stop(). */
  private governorRecoveryTimer: number | null = null;

  /** keyed by socket.id, like the mesh */
  private peers = new Map<string, RemotePeer>();
  /** session_id → socket.id, for participant-left (which only gives session) */
  private sessionToSocket = new Map<string, string>();
  private analyserCtx: AudioContext | null = null;
  /** Persistent silent element played inside the Join gesture to unlock audio
   *  autoplay for a no-mic listener (06-18). */
  private audioUnlockEl: HTMLAudioElement | null = null;
  /** AudioContext created + resumed INSIDE the Join click gesture so it is
   *  guaranteed "running" on iOS/iPadOS Safari (a context created later in a
   *  React effect can't be resumed — no user activation in scope — and stays
   *  SUSPENDED, which silently starved the STT worklet of audio). STTSession
   *  reuses this via getCaptureContext() instead of newing its own (06-18). */
  private captureCtx: AudioContext | null = null;

  constructor(opts: {
    roomId: string;
    userName: string;
    getSocketId: () => string | null;
    getToken: DailyTokenFetcher;
    events: AudioRoomEvents;
  }) {
    // The CALL room (voice + camera). Post Phase-5 merge the screen share
    // joins this SAME room (see audio/callRoom.ts) so one Daily cloud recording
    // composites voice + camera + screen into one file.
    this.roomId = callRoomName(opts.roomId);
    this.userName = opts.userName;
    this.getSocketId = opts.getSocketId;
    this.getToken = opts.getToken;
    this.events = opts.events;
    // Resolve the per-device manual-subscription threshold once. A mobile/tablet
    // (touch-only, no fine pointer) decodes far fewer streams, so it paginates
    // much sooner. Conservative: a hybrid laptop reads as desktop (the higher
    // threshold), the safe default. SSR-guarded.
    this.maxVideoSubscribe = maxVideoSubscribeFor(DailyAudio.isMobileDevice());
  }

  /** Best-effort "is this a mobile/tablet web client" probe — mirrors the
   *  heuristic in videoBg.isVideoBgSupported (touch-only, no fine pointer). Only
   *  used to pick the lower pagination threshold; a wrong guess just over- or
   *  under-subscribes by a few tiles, never breaks the call. */
  private static isMobileDevice(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return false;
    }
    try {
      const hasFinePointer =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: fine)").matches;
      if (hasFinePointer) {
        return false; // mouse/trackpad → desktop
      }
      return "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
    } catch {
      return false; // probe failed → assume desktop (higher threshold)
    }
  }

  // ---- lifecycle (mirrors AudioRoom) -------------------------------------

  async start(): Promise<void> {
    if (this.active) {
      log("DailyAudio.start() called but already active");
      return;
    }
    this.active = true;

    // Unlock audio playback NOW, synchronously inside the Join click's user
    // gesture (before any await consumes it) so a no-mic listener can later play
    // peers' <audio>. The user now ALWAYS joins listener-only (no getUserMedia
    // here), so the page is never blessed by a mic grant at join time — this
    // unlock is what lets them HEAR peers immediately. playPeerAudio's
    // per-gesture retry is the backstop.
    this.unlockAudioPlayback();

    // 1) Join LISTENER-ONLY: do NOT acquire the mic at join (no getUserMedia →
    //    no permission popup). The user goes straight into the room hearing
    //    everyone; the mic is acquired lazily on the first unmute or when STT
    //    starts (see ensureMic). Mic + camera both start OFF. localStream stays
    //    null until ensureMic() grants it.
    this.muted = true;

    // 2) Token for the audio room — tag it with our socket.id (Daily user_id)
    //    so peers can map us back to the collab identity. WAIT for the socket.id
    //    first: on a slow network the user can click "Join audio" before the DO's
    //    init-room WS frame assigns it, and minting with an empty uid makes Daily
    //    assign a RANDOM user_id → peers can't map our camera/audio to the collab
    //    identity, so our video renders as an avatar on their side (06-18 race).
    const socketId = await this.waitForSocketId();
    if (!this.active) {
      this.releaseMic();
      return;
    }
    const cfg = await this.getToken(
      this.roomId,
      this.userName,
      socketId ?? undefined,
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

    // 3) Join Daily LISTENER-ONLY: audioSource:false (no mic published, no
    //    getUserMedia) but subscribeToTracksAutomatically:true so we still HEAR
    //    everyone. Camera is also DEFAULT OFF (videoSource:false) — the user
    //    opts into mic via toggleMute→ensureMic and into camera via
    //    toggleCamera, both on this same call object. Identity is tagged so
    //    peers map us to collab.
    const call = Daily.createCallObject({
      audioSource: false,
      videoSource: false,
      subscribeToTracksAutomatically: true,
      // audio + screen share are two separate call objects on the same page
      allowMultipleCallInstances: true,
    });
    this.call = call;
    try {
      // Use the resolved socketId (same one baked into the token) so the
      // userData fallback identity matches user_id, not an empty/stale value.
      call.setUserData({ socketId: socketId ?? "" });
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
    // No mic to publish — we joined listener-only. The mic is acquired and
    // published later by ensureMic() (first unmute / STT start). emitState
    // reports canTransmit:false (no localStream) so the UI shows the muted /
    // listen state until the user turns the mic on.
    this.emitState();
  }

  /**
   * Acquire and PUBLISH the local mic, on demand. Idempotent: if a mic track
   * already exists this is a no-op. This is where the browser permission popup
   * actually fires — deliberately deferred from join() to the first moment the
   * user CHOOSES to speak (unmute) or enables STT, so a no-mic listener is never
   * prompted and the prompt always lands on an explicit user gesture.
   *
   * On success the mic is published unmuted (setLocalAudio(true)) and `muted`
   * flips false. On no device we stay a silent listener (localStream null). A
   * real permission denial is re-thrown so the caller can surface it.
   */
  async ensureMic(): Promise<boolean> {
    if (this.localStream) {
      // Already have a mic track — nothing to acquire.
      return true;
    }
    if (!this.call || !this.active) {
      // Not in a call yet — can't publish. Caller should join first.
      return false;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      log(`acquired mic (tracks=${this.localStream.getAudioTracks().length})`);
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        // No physical mic — stay a listener. Not an error: the user simply
        // can't transmit.
        log("no mic device — staying listener-only");
        this.localStream = null;
        this.emitState();
        return false;
      }
      // Permission denied / mic busy — re-throw so the caller (toggleMute / STT)
      // can route it to the right UI; we remain a listener in the meantime.
      this.localStream = null;
      this.emitState();
      throw err;
    }
    // Guard against the call being torn down while awaiting the permission
    // prompt — don't publish into a dead call.
    if (!this.active || !this.call) {
      this.releaseMic();
      return false;
    }
    // Hand the freshly-acquired track to Daily and publish it. The Daily room is
    // created with `start_audio_off: true`, so setInputDevicesAsync alone does
    // NOT publish — the explicit setLocalAudio(true) is what reaches the SFU so
    // peers actually hear us (06-18).
    const micTrack = this.localStream.getAudioTracks()[0] ?? null;
    try {
      await this.call.setInputDevicesAsync({ audioSource: micTrack ?? false });
      this.call.setLocalAudio(true);
    } catch (err) {
      warn("ensureMic: publish failed", err);
      this.releaseMic();
      this.emitState();
      throw err;
    }
    this.muted = false;
    this.emitState();
    return true;
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
    // Drop any lingering pre-join preview camera (normally torn down by the
    // modal on Join, but stop() is the safety net so the camera light always
    // goes off when the call ends).
    this.stopPreview();
    this.cameraOn = false;
    // Clear the speaker ring and reset per-call optimisation state.
    if (this.activeSpeakerSession !== null) {
      this.events.onActiveSpeaker?.(null);
    }
    this.activeSpeakerSession = null;
    this.isSfu = null;
    // Phase 5: drop the visibleTilesAtom listener and reset pagination so a fresh
    // call starts on automatic subscription and never inherits a stale "paginating"
    // flag (symmetric with the listener set up in subscribeVisibleTiles).
    if (this.unsubVisibleTiles) {
      this.unsubVisibleTiles();
      this.unsubVisibleTiles = null;
    }
    this.paginating = false;
    // Reset network-resilience state so a fresh call never inherits a stale
    // banner. The controller also resets connectionStateAtom in its idle
    // teardown block; this keeps the manager's own bookkeeping symmetric.
    this.connectionLifecycle = "connected";
    // Phase 4 — stop the getNetworkStats() poll and reset observability state so
    // a fresh call never inherits a stale sample / session id / log throttle.
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.latestStats = null;
    this.lastStatsLogAt = 0;
    this.sessionId = null;
    // Phase 3 — stop the governor: clear its deferred recovery timer and reset
    // the ceiling + latched signals so a fresh call never inherits a throttled
    // ceiling or a stale CPU/network reading (symmetric with onCpuLoad /
    // onNetworkQuality which latch them, and with the wire() listener).
    this.clearGovernorRecoveryTimer();
    this.governorCeiling = "high";
    this.governorCpuState = "low";
    this.governorCpuReason = "none";
    this.governorNetwork = "good";
    this.governorLastChangeAt = Number.NEGATIVE_INFINITY;
    this.governorCalmSince = null;
    for (const peer of this.peers.values()) {
      this.teardownPeer(peer);
    }
    this.peers.clear();
    this.sessionToSocket.clear();
    if (this.analyserCtx) {
      this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    if (this.captureCtx) {
      this.captureCtx.close().catch(() => undefined);
      this.captureCtx = null;
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
      // No mic yet (we joined listener-only). A toggle here is the user asking
      // to UNMUTE for the first time → acquire + publish the mic now. This is
      // the deferred permission popup, fired on the user's explicit click.
      // ensureMic emits the new state (muted:false on success); if it can't get
      // a mic (no device / denied) we stay muted. Fire-and-forget: toggleMute's
      // sync return shape is preserved for callers, and the real state lands via
      // emitState/onState once the async grant resolves.
      void this.ensureMic().catch((err) => {
        warn("toggleMute: mic acquire failed", err);
        this.events.onError?.(err as Error);
      });
      return this.muted; // still muted until the grant lands
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
      // Acquire a 720p camera (1280x720 @ 30fps). This is the QUALITY floor we
      // feed Daily's simulcast encoder — capturing low (was 360p) means even the
      // TOP simulcast layer is soft, so faces look blurry no matter the network.
      // 720p is the deliberate balance: sharp for an internal meeting without the
      // CPU/egress hit of 1080p. `ideal` (not `exact`) lets a weaker webcam fall
      // back gracefully instead of failing getUserMedia. Daily downscales to
      // lower layers itself for constrained receivers (see updateSendSettings /
      // applyReceiveLayers), so capturing high costs us nothing on the slow paths.
      let camStream: MediaStream;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
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
      // QUALITY: apply the effective tier (capture constraints + encode preset)
      // now that the camera is live. This replaces the old hardcoded
      // "quality-optimized" — the chosen tier is clampQuality(userPref, adminCap),
      // so it honours both the user's own ceiling and the org-wide admin cap.
      // Adaptive simulcast still floats BELOW the tier on a weak uplink — we move
      // the ceiling, we don't pin it. Best-effort inside applyVideoQuality: a
      // failure must not abort turning the camera on (raw feed still publishes).
      await this.applyVideoQuality();
      // Re-apply the user's persisted virtual background (blur / image) now that
      // the camera track exists — a processor can only attach to a live video
      // input. Best-effort: a failed processor must NOT abort turning the camera
      // on (the user still publishes a raw feed), and desktop-only support means
      // this is a silent no-op on mobile. Fire-and-forget so the toggle stays
      // snappy; the processor warms up a beat later.
      void this.setVideoBackground(getVideoBg()).catch((err) =>
        warn("initial video background apply failed (non-fatal)", err),
      );
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

  // ---- pre-join camera preview (Item 6 — "green room") -------------------

  /**
   * Acquire a STANDALONE camera stream for the pre-join modal's self-preview —
   * WITHOUT joining the call or publishing anything. This is the green-room
   * "hair check": the user sees themselves before committing to Join.
   *
   * Deliberately separate from setCamera(): there is no call object during
   * pre-join (the user hasn't joined yet), so this is a plain getUserMedia using
   * the SAME 720p constraints as setCamera so the preview matches what they'll
   * actually publish. Idempotent — a second call returns the existing stream
   * rather than opening a second camera. Resolves to null (never throws) on no
   * device / permission denied / SSR, so the modal can fall back to the avatar:
   * a real permission decision is made later at Join, where it routes through the
   * call's error channel.
   */
  async previewCamera(): Promise<MediaStream | null> {
    if (this.previewStream) {
      return this.previewStream;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      return null;
    }
    // Track this acquisition so a stopPreview() issued WHILE getUserMedia is
    // still pending can abort it. A fresh controller per call (the previous one,
    // if any, was already consumed/aborted) — we hold the reference locally so a
    // LATER previewCamera() replacing this.previewAbort can't make us mistake
    // someone else's cancellation for our own.
    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user",
        },
        audio: false,
      });
      // The modal may have torn down (camera toggled OFF / Join / Cancel /
      // unmount) while we awaited the permission prompt. Two ways to detect it,
      // both of which must stop THIS stream so we never leak a live camera:
      //   1. stopPreview() aborted us (signal fired) — the common toggle-off /
      //      unmount race the previous guard missed (stopPreview was a no-op
      //      because previewStream was still null), leaving the light stuck ON.
      //   2. a concurrent previewCamera() already grabbed one — keep that.
      if (abort.signal.aborted || this.previewStream) {
        for (const t of stream.getTracks()) {
          t.stop();
        }
        return this.previewStream;
      }
      this.previewStream = stream;
      return stream;
    } catch (err) {
      // No device / denied / busy — the modal shows the avatar placeholder. Not
      // an error here: the binding mic/cam choice is still made, and the real
      // permission decision happens at Join (setCamera), surfaced there.
      warn("previewCamera failed (non-fatal)", err);
      return null;
    } finally {
      // Only clear if we're still the current acquisition — a newer
      // previewCamera() may have installed its own controller while we awaited.
      if (this.previewAbort === abort) {
        this.previewAbort = null;
      }
    }
  }

  /** Stop + release the pre-join preview camera (modal Join / Cancel / unmount).
   *  Idempotent. The preview NEVER touches the call object, so this is just a
   *  track teardown — the live camera (setCamera) is wholly independent. */
  stopPreview(): void {
    // Cancel an in-flight previewCamera() (permission prompt still pending) so
    // its late-resolving getUserMedia stops its own tracks instead of storing a
    // now-orphaned camera — the toggle-off / unmount teardown race (Item 6).
    if (this.previewAbort) {
      this.previewAbort.abort();
      this.previewAbort = null;
    }
    if (this.previewStream) {
      for (const t of this.previewStream.getTracks()) {
        t.stop();
      }
      this.previewStream = null;
    }
  }

  /**
   * Apply a virtual background (blur / image / none) to the LOCAL camera via
   * Daily's video PROCESSOR pipeline on this same call object. Desktop-browser
   * only — Daily silently no-ops the processor on mobile web.
   *
   * Safe to call before the camera is on: updateInputSettings persists the
   * processor and Daily attaches it when a video track next appears, so the
   * choice "sticks" through a camera off→on cycle. Resolves to the applied
   * VideoBg; rejects only if the SDK call itself throws (caller treats that as
   * non-fatal — the raw camera keeps publishing).
   */
  async setVideoBackground(bg: VideoBg): Promise<VideoBg> {
    const call = this.call;
    if (!call || !this.active) {
      // No call object yet — nothing to apply to. The persisted preference is
      // re-applied from setCamera() once the camera comes up.
      return bg;
    }
    // toDailyProcessor maps our VideoBg union to Daily's exact processor shape
    // ({type:'background-blur'|'background-image'|'none', config}); see videoBg.ts.
    await call.updateInputSettings({
      video: { processor: toDailyProcessor(bg) },
    });
    return bg;
  }

  /**
   * Apply the effective video-quality tier to the LIVE camera: capture
   * constraints (width/height/frameRate) via updateInputSettings AND the encode
   * preset via updateSendSettings. The effective tier is
   * clampQuality(userPref, adminCap), so it never exceeds the org-wide admin cap
   * even if the user picked higher. Adaptive simulcast still scales below it.
   *
   * No-op unless the camera is actually publishing — there is no input/encoder
   * to retune otherwise, and the next setCamera(true) re-applies the current tier
   * from scratch. Best-effort throughout: a tuning failure must NEVER drop the
   * already-working camera (mirrors the updateSendSettings guard in setCamera).
   */
  private async applyVideoQuality(): Promise<void> {
    const call = this.call;
    if (!call || !this.active || !this.cameraOn) {
      return;
    }
    // The HARD cap: the user's pref clamped to the org-wide admin cap. The
    // governor (Phase 3) may only lower the EFFECTIVE tier FURTHER via its
    // temporary ceiling — minTier guarantees it can never raise the tier above
    // this cap. While governorCeiling is "high" (the default / recovered state)
    // minTier is a no-op and the user/admin cap rules.
    const cap = clampQuality(
      appJotaiStore.get(videoQualityAtom),
      appJotaiStore.get(videoQualityCapAtom),
    );
    const tier = QUALITY_TIERS[minTier(this.governorCeiling, cap)];

    // Capture constraints. CRITICAL: updateInputSettings({video}) REPLACES the
    // whole video input-settings object, so passing only `settings` would WIPE
    // the virtual-background processor that setVideoBackground installed. We
    // re-send the CURRENT processor (derived from the persisted videoBg, the same
    // source setVideoBackground uses) alongside the new constraints so both land
    // in one atomic call and the blur/image keeps running while resolution shifts.
    try {
      await call.updateInputSettings({
        video: {
          processor: toDailyProcessor(getVideoBg()),
          settings: {
            width: { ideal: tier.width },
            height: { ideal: tier.height },
            frameRate: { ideal: tier.frameRate, max: tier.frameRate },
          },
        },
      });
    } catch (err) {
      warn("applyVideoQuality: updateInputSettings failed (non-fatal)", err);
    }

    // Encode ceiling. SEND_PRESET maps our tier vocabulary to Daily's preset
    // literal (medium "balanced" → "bandwidth-and-quality-balanced").
    try {
      await call.updateSendSettings({
        video: SEND_PRESET[tier.sendSetting],
      });
    } catch (err) {
      warn("applyVideoQuality: updateSendSettings failed (non-fatal)", err);
    }
  }

  /**
   * RE-APPLY the video quality live after the UI has changed the user pref.
   * applyVideoQuality reads the atoms directly, so the UI's contract is: set
   * videoQualityAtom (and persist) FIRST, then call this. The `level` argument is
   * accepted to match the UI call-site shape (audioRoom.setVideoQuality(level))
   * and to document intent; the effective tier is still the clamp of the atoms,
   * so an out-of-band value can never bypass the admin cap. No-op if the camera
   * is off (the new pref is picked up automatically on the next camera-on).
   */
  async setVideoQuality(_level: QualityLevel): Promise<void> {
    await this.applyVideoQuality();
  }

  // ---- Daily events ------------------------------------------------------

  private wire(call: DailyCall) {
    call.on("track-started", this.onTrackStarted);
    call.on("track-stopped", this.onTrackStopped);
    call.on("track-started", this.onVideoStarted);
    call.on("track-stopped", this.onVideoStopped);
    call.on("participant-updated", this.onParticipantUpdated);
    call.on("participant-left", this.onParticipantLeft);
    call.on("active-speaker-change", this.onActiveSpeakerChange);
    call.on("error", this.onFatalError);
    // Non-fatal errors (call keeps running). Phase 0 handles the
    // video-processor case (virtual background failed → Daily clears the
    // processor + turns the camera OFF); Phase 2 extends this same listener for
    // the remaining nonfatal types. Registered ONCE here.
    call.on("nonfatal-error", this.onNonfatalError);
    // Phase 2 — Daily's STRUCTURED camera/mic acquisition error (permissions /
    // device-in-use / not-found / constraints). Distinct from the getUserMedia
    // exception the camera toggle classifies itself: this fires whenever Daily's
    // own input pipeline fails to acquire a device (e.g. a mid-call device pull
    // or a permission revoke). Maps to a CameraErrorKind code + cameraStateAtom.
    call.on("camera-error", this.onCameraError);
    // The AUTHORITATIVE post-change camera/processor state. After a
    // video-processor-error Daily mutates input settings (clears processor,
    // disables video) and fires this — we read the real state here instead of
    // assuming the last settings we sent still hold.
    call.on("input-settings-updated", this.onInputSettingsUpdated);
    // Phase 1 — network resilience. "network-connection" drives the
    // reconnecting/unstable BANNER (signaling vs media path interrupted);
    // "network-quality-change" drives the small link-quality CHIP. Both are
    // best-effort + non-fatal (see handlers) and torn down implicitly when the
    // call object is destroyed in stop().
    call.on("network-connection", this.onNetworkConnection);
    call.on("network-quality-change", this.onNetworkQuality);
    // Phase 3 — adaptive quality governor. "cpu-load-change" feeds the CPU
    // pressure signal; the network signal is latched from onNetworkQuality. Both
    // re-run governQuality(), which moves the TEMPORARY send-tier ceiling (and a
    // receive-base nudge) — never above clampQuality(userPref, adminCap), wholly
    // non-fatal. The governor timers are cleared in stop().
    call.on("cpu-load-change", this.onCpuLoad);
    // Phase 4 — observability. Capture the Daily session id once we're in
    // ("joined-meeting") and whenever Daily revises the summary
    // ("meeting-session-summary-updated", the CURRENT event name — NOT the old
    // "meeting-session-state-updated"). The getNetworkStats() poll is started
    // from onJoinedMeeting (not here) so it only runs once media is flowing.
    call.on("joined-meeting", this.onJoinedMeeting);
    call.on(
      "meeting-session-summary-updated",
      this.onMeetingSessionSummaryUpdated,
    );
  }

  // ---- observability (Phase 4) -------------------------------------------

  /**
   * Daily "joined-meeting" — media is flowing. Capture the session id (sync
   * meetingSessionSummary()) and start the ~2s getNetworkStats() poll. Wholly
   * non-fatal: a stats/summary hiccup must never disturb the live call.
   */
  private onJoinedMeeting = () => {
    try {
      this.captureSessionId();
    } catch (err) {
      warn("captureSessionId failed (non-fatal)", err);
    }
    this.startStatsPoll();
    this.subscribeVisibleTiles();
  };

  // ---- scale subscription + pagination (Phase 5) -------------------------

  /**
   * Start listening to visibleTilesAtom (the gallery / filmstrip publishes the
   * socket.ids it is currently rendering) so that in a BIG meeting we subscribe
   * only the tiles actually on screen + the active speaker, and stage / drop the
   * rest. Idempotent; the listener is removed in stop(). Best-effort: a jotai
   * subscribe failure leaves us on automatic subscription (decode everyone),
   * which is correct, just heavier — never breaks the call.
   */
  private subscribeVisibleTiles() {
    if (this.unsubVisibleTiles) {
      return; // already listening
    }
    try {
      this.unsubVisibleTiles = appJotaiStore.sub(visibleTilesAtom, () => {
        void this.reconcileSubscriptions();
      });
    } catch (err) {
      warn("subscribeVisibleTiles failed (non-fatal)", err);
    }
    // Apply once now in case tiles were already published before we joined.
    void this.reconcileSubscriptions();
  }

  /**
   * The heart of Phase 5: decide each REMOTE camera's subscription and apply it.
   *
   * Below the device threshold we keep Daily on AUTOMATIC subscription (decode
   * everyone — simplest, no churn) and flip automatic back on if we had
   * previously paginated. Above it we switch automatic OFF and explicitly
   * subscribe only the visible tiles + the active speaker (the rest staged /
   * unsubscribed) via updateParticipants. Wholly non-fatal — any failure leaves
   * video flowing at Daily's defaults.
   *
   * The participant list is seeded from call.participants() — which lists ALL
   * remote cameras regardless of whether we are currently subscribed to them —
   * NOT from videoSessionToSocket (which holds only tracks that already reached
   * `playable`). With automatic subscription OFF, an off-page camera is never
   * subscribed, so its track never becomes playable and it would otherwise be
   * invisible to reconcile; when it later scrolls INTO view we must still be
   * able to subscribe it (Phase 5a: paging a tile into view subscribes it).
   *
   * Empty visibleTilesAtom is the module's documented "no explicit signal yet"
   * fallback (videoPerf.ts): we keep EVERYONE subscribed (stay on / restore
   * automatic) rather than blacking the whole grid. This also covers the
   * last-writer-wins race where one of two mounted video surfaces clears the
   * shared atom on unmount.
   */
  private async reconcileSubscriptions() {
    const call = this.call;
    if (!call || !this.active) {
      return;
    }
    try {
      const visibleSockets = appJotaiStore.get(visibleTilesAtom);

      // Documented fallback (videoPerf.ts): an empty visible set means "no
      // explicit signal yet" — keep everyone subscribed instead of dropping
      // every off-speaker tile to black. Restore Daily's automatic subscription
      // if we had been paginating, then bail (nothing to micromanage).
      if (visibleSockets.size === 0) {
        if (this.paginating) {
          this.paginating = false;
          call.setSubscribeToTracksAutomatically(true);
          log(
            "pagination OFF — no visible-tile signal yet, subscribing to everyone (automatic)",
          );
        }
        return;
      }

      // Build the remote-camera participant list (session_id keyed) from the
      // LIVE call roster, not from videoSessionToSocket: a camera that joined /
      // turned on AFTER automatic subscription was switched off has no playable
      // track yet (we never subscribed it), so it is absent from
      // videoSessionToSocket but present here. Skip the local self-view and any
      // remote whose camera is off/blocked (no track to subscribe).
      const activeSocket = this.activeSpeakerSession
        ? this.socketIdForSession(this.activeSpeakerSession)
        : null;
      const dailyRoster = call.participants();
      const roster: RosterCamera[] = [];
      for (const key of Object.keys(dailyRoster)) {
        const p = dailyRoster[key];
        if (!p) {
          continue;
        }
        roster.push({
          sessionId: p.session_id,
          socketId: this.socketIdOf(p),
          local: p.local,
          videoState: p.tracks.video.state,
        });
      }
      // PURE mapping (unit-tested): drops self, non-publishing cameras, and any
      // socket.id not resolved yet; marks visible / active-speaker tiles.
      const participants = remoteCamerasFromRoster(
        roster,
        visibleSockets,
        this.activeSpeakerSession,
        activeSocket,
      );

      const paginate = shouldPaginate(
        participants.length,
        this.maxVideoSubscribe,
      );

      if (!paginate) {
        // Small meeting (or shrank back below threshold). If we had paginated,
        // restore Daily's automatic subscription so newly-arriving tiles are
        // decoded again without us micromanaging them.
        if (this.paginating) {
          this.paginating = false;
          call.setSubscribeToTracksAutomatically(true);
          log(
            `pagination OFF — ${participants.length} remote video(s) ≤ ${this.maxVideoSubscribe}, subscribing to everyone (automatic)`,
          );
        }
        return;
      }

      // Big meeting: switch off automatic subscription (once) and drive explicit
      // per-tile subscriptions.
      if (!this.paginating) {
        this.paginating = true;
        call.setSubscribeToTracksAutomatically(false);
      }
      const subs = computeSubscriptions(participants, this.maxVideoSubscribe);
      if (subs.size === 0) {
        return;
      }
      const updates: Record<
        string,
        { setSubscribedTracks: { video: ReturnType<typeof toDailyVideoSub> } }
      > = {};
      for (const [sessionId, tier] of subs) {
        updates[sessionId] = {
          setSubscribedTracks: { video: toDailyVideoSub(tier) },
        };
      }
      call.updateParticipants(updates);
      // CLEARLY log that we are NOT showing everyone, so a watcher never mistakes
      // a paginated grid for "the whole room is on screen".
      log(
        `pagination ON — showing ${countSubscribed(subs)} of ${
          participants.length
        } remote video(s) (device cap ${
          this.maxVideoSubscribe
        }); off-page streams dropped`,
      );
    } catch (err) {
      warn("reconcileSubscriptions skipped (non-fatal)", err);
    }
  }

  /** Daily "meeting-session-summary-updated" — re-capture the (possibly new)
   *  session id. Same code path / dedupe as the initial capture.
   *
   *  daily-js 0.90's `.on()` event→payload map does NOT include the
   *  summary-updated payload (only the DEPRECATED meeting-session-updated /
   *  -state-updated), so the listener is typed to the base event and we read
   *  `meetingSession` defensively off a widened view — exactly how onFatalError /
   *  onCameraError read their typed-`any` payload fields. */
  private onMeetingSessionSummaryUpdated = (e: DailyEventObjectBase) => {
    try {
      const summary = (
        e as Partial<DailyEventObjectMeetingSessionSummaryUpdated>
      ).meetingSession;
      const id = summary?.id;
      if (id && id !== this.sessionId) {
        this.sessionId = id;
        log("session id (updated)", id);
        this.events.onSessionId?.(id);
      }
    } catch (err) {
      warn("onMeetingSessionSummaryUpdated failed (non-fatal)", err);
    }
  };

  /** Read the synchronous meetingSessionSummary() and emit the session id ONCE
   *  (deduped against the last value). meetingSessionSummary() replaces the
   *  deprecated getMeetingSession(); it returns synchronously, so no await. */
  private captureSessionId() {
    const call = this.call;
    if (!call) {
      return;
    }
    const id = call.meetingSessionSummary?.()?.id;
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      log("session id", id);
      this.events.onSessionId?.(id);
    }
  }

  /** The Daily meeting session id captured after join, or null. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** The latest narrowed getNetworkStats() sample, or null before the first
   *  pull. Read by the chip tooltip + (later) the governor recover-confirm. */
  getLatestStats(): NetworkStatsSample | null {
    return this.latestStats;
  }

  /**
   * Start the getNetworkStats() poll (~2s). Idempotent: a second call is a
   * no-op while a timer is live. Each tick pulls stats, narrows them to a
   * sample, feeds the chip tooltip (onStats) and the throttled telemetry sink.
   * Wholly non-fatal — a failed pull is logged and the poll keeps going.
   */
  private startStatsPoll() {
    if (this.statsTimer !== null) {
      return; // already polling
    }
    const tick = async () => {
      const call = this.call;
      if (!call || !this.active) {
        return;
      }
      try {
        const raw = await call.getNetworkStats();
        if (!this.active) {
          return; // torn down while awaiting
        }
        const sample = extractStatsSample(raw);
        if (!sample) {
          return; // no measurement yet — skip this tick
        }
        this.latestStats = sample;
        this.events.onStats?.(sample);
        this.maybeLogStats(sample);
      } catch (err) {
        warn("getNetworkStats failed (non-fatal)", err);
      }
    };
    this.statsTimer = window.setInterval(() => {
      void tick();
    }, STATS_POLL_MS);
  }

  /**
   * THROTTLED structured telemetry stats line (the LIGHT observability sink —
   * console only). One key=value line per ~10s so the console stays readable.
   *
   * TODO(telemetry-endpoint): batch quality/cpu/fatal/nonfatal events + these
   * stats lines and POST them to the Worker `POST /v1/daily/telemetry` (D1 table
   * `daily_quality_log`) for the Admin Console quality-by-meeting view. Deferred
   * to a later phase — not built here to keep this change isolated and non-fatal.
   */
  private maybeLogStats(sample: NetworkStatsSample) {
    const now = performance.now();
    if (now - this.lastStatsLogAt < TELEMETRY_STATS_THROTTLE_MS) {
      return;
    }
    this.lastStatsLogAt = now;
    log("telemetry stats", formatStatsLine(sample));
  }

  // ---- network resilience (Phase 1) --------------------------------------

  /**
   * Daily "network-connection" → connectivity lifecycle (banner). Maps the
   * payload via the PURE lifecycleFromConnectionEvent and emits a code +
   * raw reasons; the controller mirrors it into connectionStateAtom.
   *
   * Non-fatal by default: ANY failure is caught, logged via warn(), and
   * swallowed — a monitoring signal must never tear down a working call.
   */
  private onNetworkConnection = (e: DailyEventObjectNetworkConnectionEvent) => {
    try {
      const mapped = lifecycleFromConnectionEvent(e);
      if (!mapped) {
        return; // intermediate/unknown event — keep current state
      }
      if (mapped.lifecycle === this.connectionLifecycle) {
        return; // no change — don't re-fire
      }
      this.connectionLifecycle = mapped.lifecycle;
      log(`network-connection ${e.type}/${e.event} → ${mapped.lifecycle}`);
      this.events.onConnectionState?.(mapped.lifecycle, mapped.reasons);
    } catch (err) {
      warn("onNetworkConnection failed (non-fatal)", err);
    }
  };

  /**
   * Daily "network-quality-change" → link-quality chip. Maps the payload via
   * the PURE qualityFromNetworkEvent (good/low/bad + raw reasons) and emits it.
   * Reads `networkState` / `networkStateReasons` only — never the deprecated
   * `threshold` / `quality`. Non-fatal by default.
   */
  private onNetworkQuality = (e: DailyEventObjectNetworkQualityEvent) => {
    try {
      const { quality, reasons } = qualityFromNetworkEvent(e);
      this.events.onConnectionQuality?.(quality, reasons);
      // Phase 3 — latch the link grade for the governor and re-evaluate. Our
      // ConnectionQuality ("good"|"low"|"bad") is exactly GovernorQuality, so no
      // remap is needed. governQuality() is non-fatal in its own right.
      this.governorNetwork = quality;
      this.governQuality();
    } catch (err) {
      warn("onNetworkQuality failed (non-fatal)", err);
    }
  };

  // ---- adaptive quality governor (Phase 3) -------------------------------

  /**
   * Daily "cpu-load-change" → latch the CPU pressure signal and re-evaluate the
   * governor. Payload: { cpuLoadState: 'low'|'high', cpuLoadStateReason:
   * 'encode'|'decode'|'scheduleDuration'|'none' }. Non-fatal by default: a CPU
   * signal must never disturb the live call.
   */
  private onCpuLoad = (e: DailyEventObjectCpuLoadEvent) => {
    try {
      this.governorCpuState = e.cpuLoadState;
      this.governorCpuReason = e.cpuLoadStateReason;
      this.governQuality();
    } catch (err) {
      warn("onCpuLoad failed (non-fatal)", err);
    }
  };

  /**
   * The Phase 3 GOVERNOR. Unifies the two latched signals (CPU + link quality)
   * into a single decision and moves the TEMPORARY send-tier ceiling — never
   * above the hard clampQuality(userPref, adminCap) cap (enforced in
   * applyVideoQuality via minTier(governorCeiling, cap)).
   *
   * The pure decision (videoGovernor.nextSendTier) says whether to step the
   * ceiling DOWN (machine/uplink under pressure) or back UP (sustained calm);
   * everything HERE is the timing skin around it:
   *  - HYSTERESIS / COOLDOWN: after any move we ignore further moves for
   *    GOVERNOR_COOLDOWN_MS so the tier can't pump on a flapping signal.
   *  - RECOVERY DWELL: stepping back up requires conditions to stay calm for
   *    GOVERNOR_RECOVERY_DWELL_MS; a deferred timer re-runs this even if no
   *    further Daily event arrives while it stays calm.
   *
   * Decode-side pressure (CPU high + reason "decode") is a RECEIVE cost, not a
   * send one: instead of touching the send tier we re-run applyReceiveLayers so
   * the adaptive receive base re-applies (it already lowers non-speakers for big
   * grids). Wholly best-effort + non-fatal.
   */
  private governQuality() {
    if (!this.call || !this.active) {
      return;
    }
    const signals: GovernorSignals = {
      cpuState: this.governorCpuState,
      cpuReason: this.governorCpuReason,
      networkState: this.governorNetwork,
    };
    const now = performance.now();

    // Decode pressure → nudge the RECEIVE side (re-apply adaptive base layers
    // for the current speaker/grid). Independent of the send-tier cooldown.
    if (isDecodeUnderPressure(signals)) {
      void this.applyReceiveLayers(
        this.activeSpeakerSession,
        this.activeSpeakerSession,
      );
    }

    const desired = nextSendTier(signals, this.governorCeiling);

    // Track the "calm since" window for the recovery dwell. Calm = CPU low AND
    // the link is not bad (mirrors videoGovernor.isCalm). The moment we are NOT
    // calm, reset the window so a brief lull can't shortcut a recovery.
    const calmNow =
      signals.cpuState === "low" && signals.networkState !== "bad";
    if (calmNow) {
      if (this.governorCalmSince === null) {
        this.governorCalmSince = now;
      }
    } else {
      this.governorCalmSince = null;
    }

    if (desired === this.governorCeiling) {
      // No change wanted (HOLD): clear any pending recovery timer if conditions
      // are no longer calm; otherwise leave it to fire.
      if (!calmNow) {
        this.clearGovernorRecoveryTimer();
      }
      return;
    }

    // desired != ceiling here (HOLD returned above), and nextSendTier moves at
    // most one notch, so this is a strict step. minTier picking `desired` means
    // it is the LOWER tier → a step DOWN.
    const steppingDown = minTier(desired, this.governorCeiling) === desired;

    if (steppingDown) {
      // DOWN: gated only by the cooldown (degrade promptly to protect the call,
      // but not on every single flapping event).
      if (now - this.governorLastChangeAt < GOVERNOR_COOLDOWN_MS) {
        return;
      }
      this.clearGovernorRecoveryTimer();
      this.applyGovernorCeiling(desired, now, signals);
      return;
    }

    // UP (recovery): require BOTH the cooldown AND the recovery dwell to have
    // elapsed under continuously-calm conditions. If the dwell hasn't elapsed
    // yet, arm a single deferred re-evaluation so recovery still happens when no
    // further Daily event arrives while it stays calm.
    if (now - this.governorLastChangeAt < GOVERNOR_COOLDOWN_MS) {
      return;
    }
    const calmFor =
      this.governorCalmSince === null ? 0 : now - this.governorCalmSince;
    if (calmFor < GOVERNOR_RECOVERY_DWELL_MS) {
      this.armGovernorRecoveryTimer(GOVERNOR_RECOVERY_DWELL_MS - calmFor);
      return;
    }
    this.applyGovernorCeiling(desired, now, signals);
  }

  /** Commit a new governor ceiling: record the move time, log the trace, and
   *  re-apply the effective video quality (which clamps to the user/admin cap).
   *  After a step the governor re-arms a recovery check if it's still calm. */
  private applyGovernorCeiling(
    next: QualityCap,
    now: number,
    signals: GovernorSignals,
  ) {
    const prev = this.governorCeiling;
    this.governorCeiling = next;
    this.governorLastChangeAt = now;
    log(
      `governor ${prev}→${next} (cpu=${signals.cpuState}/${signals.cpuReason} net=${signals.networkState})`,
    );
    void this.applyVideoQuality();
    // If we just stepped DOWN but are already calm, or stepped UP but not yet at
    // the top, keep the recovery loop alive so the ceiling keeps climbing back.
    if (next !== "high" && this.governorCalmSince !== null) {
      this.armGovernorRecoveryTimer(GOVERNOR_RECOVERY_DWELL_MS);
    }
  }

  /** Arm a single deferred governQuality() re-evaluation after `delayMs`. Used
   *  for recovery so the ceiling can step back up even if Daily emits no further
   *  cpu/network event while conditions stay calm. Idempotent (replaces any
   *  pending timer). */
  private armGovernorRecoveryTimer(delayMs: number) {
    this.clearGovernorRecoveryTimer();
    this.governorRecoveryTimer = window.setTimeout(() => {
      this.governorRecoveryTimer = null;
      try {
        this.governQuality();
      } catch (err) {
        warn("governor recovery tick failed (non-fatal)", err);
      }
    }, Math.max(0, delayMs));
  }

  private clearGovernorRecoveryTimer() {
    if (this.governorRecoveryTimer !== null) {
      window.clearTimeout(this.governorRecoveryTimer);
      this.governorRecoveryTimer = null;
    }
  }

  // ---- active speaker (SFU) → speaker ring + receive-layer promotion -------

  private onActiveSpeakerChange = (e: DailyEventObjectActiveSpeakerChange) => {
    // Daily's activeSpeaker.peerId is a session_id; resolve it to OUR socket.id.
    const sessionId = e.activeSpeaker?.peerId || null;
    const prevSession = this.activeSpeakerSession;
    this.activeSpeakerSession = sessionId;

    const socketId = sessionId ? this.socketIdForSession(sessionId) : null;
    // Surface to the UI even if we can't resolve a socketId yet (null clears the
    // ring) — the layout lane just won't ring an unknown tile.
    this.events.onActiveSpeaker?.(socketId);

    // Optimisation: promote the active speaker's video to a high simulcast
    // layer, demote the previous one back to base. No-op-safe (see below).
    this.applyReceiveLayers(sessionId, prevSession);
    // Phase 5: when paginating, keep the (possibly off-page) active speaker
    // subscribed so the speaker tile is never a black frame. No-op below threshold.
    if (this.paginating) {
      void this.reconcileSubscriptions();
    }
  };

  /** Map a Daily session_id to our socket.id. Tries the live participant's
   *  baked identity first (user_id / userData), then the audio + video
   *  session→socket maps we already maintain. */
  private socketIdForSession(sessionId: string): string | null {
    const call = this.call;
    if (call) {
      const participants = call.participants();
      for (const key of Object.keys(participants)) {
        const p = participants[key];
        if (p && p.session_id === sessionId) {
          const id = this.socketIdOf(p);
          if (id) {
            return id;
          }
          break;
        }
      }
    }
    return (
      this.sessionToSocket.get(sessionId) ??
      this.videoSessionToSocket.get(sessionId) ??
      null
    );
  }

  /** Receive-layer optimisation (the main CPU/bandwidth saver). Defaults every
   *  remote camera to the LOWEST simulcast layer via the "*" wildcard base and
   *  promotes ONLY the active speaker to a higher layer, demoting the previous
   *  one back to inherit. SFU-only: on a P2P room (small calls) there are no
   *  simulcast layers and updateReceiveSettings is meaningless, so we probe the
   *  topology once and skip entirely if it is not an SFU. Wrapped so ANY failure
   *  leaves video untouched — this must never regress the working camera path.
   *
   *  We only act when remote camera videos are actually present (videoSockets);
   *  with no remote video there is nothing to down-tier. */
  private async applyReceiveLayers(
    activeSession: string | null,
    prevSession: string | null,
  ) {
    const call = this.call;
    if (!call || !this.active || this.videoSockets.size === 0) {
      return;
    }
    try {
      // Probe topology once. Daily may briefly report 'none' before the SFU is
      // up; leave isSfu unknown in that case and retry on the next change.
      if (this.isSfu === null) {
        const { topology } = await call.getNetworkTopology();
        if (topology === "none") {
          return; // not settled yet — don't cache, try again next time
        }
        this.isSfu = topology === "sfu";
      }
      if (this.isSfu !== true) {
        return; // P2P (or unknown): no simulcast layers, nothing safe to do
      }
      if (this.call !== call || !this.active) {
        return; // call was torn down while awaiting topology
      }

      // Phase 5: the base layer is ADAPTIVE in the grid size. A small grid keeps
      // non-speakers on layer 1 (sharp); a large grid drops them to layer 0
      // (cheapest) per Daily's big-grid guidance. videoSockets is the remote
      // camera count (the self-view is added separately but is local, never a
      // receive layer concern here).
      const receiveBase = receiveBaseForTileCount(this.videoSockets.size);
      const updates: Record<string, { video: { layer: number | "inherit" } }> =
        {
          // Everyone defaults to the adaptive base layer; the speaker overrides.
          "*": { video: { layer: receiveBase } },
        };
      if (prevSession && prevSession !== activeSession) {
        updates[prevSession] = { video: { layer: "inherit" } };
      }
      if (activeSession) {
        updates[activeSession] = { video: { layer: RECEIVE_LAYER_ACTIVE } };
      }
      await call.updateReceiveSettings(updates);
    } catch (err) {
      // Any failure (P2P, transient, API shape) is non-fatal: video keeps
      // flowing at Daily's default adaptive quality. Disable further attempts
      // for this call so we don't spam on every speaker change.
      this.isSfu = false;
      warn("updateReceiveSettings skipped (non-fatal)", err);
    }
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
    // Phase 5: a new remote camera may push us over the pagination threshold.
    void this.reconcileSubscriptions();
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
    // Phase 5: a camera left — the count may have dropped back below the
    // threshold, in which case reconcile re-enables automatic subscription.
    void this.reconcileSubscriptions();
  }

  /** Wait until the DO has minted our socket.id (delivered in the init-room WS
   *  frame) so the Daily token can bake it as user_id. Polls getSocketId() up to
   *  timeoutMs; if it never lands (e.g. WS still down) we proceed with null
   *  rather than blocking the call forever — degraded (peers see an avatar) but
   *  not stuck. Closes the slow-network join race (06-18). */
  private async waitForSocketId(timeoutMs = 6000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let id = this.getSocketId();
    while (!id && this.active && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      id = this.getSocketId();
    }
    return id;
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
      sourceNode: null,
      analyser: null,
      buffer: null,
      raf: null,
      removeResumeListeners: null,
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
      // Phase 5: reconcile in case this camera tips us over the threshold.
      void this.reconcileSubscriptions();
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
        sourceNode: null,
        analyser: null,
        buffer: null,
        raf: null,
        removeResumeListeners: null,
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

  /**
   * Daily FATAL error — the call is over. Phase 2 classifies `error.type` into a
   * language-neutral AudioErrorKind (meeting-full / token-expired / generic
   * "call") via the PURE fatalErrorKindFor, so the UI can show a TYPE-specific
   * headline (the room is full vs. the token expired → refresh) instead of one
   * opaque "call failed". We emit BOTH the new classified onFatal (preferred) and
   * the legacy onError (so any consumer still bound to it keeps working).
   */
  private onFatalError = (e: DailyEventObjectFatalError) => {
    // error.type is `any` for non-connection fatal types in the daily-js typings
    // (DailyFatalErrorObject collapses to any); read it defensively.
    const type = (e.error as { type?: string } | undefined)?.type;
    const kind = fatalErrorKindFor(type);
    warn("fatal error", type ?? "(no type)", e.errorMsg);
    this.events.onFatal?.(kind, e.errorMsg ?? "");
    this.events.onError?.(new Error(e.errorMsg || "call error"));
  };

  /**
   * Daily STRUCTURED `camera-error` (Phase 2) — a camera/mic acquisition failure
   * with a typed reason. Maps `error.type` to our language-neutral CameraErrorKind
   * via the PURE cameraErrorKindFor and emits it; the controller mirrors it into
   * cameraStateAtom so the UI can offer the right guidance (an "allow camera"
   * prompt for "permissions"). Non-fatal by default: a camera failure must never
   * tear the AUDIO call down — we only surface the camera state.
   */
  private onCameraError = (e: DailyEventObjectCameraError) => {
    try {
      // error.type is a discriminated union across cam/mic error shapes; the
      // disambiguation fields (blockedMedia/missingMedia/failedMedia) live on
      // the specific variants, so read them defensively off a widened view.
      const error = e.error as
        | {
            type?: string;
            blockedMedia?: Array<"video" | "audio">;
            missingMedia?: Array<"video" | "audio">;
            failedMedia?: Array<"video" | "audio">;
          }
        | undefined;
      const type = error?.type;
      const kind = cameraErrorKindFor(type);
      // Did the failure actually implicate the CAMERA, or is it a mic-only error
      // riding the same event? Mic and camera are acquired on SEPARATE paths
      // here, so a `mic-in-use` / mic-permission failure must NOT drop a working
      // self-view. We disambiguate via Daily's videoOk flag + the per-type media
      // array (blockedMedia / missingMedia / failedMedia).
      const affectsVideo = cameraErrorAffectsVideo({
        type,
        videoOk: e.errorMsg?.videoOk,
        affectedMedia:
          error?.blockedMedia ?? error?.missingMedia ?? error?.failedMedia,
      });
      warn(
        "camera error",
        type ?? "(no type)",
        affectsVideo ? "(video affected)" : "(mic-only)",
        e.errorMsg?.errorMsg,
      );
      // Only when VIDEO actually failed: our local self-view is no longer valid
      // — drop it and flip cameraOn off so the UI stops promising a live camera.
      // input-settings-updated reconciles the authoritative state. A mic-only
      // failure leaves the live camera untouched.
      if (affectsVideo && this.cameraOn) {
        this.cameraOn = false;
        this.releaseLocalVideo();
        const selfSocketId = this.getSocketId();
        if (selfSocketId && this.videoSockets.has(selfSocketId)) {
          this.videoSockets.delete(selfSocketId);
          this.events.onVideoRemoved?.(selfSocketId);
        }
      }
      this.events.onCameraError?.(
        kind,
        e.errorMsg?.errorMsg ?? "",
        affectsVideo,
      );
    } catch (err) {
      warn("onCameraError failed (non-fatal)", err);
    }
  };

  /** Map a Daily non-fatal error type to our language-neutral NonfatalKind.
   *  Centralised + pure so it can be unit-tested. Unknown / future types
   *  collapse to "other" so nothing is swallowed silently. */
  private static nonfatalKindFor(type: string | undefined): NonfatalKind {
    switch (type) {
      case "video-processor-error":
        return "video-processor";
      case "audio-processor-error":
        return "audio-processor";
      case "screen-share-error":
        return "screen-share";
      default:
        return "other";
    }
  }

  /**
   * Daily NON-FATAL error — the call keeps running. The important Phase 0 case
   * is `video-processor-error`: a virtual background (blur/image) failed (e.g.
   * under CPU load). Per Daily's contract, on this error Daily CLEARS the
   * processor AND turns the local camera OFF — so we must sync our own state to
   * "camera off" rather than leaving a stale "on". We do NOT tear the call down
   * (non-fatal by default); we surface a light toast via onNonfatal and let the
   * authoritative `input-settings-updated` event reconcile the true video state.
   */
  private onNonfatalError = (e: DailyEventObjectNonFatalError) => {
    const kind = DailyAudio.nonfatalKindFor(e.type);
    warn("nonfatal error", e.type, e.errorMsg);
    if (kind === "video-processor" && this.cameraOn) {
      // Daily already cleared the processor and disabled local video. Mirror
      // that into OUR state: drop the local self-view tile and flip cameraOn
      // off so the UI stops showing a live camera. input-settings-updated is
      // the source of truth and will confirm video is off (handled below).
      this.cameraOn = false;
      this.releaseLocalVideo();
      const selfSocketId = this.getSocketId();
      if (selfSocketId && this.videoSockets.has(selfSocketId)) {
        this.videoSockets.delete(selfSocketId);
        this.events.onVideoRemoved?.(selfSocketId);
      }
    }
    // Best-effort UI surface (toast). Never alters call lifecycle.
    this.events.onNonfatal?.(kind, e.errorMsg ?? "");
  };

  /**
   * Authoritative input-settings state from Daily. Daily fires this whenever it
   * mutates input settings — including AFTER a video-processor-error, where it
   * has cleared the processor and disabled local video. We read the REAL video
   * state here instead of assuming the last settings we sent still apply. If
   * Daily reports the camera off while we still think it's on, reconcile (drop
   * our self-view + flip cameraOn). Purely defensive + non-fatal.
   */
  private onInputSettingsUpdated = (
    e: DailyEventObjectInputSettingsUpdated,
  ) => {
    try {
      const call = this.call;
      if (!call) {
        return;
      }
      // Read the genuine local-video state from the live participant rather than
      // trusting cached flags. Daily may have turned video off (processor error)
      // without us issuing setLocalVideo(false).
      const local = call.participants?.()?.local;
      const videoState = local?.tracks?.video?.state;
      const videoOff =
        videoState === "off" ||
        videoState === "blocked" ||
        videoState === "interrupted";
      if (this.cameraOn && videoOff) {
        this.cameraOn = false;
        this.releaseLocalVideo();
        const selfSocketId = this.getSocketId();
        if (selfSocketId && this.videoSockets.has(selfSocketId)) {
          this.videoSockets.delete(selfSocketId);
          this.events.onVideoRemoved?.(selfSocketId);
        }
      }
    } catch (err) {
      // Defensive read of participant state — never let it disturb the call.
      warn("onInputSettingsUpdated reconcile failed (non-fatal)", err);
    }
    // Silence the unused-payload lint while keeping the typed param for clarity
    // and Phase-2 extension (it carries inputSettings.video.processor).
    void e;
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
    // Drop any pending autoplay-resume gesture listeners — without this a peer
    // who left before the user ever clicked leaks a window pointerdown/keydown
    // listener (and a closure capturing the dead <audio>).
    if (peer.removeResumeListeners) {
      peer.removeResumeListeners();
      peer.removeResumeListeners = null;
    }
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
      peer.audioEl = null;
    }
    // Disconnect the analyser source node so the AudioContext stops holding a
    // reference to this peer's MediaStream (otherwise it leaks until the whole
    // context is closed on stop()).
    if (peer.sourceNode) {
      try {
        peer.sourceNode.disconnect();
      } catch {
        // already disconnected — ignore
      }
      peer.sourceNode = null;
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
  /** Bless the page for audio playback within the Join gesture so a no-mic
   *  listener can later play peer audio (the autoplay policy otherwise blocks
   *  it — see playPeerAudio). Plays a silent WAV (grants <audio> engagement)
   *  and resumes the AudioContext. Best-effort; the per-gesture retry in
   *  playPeerAudio is the backstop if this is itself blocked. */
  private unlockAudioPlayback() {
    try {
      if (!this.audioUnlockEl) {
        const el = document.createElement("audio");
        el.setAttribute("playsinline", "");
        el.src = SILENT_WAV;
        el.style.display = "none";
        document.body.appendChild(el);
        this.audioUnlockEl = el;
      }
      void this.audioUnlockEl.play().catch(() => undefined);
    } catch {
      // ignore — backstop retry covers it
    }
    try {
      void this.analyserCtx?.resume();
    } catch {
      // ignore
    }
    // Create + resume the STT capture context HERE, inside the Join gesture, so
    // iOS Safari keeps it running. STTSession (which starts later, in a React
    // effect with no user activation) reuses it via getCaptureContext() — a
    // context it created itself would stay SUSPENDED and produce no PCM.
    try {
      if (!this.captureCtx) {
        this.captureCtx = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
      }
      void this.captureCtx.resume();
    } catch {
      // ignore — STT falls back to its own context if this is unavailable
    }
  }

  /** The Join-gesture-unlocked AudioContext for STT capture (see captureCtx).
   *  null until the user has joined audio. */
  getCaptureContext(): AudioContext | null {
    return this.captureCtx;
  }

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
      // Autoplay policy blocks playback until the page has audio engagement —
      // common on a NO-MIC listener (no getUserMedia grant blessed the page) and
      // the remote track arrives after the Join click's activation is gone, so
      // the listener would hear NOTHING (06-18). Retry on EVERY gesture (NOT
      // once) and only stop once playback actually starts — so the user's next
      // interaction with the meeting (draw, click, type) recovers the audio.
      warn("peer audio autoplay blocked; will resume on next gesture", err);
      // CAPTURE phase (the `true` 3rd arg) is essential: the Excalidraw canvas
      // calls stopPropagation() on its pointer handlers, so a BUBBLE-phase
      // window listener never sees a click/draw ON the canvas — which is exactly
      // where a meeting user clicks. Capture fires at window BEFORE the event
      // reaches the canvas target, so the gesture always reaches us (06-18: this
      // was why clicking/drawing didn't recover a no-mic listener's audio).
      const removeResumeListeners = () => {
        window.removeEventListener("pointerdown", resume, true);
        window.removeEventListener("keydown", resume, true);
        window.removeEventListener("touchstart", resume, true);
        if (peer.removeResumeListeners === removeResumeListeners) {
          peer.removeResumeListeners = null;
        }
      };
      const resume = () => {
        // Also nudge the shared analyser AudioContext back to running — iOS/
        // Safari can suspend it, and a suspended context blocks the element too.
        void this.analyserCtx?.resume().catch(() => undefined);
        tryPlay()
          .then(() => removeResumeListeners()) // succeeded → stop retrying
          .catch(() => undefined); // still blocked → keep listening for the next
      };
      window.addEventListener("pointerdown", resume, true);
      window.addEventListener("keydown", resume, true);
      window.addEventListener("touchstart", resume, true);
      // Tracked so teardownPeer can drop these if the peer leaves first.
      peer.removeResumeListeners = removeResumeListeners;
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
      peer.sourceNode = src; // kept so teardownPeer can disconnect() it
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
