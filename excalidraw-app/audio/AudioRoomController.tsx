// Controller component that wires the AudioRoom imperative manager to
// the Jotai state used by the UI. Mounted once at app shell level —
// owns the AudioRoom lifecycle so any component (header, sidebar,
// participants bar) can read state and dispatch commands via the atoms.
//
// The audio call follows the collab room: when activeRoomLink becomes
// non-null we provision an AudioRoom (no mic prompt yet — that only
// happens when the user actually clicks "Join audio"). When the room
// link clears, we tear everything down.

import { useEffect, useRef } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";
import { activeRoomLinkAtom, collabAPIAtom } from "../collab/Collab";
import { getDailyToken } from "../data/projects";
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
  recorderInstanceAtom,
  recordingStateAtom,
} from "./audioState";
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
  const setSttLiveError = useSetAtom(sttLiveErrorAtom);
  const setSttCapturing = useSetAtom(sttCapturingAtom);
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
        setCameraState({ status: "off", errorMessage: null });
        setActiveSpeaker(null);
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
  ]);

  // -----------------------------------------------------------------
  // STT session lifecycle — driven by (audio live + STT toggle on +
  // we can transmit). Mirrors the audio call lifecycle exactly: when
  // the user joins a call with a working mic, we start streaming their
  // audio to Deepgram in parallel. When they leave or mute the STT
  // toggle, we tear it down.
  // -----------------------------------------------------------------
  useEffect(() => {
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
