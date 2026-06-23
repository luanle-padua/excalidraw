// Phase 5 — the elegant, subtle REC indicator shown to EVERYONE in the room
// when a recording is active (anh Luân 06-23 §7.5: legally required, everyone
// must see they're being recorded). Reads the SHARED roomRecordingAtom, which
// the host's CloudRecordingControls drives + broadcasts over the DO realtime
// channel (RECORDING_STATE), so every participant — host and peers alike —
// renders the same state.
//
// Two surfaces, both refined (Glass Desk), never jarring:
//   • RecordingIndicator  — a small header pill: a softly pulsing red dot +
//     "REC" + who started it. Sits in the meeting header.
//   • RecordingFrameGlow  — a very faint red glow inset around the meeting
//     frame (pointer-events:none overlay), so the whole canvas reads "live".
//
// Self-hiding: both render null when nothing is recording, so they cost nothing
// in the common case.

import { useAtomValue } from "../../app-jotai";
import { roomRecordingAtom } from "../../data/roomRecording";
import {
  hostSocketIdAtom,
  mySocketIdAtom,
  peerProfilesAtom,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

/** Resolve a friendly name for whoever started the recording, mirroring the
 *  chain RecordingControls uses (explicit broadcast name → cached peer profile
 *  → my own profile if I started it → generic). */
const useRecorderName = (): string => {
  const t = useT();
  const rec = useAtomValue(roomRecordingAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const myProfile = useAtomValue(userProfileAtom);
  const mySocketId = useAtomValue(mySocketIdAtom);
  const hostSocketId = useAtomValue(hostSocketIdAtom);
  const startedByMe = !!mySocketId && mySocketId === rec.hostSocketId;
  return (
    rec.hostName ??
    (rec.hostSocketId
      ? peerProfiles.get(rec.hostSocketId)?.username
      : null) ??
    (startedByMe ? myProfile?.username : null) ??
    (hostSocketId ? peerProfiles.get(hostSocketId)?.username : null) ??
    t("cloudRecording.someone")
  );
};

/** Header REC pill — pulsing dot + "REC" + who started it. */
export const RecordingIndicator = () => {
  const t = useT();
  const rec = useAtomValue(roomRecordingAtom);
  const name = useRecorderName();
  if (!rec.recording) {
    return null;
  }
  const label = t("cloudRecording.indicatorBy", { name });
  return (
    <div
      className="mcm-rec-indicator"
      role="status"
      aria-live="polite"
      title={label}
    >
      <span className="mcm-rec-indicator__dot" aria-hidden="true" />
      <span className="mcm-rec-indicator__label">{t("cloudRecording.rec")}</span>
      <span className="mcm-rec-indicator__by">{name}</span>
    </div>
  );
};

/** Very faint red glow inset around the meeting frame while recording — a
 *  pointer-events-none overlay so it never intercepts canvas interaction. */
export const RecordingFrameGlow = () => {
  const rec = useAtomValue(roomRecordingAtom);
  if (!rec.recording) {
    return null;
  }
  return <div className="mcm-rec-glow" aria-hidden="true" />;
};

export default RecordingIndicator;
