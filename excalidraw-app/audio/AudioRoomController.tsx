// Controller component that wires the AudioRoom imperative manager to
// the Jotai state used by the UI. Mounted once at app shell level —
// owns the AudioRoom lifecycle so any component (header, sidebar,
// participants bar) can read state and dispatch commands via the atoms.
//
// The audio call follows the collab room: when activeRoomLink becomes
// non-null we provision an AudioRoom. Join is now listener-only — no mic
// prompt at join; the mic is acquired lazily on the first unmute or when STT
// is enabled (see ensureMic). When the room link clears, we tear everything
// down.

import { useEffect, useRef } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";
import { activeRoomLinkAtom, collabAPIAtom } from "../collab/Collab";
import { showAppToast } from "../data/appToast";
import { getDailyToken } from "../data/projects";
import { useT } from "../i18n/mcm";
import { sttProviderAtom } from "../data/sttProviders";
import {
  sttCapturingAtom,
  sttEnabledAtom,
  sttLiveErrorAtom,
  sttSpokenLanguageAtom,
} from "../data/transcription";

import { DailyAudio } from "./DailyAudio";
import {
  audioRoomInstanceAtom,
  audioStateAtom,
  preJoinCamIntentAtom,
  preJoinMicIntentAtom,
  preJoinPendingAtom,
  recorderInstanceAtom,
  recordingStateAtom,
} from "./audioState";
import {
  CONNECTION_STATE_DEFAULT,
  connectionStateAtom,
} from "./connectionState";
import { formatStatsTooltip } from "./dailyTelemetry";
import { STTSession } from "./sttSession";
import { activeSpeakerAtom } from "./videoPerf";
import { cameraStateAtom, videoTilesAtom } from "./videoState";

import type { STTLang } from "./sttSession";

export const AudioRoomController = () => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const recorder = useAtomValue(recorderInstanceAtom);
  const audioState = useAtomValue(audioStateAtom);
  const sttEnabled = useAtomValue(sttEnabledAtom);
  const sttProvider = useAtomValue(sttProviderAtom);
  // Language the local user SPEAKS — drives Deepgram capture, independent of
  // the app UI language. Defaults to the UI preferred language until the user
  // picks one in the STT panel.
  const spokenLang = useAtomValue(sttSpokenLanguageAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const setAudioRoomInstance = useSetAtom(audioRoomInstanceAtom);
  const setRecordingState = useSetAtom(recordingStateAtom);
  const setRecorderInstance = useSetAtom(recorderInstanceAtom);
  const setVideoTiles = useSetAtom(videoTilesAtom);
  const setCameraState = useSetAtom(cameraStateAtom);
  const setActiveSpeaker = useSetAtom(activeSpeakerAtom);
  const setConnectionState = useSetAtom(connectionStateAtom);
  const setSttLiveError = useSetAtom(sttLiveErrorAtom);
  const setSttCapturing = useSetAtom(sttCapturingAtom);
  // Pre-join "green room" gate (Item 6). Raised (to the roomId) when a NEW room
  // is provisioned; reset on idle teardown so a fresh room re-gates and a
  // reconnect to the SAME room never re-shows the modal.
  const setPreJoinPending = useSetAtom(preJoinPendingAtom);
  const setPreJoinMicIntent = useSetAtom(preJoinMicIntentAtom);
  const setPreJoinCamIntent = useSetAtom(preJoinCamIntentAtom);
  // Translator bound to the viewer's current language. Held in a ref so the
  // long-lived DailyAudio event closures (installed once when the room is
  // created) always read the CURRENT language at toast time — state stays
  // language-neutral (a CODE crosses the boundary; the string is built here).
  const t = useT();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  /** Live STT session bound to the user's own mic. Spun up when the
   *  audio call goes live, torn down when the call ends or STT
   *  toggle is flipped off. */
  const sttRef = useRef<STTSession | null>(null);
  /** Unix ms of the last PCM-capture heartbeat from the live session (see
   *  STTSession.onCapture). A watchdog interval compares against it to flip
   *  `sttCapturingAtom` false once frames stop — that's the "enabled but no
   *  audio" signal. Held in a ref (not state) so the heartbeat doesn't re-render. */
  const lastCaptureAtRef = useRef(0);
  /** keep a ref of the live DailyAudio for cleanup independent of React
   *  render timing — we must tear the call down deterministically */
  const roomRef = useRef<DailyAudio | null>(null);
  /** mirror of `recorder` for the AudioRoom event closures, which are
   *  installed once when the room is created and need to see the live
   *  recorder without recreating the room */
  const recorderRef = useRef(recorder);
  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  // Provision / tear down the AudioRoom based on collab room state. We
  // only *create* the instance here — the mic prompt is deferred to
  // the explicit "Join audio" click so we never ask before the user
  // expects it.
  useEffect(() => {
    if (!collabAPI || !activeRoomLink) {
      const room = roomRef.current;
      if (room) {
        const rec = recorderRef.current;
        if (rec) {
          rec.close();
          recorderRef.current = null;
          setRecorderInstance(null);
          setRecordingState({
            status: "idle",
            inputCount: 0,
            lastResult: null,
            errorMessage: null,
          });
        }
        room.stop();
        roomRef.current = null;
        setAudioRoomInstance(null);
        setAudioState({
          status: "idle",
          muted: false,
          canTransmit: true,
          peers: new Map(),
          errorKind: null,
          errorMessage: null,
        });
        setVideoTiles(new Map());
        setCameraState({ status: "off", errorKind: null, errorMessage: null });
        setActiveSpeaker(null);
        // Phase 1: drop any reconnecting/unstable banner + reset the quality
        // chip when the call tears down, so a new call never inherits a stale
        // network-warning UI (symmetric with DailyAudio.stop()).
        setConnectionState(CONNECTION_STATE_DEFAULT);
        // Item 6: reset the pre-join gate + intents so the NEXT room re-gates
        // from a clean slate (no stale mic/camera intent leaks across rooms).
        setPreJoinPending(null);
        setPreJoinMicIntent(false);
        setPreJoinCamIntent(false);
      }
      return;
    }

    if (roomRef.current) {
      return;
    }

    const roomId = activeRoomLink.match(/#room=([a-zA-Z0-9_-]+),/)?.[1];
    if (!roomId) {
      return;
    }

    // Item 6: raise the pre-join gate for THIS room. Keyed by roomId so a
    // reconnect that re-provisions the SAME room doesn't re-gate a user who
    // already chose (MeetingShell only shows the modal while pending === the
    // current room AND audio is idle). Reset intents to the lazy defaults.
    setPreJoinPending(roomId);
    setPreJoinMicIntent(false);
    setPreJoinCamIntent(false);

    console.info(`[audio] controller provisioning DailyAudio (${roomId})`);
    const room = new DailyAudio({
      roomId,
      userName: collabAPI.getUsername() || "Guest",
      getSocketId: () => collabAPI.portal.socket?.id ?? null,
      // Forward the 3rd arg (our DO socket.id) → ?uid → the Worker bakes it
      // into Daily's user_id, so a remote peer's video/audio track maps back to
      // the real socket.id (not a random Daily UUID). Dropping it was why a
      // peer's CAMERA never rendered: the tile is keyed by socket.id but the
      // track arrived keyed by Daily's UUID, so it never matched (06-18).
      getToken: (rid, name, uid) => getDailyToken(rid, name, uid),
      events: {
        onState: ({ peers, muted, canTransmit }) => {
          setAudioState((prev) => ({
            ...prev,
            peers,
            muted,
            canTransmit,
            status: prev.status === "connecting" ? "live" : prev.status,
          }));
        },
        onPeerStream: (socketId, stream) => {
          const rec = recorderRef.current;
          if (rec?.isRecording()) {
            rec.addStream(socketId, stream);
            setRecordingState((prev) => ({
              ...prev,
              inputCount: prev.inputCount + 1,
            }));
          }
        },
        onPeerRemoved: (socketId) => {
          const rec = recorderRef.current;
          if (rec?.isRecording()) {
            rec.removeStream(socketId);
            setRecordingState((prev) => ({
              ...prev,
              inputCount: Math.max(0, prev.inputCount - 1),
            }));
          }
        },
        // CAMERA video (same call object) → drive the videoTilesAtom keyed by
        // socket.id. ParticipantsBar renders a <video> into that person's tile;
        // absence of an entry falls the tile back to the MCMAvatar.
        onVideoTrack: (socketId, stream) => {
          setVideoTiles((prev) => {
            const next = new Map(prev);
            next.set(socketId, stream);
            return next;
          });
        },
        onVideoRemoved: (socketId) => {
          setVideoTiles((prev) => {
            if (!prev.has(socketId)) {
              return prev;
            }
            const next = new Map(prev);
            next.delete(socketId);
            return next;
          });
        },
        // Active speaker (Daily SFU) → activeSpeakerAtom, read by the layout
        // lane to ring that person's tile. Already mapped to our socket.id in
        // DailyAudio (null clears the ring).
        onActiveSpeaker: (socketId) => {
          setActiveSpeaker(socketId);
        },
        // Phase 1 — network resilience. Both callbacks carry language-neutral
        // CODES (DailyAudio already mapped Daily's payloads); we only pour them
        // into connectionStateAtom here, where ConnectionBanner maps each code
        // to an i18n string at render time. Lifecycle drives the
        // reconnecting/unstable banner; quality drives the header chip.
        onConnectionState: (lifecycle, reasons) => {
          setConnectionState((prev) => ({ ...prev, lifecycle, reasons }));
        },
        onConnectionQuality: (quality, reasons) => {
          setConnectionState((prev) => ({ ...prev, quality, reasons }));
        },
        // Phase 4 — observability. A fresh getNetworkStats() sample (~2s). We
        // format it to a short real-numbers suffix HERE (the only non-code field
        // in the atom — pure numerics + units, language-neutral) so the quality
        // chip tooltip can show "rtt 180ms · loss 4% · 320kbps" alongside the
        // reason codes. Pour into the atom only; never alters call lifecycle.
        onStats: (sample) => {
          const statsTooltip = formatStatsTooltip(sample);
          setConnectionState((prev) => ({ ...prev, statsTooltip }));
        },
        // Phase 4 — the Daily meeting SESSION id (captured after join). Record
        // it for cross-referencing a post-meeting log/recording. Attaching it to
        // recorder metadata is deferred (no metadata hook on MeetingRecorder
        // yet); a structured console line is the LIGHT sink for now.
        onSessionId: (sessionId) => {
          console.info(`[audio] daily session id: ${sessionId}`);
        },
        // Daily NON-FATAL error (the call keeps running). Carries a
        // language-neutral CODE; map it to a light toast here at the controller
        // boundary so no localized string is ever baked into state. The most
        // important case is "video-processor": a virtual background failed and
        // Daily cleared it AND turned the camera off — DailyAudio has already
        // synced cameraOn=off + dropped the self-view tile, so here we only need
        // to inform the user. Reflect the camera-off in cameraStateAtom too.
        onNonfatal: (kind, rawMsg) => {
          if (rawMsg) {
            console.warn(`[audio] nonfatal (${kind}):`, rawMsg);
          }
          if (kind === "video-processor") {
            // Virtual background failed → Daily cleared the processor AND turned
            // the camera off (DailyAudio already synced cameraOn + dropped the
            // self-view tile). Reflect the camera-off and toast the user.
            setCameraState({
              status: "off",
              errorKind: null,
              errorMessage: null,
            });
            showAppToast(tRef.current("videoBg.processorCleared"));
          } else {
            // audio-processor / screen-share / other: a light, generic toast so
            // the failure is VISIBLE rather than swallowed in the console. The
            // call keeps running — never alter call lifecycle here.
            showAppToast(tRef.current("callControls.featureDisabled"));
          }
        },
        // Phase 2 — Daily's STRUCTURED camera-error (permissions / in-use /
        // not-found / constraints). DailyAudio already mapped it to a
        // language-neutral CameraErrorKind and dropped the self-view; here we
        // pour it into cameraStateAtom so MeetingCallControls renders the right
        // guidance (e.g. an "allow camera" prompt). State carries the CODE only.
        onCameraError: (kind, rawMsg, affectsVideo) => {
          if (rawMsg) {
            console.warn(`[audio] camera-error (${kind}):`, rawMsg);
          }
          // A mic-only failure rides the same `camera-error` event but does NOT
          // implicate the camera (mic + camera are on separate acquisition paths
          // here). Forcing cameraStateAtom into {status:"error"} would wrongly
          // tear the camera UI into an error state, so we leave it untouched —
          // DailyAudio already kept the live self-view. The mic failure surfaces
          // on the audio path (getUserMedia → onError) where it belongs.
          if (!affectsVideo) {
            return;
          }
          setCameraState({
            status: "error",
            errorKind: kind,
            errorMessage: rawMsg || null,
          });
        },
        // Phase 2 — Daily FATAL error already classified to an AudioErrorKind
        // (meeting-full / token-expired / generic call). Flip audioStateAtom into
        // the error state with the CODE so MeetingCallControls shows the right
        // headline. This is preferred over onError below (which carries an
        // un-classified Error from the getUserMedia / token paths).
        onFatal: (kind, rawMsg) => {
          console.warn(`[audio] fatal (${kind}):`, rawMsg);
          setAudioState({
            status: "error",
            muted: false,
            canTransmit: false,
            peers: new Map(),
            errorKind: kind,
            errorMessage: rawMsg || null,
          });
        },
        onError: (err) => {
          // Classify into a CODE; MeetingCallControls translates it at
          // render time (state must stay language-neutral). getUserMedia
          // failures carry DOMException names; plain Errors (token/join
          // from DailyAudio) are call-level failures.
          // NotFoundError is no longer fatal — AudioRoom downgrades to
          // listener-only mode, so we never reach this handler for it.
          const name = err?.name;
          const kind =
            name === "NotAllowedError"
              ? "mic-denied"
              : name === "NotReadableError" || name === "TrackStartError"
              ? "mic-busy"
              : name && name !== "Error"
              ? "mic"
              : "call";
          setAudioState({
            status: "error",
            muted: false,
            canTransmit: false,
            peers: new Map(),
            errorKind: kind,
            errorMessage: err?.message ?? null,
          });
        },
      },
    });
    roomRef.current = room;
    setAudioRoomInstance(room);
  }, [
    collabAPI,
    activeRoomLink,
    setAudioRoomInstance,
    setAudioState,
    setRecorderInstance,
    setRecordingState,
    setVideoTiles,
    setCameraState,
    setActiveSpeaker,
    setConnectionState,
    setPreJoinPending,
    setPreJoinMicIntent,
    setPreJoinCamIntent,
  ]);

  // -----------------------------------------------------------------
  // STT session lifecycle — driven by (audio live + STT toggle on +
  // we can transmit). Mirrors the audio call lifecycle exactly: when
  // the user joins a call with a working mic, we start streaming their
  // audio to Deepgram in parallel. When they leave or mute the STT
  // toggle, we tear it down.
  // -----------------------------------------------------------------
  useEffect(() => {
    // We now join listener-only, so the mic isn't acquired until the user
    // unmutes — but turning STT ON must also bring the mic up (STT transcribes
    // the LOCAL mic via getLocalStream). When STT is enabled and the call is
    // live but we have no mic yet, acquire it; ensureMic publishes + flips
    // canTransmit true via onState, which re-runs this effect and falls through
    // to actually start the session. Idempotent, so it's safe to call on every
    // run while we're still mic-less.
    if (
      audioState.status === "live" &&
      sttEnabled &&
      !audioState.canTransmit &&
      collabAPI
    ) {
      void roomRef.current?.ensureMic().catch((err) => {
        // No mic / denied — STT simply can't capture. Surface it in the panel
        // rather than silently doing nothing.
        console.warn("[stt] ensureMic failed:", err);
        setSttLiveError((err as Error)?.message ?? "Microphone unavailable");
      });
    }

    const shouldRunSTT =
      audioState.status === "live" &&
      audioState.canTransmit &&
      sttEnabled &&
      !!collabAPI;

    const teardownSTT = async () => {
      const session = sttRef.current;
      if (!session) {
        return;
      }
      sttRef.current = null;
      await session.stop();
      collabAPI?.clearLocalInterimTranscript();
      setSttLiveError(null);
      // Clear the capture heartbeat so the indicator can't linger on "Live"
      // after the mic stops streaming.
      lastCaptureAtRef.current = 0;
      setSttCapturing(false);
    };

    if (!shouldRunSTT) {
      void teardownSTT();
      return;
    }

    if (sttRef.current) {
      // Already running — no-op (sttEnabled/lang changes mid-call
      // require a restart, handled by the deps array).
      return;
    }

    const stream = roomRef.current?.getLocalStream();
    if (!stream) {
      // Audio just went live but the local stream isn't ready yet.
      // The effect will re-run when audioState updates next.
      return;
    }

    const lang: STTLang = (spokenLang ?? "multi") as STTLang;
    // A fresh session is starting — clear any stale error from a prior attempt.
    setSttLiveError(null);
    const session = new STTSession({
      lang,
      meetingId: collabAPI?.portal.roomId ?? undefined,
      provider: sttProvider,
      // Reuse the AudioContext DailyAudio unlocked in the Join gesture — on iOS
      // a context created here (no user activation) stays SUSPENDED and the
      // worklet emits no PCM, so Deepgram gets silence (06-18).
      audioCtx: roomRef.current?.getCaptureContext() ?? undefined,
      onCapture: (level) => {
        // PCM heartbeat carrying the chunk's peak level. Only count it as
        // "capturing" when there's REAL signal — a silent clone (iOS mic
        // exclusivity) still streams chunks at peak≈0, which must read as
        // "no audio" (amber), not a false green. ~-40dBFS gate tolerates the
        // room noise floor but not true silence. The watchdog flips it back off
        // if signal stops (≈1.5s) — exactly the "enabled but no audio reaching
        // STT" state the PM needs to SEE without a console.
        if (level > 0.01) {
          lastCaptureAtRef.current = Date.now();
          setSttCapturing(true);
        }
      },
      onInterim: (text) => {
        collabAPI?.setLocalInterimTranscript(text);
        // First successful interim proves capture→Deepgram is flowing — drop
        // any earlier error pill (e.g. a transient handshake retry that recovered).
        setSttLiveError(null);
      },
      onFinal: (text, ts) => {
        collabAPI?.publishSTTSegment({ text, lang, ts });
      },
      onError: (msg) => {
        // Surface live STT failures in the panel instead of swallowing them in
        // console — a no-mic / iPad / auth failure was previously invisible.
        console.warn("[stt] session error:", msg);
        setSttLiveError(msg);
      },
    });
    sttRef.current = session;
    void session.start(stream).catch((err) => {
      console.warn("[stt] failed to start session:", err);
      setSttLiveError((err as Error)?.message ?? "STT failed to start");
      sttRef.current = null;
    });

    // Capture watchdog: onCapture only ever turns the indicator ON. This timer
    // turns it OFF when the heartbeat goes stale — i.e. STT is enabled but no PCM
    // has arrived for a while (suspended context / muted clone / silent mic). The
    // 1.5s gap tolerates the ~300ms heartbeat plus a brief pause between words
    // without false-flipping to "no audio". Cleared on teardown below.
    const CAPTURE_STALE_MS = 1500;
    const watchdog = window.setInterval(() => {
      if (
        lastCaptureAtRef.current !== 0 &&
        Date.now() - lastCaptureAtRef.current > CAPTURE_STALE_MS
      ) {
        setSttCapturing(false);
      }
    }, 500);

    return () => {
      window.clearInterval(watchdog);
      void teardownSTT();
    };
  }, [
    audioState.status,
    audioState.canTransmit,
    sttEnabled,
    sttProvider,
    spokenLang,
    collabAPI,
  ]);

  // Hard cleanup on unmount — closes peer connections, releases mic.
  useEffect(() => {
    return () => {
      const room = roomRef.current;
      if (room) {
        room.stop();
        roomRef.current = null;
      }
      const session = sttRef.current;
      if (session) {
        void session.stop();
        sttRef.current = null;
      }
    };
  }, []);

  return null;
};

export default AudioRoomController;
