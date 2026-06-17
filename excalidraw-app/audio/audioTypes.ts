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
};
