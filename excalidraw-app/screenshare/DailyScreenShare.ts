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
    call.on("participant-left", this.onParticipantLeft);
    call.on("error", this.onFatalError);
  }

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
      this.remoteStream = new MediaStream([e.track]);
      this.remoteSharerName = e.participant.user_name || "Participant";
      this.recomputeStatus();
      this.emit();
    }
  };

  private onTrackStopped = (e: DailyEventObjectTrack) => {
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
    } else if (this.remoteStream) {
      this.remoteStream = null;
      this.remoteSharerName = null;
      this.recomputeStatus();
      this.emit();
    }
  };

  private onParticipantLeft = (_e: DailyEventObjectParticipantLeft) => {
    // If the presenter left abruptly we may not get track-stopped; reconcile
    // against the current participant set.
    if (!this.call) {
      return;
    }
    const participants = this.call.participants();
    const someoneRemoteSharing = Object.values(participants).some(
      (p) => !p.local && p.tracks.screenVideo.state === "playable",
    );
    if (!someoneRemoteSharing && this.remoteStream) {
      this.remoteStream = null;
      this.remoteSharerName = null;
      this.recomputeStatus();
      this.emit();
    }
  };

  private onFatalError = (e: DailyEventObjectFatalError) => {
    warn("fatal error", e.errorMsg);
    this.errorMessage = e.errorMsg || "screen share error";
    this.recomputeStatus();
    this.emit();
  };
}
