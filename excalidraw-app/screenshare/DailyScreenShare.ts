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

import {
  screenShareFatalKindFor,
  screenShareLinkFor,
} from "./screenShareState";

import type {
  DailyCall,
  DailyEventObjectTrack,
  DailyEventObjectFatalError,
  DailyEventObjectNonFatalError,
  DailyEventObjectNetworkConnectionEvent,
  DailyEventObjectParticipantLeft,
} from "@daily-co/daily-js";

import type {
  ScreenShareErrorKind,
  ScreenShareLink,
  ScreenShareMedia,
  ScreenShareStatus,
} from "./screenShareState";

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
  /** OUR OWN screen stream, wrapped for the presenter self-preview. Built from
   *  the same local screenVideo track that flips localActive (reusing the remote
   *  MediaStream pattern) and torn down on stop/leave so we never leak. */
  private localStream: MediaStream | null = null;
  private localSurface: "monitor" | "window" | "browser" | null = null;
  private localLabel: string | null = null;
  private errorKind: ScreenShareErrorKind | null = null;
  private errorMessage: string | null = null;
  /** connectivity lifecycle of the screen-share call (Daily network-connection),
   *  surfaced to the presenter; reset to "connected" on leave(). */
  private link: ScreenShareLink = "connected";
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
      localStream: this.localStream,
      localSurface: this.localSurface,
      localLabel: this.localLabel,
      errorKind: this.errorKind,
      errorMessage: this.errorMessage,
      link: this.link,
    });
  }

  /** Set a language-neutral error code + raw dev detail, then recompute/emit.
   *  Centralises the error path so every failure carries a code the UI can map
   *  to i18n (never a bare localized string). */
  private setError(kind: ScreenShareErrorKind, raw: string | null) {
    this.errorKind = kind;
    this.errorMessage = raw;
    this.recomputeStatus();
    this.emit();
  }

  /** Recompute the coarse status from the underlying flags. */
  private recomputeStatus() {
    if (this.errorKind) {
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
    this.errorKind = null;
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
        this.setError("token", "no token");
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
        this.setError(
          "call",
          err instanceof Error ? err.message : "join failed",
        );
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
    // Phase 6 parity with the audio call object: surface non-fatal screen-share
    // errors (instead of swallowing them) + the call's connectivity lifecycle so
    // a dropped/recovering screen-share call is visible to the presenter rather
    // than silently freezing.
    call.on("nonfatal-error", this.onNonfatalError);
    call.on("network-connection", this.onNetworkConnection);
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
      // Recover the self-preview too — Daily won't re-fire a local track-started
      // for the pre-existing track, so capture it from the participant set.
      const t = sv?.persistentTrack ?? sv?.track;
      if (t) {
        this.captureLocalSelfPreview(t);
      }
      this.recomputeStatus();
      this.emit();
      this.events.onLocalShareChange(true);
    }
  }

  /** Capture OUR own live screen track into a self-preview MediaStream + read
   *  its source kind/label, so the presenter can see what everyone else sees.
   *  Reuses the remote `new MediaStream([track])` pattern. Idempotent: if the
   *  same track is already wrapped this is a no-op (never double-wraps). Does
   *  NOT emit — the caller emits once after flipping localActive. */
  private captureLocalSelfPreview(track: MediaStreamTrack) {
    if (this.localStream?.getVideoTracks()[0] === track) {
      return; // already wrapped this exact track — don't double-wrap
    }
    this.localStream = new MediaStream([track]);
    // displaySurface is Chromium-only — guard the cast; Safari/Firefox give
    // undefined → null (the UI shows a generic "screen" label). Never parse the
    // label for logic; it's free browser text shown as-is.
    const surface = track.getSettings().displaySurface;
    this.localSurface =
      surface === "monitor" || surface === "window" || surface === "browser"
        ? surface
        : null;
    this.localLabel = track.label || null;
  }

  /** Drop the self-preview stream + source metadata when our share ends. We
   *  do NOT stop the underlying track here — Daily owns its lifecycle
   *  (stopScreenShare / leave handles that); we only release our MediaStream
   *  wrapper so it doesn't dangle. */
  private clearLocalSelfPreview() {
    this.localStream = null;
    this.localSurface = null;
    this.localLabel = null;
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
      this.setError(
        "share",
        err instanceof Error ? err.message : "screen share failed",
      );
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
    this.clearLocalSelfPreview();
    this.errorKind = null;
    this.errorMessage = null;
    this.link = "connected";
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
        // Keep e.track (previously discarded): wrap it for the presenter's own
        // self-preview so they SEE what everyone else sees.
        if (e.track) {
          this.captureLocalSelfPreview(e.track);
        }
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
        this.clearLocalSelfPreview();
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

  /**
   * Daily FATAL error on the SCREEN-SHARE call object — the screen-share call is
   * over. Phase 6 parity: classify `error.type` into a language-neutral
   * ScreenShareErrorKind via the PURE screenShareFatalKindFor, so the UI can show
   * a TYPE-specific message (room full / token expired → refresh) instead of one
   * opaque "screen share error". This NEVER touches the separate AUDIO call.
   */
  private onFatalError = (e: DailyEventObjectFatalError) => {
    // error.type is `any` for non-connection fatal types in the daily-js typings;
    // read it defensively.
    const type = (e.error as { type?: string } | undefined)?.type;
    const kind = screenShareFatalKindFor(type);
    warn("fatal error", type ?? "(no type)", e.errorMsg);
    this.setError(kind, e.errorMsg || "screen share error");
  };

  /**
   * Daily NON-FATAL error — the screen-share call keeps running. The important
   * case here is `screen-share-error`: the local screen share itself failed (the
   * picker errored, the source was lost, or capture stopped). Previously this was
   * swallowed; now we surface a clear, language-neutral "share" error so the
   * presenter learns why their screen stopped. Non-fatal by default: we do NOT
   * tear the call down (a remote viewer keeps watching anyone else still sharing).
   */
  private onNonfatalError = (e: DailyEventObjectNonFatalError) => {
    try {
      warn("nonfatal error", e.type, e.errorMsg);
      if (e.type !== "screen-share-error") {
        return; // not our concern — keep the call running, don't churn state
      }
      // The local screen-share dropped. Reflect that we're no longer presenting
      // and broadcast presence off so peers prune our stale SCREEN_SHARE badge.
      if (this.localActive) {
        this.localActive = false;
        this.clearLocalSelfPreview();
        this.events.onLocalShareChange(false);
      }
      this.setError("share", e.errorMsg || "screen share error");
    } catch (err) {
      warn("onNonfatalError failed (non-fatal)", err);
    }
  };

  /**
   * Daily "network-connection" on the screen-share call object → connectivity
   * lifecycle, surfaced to the presenter so a dropped/recovering screen-share
   * call is visible instead of a silently frozen frame. Maps the payload via the
   * PURE screenShareLinkFor. Non-fatal by default: ANY failure is caught, logged
   * and swallowed — a monitoring signal must never tear down a working call.
   */
  private onNetworkConnection = (
    e: DailyEventObjectNetworkConnectionEvent,
  ) => {
    try {
      const link = screenShareLinkFor(e);
      if (!link || link === this.link) {
        return; // intermediate/unknown event or no change — don't churn state
      }
      this.link = link;
      log(`network-connection ${e.type}/${e.event} → ${link}`);
      // A connectivity blip is NOT an error state — the call recovers. We only
      // update `link` (the presenter notice) and re-emit; status is unchanged.
      this.emit();
    } catch (err) {
      warn("onNetworkConnection failed (non-fatal)", err);
    }
  };
}
