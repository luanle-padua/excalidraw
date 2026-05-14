// AudioRoom — manager for a mesh WebRTC voice call inside an existing
// Excalidraw collab room. Reuses the same socket.io connection (Portal)
// for signaling; only adds a single `rtc-signal` event in each direction.
//
// Topology: full mesh. Each peer holds N-1 RTCPeerConnections. Fine for
// up to ~8 participants; beyond that we'd want an SFU and this file is
// the place that would change (everything outside knows only about
// peer state, not transport).
//
// Initiator tie-break: the peer with the lexicographically smaller
// socket.id sends the offer. This avoids glare without needing the
// server to track call state.

import { AudioPeer } from "./AudioPeer";
import { getIceServers } from "./turnConfig";

import type { Socket } from "socket.io-client";

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

type IncomingSignal = {
  from: string;
  type: "offer" | "answer" | "ice";
  data: any;
};

export class AudioRoom {
  private readonly socket: Socket;
  private readonly events: AudioRoomEvents;
  private localStream: MediaStream | null = null;
  private iceServers: RTCIceServer[] = [];
  private peers = new Map<string, AudioPeer>();
  private state = new Map<string, PeerState>();
  private muted = false;
  private active = false;

  constructor(socket: Socket, events: AudioRoomEvents) {
    this.socket = socket;
    this.events = events;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.active) {
      console.info("[audio] AudioRoom.start() called but already active");
      return;
    }
    console.info("[audio] AudioRoom.start() — requesting mic + ICE servers");
    this.active = true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      console.info(
        `[audio] got local mic stream (tracks=${this.localStream
          .getAudioTracks()
          .length})`,
      );
    } catch (err) {
      // No microphone on this device → join as a listener. Anything
      // worse (denied permission, mic held by another app) is fatal —
      // surface the error to the UI and bail out.
      const name = (err as Error)?.name;
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        console.info(
          "[audio] no mic on this device — joining as listener",
        );
        this.localStream = null;
      } else {
        this.active = false;
        this.events.onError?.(err as Error);
        throw err;
      }
    }

    const { iceServers } = await getIceServers();
    this.iceServers = iceServers;

    this.socket.on("new-user", this.onNewUser);
    this.socket.on("room-user-change", this.onRoomUserChange);
    this.socket.on("rtc-signal", this.onIncomingSignal);

    // The collab room was likely joined before audio was turned on, so
    // we've already missed the initial `room-user-change` broadcast.
    // Ask the server to replay it so we can build up the mesh against
    // anyone already in the room.
    console.info(
      `[audio] subscribed to signals (socket.id=${this.socket.id}) — requesting current room state`,
    );
    this.socket.emit("request-room-clients");

    this.emitState();
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.socket.off("new-user", this.onNewUser);
    this.socket.off("room-user-change", this.onRoomUserChange);
    this.socket.off("rtc-signal", this.onIncomingSignal);
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.state.clear();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        t.stop();
      }
      this.localStream = null;
    }
    this.muted = false;
    this.emitState();
  }

  toggleMute(): boolean {
    if (!this.localStream) {
      // Listener mode — no track to toggle. Keep muted=true so UI shows
      // a consistent state.
      this.muted = true;
      this.emitState();
      return true;
    }
    this.muted = !this.muted;
    for (const t of this.localStream.getAudioTracks()) {
      t.enabled = !this.muted;
    }
    this.emitState();
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Exposed for the in-app mic-test recorder (diagnostic playback) —
   *  not part of the regular call lifecycle. */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** Snapshot of every remote stream currently held by a peer. The
   *  meeting recorder uses this when it starts mid-call: peers whose
   *  ontrack already fired won't fire it again, so we have to seed
   *  the recorder mixer from this snapshot. */
  getPeerStreams(): Array<{ socketId: string; stream: MediaStream }> {
    const out: Array<{ socketId: string; stream: MediaStream }> = [];
    for (const [socketId, peer] of this.peers) {
      const stream = peer.getRemoteStream();
      if (stream) {
        out.push({ socketId, stream });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Socket handlers (bound as arrow methods so `.off()` works)
  // -------------------------------------------------------------------

  private onNewUser = (newSocketId: string) => {
    console.info(`[audio] new-user: ${newSocketId} (self=${this.socket.id})`);
    if (!this.active || newSocketId === this.socket.id) {
      return;
    }
    // The existing peer (us) is the offerer for newcomers by tie-break:
    // smaller socket.id offers. If we happen to be larger, we just wait
    // for the new peer's offer to come through.
    if (this.socket.id && this.socket.id < newSocketId) {
      void this.ensurePeer(newSocketId, /* initiate */ true);
    } else {
      // we'll receive an offer from the new user soon
      void this.ensurePeer(newSocketId, /* initiate */ false);
    }
  };

  private onRoomUserChange = (clients: string[]) => {
    console.info(
      `[audio] room-user-change: [${clients.join(", ")}] (self=${this.socket.id})`,
    );
    if (!this.active) {
      return;
    }
    const live = new Set(clients);
    // Drop any peers no longer in the room.
    for (const id of Array.from(this.peers.keys())) {
      if (!live.has(id)) {
        this.dropPeer(id);
      }
    }
    // For each remaining peer, make sure we have a connection. Tie-break
    // ensures only one side actually sends the offer.
    for (const id of clients) {
      if (id === this.socket.id) {
        continue;
      }
      const shouldInitiate = Boolean(this.socket.id && this.socket.id < id);
      console.info(
        `[audio] ensurePeer ${id} (initiate=${shouldInitiate})`,
      );
      void this.ensurePeer(id, shouldInitiate);
    }
  };

  private onIncomingSignal = async (signal: IncomingSignal) => {
    if (!this.active || !signal || !signal.from) {
      return;
    }

    // Every offer is a fresh handshake. If we already have a peer for
    // this socketId (e.g. left over from a previous call that the other
    // side bailed on), drop it and start clean — the SDP state machine
    // on RTCPeerConnection won't accept an "offer-after-offer" without
    // a full negotiation-needed cycle, so reusing the old object causes
    // rejoins to silently produce no audio.
    if (signal.type === "offer") {
      if (this.peers.has(signal.from)) {
        console.info(
          `[audio] re-offer from ${signal.from} — recreating peer`,
        );
        this.dropPeer(signal.from);
      }
      const peer = await this.ensurePeer(signal.from, /* initiate */ false);
      if (!peer) {
        return;
      }
      try {
        await peer.handleRemoteOffer(signal.data);
      } catch (err) {
        console.warn("rtc-signal handling failed (offer)", err);
      }
      return;
    }

    // Answer / ICE: must arrive at the existing peer; if it doesn't
    // exist anymore there's nothing useful we can do.
    const peer = this.peers.get(signal.from);
    if (!peer) {
      console.info(
        `[audio] stray ${signal.type} from ${signal.from} — no peer, ignoring`,
      );
      return;
    }
    try {
      if (signal.type === "answer") {
        await peer.handleRemoteAnswer(signal.data);
      } else if (signal.type === "ice") {
        await peer.handleRemoteIce(signal.data);
      }
    } catch (err) {
      console.warn(`rtc-signal handling failed (${signal.type})`, err);
    }
  };

  // -------------------------------------------------------------------
  // Peer plumbing
  // -------------------------------------------------------------------

  private async ensurePeer(
    socketId: string,
    initiate: boolean,
  ): Promise<AudioPeer | null> {
    if (this.peers.has(socketId)) {
      return this.peers.get(socketId)!;
    }
    // localStream === null is OK now (listener-only mode); the peer will
    // declare itself recvonly so it still receives the remote's audio.
    const peer = new AudioPeer(socketId, this.iceServers, {
      onSignal: (signal) => {
        this.socket.emit("rtc-signal", {
          to: socketId,
          type: signal.type,
          data: signal.data,
        });
      },
      onSpeaking: (speaking) => {
        const prev = this.state.get(socketId);
        if (prev) {
          this.state.set(socketId, { ...prev, speaking });
          this.emitState();
        }
      },
      onRemoteStream: (stream) => {
        const prev = this.state.get(socketId);
        if (prev) {
          this.state.set(socketId, { ...prev, hasRemoteStream: true });
          this.emitState();
        }
        this.events.onPeerStream?.(socketId, stream);
      },
      onClosed: () => {
        this.dropPeer(socketId);
      },
    });
    peer.setLocalStream(this.localStream);
    this.peers.set(socketId, peer);
    this.state.set(socketId, {
      socketId,
      speaking: false,
      hasRemoteStream: false,
    });
    this.emitState();

    if (initiate) {
      try {
        await peer.createOffer();
      } catch (err) {
        console.warn("createOffer failed", err);
      }
    }
    return peer;
  }

  private dropPeer(socketId: string) {
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.close();
      this.peers.delete(socketId);
    }
    if (this.state.delete(socketId)) {
      this.emitState();
    }
    this.events.onPeerRemoved?.(socketId);
  }

  private emitState() {
    this.events.onState({
      peers: new Map(this.state),
      muted: this.muted,
      canTransmit: !!this.localStream,
    });
  }
}
