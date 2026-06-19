// Imperative manager around ONE Daily.co call object — the screen-share
// equivalent of audio/AudioRoom.ts, but far thinner because Daily handles all
// the WebRTC/SFU plumbing. We never touch the app's socket here: media flows
// over Daily; the socket only carries presence/lock (the controller bridges
// that via collabAPI.setScreenShare on our onLocalShareChange callback).
//
// Lifecycle (lazy — we only hold a Daily connection while someone is sharing):
//   startSharing() → ensureJoined() → call.startScreenShare()  (browser picks a
//     screen; a local "screenVideo" track-started fires → we flip localActive +
//     fire onLocalShareChange(true) so the controller broadcasts presence).
//   A remote presenter's "screenVideo" track-started → we surface a MediaStream
//     for the viewer pane.
//   leave() → tear the Daily connection down and reset to idle.

import Daily from "@daily-co/daily-js";

import type {
  DailyCall,
  DailyEventObjectTrack,
  DailyEventObjectFatalError,
  DailyEventObjectParticipantLeft,
} from "@daily-co/daily-js";

import type { ScreenShareMedia, ScreenShareStatus } from "./screenShareState";

export type DailyTokenFetcher = (
  roomId: string,
  userName: string,
) => Promise<{ url: string; token: string } | null>;

export type DailyScreenShareEvents = {
  /** snapshot of the media state for the UI atom */
  onState: (state: ScreenShareMedia) => void;
  /** fires when OUR local screen share actually starts/stops (driven by the
   *  real local track), so the controller can broadcast presence + flip the
   *  single-share lock. Never fires for a cancelled screen-picker. */
  onLocalShareChange: (sharing: boolean) => void;
};

const log = (...args: unknown[]) => console.info("[screenshare]", ...args);
const warn = (...args: unknown[]) => console.warn("[screenshare]", ...args);

export class DailyScreenShare {
  private readonly roomId: string;
  private readonly userName: string;
  private readonly getToken: DailyTokenFetcher;
  private readonly events: DailyScreenShareEvents;

  private call: DailyCall | null = null;
  private joining: Promise<boolean> | null = null;
  private destroyed = false;

  // media state
  private status: ScreenShareStatus = "idle";
  private remoteStream: MediaStream | null = null;
  private remoteSharerName: string | null = null;
  private localActive = false;
  private errorMessage: string | null = null;
  /** hidden <audio> playing a remote presenter's shared tab/system audio
   *  (the "screenAudio" track). Daily does NOT auto-play screen audio in
   *  call-object mode, so we play it ourselves. */
  private screenAudioEl: HTMLAudioElement | null = null;
  /** Track id of the remote screen-video currently attached to remoteStream —
   *  lets reconcileRemoteScreenVideo() skip rebuilding the MediaStream (and
   *  re-attaching the <video>) when nothing actually changed. */
  private currentScreenTrackId: string | null = null;

  constructor(opts: {
    roomId: string;
    userName: string;
    getToken: DailyTokenFetcher;
    events: DailyScreenShareEvents;
  }) {
    this.roomId = opts.roomId;
    this.userName = opts.userName;
    this.getToken = opts.getToken;
    this.events = opts.events;
  }

  // ---- state snapshot ----------------------------------------------------

  private emit() {
    this.events.onState({
      status: this.status,
      remoteStream: this.remoteStream,
      remoteSharerName: this.remoteSharerName,
      localActive: this.localActive,
      errorMessage: this.errorMessage,
    });
  }

  /** Recompute the coarse status from the underlying flags. */
  private recomputeStatus() {
    if (this.errorMessage) {
      this.status = "error";
    } else if (this.localActive) {
      this.status = "sharing";
    } else if (this.remoteStream) {
      this.status = "viewing";
    } else if (this.call || this.joining) {
      this.status = this.joining ? "connecting" : "idle";
    } else {
      this.status = "idle";
    }
  }

  // ---- Daily connection --------------------------------------------------

  /** Join the Daily room (idempotent + de-duped). Resolves true on success. */
  async ensureJoined(): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }
    if (this.call) {
      return true;
    }
    if (this.joining) {
      return this.joining;
    }
    this.errorMessage = null;
    this.recomputeStatus();
    this.status = "connecting";
    this.emit();

    this.joining = (async () => {
      const cfg = await this.getToken(this.roomId, this.userName);
      if (this.destroyed) {
        return false;
      }
      if (!cfg) {
        this.errorMessage = "token";
        this.recomputeStatus();
        this.emit();
        return false;
      }
      // No webcam/mic — viewers join silently (no device prompts) and the
      // sharer only sends a screen track. Auto-subscribe so a remote screen
      // surfaces as a track-started without manual subscription.
      const call = Daily.createCallObject({
        videoSource: false,
        audioSource: false,
        subscribeToTracksAutomatically: true,
        // audio call + screen share are two separate call objects on the page
        allowMultipleCallInstances: true,
      });
      this.wire(call);
      try {
        log(`joining room ${this.roomId}`);
        await call.join({
          url: cfg.url,
          token: cfg.token,
          startVideoOff: true,
          startAudioOff: true,
        });
        if (this.destroyed) {
          await call.destroy().catch(() => undefined);
          return false;
        }
        this.call = call;
        // Pick up a share that started BEFORE we joined (Daily fires
        // track-started only for tracks beginning after we subscribe), so a
        // late joiner sees an in-progress screen share.
        this.reconcileRemoteScreenVideo();
        // A sharer who REFRESHED mid-share rejoins Daily with the screen track
        // still live in the SFU, but localActive was reset to false by the
        // reload — Daily won't re-fire a local track-started for the existing
        // track. Re-detect our own active screenVideo here so the controller
        // re-broadcasts SCREEN_SHARE presence (otherwise peers prune our old
        // socketId and never re-learn we're presenting). Idempotent.
        this.reconcileLocalScreenShare();
        this.recomputeStatus();
        this.emit();
        return true;
      } catch (err) {
        warn("join failed", err);
        this.errorMessage = err instanceof Error ? err.message : "join failed";
        this.recomputeStatus();
        this.emit();
        await call.destroy().catch(() => undefined);
        return false;
      }
    })();

    try {
      return await this.joining;
    } finally {
      this.joining = null;
    }
  }

  private wire(call: DailyCall) {
    call.on("track-started", this.onTrackStarted);
    call.on("track-stopped", this.onTrackStopped);
    // participant-updated is how Daily signals a screen-video mute/un-mute
    // (e.g. the presenter minimising the shared window) — track-started does NOT
    // re-fire on un-mute, so without this the viewer's video froze/blacked out
    // and never recovered (06-18).
    call.on("participant-updated", this.onParticipantUpdated);
    call.on("participant-left", this.onParticipantLeft);
    call.on("error", this.onFatalError);
  }

  /** Reconcile the remote screen VIDEO against the live participant set. Daily
   *  only fires track-started for tracks that BEGIN after we subscribe, and
   *  signals a minimise/occlude (mute→un-mute) via participant-updated rather
   *  than a fresh track-started. So scanning participants() here — on join,
   *  participant-updated, track start/stop and leave — is what makes a LATE
   *  JOINER pick up an in-progress share and a minimised window RECOVER when it
   *  un-mutes. Audio is handled separately (track-started/stopped). */
  private reconcileRemoteScreenVideo() {
    const call = this.call;
    if (!call) {
      return;
    }
    let track: MediaStreamTrack | null = null;
    let name = "Participant";
    for (const p of Object.values(call.participants())) {
      if (p.local) {
        continue;
      }
      const sv = p.tracks.screenVideo;
      const t = sv?.persistentTrack ?? sv?.track;
      if (sv?.state === "playable" && t) {
        track = t;
        name = p.user_name || "Participant";
        break;
      }
    }
    if (track) {
      if (this.currentScreenTrackId !== track.id) {
        this.currentScreenTrackId = track.id;
        this.remoteStream = new MediaStream([track]);
        this.remoteSharerName = name;
        this.recomputeStatus();
        this.emit();
      }
    } else if (this.remoteStream || this.currentScreenTrackId) {
      this.currentScreenTrackId = null;
      this.remoteStream = null;
      this.remoteSharerName = null;
      this.recomputeStatus();
      this.emit();
    }
  }

  /** Reconcile OUR OWN screen-share against the live participant set. Used on
   *  (re)join to recover a local share that survived a reload: the screen
   *  track is still live in the SFU but `localActive` was reset, and Daily does
   *  NOT re-fire a local track-started for a pre-existing track. Detecting it
   *  here lets us flip localActive back on and tell the controller to
   *  re-broadcast presence. Idempotent — if localActive is already true (or we
   *  have no local screen track) this is a no-op and never double-fires. */
  private reconcileLocalScreenShare() {
    const call = this.call;
    if (!call || this.localActive) {
      return;
    }
    const local = call.participants().local;
    const sv = local?.tracks.screenVideo;
    // "sendable"/"playable" (or simply not "off"/"blocked") means our screen
    // track is actually live in the SFU; an absent/off track means we're not
    // really sharing and must not announce presence.
    const live =
      !!sv && sv.state !== "off" && sv.state !== "blocked" && !!local?.local;
    if (live) {
      this.localActive = true;
      this.recomputeStatus();
      this.emit();
      this.events.onLocalShareChange(true);
    }
  }

  private onParticipantUpdated = () => {
    this.reconcileRemoteScreenVideo();
  };

  // ---- sharing -----------------------------------------------------------

  /** Begin presenting OUR screen. The browser prompts for a screen/window;
   *  presence is broadcast only once the real local track starts. */
  async startSharing(): Promise<boolean> {
    const ok = await this.ensureJoined();
    if (!ok || !this.call) {
      return false;
    }
    try {
      log("startScreenShare()");
      this.call.startScreenShare();
      return true;
    } catch (err) {
      warn("startScreenShare failed", err);
      this.errorMessage =
        err instanceof Error ? err.message : "screen share failed";
      this.recomputeStatus();
      this.emit();
      return false;
    }
  }

  /** Stop presenting. Stays joined (the controller decides whether to leave). */
  stopSharing() {
    if (this.call && this.localActive) {
      log("stopScreenShare()");
      try {
        this.call.stopScreenShare();
      } catch (err) {
        warn("stopScreenShare failed", err);
      }
    }
  }

  /** Tear the Daily connection down and reset to idle (lazy disconnect when
   *  nobody is sharing). */
  async leave() {
    const call = this.call;
    this.call = null;
    this.stopRemoteScreenAudio();
    this.remoteStream = null;
    this.remoteSharerName = null;
    const wasSharing = this.localActive;
    this.localActive = false;
    this.errorMessage = null;
    this.status = "idle";
    this.emit();
    if (wasSharing) {
      this.events.onLocalShareChange(false);
    }
    if (call) {
      try {
        await call.leave();
      } catch {
        // ignore
      }
      await call.destroy().catch(() => undefined);
    }
  }

  /** Permanent teardown (component unmount / room exit). */
  async destroy() {
    this.destroyed = true;
    await this.leave();
  }

  isLocalSharing(): boolean {
    return this.localActive;
  }

  isConnected(): boolean {
    return !!this.call;
  }

  // ---- Daily event handlers ----------------------------------------------

  private onTrackStarted = (e: DailyEventObjectTrack) => {
    log(
      `track-started type=${e.type} local=${e.participant?.local} from=${e.participant?.user_name}`,
    );
    // Remote shared tab/system audio → play it (Daily won't auto-play it).
    if (e.type === "screenAudio" && e.participant && !e.participant.local) {
      this.playRemoteScreenAudio(e.track);
      return;
    }
    if (e.type !== "screenVideo" || !e.participant) {
      return;
    }
    if (e.participant.local) {
      if (!this.localActive) {
        this.localActive = true;
        this.recomputeStatus();
        this.emit();
        this.events.onLocalShareChange(true);
      }
    } else {
      log(`remote screen from ${e.participant.user_name}`);
      // Resolve via the participant set so this stays consistent with the
      // mute/un-mute (participant-updated) and late-join paths.
      this.reconcileRemoteScreenVideo();
    }
  };

  private onTrackStopped = (e: DailyEventObjectTrack) => {
    if (e.type === "screenAudio") {
      this.stopRemoteScreenAudio();
      return;
    }
    if (e.type !== "screenVideo") {
      return;
    }
    // participant may be null if they already left — treat as remote-stop.
    if (e.participant?.local) {
      if (this.localActive) {
        this.localActive = false;
        this.recomputeStatus();
        this.emit();
        this.events.onLocalShareChange(false);
      }
    } else {
      // Remote stop — reconcile (handles "another remote is still sharing" too).
      this.reconcileRemoteScreenVideo();
    }
  };

  private onParticipantLeft = (_e: DailyEventObjectParticipantLeft) => {
    // The presenter may leave without a track-stopped; reconcile against the
    // live participant set.
    this.reconcileRemoteScreenVideo();
  };

  private playRemoteScreenAudio(track: MediaStreamTrack) {
    this.stopRemoteScreenAudio();
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.srcObject = new MediaStream([track]);
    el.style.display = "none";
    document.body.appendChild(el);
    this.screenAudioEl = el;
    const tryPlay = () => el.play();
    tryPlay().catch((err) => {
      // Autoplay policy may block until a user gesture — retry once on the
      // next click/keydown anywhere in the page.
      warn("screen audio autoplay blocked; will resume on next gesture", err);
      const resume = () => {
        tryPlay().catch(() => undefined);
        window.removeEventListener("pointerdown", resume);
        window.removeEventListener("keydown", resume);
      };
      window.addEventListener("pointerdown", resume, { once: true });
      window.addEventListener("keydown", resume, { once: true });
    });
    log("remote screen AUDIO attached");
  }

  private stopRemoteScreenAudio() {
    if (this.screenAudioEl) {
      this.screenAudioEl.pause();
      this.screenAudioEl.srcObject = null;
      this.screenAudioEl.remove();
      this.screenAudioEl = null;
    }
  }

  private onFatalError = (e: DailyEventObjectFatalError) => {
    warn("fatal error", e.errorMsg);
    this.errorMessage = e.errorMsg || "screen share error";
    this.recomputeStatus();
    this.emit();
  };
}
