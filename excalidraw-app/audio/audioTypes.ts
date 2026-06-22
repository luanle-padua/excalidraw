// Shared audio types — the stable surface consumed by the audio UI and
// the Daily SFU transport (DailyAudio.ts, audioState.ts). Extracted from
// the now-retired mesh AudioRoom so the rest of the audio stack keeps the
// exact same type contract after the P2P mesh was removed.

export type PeerState = {
  socketId: string;
  speaking: boolean;
  /** the remote audio is playing — handy for showing a connecting state */
  hasRemoteStream: boolean;
};

/** Language-neutral CODE for a Daily non-fatal error surfaced to the UI as a
 *  light toast (the call keeps running — see DailyAudio.onNonfatalError). The
 *  controller maps the code to an i18n string at render time; state never
 *  carries a localized message (mirrors AudioErrorKind in audioState.ts).
 *
 *  - `video-processor`: a video processor (virtual background blur/image)
 *    failed. Daily CLEARS the processor AND turns the local camera OFF; the
 *    real post-failure state is read from `input-settings-updated`.
 *  - `audio-processor`: an audio processor (e.g. noise cancellation) failed.
 *  - `screen-share`: a screen-share error (handled in full by Phase 6 parity).
 *  - `other`: any other non-fatal type — surfaced generically so nothing is
 *    swallowed silently.
 *
 *  Phase 2 extends this enum with the remaining nonfatal types; the
 *  `nonfatal-error` listener is registered ONCE here (Phase 0) and reused. */
export type NonfatalKind =
  | "video-processor"
  | "audio-processor"
  | "screen-share"
  | "other";

export type AudioRoomEvents = {
  /** fires whenever the peer roster or any speaking state changes */
  onState: (state: {
    peers: Map<string, PeerState>;
    muted: boolean;
    /** false when this device has no mic and joined as a listener */
    canTransmit: boolean;
  }) => void;
  onError?: (err: Error) => void;
  /** a peer's remote audio stream became available — the meeting
   *  recorder uses this to add the peer into its live audio mix */
  onPeerStream?: (socketId: string, stream: MediaStream) => void;
  /** a peer disconnected — recorder should remove their mix input */
  onPeerRemoved?: (socketId: string) => void;
  /** a participant's CAMERA video track became playable — the
   *  ParticipantsBar renders it into that person's tile (keyed by
   *  socket.id). Fires for remote peers AND the local self-view. */
  onVideoTrack?: (socketId: string, stream: MediaStream) => void;
  /** a participant's camera stopped (toggle off / left) — drop their
   *  <video> tile and fall back to the avatar. */
  onVideoRemoved?: (socketId: string) => void;
  /** the active speaker changed (Daily SFU "active-speaker-change"), mapped
   *  back to OUR socket.id; null when nobody is speaking. The controller
   *  mirrors this into activeSpeakerAtom for the layout lane's speaker ring. */
  onActiveSpeaker?: (socketId: string | null) => void;
  /** a Daily NON-FATAL error occurred (the call keeps running). Carries a
   *  language-neutral CODE — the controller maps it to a light toast at render
   *  time. `rawMsg` is dev-facing detail (console only), never shown localized.
   *  Used by Phase 0 for `video-processor-error` (virtual background failed →
   *  Daily cleared the processor + turned the camera off); extended in Phase 2. */
  onNonfatal?: (kind: NonfatalKind, rawMsg: string) => void;
  /** Daily's STRUCTURED `camera-error` (Phase 2) — a camera/mic acquisition
   *  failure with a typed reason. Carries a language-neutral CODE
   *  (CameraErrorKind); the controller mirrors it into cameraStateAtom
   *  ({status:"error", errorKind}) so MeetingCallControls can show the right
   *  guidance (e.g. an "allow camera" prompt for "permissions"). `rawMsg` is
   *  dev-facing detail (console / tooltip), never shown localized. This is the
   *  CALL-OBJECT signal, distinct from the getUserMedia exception the camera
   *  toggle already classifies on its own path.
   *
   *  `affectsVideo` disambiguates a real camera failure from a mic-only failure
   *  that merely rides the same `camera-error` event (mic and camera are on
   *  SEPARATE acquisition paths here). When false (e.g. `mic-in-use`), the
   *  controller must NOT flip cameraStateAtom into an error state — a working
   *  self-view stays live. */
  onCameraError?: (
    kind: import("./videoState").CameraErrorKind,
    rawMsg: string,
    affectsVideo: boolean,
  ) => void;
  /** a Daily FATAL `error` (the call is over). Carries a language-neutral CODE
   *  (AudioErrorKind) already classified from `error.type` in DailyAudio, plus
   *  the raw dev-facing message. The controller flips audioStateAtom to
   *  {status:"error", errorKind} so MeetingCallControls shows the right headline
   *  (meeting full / token expired / generic). Distinct from onError, which
   *  carries an un-classified Error from the getUserMedia / token paths. */
  onFatal?: (
    kind: import("./audioState").AudioErrorKind,
    rawMsg: string,
  ) => void;
  /** the call's CONNECTIVITY lifecycle changed (Daily "network-connection").
   *  `lifecycle` is a language-neutral CODE (connected / reconnecting /
   *  unstable); `reasons` carries raw machine codes for the tooltip (e.g. the
   *  degraded path "signaling" / "sfu"). The controller mirrors this into
   *  connectionStateAtom, which drives the reconnecting/unstable banner. The
   *  imports of those code types live in connectionState.ts (Phase 1). */
  onConnectionState?: (
    lifecycle: import("./connectionState").ConnectionLifecycle,
    reasons: string[],
  ) => void;
  /** the call's link QUALITY changed (Daily "network-quality-change"). `quality`
   *  is a language-neutral CODE (good / low / bad); `reasons` carries Daily's
   *  raw reason codes (sendPacketLoss / recvPacketLoss / roundTripTime /
   *  availableOutgoingBitrate) for the chip tooltip. */
  onConnectionQuality?: (
    quality: import("./connectionState").ConnectionQuality,
    reasons: string[],
  ) => void;
  /** Phase 4 — a fresh getNetworkStats() sample (pulled on a ~2s interval while
   *  the call is live). Daily has no live-quality webhook, so this poll is the
   *  only real-time observability source. The controller pours the sample into
   *  connectionStateAtom so the quality CHIP tooltip can show real numbers
   *  (rtt / loss / bitrate) instead of just reason codes. Carries narrowed
   *  numeric fields only (NetworkStatsSample) — never a localized string. */
  onStats?: (sample: import("./dailyTelemetry").NetworkStatsSample) => void;
  /** Phase 4 — the Daily meeting SESSION id, captured from
   *  meetingSessionSummary() after joined-meeting (and re-emitted on
   *  "meeting-session-summary-updated"). Lets a post-meeting log/recording be
   *  cross-referenced to the exact Daily session. The controller currently just
   *  records it (console); attaching it to recorder metadata is deferred (the
   *  recorder has no metadata hook yet). */
  onSessionId?: (sessionId: string) => void;
};
