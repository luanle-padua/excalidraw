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
import { sttEnabledAtom } from "../data/transcription";
import { preferredLanguageAtom } from "../data/translation";

import { DailyAudio } from "./DailyAudio";
import {
  audioRoomInstanceAtom,
  audioStateAtom,
  recorderInstanceAtom,
  recordingStateAtom,
} from "./audioState";
import { STTSession } from "./sttSession";

import type { STTLang } from "./sttSession";

export const AudioRoomController = () => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const recorder = useAtomValue(recorderInstanceAtom);
  const audioState = useAtomValue(audioStateAtom);
  const sttEnabled = useAtomValue(sttEnabledAtom);
  const preferredLang = useAtomValue(preferredLanguageAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const setAudioRoomInstance = useSetAtom(audioRoomInstanceAtom);
  const setRecordingState = useSetAtom(recordingStateAtom);
  const setRecorderInstance = useSetAtom(recorderInstanceAtom);
  /** Live STT session bound to the user's own mic. Spun up when the
   *  audio call goes live, torn down when the call ends or STT
   *  toggle is flipped off. */
  const sttRef = useRef<STTSession | null>(null);
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
          errorMessage: null,
        });
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
      getToken: (rid, name) => getDailyToken(rid, name),
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
      onError: (err) => {
        const name = err?.name;
        let message = err?.message ?? "Không thể bật microphone";
        if (name === "NotAllowedError") {
          message =
            "Mic bị từ chối — bật quyền microphone trong trình duyệt rồi thử lại.";
        } else if (name === "NotReadableError" || name === "TrackStartError") {
          message =
            "Mic đang bị app khác chiếm (Teams/Zoom...). Thoát app đó rồi thử lại.";
        }
        // NotFoundError is no longer fatal — AudioRoom downgrades to
        // listener-only mode, so we never reach this handler for it.
        setAudioState({
          status: "error",
          muted: false,
          canTransmit: false,
          peers: new Map(),
          errorMessage: message,
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

    const lang: STTLang = (preferredLang ?? "multi") as STTLang;
    const session = new STTSession({
      lang,
      onInterim: (text) => {
        collabAPI?.setLocalInterimTranscript(text);
      },
      onFinal: (text, ts) => {
        collabAPI?.publishSTTSegment({ text, lang, ts });
      },
      onError: (msg) => {
        console.warn("[stt] session error:", msg);
      },
    });
    sttRef.current = session;
    void session.start(stream).catch((err) => {
      console.warn("[stt] failed to start session:", err);
      sttRef.current = null;
    });

    return () => {
      void teardownSTT();
    };
  }, [
    audioState.status,
    audioState.canTransmit,
    sttEnabled,
    preferredLang,
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
