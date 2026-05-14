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

import { AudioRoom } from "./AudioRoom";
import {
  audioRoomInstanceAtom,
  audioStateAtom,
  recorderInstanceAtom,
  recordingStateAtom,
} from "./audioState";

export const AudioRoomController = () => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const recorder = useAtomValue(recorderInstanceAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const setAudioRoomInstance = useSetAtom(audioRoomInstanceAtom);
  const setRecordingState = useSetAtom(recordingStateAtom);
  const setRecorderInstance = useSetAtom(recorderInstanceAtom);
  /** keep a ref of the live AudioRoom for cleanup independent of React
   *  render timing — we must close peer connections deterministically */
  const roomRef = useRef<AudioRoom | null>(null);
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

    const socket = collabAPI.portal.socket;
    if (!socket) {
      return;
    }

    console.info(
      `[audio] controller provisioning AudioRoom (socket=${socket.id})`,
    );
    const room = new AudioRoom(socket, {
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
        } else if (
          name === "NotReadableError" ||
          name === "TrackStartError"
        ) {
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
    });
    roomRef.current = room;
    setAudioRoomInstance(room);
  }, [collabAPI, activeRoomLink, setAudioRoomInstance, setAudioState]);

  // Hard cleanup on unmount — closes peer connections, releases mic.
  useEffect(() => {
    return () => {
      const room = roomRef.current;
      if (room) {
        room.stop();
        roomRef.current = null;
      }
    };
  }, []);

  return null;
};

export default AudioRoomController;
