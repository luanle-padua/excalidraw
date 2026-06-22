// useJoinCall — the SINGLE join-the-call decision behind the header "Call"
// button (MeetingCallControls), for both the idle entry point and the error
// retry. Extracting it keeps a single code path: start the Daily call
// listener-only, then honour the user's mic / camera intent. Callers pass no
// intent today (listener-only); the intent plumbing is retained so a future
// "join with mic/camera on" entry point can reuse the exact same logic.
//
// Lazy architecture preserved (do NOT regress it):
//   • audioRoom.start() joins LISTENER-ONLY — no getUserMedia, no permission
//     popup at join.
//   • mic is acquired only if intent is set (ensureMic → the deferred mic
//     prompt, on the user's explicit choice). A guest room with
//     start_audio_off still publishes correctly via ensureMic.
//   • camera is turned on only if intent is set (setCamera(true)), mirrored into
//     cameraStateAtom exactly like the header camera toggle.
//
// NON-FATAL by default: permission errors at Join route through the existing
// onError → audioStateAtom.errorKind (mic) / cameraStateAtom.errorKind (camera)
// channels; a camera-intent failure must NEVER abort a successful audio join.

import { useCallback } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";

import { audioRoomInstanceAtom, audioStateAtom } from "./audioState";
import { cameraErrorKindForDomException, cameraStateAtom } from "./videoState";

export type JoinIntent = {
  /** acquire + publish the mic right after the call goes live */
  mic?: boolean;
  /** turn the local camera on right after the call goes live */
  camera?: boolean;
};

/** The ordered post-`start()` actions a given intent implies — the PURE decision
 *  core of the join flow, extracted so it can be unit-tested in isolation
 *  (intent → ordered action list) without standing up React or a DailyCall. The
 *  hook below walks exactly this list. `start` is always implicit (the call must
 *  go live first); these are the OPT-IN media acquisitions layered on top, in a
 *  fixed order (mic before camera) so the behaviour is deterministic. */
export type JoinAction = "ensureMic" | "setCameraOn";

export const joinActionsFor = (intent: JoinIntent): JoinAction[] => {
  const actions: JoinAction[] = [];
  if (intent.mic) {
    actions.push("ensureMic");
  }
  if (intent.camera) {
    actions.push("setCameraOn");
  }
  return actions;
};

export const useJoinCall = () => {
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  const setAudioState = useSetAtom(audioStateAtom);
  const setCameraState = useSetAtom(cameraStateAtom);

  return useCallback(
    async (intent: JoinIntent = {}) => {
      if (!audioRoom) {
        return;
      }
      setAudioState((prev) => ({
        ...prev,
        status: "connecting",
        errorKind: null,
        errorMessage: null,
      }));
      try {
        // Listener-only join (unchanged) — no mic/camera acquired here.
        await audioRoom.start();
        setAudioState((prev) => ({ ...prev, status: "live" }));
      } catch {
        // start()'s failure is already surfaced via onError → audioStateAtom
        // (errorKind/errorMessage). Bail BEFORE touching mic/camera: there is no
        // live call to attach them to.
        return;
      }

      // Walk the PURE action list (mic before camera) so the modal and the idle
      // Join button apply intent identically.
      for (const action of joinActionsFor(intent)) {
        if (action === "ensureMic") {
          // Acquire + publish the mic. ensureMic fires the deferred permission
          // prompt; on denial it re-throws, which we route through the audio
          // error channel (same code the header mute toggle uses) so the user
          // sees "allow microphone". A no-device grant simply stays
          // listener-only. A guest room with start_audio_off still publishes
          // correctly via ensureMic's explicit setLocalAudio(true).
          try {
            await audioRoom.ensureMic();
          } catch (err) {
            const name = err instanceof Error ? err.name : undefined;
            const kind =
              name === "NotAllowedError" || name === "PermissionDeniedError"
                ? "mic-denied"
                : name === "NotReadableError" || name === "TrackStartError"
                ? "mic-busy"
                : "mic";
            setAudioState((prev) => ({
              ...prev,
              errorKind: kind,
              errorMessage: err instanceof Error ? err.message : null,
            }));
          }
        } else if (action === "setCameraOn") {
          // Turn the camera on, mirroring cameraStateAtom exactly as the header
          // toggle does. A camera failure must NOT abort the (already
          // successful) audio join — it only flips the camera tile into its
          // error state with the right guidance code.
          setCameraState({
            status: "starting",
            errorKind: null,
            errorMessage: null,
          });
          try {
            const on = await audioRoom.setCamera(true);
            setCameraState({
              status: on ? "on" : "off",
              errorKind: null,
              errorMessage: null,
            });
          } catch (err) {
            setCameraState({
              status: "error",
              errorKind: cameraErrorKindForDomException(
                err instanceof Error ? err.name : undefined,
              ),
              errorMessage: err instanceof Error ? err.message : null,
            });
          }
        }
      }
    },
    [audioRoom, setAudioState, setCameraState],
  );
};
