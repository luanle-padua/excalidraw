// ParticipantMicRecorder — per-speaker LOCAL mic capture (06-24 #23/#24).
//
// Mounted for EVERY participant (incl. the session owner) in MeetingShell. Pure
// lifecycle, renders null. While a recording SESSION is active (the DO-driven
// roomRecordingAtom.recording is true) and this participant has a live local
// mic, it records that mic to its OWN file — the cleanest possible per-speaker
// audio (local, pre-network). On session end / leave / unmount it stops and
// uploads the blob with the session's id (kind:'mic'); the skip-silent heuristic
// in MicRecorder.stop() returns null for a muted/never-spoke mic, in which case
// we upload NOTHING (no empty row).
//
// WHY a component (not host-only logic): the session has a SINGLE owner, but
// every participant records their OWN mic locally. This is the "slave" recorder
// of the session lock (plan §7): it only ever reacts to roomRecordingAtom, never
// owns the lock. The owner records their mic THROUGH THIS SAME component too —
// CloudRecordingControls deliberately does NOT also record the owner's mic, so
// there's exactly one mic file per person.

import { useEffect, useRef } from "react";

import { useAtomValue } from "../../app-jotai";
import { audioRoomInstanceAtom, audioStateAtom } from "../../audio/audioState";
import { MicRecorder } from "../../audio/clientRecording";
import { activeRoomLinkAtom } from "../../collab/Collab";
import { uploadRecording } from "../../data/recordings";
import { roomRecordingAtom } from "../../data/roomRecording";

const extractRoomId = (link: string | null | undefined): string | null =>
  link?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;

/** Identifies a single record run so the start effect and the async stop/upload
 *  agree on which session/room/start the captured blob belongs to — even if the
 *  atom changed (new session, room switch) by the time stop() resolves. */
type ActiveRun = {
  recorder: MicRecorder;
  roomId: string;
  sessionId: string | null;
  startedAt: number;
};

export const ParticipantMicRecorder = () => {
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);
  // We read audioState so a mic going live mid-recording is reflected — but the
  // start effect must DEPEND on canTransmit (below), not merely re-render: a
  // re-render alone never re-runs an effect whose dep array is unchanged.
  const audioState = useAtomValue(audioStateAtom);
  const roomRecording = useAtomValue(roomRecordingAtom);

  const roomId = extractRoomId(activeRoomLink);
  const recording = roomRecording.recording;
  const sessionId = roomRecording.sessionId;
  const startedAt = roomRecording.startedAt;
  const audioLive = audioState.status === "live";
  // canTransmit = the local mic has been acquired (DailyAudio: !!localStream). It
  // flips false→true the instant a listener-only participant unmutes — the signal
  // a per-speaker mic recorder MUST react to. Without it (the original bug #26-A),
  // a participant who unmutes AFTER Record starts is NEVER captured, so only the
  // owner (already transmitting) gets a file. STT works precisely because its
  // effect depends on canTransmit; this mirrors that.
  const canTransmit = audioState.canTransmit;

  // The single in-flight run, held in a ref so the stop/upload reads the values
  // captured AT START even if the atoms have since changed.
  const runRef = useRef<ActiveRun | null>(null);

  // Stop the current run (if any) and upload its mic blob. Shared by the
  // session-end path and unmount. Guarded so a double-call can't double-upload.
  const stopAndUpload = useRef<() => Promise<void>>(async () => {});
  stopAndUpload.current = async () => {
    const run = runRef.current;
    if (!run) {
      return;
    }
    runRef.current = null; // claim it first → no concurrent stop double-fires
    let blob: Blob | null = null;
    try {
      blob = await run.recorder.stop(); // null when silent (skip-silent)
    } catch {
      blob = null;
    }
    if (!blob) {
      return;
    }
    const durationSec = Math.round(
      Math.max(0, Date.now() - run.startedAt) / 1000,
    );
    await uploadRecording(run.roomId, blob, {
      kind: "mic",
      durationSec,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    });
  };

  // START / STOP on the recording-session edge. Runs whenever recording, the
  // live-mic availability, the room, or the session changes.
  useEffect(() => {
    const localStream = audioLive ? audioRoom?.getLocalStream() ?? null : null;
    const haveMicTrack =
      !!localStream && localStream.getAudioTracks().length > 0;

    if (recording && roomId && haveMicTrack && !runRef.current) {
      // Session active + we have a mic + not already recording → START. Captures
      // the session/room/start NOW so the eventual upload tags the right file.
      try {
        const recorder = new MicRecorder();
        recorder.start(localStream!);
        runRef.current = {
          recorder,
          roomId,
          sessionId,
          startedAt: startedAt ?? Date.now(),
        };
      } catch {
        // No usable mic track (e.g. listener-only) → record nothing for us.
        runRef.current = null;
      }
      return;
    }

    if (!recording && runRef.current) {
      // Session ended → stop + upload our mic file.
      void stopAndUpload.current();
    }
    // We intentionally do NOT restart on a mic blip mid-session; once started we
    // keep the one continuous file until the session ends.
  }, [recording, roomId, sessionId, startedAt, audioLive, canTransmit, audioRoom]);

  // Leave / unmount while still recording → flush our mic file (best effort).
  // The async upload may not finish if the tab is closing, but a normal Leave
  // (component unmount, tab stays open) completes it.
  useEffect(() => {
    return () => {
      if (runRef.current) {
        void stopAndUpload.current();
      }
    };
  }, []);

  return null;
};

export default ParticipantMicRecorder;
