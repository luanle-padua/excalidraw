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
};
