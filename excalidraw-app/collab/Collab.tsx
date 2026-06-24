import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, cloneJSON, EVENT, toBrandedType } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith, newImageElement } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  clearReviewRoom,
  clearStealthRoom,
  isReviewRoom,
  isStealthRoom,
  markReviewRoom,
  markStealthRoom,
} from "../data/reviewMode";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadChatFromFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  loadLibraryFromFirebase,
  loadTranscriptFromFirebase,
  saveChatToFirebase,
  saveFilesToFirebase,
  saveLibraryToFirebase,
  saveToFirebase,
  saveTranscriptToFirebase,
} from "../data/firebase";
import {
  canvasHistory,
  recordCanvasHistory,
  type CanvasHistoryEntry,
} from "../data/canvasHistory";
import {
  loadCanvasHistoryFromStorage,
  saveCanvasHistoryToStorage,
} from "../data/storage";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";

import {
  meetingFilesAtom,
  isFileSeen,
  markFileSeen,
  removeMeetingFile,
  setMeetingFileBytes,
  setMeetingFileLock,
  upsertMeetingFile,
} from "../data/meetingLibrary";

import {
  fetchBatchTranslation,
  preferredLanguageAtom,
} from "../data/translation";
import { t as tMcm } from "../i18n/mcm";
import {
  liveTranscriptsAtom,
  loadTranscriptLog,
  saveTranscriptLog,
  transcriptionLogAtom,
} from "../data/transcription";

import { clearDxfSnapshotsForFile } from "../components/mcm/dxf/dxfSnapshotCache";
import { clearIfcSnapshotsForFile } from "../components/mcm/ifc/ifcSnapshotCache";
import { clearPdfSnapshotsForFile } from "../components/mcm/pdf/pdfSnapshotCache";
import {
  isFinishedStatus,
  normalizeMeetingStatus,
} from "../components/mcm/meetingStatus";
import { showAppToast } from "../data/appToast";
import { getMyKnock, knockToMeeting } from "../data/invite";
import {
  getMeeting,
  getMeetingChecked,
  IS_PROJECTS_CONFIGURED,
  registerMeeting,
} from "../data/projects";
import { isInternalEmail, sessionAtom } from "../data/session";

import {
  avatarIdentityKey,
  ensureMyJoinedAt,
  hostSocketIdAtom,
  importUserProfileFromLocalStorage,
  markMeAsFirstInRoom,
  peerProfilesAtom,
  persistHostClaimForRoom,
  removePeerAudio,
  removePeerJoinedAt,
  removePeerProfile,
  resetMyJoinedAt,
  resolveAvatarUrlWithDefault,
  restoreHostClaimForRoom,
  setMySocketId,
  upsertPeerAudio,
  upsertPeerJoinedAt,
  upsertPeerProfile,
  userProfileAtom,
} from "../data/userProfile";
import { resetRoomRecording, setRoomRecording } from "../data/roomRecording";
import { audioRoomInstanceAtom, audioStateAtom } from "../audio/audioState";
import { screenShareMediaAtom } from "../screenshare/screenShareState";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";
import { RawWsTransport } from "./RawWsTransport";

import type { TranscriptSegment } from "../data/transcription";
import type { Socket } from "socket.io-client";

import type { MeetingFile } from "../data/meetingLibrary";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

/** True while REVIEWING a finished meeting (opened from the project
 *  folder). A finished meeting is immutable: the canvas is strictly
 *  read-only (drives `viewModeEnabled`), no editing — extract-only. Set by
 *  `startCollaboration(_, { viewOnly: true })`, cleared on teardown. */
export const meetingViewOnlyAtom = atom(false);

/** Set true when the host KICKs the local user out of the meeting. MeetingShell
 *  watches this, shows a notice, and leaves the room. */
export const kickedAtom = atom(false);

/** START GATE (Phase 4.5 state machine). Set when a join hits a meeting that
 *  is still `scheduled` (host hasn't pressed Start) or was `cancelled` —
 *  instead of connecting, `startCollaboration` parks the room here and the
 *  WaitingForStart overlay takes over: internal staff get a Start button
 *  (acting-host rule), guests poll until the meeting goes live. */
export type StartGate = {
  roomId: string;
  roomKey: string;
  title: string | null;
  scheduledAt: string | null;
  // "finished" only ever parks GUESTS here — review is internal-only
  // (quyết định 06-11: sau họp host gom nội dung gửi khách dạng khác).
  status: "scheduled" | "cancelled" | "finished";
};
export const startGateAtom = atom<StartGate | null>(null);

/** WAITING ROOM (knock-to-join). Set when an EXTERNAL guest joins a LIVE meeting
 *  they haven't been admitted to yet: instead of connecting, `startCollaboration`
 *  parks the room here, knocks, and the WaitingRoom overlay polls until a host
 *  admits them (then auto-connects) or denies them. Internal staff auto-admit
 *  and never park here. Mirrors `startGateAtom` but for the live-meeting admit
 *  gate rather than the scheduled-meeting start gate. */
export type WaitingRoom = {
  roomId: string;
  roomKey: string;
  title: string | null;
  scheduledAt: string | null;
  // The guest's own knock status, mirrored from the server poll.
  status: "invited" | "denied";
};
export const waitingRoomAtom = atom<WaitingRoom | null>(null);

/** Open state of the Zoom-style participants management panel. Lifted to an
 *  atom so both the toolbar button (MeetingHeader) and the bar chip can open it
 *  while ParticipantsBar owns the rendering. */
export const participantsPanelOpenAtom = atom(false);

/** Map of socketId → true for participants currently signaling "hand
 *  raised". Sticky until that peer broadcasts a lower (or leaves). */
export const raisedHandsAtom = atom<ReadonlyMap<string, true>>(new Map());

/** Map of socketId → true for participants currently sharing their screen
 *  (media flows over Daily.co; this atom is just the presence signal that
 *  drives the badge, the viewer, and the single-share lock). Sticky until
 *  the sharer broadcasts sharing:false or leaves the room. At most one
 *  entry in practice — the lock prevents a second concurrent sharer. */
export const screenShareStateAtom = atom<ReadonlyMap<string, true>>(new Map());

/** Short-lived list of active reactions floating over avatars. Each
 *  entry is removed after ~3.5s by the consumer that rendered it. */
export type MeetingReactionEvent = {
  id: string;
  socketId: string;
  emoji: string;
  ts: number;
};
export const meetingReactionsAtom = atom<MeetingReactionEvent[]>([]);

/** Quoted reference embedded on a chat message — the user replied to
 *  the message identified by `id`. Snippet is the original text (first
 *  few words), captured at reply-time so renaming the original later
 *  still shows what was being replied to. */
export type ChatReplyRef = {
  id: string;
  author: string;
  snippet: string;
};

export type ChatMessage = {
  id: string;
  socketId: string;
  username: string;
  text: string;
  ts: number;
  /** emoji → list of socketIds who reacted (deduped). Local atom only;
   *  receivers update it via the CHAT_REACTION socket subtype. */
  reactions?: Record<string, string[]>;
  /** Set when this message is a reply to another. Renders as a quoted
   *  snippet above the bubble; clicking it scrolls to the original. */
  replyTo?: ChatReplyRef;
  /** Translations to {vi, en, ko} pre-computed by the sender's client.
   *  Receivers read translations[theirPreferredLang] directly — no
   *  per-viewer /translate hit. Missing keys fall back to the legacy
   *  /translate path inside `useTranslate`. */
  translations?: Record<string, string>;
};

/** Sentinel sender identity for AI-generated replies in chat. Receivers
 *  match on these to render bot bubbles in the AI-accent colour and
 *  with the robot avatar. */
export const BOT_SOCKET_ID = "__mcm_bot__";
export const BOT_USERNAME = "MCM Bot";
export const isBotMessage = (m: ChatMessage): boolean =>
  m.socketId === BOT_SOCKET_ID || m.username === BOT_USERNAME;

export const chatMessagesAtom = atom<ChatMessage[]>([]);

/** dataURL length above which a library file is broadcast METADATA-ONLY and
 *  its bytes routed through R2-by-reference instead of riding the realtime
 *  broadcast (see `broadcastLibraryFileSmart`). ~256k chars ≈ ~190KB of bytes,
 *  well under the DO 1 MiB/message cap — keeps small DXFs/images inline
 *  (instant) while large IFC GLBs go via storage so the broadcast frame stays
 *  tiny on BOTH the socket.io and Durable Object transports. */
const LIBRARY_INLINE_MAX_BYTES = 256 * 1024;

/** Upper bound for a single library file routed through R2. Much larger than
 *  the 30MB FILE_UPLOAD_MAX_BYTES used for the socket/inline path — IFC GLBs
 *  routinely exceed 30MB and the worker streams them to R2, so the inline cap
 *  doesn't apply here. */
const LIBRARY_FILE_MAX_BYTES = 512 * 1024 * 1024;

/** Largest dataURL we'll ever push over the realtime broadcast (inline frame).
 *  HARD CAP for the DO migration: Cloudflare Workers WebSocket caps a single
 *  message at 1 MiB, and a frame over it DISCONNECTS the sender — so on the DO
 *  path a multi-MB inline library file simply cannot ride the broadcast. This
 *  is transport-agnostic (gated by build, not the realtime_backend flag), so we
 *  keep the inline cap well under 1 MiB on BOTH the socket.io and DO paths.
 *  Files above this only reach peers via R2-by-reference; if R2 also fails,
 *  peers keep the metadata (thumbnail) only — never a >1 MiB inline frame.
 *  Aligned with LIBRARY_INLINE_MAX_BYTES: anything large enough to route via R2
 *  stays metadata-only on a fallback rather than re-flooding the broadcast. */
const LIBRARY_SOCKET_MAX_BYTES = LIBRARY_INLINE_MAX_BYTES;

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
  sendChatMessage: CollabInstance["sendChatMessage"];
  sendBotMessage: CollabInstance["sendBotMessage"];
  toggleChatReaction: CollabInstance["toggleChatReaction"];
  toggleRaiseHand: CollabInstance["toggleRaiseHand"];
  isHandRaised: CollabInstance["isHandRaised"];
  setScreenShare: CollabInstance["setScreenShare"];
  sendMeetingReaction: CollabInstance["sendMeetingReaction"];
  removeMeetingReaction: CollabInstance["removeMeetingReaction"];
  publishSTTSegment: CollabInstance["publishSTTSegment"];
  setLocalInterimTranscript: CollabInstance["setLocalInterimTranscript"];
  clearLocalInterimTranscript: CollabInstance["clearLocalInterimTranscript"];
  publishLibraryFile: CollabInstance["publishLibraryFile"];
  publishLibraryFileDelete: CollabInstance["publishLibraryFileDelete"];
  publishLibraryFileLock: CollabInstance["publishLibraryFileLock"];
  uploadAnchorSnapshot: CollabInstance["uploadAnchorSnapshot"];
  ensureSnapshotLoaded: CollabInstance["ensureSnapshotLoaded"];
  publishRecordingState: CollabInstance["publishRecordingState"];
  /** Acquire / release the room's exclusive recording-session lock (DO-backed,
   *  06-24 #24). The host's CloudRecordingControls drives these; the per-mic
   *  ParticipantMicRecorder only reacts to the resulting roomRecordingAtom. */
  acquireRecordingLock: CollabInstance["acquireRecordingLock"];
  releaseRecordingLock: CollabInstance["releaseRecordingLock"];
  /** Element-only lock toggle. Use when the file isn't tracked by the
   *  meeting library (legacy paste, direct addFiles, etc.) — these
   *  images still want the pin/tape affordance but don't have a
   *  library entry to gate on. */
  toggleCanvasImageElementLock: CollabInstance["toggleCanvasImageElementLock"];
  linkTextToFile: CollabInstance["linkTextToFile"];
  /** exposed for the WebRTC audio/video mesh — peers reuse this socket
   *  to signal offer/answer/ICE without opening a second connection */
  portal: Portal;
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  // RECORDING SESSION lock intent (06-24, #24). Non-null while THIS client is
  // the lock owner and still wants to record (between acquire and release). Read
  // by the "connect" reconnect handler to re-acquire the DO lock on the new
  // socket (the old socket's attachment-held lock died with it). Cleared on
  // release, on a `recording-state {recording:false}`, and on leave (portal
  // close drops the field with the instance).
  private recordingIntent: { sessionId: string; startedAt: number } | null =
    null;
  private collaborators = new Map<SocketId, Collaborator>();
  // The ONLY source of truth for "who is actually in the room right now":
  // rebuilt from the live socket list every `room-user-change`
  // (setCollaborators). Anything that wants to ADD/ENRICH a collaborator
  // (updateCollaborator, the peerProfilesAtom sub) must gate on this so a
  // late / re-announced USER_PROFILE from a peer who already LEFT can never
  // resurrect a ghost tile. Empty until the first roster lands.
  private liveSocketIds = new Set<SocketId>();
  private remoteElementIds = new Set<string>();
  // Set once the eager storage prefetch (kicked off in startCollaboration,
  // in parallel with the socket connect) has rendered the saved scene, so
  // the slower socket paths (`first-in-room`, the 5s fallback) skip the
  // redundant re-fetch + resetScene flicker. A live peer's INIT still
  // reconciles on top because the eager path does NOT mark the socket
  // initialized.
  private eagerSceneLoaded = false;

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    // Hydrate the local UserProfile from localStorage so the atom is
    // populated before any socket events fire. If the user has never
    // saved a profile, the atom stays null and the settings modal
    // will auto-open via the meeting shell.
    const storedProfile = importUserProfileFromLocalStorage();
    if (storedProfile) {
      appJotaiStore.set(userProfileAtom, storedProfile);
    }
    // Rebroadcast our profile to every peer whenever the local user
    // edits it (e.g. renames themselves or picks a new avatar). The
    // sub callback is async-tolerant — the socket-not-connected case
    // is handled inside Portal.broadcastUserProfile.
    const unsubProfile = appJotaiStore.sub(userProfileAtom, () => {
      if (this.portal.socket) {
        this.broadcastUserProfileSnapshot();
      }
    });

    // Rebroadcast our audio state (in-call + muted) whenever it changes, so
    // every peer renders the same mic icon in real time — including self-mute,
    // which Daily's track events alone don't surface to other clients. The
    // snapshot dedups internally so peer/speaking churn doesn't spam the room.
    const unsubAudio = appJotaiStore.sub(audioStateAtom, () => {
      this.broadcastAudioStateSnapshot();
    });

    // When a peer's profile arrives or changes, push the new name /
    // avatar onto their Collaborator entry so the on-canvas cursor
    // label + Excalidraw's built-in UserList refresh immediately —
    // without this they'd only update on the peer's next mouse move.
    const unsubPeerProfiles = appJotaiStore.sub(peerProfilesAtom, () => {
      const peers = appJotaiStore.get(peerProfilesAtom);
      for (const [socketId, profile] of peers) {
        // GHOST GUARD (mirror of updateCollaborator): a peerProfilesAtom entry
        // can outlive the peer briefly — a re-announced USER_PROFILE upserts the
        // profile before the matching room-user-change prunes it. Only ENRICH a
        // peer the live roster still lists; never seed a tile for one who left.
        if (!this.liveSocketIds.has(socketId as SocketId)) {
          continue;
        }
        // Default to a deterministic library image when the peer hasn't
        // picked an avatar. Key the default on the peer's EMAIL (their stable
        // login identity) so the canvas cursor stays the SAME face across
        // reconnects and matches every other avatar surface; only anonymous
        // link-join peers (no email) fall back to the per-session socketId.
        const avatarUrl = resolveAvatarUrlWithDefault(
          profile.avatar,
          avatarIdentityKey(profile.email, socketId),
        );
        this.updateCollaborator(socketId as SocketId, {
          username: profile.username,
          avatarUrl,
          ...(profile.company ? { company: profile.company } : {}),
        });
      }
    });

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
      unsubProfile();
      unsubPeerProfiles();
      unsubAudio();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
      sendChatMessage: this.sendChatMessage,
      sendBotMessage: this.sendBotMessage,
      toggleChatReaction: this.toggleChatReaction,
      toggleRaiseHand: this.toggleRaiseHand,
      isHandRaised: this.isHandRaised,
      setScreenShare: this.setScreenShare,
      sendMeetingReaction: this.sendMeetingReaction,
      removeMeetingReaction: this.removeMeetingReaction,
      publishSTTSegment: this.publishSTTSegment,
      setLocalInterimTranscript: this.setLocalInterimTranscript,
      clearLocalInterimTranscript: this.clearLocalInterimTranscript,
      publishLibraryFile: this.publishLibraryFile,
      publishLibraryFileDelete: this.publishLibraryFileDelete,
      publishLibraryFileLock: this.publishLibraryFileLock,
      uploadAnchorSnapshot: this.uploadAnchorSnapshot,
      ensureSnapshotLoaded: this.ensureSnapshotLoaded,
      publishRecordingState: this.publishRecordingState,
      acquireRecordingLock: this.acquireRecordingLock,
      releaseRecordingLock: this.releaseRecordingLock,
      toggleCanvasImageElementLock: this.toggleCanvasImageElementLock,
      linkTextToFile: this.linkTextToFile,
      portal: this.portal,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    // CENTRAL REVIEW SEAL: never write a finished meeting's scene blob —
    // every scene-PUT path (onChange autosave, stopCollaboration on exit,
    // beforeunload, flush) funnels through here. Without this the worker's
    // 10-minute grace window let a reviewer overwrite the stored scene.
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    syncableElements = cloneJSON(syncableElements);
    // Capture which room this save belongs to. If the user switches rooms
    // while this async save is in flight, the success tail below must NOT
    // re-inject the OLD room's reconciled elements onto the NEW room's
    // canvas (cross-meeting contamination). The PUT itself already targets
    // the captured roomId; this guards the local re-render.
    const savingRoomId = this.portal.roomId;
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (
        this.isCollaborating() &&
        storedElements &&
        this.portal.roomId === savingRoomId
      ) {
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
      }
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  /** Fire any pending debounced room saves NOW — called on leave/End/unload
   *  before the portal closes. Without this, whatever landed inside the last
   *  debounce window (chat 800ms, library 1.2s, transcript 5s) never reached
   *  R2 and only resurfaced from THIS browser's local cache. A pending timer
   *  implies we're not in read-only review (persist* never schedules there). */
  private flushPendingRoomSaves = () => {
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    if (this.chatSaveTimer) {
      clearTimeout(this.chatSaveTimer);
      this.chatSaveTimer = null;
      this.saveChatNow(roomId, roomKey);
    }
    if (this.transcriptSaveTimer) {
      clearTimeout(this.transcriptSaveTimer);
      this.transcriptSaveTimer = null;
      this.saveTranscriptNow(roomId, roomKey);
    }
    if (this.librarySaveTimer) {
      clearTimeout(this.librarySaveTimer);
      this.librarySaveTimer = null;
      this.saveLibraryNow(roomId, roomKey);
    }
    // Canvas replay log: always flush on leave/End so the final burst of edits
    // reaches R2 for replay. We do NOT gate on meetingViewOnlyAtom here — on End
    // the meeting flips to view-only BEFORE this flush runs, so gating SKIPPED
    // the save and the replay came out EMPTY (owner: "file record canvas k có
    // sau cuộc họp"). saveCanvasHistoryNow already no-ops when the recorder is
    // empty (a pure review session), so it can never overwrite the real log with
    // nothing.
    if (this.canvasHistorySaveTimer) {
      clearTimeout(this.canvasHistorySaveTimer);
      this.canvasHistorySaveTimer = null;
    }
    this.saveCanvasHistoryNow(roomId, roomKey);
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.eagerSceneLoaded = false;
    this.stopAccessRecheck();
    this.flushPendingRoomSaves();
    this.portal.close();
    this.fileManager.reset();
    // Canvas replay log is per-room and in-memory; clear it so the next room
    // (or a review session) starts from its own persisted log, not this one's
    // frames. flushPendingRoomSaves above already pushed the final state to R2.
    if (this.canvasHistorySaveTimer) {
      clearTimeout(this.canvasHistorySaveTimer);
      this.canvasHistorySaveTimer = null;
    }
    canvasHistory.reset();
    if (this.chatSaveTimer) {
      clearTimeout(this.chatSaveTimer);
      this.chatSaveTimer = null;
    }
    if (this.libraryUnsub) {
      this.libraryUnsub();
      this.libraryUnsub = null;
    }
    if (this.librarySaveTimer) {
      clearTimeout(this.librarySaveTimer);
      this.librarySaveTimer = null;
    }
    // R2 paths are per-room, so don't carry these flags into the next room.
    this.storedLibraryFileIds.clear();
    this.hydratingLibraryFileIds.clear();
    this.uploadingLibraryFiles.clear();
    this.loadingLibrary = false;
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      appJotaiStore.set(meetingViewOnlyAtom, false);
      appJotaiStore.set(waitingRoomAtom, null);
      clearReviewRoom();
      clearStealthRoom();
      // Drop the LEFT meeting's chat so it can't bleed into the next room;
      // the next room loads its own persisted history on join.
      appJotaiStore.set(chatMessagesAtom, []);
      // Drop the LEFT meeting's LIBRARY SHELF too. hydrateMeetingFiles() MERGES
      // the current atom into the next room's files (to survive the join-race
      // where peer broadcasts land mid-handshake) — so if we leave this stale,
      // meeting A's DXF/IFC/PDF/images bleed into EVERY next meeting's shelf.
      // Per-room IndexedDB is untouched (roomId-keyed); only the in-memory atom
      // is the cross-room leak. (Fix: "vào project nào cũng thấy file cũ", 06-15.)
      appJotaiStore.set(meetingFilesAtom, []);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      // Reset the live roster too — a stale liveSocketId would otherwise let a
      // late USER_PROFILE from the LEFT room seed a ghost into the next room.
      this.liveSocketIds = new Set();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      // CRITICAL: clear the canvas on leave. The portal is now closed
      // (roomId nulled above), but the LEFT meeting's elements are still
      // resident in the scene. If we don't drop them, opening the NEXT
      // meeting sets portal.roomId = B and any save that fires before B's
      // scene loads would persist meeting A's elements under roomId B —
      // exactly the cross-meeting contamination we hit. resetScene now =
      // no stale content can ever leak into the next room.
      this.excalidrawAPI.resetScene();
      LocalData.resumeSave("collaboration");
    }
    // Reset the host-detection scaffolding so a re-joined room
    // doesn't keep the previous session's socket id / join time
    // tilting the host election. mySocketId is re-set on next
    // socket "connect"; joinedAt is rebroadcast on next profile sync.
    setMySocketId(null);
    resetMyJoinedAt();
    resetRoomRecording();
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
    opts?: { viewOnly?: boolean; stealth?: boolean },
  ) => {
    // REVIEW MODE: opening a finished meeting from the project folder. The
    // canvas is locked read-only (viewModeEnabled, driven by this atom) —
    // a finished meeting is immutable, extract-only. Set before any scene
    // load so the very first render is already read-only. Fall back to the
    // per-tab persisted mark so a page RELOAD (which auto-rejoins from the
    // #room URL without opts) stays read-only instead of becoming editable.
    const reviewRoomId = existingRoomLinkData?.roomId ?? null;
    const viewOnly = opts?.viewOnly ?? isReviewRoom(reviewRoomId);
    appJotaiStore.set(meetingViewOnlyAtom, viewOnly);
    // Mark/clear unconditionally so an EDITABLE join (new meeting / resume)
    // in the same tab wipes any stale review mark — otherwise a leftover
    // mark from an earlier review would make the next reload read-only.
    if (viewOnly && reviewRoomId) {
      markReviewRoom(reviewRoomId);
    } else {
      clearReviewRoom();
      // An editable join also wipes any stale stealth mark, mirroring the
      // review-mark hygiene above.
      clearStealthRoom();
    }

    // STEALTH REVIEW (admin compliance open — "ẩn hoàn toàn", quyết định
    // 06-10): load the meeting PURELY from its R2 snapshot. No socket join,
    // so nothing observable leaks to the people in the room: no presence, no
    // cursor, no USER_PROFILE broadcast. (The participant row is suppressed
    // separately in MeetingShell.) Trade-off: a LIVE meeting shows its last
    // autosaved state, not realtime strokes — accepted for invisibility.
    // The sessionStorage mark makes a mid-review reload re-enter stealth
    // instead of silently joining as a visible peer.
    if (
      existingRoomLinkData &&
      (opts?.stealth || isStealthRoom(reviewRoomId))
    ) {
      const { roomId: sRoomId, roomKey: sRoomKey } = existingRoomLinkData;
      appJotaiStore.set(meetingViewOnlyAtom, true);
      markReviewRoom(sRoomId);
      markStealthRoom(sRoomId);
      appJotaiStore.set(startGateAtom, null);
      appJotaiStore.set(waitingRoomAtom, null);
      this.portal.roomId = sRoomId;
      this.portal.roomKey = sRoomKey;
      this.setIsCollaborating(true);
      LocalData.pauseSave("collaboration");
      this.excalidrawAPI.resetScene();
      void this.loadChatHistory(sRoomId, sRoomKey);
      void this.loadLibrary(sRoomId, sRoomKey);
      void this.loadTranscriptHistory(sRoomId, sRoomKey);
      // Review opens the replay log too, so the finished-meeting Replay surface
      // can scrub the canvas evolution.
      void this.loadCanvasHistory(sRoomId, sRoomKey);
      const stealthScene = resolvablePromise<
        | (ImportedDataState & {
            elements: readonly OrderedExcalidrawElement[];
          })
        | null
      >();
      try {
        const elements = await loadFromFirebase(sRoomId, sRoomKey, null);
        if (elements) {
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );
          this.handleRemoteSceneUpdate(
            this._reconcileElements(
              toBrandedType<readonly RemoteExcalidrawElement[]>(elements),
            ),
          );
          stealthScene.resolve({ elements, scrollToContent: true });
        } else {
          stealthScene.resolve(null);
        }
      } catch (error: any) {
        console.error(error);
        stealthScene.resolve(null);
      }
      this.setActiveRoomLink(window.location.href);
      return stealthScene;
    }

    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;
    // REALTIME BACKEND — FORCED to Durable Objects (06-17). Realtime is now
    // 100% DO; the legacy socket.io room server is RETIRED, so a socket.io
    // connection can never succeed anymore (the WS opens then closes
    // immediately — the bug this fixes). There is no per-meeting transport
    // choice left: EVERY entry path uses the DO transport below — live
    // meetings, unregistered ad-hoc rooms, and crucially the review/finished
    // view-only path (which skips the metadata fetch and so never re-resolved
    // the old flag — it used to fall through to the dead relay). The
    // `realtime_backend` meeting flag is kept only for the admin rollout view.

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);

      // START GATE (Phase 4.5 state machine): joining a registered meeting
      // that is still `scheduled` (host hasn't pressed Start) or `cancelled`
      // parks the room in startGateAtom instead of connecting — the
      // WaitingForStart overlay then offers Start (internal staff =
      // acting-host rule) or polls until live (guests). `live`, `finished`,
      // unregistered ad-hoc rooms, and explicit review opens pass through.
      if (!viewOnly) {
        // First gate read goes through the short-lived dedupe so it shares ONE
        // round-trip with the other open-time readers (MeetingShell,
        // MeetingConsentGate, MeetingHeader, …) firing for this same roomId.
        let fetched = await getMeetingChecked(roomId);
        if (fetched.kind === "error") {
          // Transient worker hiccup? One retry before deciding. `fresh` bypasses
          // the dedupe so the retry truly re-asks the worker (an `error` is
          // never cached, but be explicit: a retry must hit the network).
          await new Promise((resolve) => setTimeout(resolve, 1500));
          fetched = await getMeetingChecked(roomId, { fresh: true });
        }
        if (fetched.kind === "error") {
          // FAIL CLOSED: we can't tell a finished/scheduled meeting from a
          // live one, so don't grant an editable canvas on a guess. Bail
          // before setIsCollaborating/socket open — the user stays in the
          // lobby with #room intact on the URL, so a plain retry works.
          showAppToast(
            // Class context — read the viewer's language straight off the
            // store instead of the useT hook.
            tMcm(
              appJotaiStore.get(preferredLanguageAtom),
              "errors.joinUnverified",
            ),
          );
          return null;
        }
        if (fetched.kind === "forbidden") {
          // The server says this user may not see the meeting (revoked /
          // never invited). Same UX as being kicked — MeetingShell shows
          // the notice and clears the room hash.
          appJotaiStore.set(kickedAtom, true);
          return null;
        }
        // `not-found` = genuinely unregistered ad-hoc room → editable
        // pass-through, same as before.
        const reg = fetched.kind === "found" ? fetched.meeting : null;
        // Realtime transport is forced to the Durable Object backend for every
        // meeting now (socket.io relay retired) — see realtimeBackend above.
        const gateStatus = normalizeMeetingStatus(reg?.status);
        if (gateStatus === "scheduled" || gateStatus === "cancelled") {
          appJotaiStore.set(startGateAtom, {
            roomId,
            roomKey,
            title: reg?.title ?? null,
            scheduledAt: reg?.scheduled_at ?? null,
            status: gateStatus,
          });
          return null;
        }
        if (gateStatus === "finished") {
          // Review is INTERNAL-ONLY (quyết định 06-11): guests/clients get a
          // terminal "meeting đã kết thúc" card instead — the host will share
          // a packaged recap with them separately (later phase). The worker
          // re-enforces this (403 on finished rooms for guests).
          const me = appJotaiStore.get(sessionAtom)?.email;
          if (!isInternalEmail(me)) {
            appJotaiStore.set(startGateAtom, {
              roomId,
              roomKey,
              title: reg?.title ?? null,
              scheduledAt: reg?.scheduled_at ?? null,
              status: "finished",
            });
            return null;
          }
          // Finished = immutable review on EVERY entry path — raw #room link,
          // stale resume, reload in a fresh tab. The registry status is the
          // single source of truth now, so the old "review only when opened
          // from the folder tile" carve-out is gone: an editable canvas on a
          // finished meeting just produced doomed writes (the worker 409s
          // every PATCH) and host controls that can't work.
          appJotaiStore.set(meetingViewOnlyAtom, true);
          markReviewRoom(roomId);
        }
        if (gateStatus === "live") {
          // WAITING ROOM (knock-to-join): an EXTERNAL guest doesn't barge into a
          // live meeting — they knock and wait for a host to admit them. Internal
          // staff auto-admit (the worker gives them no knock row) and fall
          // through to connect unchanged.
          const me = appJotaiStore.get(sessionAtom)?.email;
          if (!isInternalEmail(me)) {
            const knock = await getMyKnock(roomId);
            if (knock?.status !== "admitted") {
              // Not yet admitted → knock and park. The WaitingRoom overlay polls
              // until admitted (auto-connect) or denied. Do NOT connect.
              const myName = appJotaiStore.get(sessionAtom)?.name;
              void knockToMeeting(roomId, myName);
              appJotaiStore.set(waitingRoomAtom, {
                roomId,
                roomKey,
                title: reg?.title ?? null,
                scheduledAt: reg?.scheduled_at ?? null,
                status: "invited",
              });
              return null;
            }
            // Already admitted (re-entry / refresh) → fall through to connect.
          }
        }
      }
      appJotaiStore.set(startGateAtom, null);
      appJotaiStore.set(waitingRoomAtom, null);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
      // Ad-hoc room (share dialog / lobby side paths): register it with an
      // OWNER and a lifecycle from birth, like every other meeting — the
      // organizer email is stamped server-side from the verified JWT, status
      // goes straight to `live` (nobody schedules an ad-hoc room), and the
      // creator can later End-for-all / find it on their calendar.
      //
      // RELIABILITY (06-19): this used to be fire-and-forget (`void`), which
      // SWALLOWED failures — a dropped POST meant NO D1 row, and the worker's
      // `canSeeMeeting` then treated the unregistered room as open to every
      // logged-in user (an access-gating hole). We now reliably register with a
      // bounded retry. We DON'T block the join UX on it (the await runs in
      // parallel with the socket handshake below and we never `return` on
      // failure), but we try hard and LOUDLY warn if every attempt fails so an
      // ungated room is never created silently. The worker fail-closes
      // server-side for still-unregistered rooms as the backstop.
      const session = appJotaiStore.get(sessionAtom);
      void this.registerAdHocMeetingReliably({
        roomId,
        roomKey,
        createdBy: session?.name,
        status: "live",
      });
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      // ── REALTIME TRANSPORT (DO migration §5) ───────────────────────────────
      // 100% Durable Objects: the ONLY transport is RawWsTransport (raw
      // WebSocket to the RoomDO route `/rooms/:id/ws` on the mcm-storage
      // Worker). The legacy socket.io relay is retired, so there is no
      // transport branch anymore — every meeting connects via the DO. Everything
      // downstream — Portal.open, encrypt, the 18-subtype client-broadcast
      // switch, host election — is unchanged because RawWsTransport presents the
      // slice of the socket.io Socket surface the app uses.
      const tunnelMode = import.meta.env.VITE_DEV_TUNNEL === "true";
      // RoomDO is hosted on the mcm-storage Worker → use the storage URL as the
      // WS base (same-origin "" in tunnel mode). The Supabase token is attached
      // inside RawWsTransport via the WS subprotocol, not a query param.
      // #room=roomId,roomKey stays in the hash (E2E); roomKey is never sent to
      // the server.
      const wsBase = tunnelMode
        ? ""
        : (import.meta.env.VITE_APP_STORAGE_URL as string | undefined) || "";
      const transport = new RawWsTransport({ wsBase, roomId });
      // Cast: RawWsTransport is a structural stand-in for the socket.io Socket
      // surface the app touches, not a real socket.io socket.
      const socket = transport as unknown as Socket;
      this.portal.socket = this.portal.open(socket, roomId, roomKey);
      transport.connect();

      // If we previously claimed host for THIS roomId, re-apply the
      // sentinel joinedAt BEFORE the first USER_PROFILE broadcast so
      // the reconnect lands with host already pinned to us. The
      // "first-in-room" event will NOT fire on a reload (a peer is
      // already in the room) so we have to restore from storage.
      restoreHostClaimForRoom(roomId);

      // Mirror the socket id into a jotai atom so derived host election
      // (hostSocketIdAtom) can include the local user without
      // having to read this.portal.socket from a render path. The
      // socket may not be ready yet — the on("connect") handler below
      // patches in the real id once it lands.
      const setIdFromSocket = () => {
        setMySocketId(this.portal.socket?.id ?? null);
      };
      setIdFromSocket();
      this.portal.socket.on("connect", setIdFromSocket);
      // DO parity: RawWsTransport's connection id is assigned from the
      // `init-room` control frame (the DO mints it post-accept), which lands
      // AFTER "connect" — so refresh the id atom on init-room too. Harmless on
      // socket.io (id is already set; idempotent) and re-applies after every
      // reconnect (the DO re-sends init-room each accept). (plan §5)
      this.portal.socket.on("init-room", () => {
        setIdFromSocket();
        // Announce our profile to the room on (re)connect so EXISTING peers
        // learn our name immediately. Without this a newcomer only broadcasts
        // on "first-in-room" (which it doesn't get when others are already
        // present) or on the first mouse-move/idle — so we showed up as "Guest"
        // on everyone else's tile until we moved the cursor (06-18). Existing
        // members already re-announce to us via the "new-user" handler below;
        // this closes the other direction. userProfileAtom is set by MeetingShell
        // before the socket connects, so the snapshot carries our real name.
        this.broadcastUserProfileSnapshot();
      });

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    // Persist the meeting library to R2 on any change (debounced), so all
    // material is durable and a reopen on any browser restores it. One
    // subscription per session; torn down in destroySocketClient.
    if (!this.libraryUnsub) {
      this.libraryUnsub = appJotaiStore.sub(meetingFilesAtom, () => {
        this.persistLibrary();
      });
    }

    if (existingRoomLinkData) {
      // when joining existing room, don't merge it with current scene data
      this.excalidrawAPI.resetScene();

      // Load this room's persisted chat log + library in parallel with the
      // scene, so a reopen (and especially a finished-meeting review) shows
      // the past conversation and the DXF/IFC/PDF material. Both merge by id,
      // so live messages / peer files aren't lost.
      void this.loadChatHistory(
        existingRoomLinkData.roomId,
        existingRoomLinkData.roomKey,
      );
      void this.loadLibrary(
        existingRoomLinkData.roomId,
        existingRoomLinkData.roomKey,
      );
      void this.loadTranscriptHistory(
        existingRoomLinkData.roomId,
        existingRoomLinkData.roomKey,
      );
      void this.loadCanvasHistory(
        existingRoomLinkData.roomId,
        existingRoomLinkData.roomKey,
      );

      // EAGER PARALLEL PREFETCH — load the saved scene from storage (R2)
      // RIGHT NOW, in parallel with the socket connect, instead of waiting
      // for the "first-in-room" event or the 5s INITIAL_SCENE_UPDATE_TIMEOUT
      // fallback. On reopen a lingering ghost socket on the room server
      // suppresses "first-in-room", and with no live peer to answer, the
      // scene would otherwise only render after the full 5s timeout even
      // though it was already saved — the user staring at a blank canvas.
      // The socket path still runs afterwards and reconciles any newer peer
      // state on top (reconcileElements merges), since we do NOT mark the
      // socket initialized here.
      void (async () => {
        try {
          const elements = await loadFromFirebase(
            existingRoomLinkData.roomId,
            existingRoomLinkData.roomKey,
            this.portal.socket,
          );
          if (!elements || this.portal.socketInitialized) {
            return;
          }
          this.eagerSceneLoaded = true;
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );
          this.handleRemoteSceneUpdate(
            this._reconcileElements(
              toBrandedType<readonly RemoteExcalidrawElement[]>(elements),
            ),
          );
          scenePromise.resolve({ elements, scrollToContent: true });
        } catch (error: any) {
          // Non-fatal: the socket paths remain as the fallback.
          console.error(error);
        }
      })();
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const remoteElements = toBrandedType<
                readonly RemoteExcalidrawElement[]
              >(decryptedData.payload.elements);
              const reconciledElements =
                this._reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SUBTYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this._reconcileElements(
                toBrandedType<readonly RemoteExcalidrawElement[]>(
                  decryptedData.payload.elements,
                ),
              ),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            // Layer the peer's profile (custom display name + uploaded
            // avatar) onto Excalidraw's Collaborator so the on-canvas
            // cursor + the built-in UserList both reflect the values
            // the user picked in the profile modal. Falls back to the
            // raw MOUSE_LOCATION username when no profile has arrived
            // yet.
            const profile = appJotaiStore.get(peerProfilesAtom).get(socketId);
            // Always send a real image URL — falls back to a library avatar
            // deterministic from the peer's EMAIL (stable login identity) so
            // the on-canvas cursor face matches the participants bar / chat and
            // does NOT change on reconnect. Anonymous link-join peers with no
            // email use the per-session socketId as the only key available.
            const avatarUrl = resolveAvatarUrlWithDefault(
              profile?.avatar,
              avatarIdentityKey(profile?.email, socketId),
            );
            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username: profile?.username || username,
              avatarUrl,
              ...(profile?.company ? { company: profile.company } : {}),
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const appState = this.excalidrawAPI.getAppState();

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (appState.userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (
              appState.userToFollow &&
              appState.followedBy.has(appState.userToFollow.socketId)
            ) {
              return;
            }

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fitToViewport: true,
                viewportZoomFactor: 1,
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          case WS_SUBTYPES.CHAT: {
            this.appendChatMessage(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.CHAT_REACTION: {
            this.applyChatReaction(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.LIBRARY_FILE: {
            this.applyRemoteLibraryFile(decryptedData.payload.file);
            break;
          }

          case WS_SUBTYPES.LIBRARY_FILE_DELETE: {
            this.applyRemoteLibraryFileDelete(decryptedData.payload.fileId);
            break;
          }

          case WS_SUBTYPES.LIBRARY_FILE_LOCK: {
            const { fileId, lockedBy } = decryptedData.payload;
            if (setMeetingFileLock(this.portal.roomId, fileId, lockedBy)) {
              // Mirror the lock onto any canvas image referencing this
              // file locally too. Excalidraw's element sync handles its
              // own peer-to-peer fanout, so we don't broadcast from here.
              this.setCanvasImagesLockedByFileId(fileId, lockedBy !== null);
            }
            break;
          }

          case WS_SUBTYPES.RAISE_HAND: {
            const { socketId, raised } = decryptedData.payload;
            this.applyRaiseHand(socketId, raised);
            break;
          }

          case WS_SUBTYPES.SCREEN_SHARE: {
            const { socketId, sharing } = decryptedData.payload;
            this.applyScreenShare(socketId, sharing);
            break;
          }

          case WS_SUBTYPES.MEETING_REACTION: {
            this.applyMeetingReaction(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.STT_SEGMENT: {
            this.applySTTSegment(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.USER_PROFILE: {
            const { socketId, username, company, avatar, joinedAt, email } =
              decryptedData.payload;
            upsertPeerProfile(socketId, {
              username,
              ...(company ? { company } : {}),
              ...(avatar ? { avatar } : {}),
              ...(email ? { email } : {}),
            });
            if (typeof joinedAt === "number" && Number.isFinite(joinedAt)) {
              upsertPeerJoinedAt(socketId, joinedAt);
            }
            break;
          }

          case WS_SUBTYPES.RECORDING_STATE: {
            // SUPERSEDED (06-24, #24): the recording SESSION lock now lives in
            // the room Durable Object, which is the single source of truth and
            // pushes its own UNENCRYPTED `recording-state` control frame (see
            // the `recording-state` subscription in startCollaboration). We
            // deliberately IGNORE this legacy encrypted broadcast so a peer
            // still running an old build can't clobber the DO-driven state.
            break;
          }

          case WS_SUBTYPES.HOST_COMMAND: {
            const { hostSocketId, action, target, fromAuthority } =
              decryptedData.payload;
            const mySocketId = this.portal.socket?.id;
            // KICK must come from the host we locally elect — blocks a rogue
            // peer from kicking someone. If our election is unresolved (null)
            // we accept (host-only UI in practice). EXCEPTION: a sender with
            // server-verified PROJECT authority (leader / head / deputy —
            // fromAuthority) is accepted even when election landed elsewhere,
            // so a division head can always kick (anh Luân 06-15). MUTE/UNMUTE
            // stay trusted: they're target-scoped and low-harm.
            if (action === "KICK" && !fromAuthority) {
              const localHost = appJotaiStore.get(hostSocketIdAtom);
              if (localHost && hostSocketId !== localHost) {
                break;
              }
            }
            if (action === "END_MEETING") {
              // The broadcast is only a HINT — End may legitimately come from
              // the organizer/co-host (email role, 06-11), who is often NOT
              // this client's elected host socket, so a socket-id check drops
              // real Ends. The REGISTRY is the authority: verify finished
              // there, then flip to review. A spoofed broadcast verifies as
              // not-finished and does nothing.
              const endedRoomId = this.portal.roomId;
              if (!endedRoomId) {
                break;
              }
              // EXTERNAL GUESTS get NO raw review after End (quyết định 06-11) —
              // the host shares a packaged recap separately. So a guest must NOT
              // wait on getMeeting()=200 (the worker 403s finished rooms for
              // guests, so the verify can never confirm and they'd stay editable
              // until the slow 60s access-recheck → cold "host removed you").
              // The END_MEETING broadcast is host-authenticated; react to it
              // INSTANTLY: park into the graceful "meeting has ended" gate card
              // (same terminal card guests get when JOINING a finished meeting)
              // and tear the live socket down so they can no longer chat/draw.
              // Internal users fall through to the registry-verified review flip
              // below — their review-on-every-path behaviour is unchanged.
              if (appJotaiStore.get(sessionAtom)?.isGuest) {
                const { roomKey } = this.portal;
                // Close the portal FIRST: stops chat/draw broadcasts and the
                // live socket (and clears review/waiting atoms). The gate is set
                // AFTER so the teardown can't wipe it — destroySocketClient does
                // NOT touch startGateAtom.
                this.destroySocketClient();
                appJotaiStore.set(startGateAtom, {
                  roomId: endedRoomId,
                  roomKey: roomKey ?? "",
                  // Title is optional on the card; skip the network round-trip
                  // so the transition is instant. The card reads fine without it.
                  title: null,
                  scheduledAt: null,
                  status: "finished",
                });
                break;
              }
              // INTERNAL review path — unchanged. The ender's status='finished'
              // write may not have reached the D1 read replica this verify hits
              // yet (eventual consistency) — a single read can MISS it and strand
              // everyone in the room until the slow 60s status poll ("ends a while
              // later"). Retry the verify a few times with short backoff so a real
              // End flips to review within ~1-2s; a spoofed broadcast still
              // verifies as not-finished across all retries and gives up.
              void (async () => {
                for (let attempt = 0; attempt < 5; attempt++) {
                  // `fresh`: this verify races D1 read-replica consistency — it
                  // MUST hit the worker each attempt, never a cached pre-End
                  // status, or the finished flip is missed and the room strands.
                  const m = await getMeeting(endedRoomId, { fresh: true });
                  if (this.portal.roomId !== endedRoomId) {
                    return;
                  }
                  if (isFinishedStatus(m?.status ?? null)) {
                    appJotaiStore.set(meetingViewOnlyAtom, true);
                    markReviewRoom(endedRoomId);
                    return;
                  }
                  await new Promise((r) => setTimeout(r, 1000));
                }
              })();
            } else if (action === "KICK" && target && target === mySocketId) {
              // The host removed me — MeetingShell watches this and leaves.
              appJotaiStore.set(kickedAtom, true);
            } else if (action === "MUTE" && target && target === mySocketId) {
              // The host muted me — self-mute the mic if I'm live and unmuted.
              const audioRoom = appJotaiStore.get(audioRoomInstanceAtom);
              const aState = appJotaiStore.get(audioStateAtom);
              if (audioRoom && aState.status === "live" && !aState.muted) {
                audioRoom.toggleMute();
              }
            } else if (action === "UNMUTE" && target && target === mySocketId) {
              // The host un-muted me — re-enable the mic if I have one. (No-op
              // in listener mode: there is no mic to turn on.)
              const audioRoom = appJotaiStore.get(audioRoomInstanceAtom);
              const aState = appJotaiStore.get(audioStateAtom);
              if (
                audioRoom &&
                aState.status === "live" &&
                aState.muted &&
                aState.canTransmit
              ) {
                audioRoom.toggleMute();
              }
            }
            break;
          }

          case WS_SUBTYPES.AUDIO_STATE: {
            const { socketId, inCall, muted } = decryptedData.payload;
            upsertPeerAudio(socketId, { inCall, muted });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      // The server fires "first-in-room" only on whoever shows up to
      // an empty room — by definition the user who originated the
      // link. Pin them as host election winner with a sentinel
      // joinedAt, persist the claim to localStorage so a reload of
      // THIS room doesn't silently transfer host to a peer who
      // happens to have an earlier Date.now() joinedAt, then
      // rebroadcast so peers update their host atom.
      markMeAsFirstInRoom();
      persistHostClaimForRoom(this.portal.roomId ?? null);
      this.broadcastUserProfileSnapshot();
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    // when a new user joins, share our current Meeting Library so they
    // receive any files we have already added
    this.portal.socket.on("new-user", () => {
      this.broadcastLibrarySnapshot();
      this.broadcastUserProfileSnapshot();
      // If WE are the one currently presenting, re-announce it so the
      // just-joined peer learns there's an in-progress share. Without this,
      // SCREEN_SHARE presence is fire-once at start time and a viewer who
      // joins/refreshes mid-share sees an empty presence map → never joins
      // Daily → never sees the screen (the media track is still live in the
      // SFU; we just have to re-trigger the presence-driven ensureJoined).
      this.broadcastScreenShareSnapshot();
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.excalidrawAPI.updateScene({
          appState: { followedBy: new Set(followedBy) },
        });

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    // RECORDING SESSION lock (06-24, #24) — the room DO is the single source of
    // truth. It pushes an UNENCRYPTED `recording-state` control frame on
    // acquire / release / owner-disconnect, AND unicasts it to a socket right
    // after it joins (late-join). We mirror it into roomRecordingAtom, resolving
    // the owner's DISPLAY NAME from collaborators by EMAIL (the DO's owner.name
    // is always null — it has no DB). This REPLACES the old host-driven
    // RECORDING_STATE broadcast as the banner/glow/per-mic trigger.
    this.portal.socket.on(
      "recording-state",
      (state: {
        recording?: boolean;
        owner?: { email?: string | null; name?: string | null } | null;
        startedAt?: number | null;
        sessionId?: string | null;
      }) => {
        if (!state || !state.recording) {
          // Session ended (or never started) → clear. If WE were the owner, our
          // intent is satisfied; drop it so a later reconnect doesn't re-acquire
          // a session the DO already released.
          this.recordingIntent = null;
          resetRoomRecording();
          return;
        }
        const ownerEmail = state.owner?.email?.toLowerCase() ?? null;
        setRoomRecording({
          recording: true,
          ownerEmail,
          sessionId: state.sessionId ?? null,
          hostName: this.resolveOwnerName(ownerEmail),
          hostSocketId: null,
          startedAt: state.startedAt ?? null,
        });
      },
    );

    // RECONNECT re-acquire (06-24, #24). The DO holds the lock in the SOCKET's
    // attachment, so when our socket dies the lock dies with it. The transport
    // auto-reconnects (RawWsTransport) and re-fires "connect" with a FRESH
    // socket; if we still intend to record this session, re-emit
    // recording-acquire so the DO re-pins the lock to the new socket. We do NOT
    // generate a new sessionId — every file from this Record press keeps sharing
    // the original one. Bound once here (the connect listener is additive to the
    // setIdFromSocket one bound earlier; both fire on every reconnect).
    this.portal.socket.on("connect", () => {
      const intent = this.recordingIntent;
      if (intent) {
        this.portal.socket?.emit("recording-acquire", {
          sessionId: intent.sessionId,
          startedAt: intent.startedAt,
        });
      }
    });

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    this.startAccessRecheck();

    return scenePromise;
  };

  // --- In-room access re-check (revoke có răng, quyết định 06-11) ----------
  // The organizer removing someone from the invitee list must EJECT them from
  // a live room, not just hide future entry — the socket relay has no authz,
  // so the client re-asks the Worker every minute. 403 = roomGate says we
  // lost access (revoked) → same UX as a host kick. 404 (ad-hoc room) and
  // network errors are NOT kicks — fail open here; the start gate already
  // fails closed where it matters.
  private accessRecheckInterval: number | null = null;
  private startAccessRecheck = () => {
    this.stopAccessRecheck();
    this.accessRecheckInterval = window.setInterval(() => {
      const checkingRoomId = this.portal.roomId;
      if (!checkingRoomId || !this.portal.socketInitialized) {
        return;
      }
      // `fresh`: revocation is detected ONLY by re-asking the worker live —
      // a cached "still allowed" from join time would silently keep a kicked
      // user in the room. The 60s cadence is far longer than the cache TTL,
      // but bypass explicitly so intent can't drift.
      void getMeetingChecked(checkingRoomId, { fresh: true }).then(
        (fetched) => {
          if (
            this.portal.roomId === checkingRoomId &&
            fetched.kind === "forbidden"
          ) {
            appJotaiStore.set(kickedAtom, true);
          }
        },
      );
    }, 60_000);
  };
  private stopAccessRecheck = () => {
    if (this.accessRecheckInterval !== null) {
      window.clearInterval(this.accessRecheckInterval);
      this.accessRecheckInterval = null;
    }
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      // The eager prefetch in startCollaboration already loaded + rendered
      // this scene. Don't resetScene + re-fetch (a visible flicker + wasted
      // round-trip) — just mark the socket initialized so live updates flow.
      if (this.eagerSceneLoaded) {
        this.portal.socketInitialized = true;
        return null;
      }

      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );

          return {
            elements,
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();

    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    remoteElements = restoreElements(remoteElements, existingElements);

    // Record every incoming id so we never claim authorship of a peer's
    // element when stamping local text in applyTextAuthorship.
    for (const el of remoteElements) {
      this.remoteElementIds.add(el.id);
    }

    let reconciledElements = reconcileElements(
      existingElements,
      remoteElements,
      appState,
    );

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  /**
   * Register an ad-hoc room with bounded retry + backoff so a flaky network
   * doesn't leave the room unregistered (and therefore ungated server-side).
   * registerMeeting() resolves `false` on a non-ok / thrown request, `true` on
   * success, and short-circuits to `false` when storage isn't configured —
   * which we treat as "nothing to do" (not an error worth shouting about).
   * Non-blocking by design: the caller `void`s this so the join handshake
   * proceeds in parallel.
   */
  private registerAdHocMeetingReliably = async (m: {
    roomId: string;
    roomKey: string;
    createdBy?: string;
    status: "live";
  }): Promise<void> => {
    // Storage off (dev / unconfigured) → registerMeeting() no-ops and returns
    // false; the room legitimately stays unregistered, exactly as before. Bail
    // before the retry loop so we don't retry-then-warn on a non-error.
    if (!IS_PROJECTS_CONFIGURED) {
      return;
    }
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ok = await registerMeeting(m);
      if (ok) {
        return;
      }
      if (attempt < MAX_ATTEMPTS) {
        // Short exponential-ish backoff (0.5s, 1s, 2s) — long enough to ride
        // out a transient blip, short enough not to leave the room ungated for
        // long. We DON'T await this before opening the socket; it races the
        // handshake so the user never waits on it.
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * 2 ** (attempt - 1)),
        );
      }
    }
    // Every attempt failed: do NOT stay silent — an unregistered ad-hoc room is
    // an access-gating risk (worker fail-closes, but we want a visible trail).
    console.error(
      `[MCM] Failed to register ad-hoc meeting ${m.roomId} after ${MAX_ATTEMPTS} attempts — ` +
        `room may be unregistered (server will fail-closed for unregistered rooms).`,
    );
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    // Seed each collaborator's username from the last-known USER_PROFILE so a
    // peer that's present but whose profile already arrived shows their real
    // name, not a blank that renders as "Guest" (06-18). New socketIds with no
    // cached profile still resolve once their USER_PROFILE / init-room
    // announce lands.
    const knownProfiles = appJotaiStore.get(peerProfilesAtom);
    for (const socketId of sockets) {
      const prior = this.collaborators.get(socketId);
      const username = prior?.username || knownProfiles.get(socketId)?.username;
      collaborators.set(
        socketId,
        Object.assign({}, prior, {
          isCurrentUser: socketId === this.portal.socket?.id,
          ...(username ? { username } : {}),
        }),
      );
    }
    this.collaborators = collaborators;
    // Refresh the live roster from the authoritative socket list. This is the
    // ONLY place liveSocketIds grows; updateCollaborator / the peerProfiles sub
    // only READ it, so a peer who isn't in `sockets` can never be (re)added by a
    // late USER_PROFILE — the ghost-presence root cause (06-19).
    this.liveSocketIds = new Set(sockets);
    this.excalidrawAPI.updateScene({ collaborators });

    // Prune raised hands belonging to peers who left the room — they
    // can't lower their own hand if they're already gone.
    const currentHands = appJotaiStore.get(raisedHandsAtom);
    if (currentHands.size > 0) {
      const validIds = new Set<string>(sockets);
      const me = this.portal.socket?.id;
      if (me) {
        validIds.add(me);
      }
      let changed = false;
      const next = new Map(currentHands);
      for (const id of next.keys()) {
        if (!validIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) {
        appJotaiStore.set(raisedHandsAtom, next);
      }
    }

    // Prune screen-share presence for peers who left — a sharer who drops
    // can't broadcast sharing:false, so without this the single-share lock
    // would stay stuck and the viewer would hang on a dead stream.
    const currentShares = appJotaiStore.get(screenShareStateAtom);
    if (currentShares.size > 0) {
      const validIds = new Set<string>(sockets);
      const me = this.portal.socket?.id;
      if (me) {
        validIds.add(me);
      }
      let changed = false;
      const next = new Map(currentShares);
      for (const id of next.keys()) {
        if (!validIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) {
        appJotaiStore.set(screenShareStateAtom, next);
      }
    }

    // Drop peer profile entries for participants who just left so
    // their stale name / company / avatar don't linger in the next
    // session if the same socketId is reused. Also drop their
    // joinedAt — leaving them in would cause the host election to
    // keep picking a ghost participant as host.
    const validIds = new Set<string>(sockets);
    const currentProfiles = appJotaiStore.get(peerProfilesAtom);
    for (const peerId of currentProfiles.keys()) {
      if (!validIds.has(peerId)) {
        removePeerProfile(peerId);
        removePeerJoinedAt(peerId);
        removePeerAudio(peerId);
      }
    }
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    // GHOST GUARD: only add/enrich a collaborator that the live roster knows is
    // actually present. A USER_PROFILE / pointer update that arrives AFTER a peer
    // left (late delivery or the 06-19 snapshot re-announce) must not resurrect a
    // tile — it would render as a fallback "Guest" nobody invited. Self is always
    // allowed (our own id may not be in liveSocketIds before the first roster).
    // updateCollaborator only ENRICHES known peers; setCollaborators owns adds.
    const isSelf = socketId === this.portal.socket?.id;
    if (!isSelf && !this.liveSocketIds.has(socketId)) {
      return;
    }
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.socket?.id,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  // Stamp customData.mcmAuthor on TEXT elements this client created
  // (no author yet AND not received from a peer). Persists via
  // updateScene so the author travels with the element to peers +
  // Firebase. Returns true if it mutated the scene.
  private applyTextAuthorship = (
    elements: readonly OrderedExcalidrawElement[],
  ): boolean => {
    const socketId = this.portal.socket?.id;
    if (!socketId) {
      return false;
    }
    // STABLE identity: socketId changes every session, so after a reload
    // we could no longer recognise our OWN text. Stamp the login email
    // (from the session) alongside it — email is the durable key used by
    // the edit gate (canEditTextElement) to decide "is this mine?".
    const email = appJotaiStore.get(sessionAtom)?.email;
    // Snapshot the avatar too, so the author badge keeps the right
    // email-keyed face/initials AFTER the author leaves the room — without
    // it the badge degrades to a socketId-keyed default once the live
    // profile is pruned from peerProfilesAtom.
    const avatar = appJotaiStore.get(userProfileAtom)?.avatar;
    const me = {
      id: socketId,
      name: this.state.username || "Guest",
      email,
      ...(avatar ? { avatar } : {}),
    };
    let changed = false;
    const next = elements.map((el) => {
      if (
        el.type === "text" &&
        !el.isDeleted &&
        !(el.customData as any)?.mcmAuthor &&
        !this.remoteElementIds.has(el.id)
      ) {
        changed = true;
        return newElementWith(el, {
          customData: { ...((el.customData as any) || {}), mcmAuthor: me },
        });
      }
      return el;
    });
    if (changed) {
      this.excalidrawAPI.updateScene({
        elements: next,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    return changed;
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    // Stamp local text authorship BEFORE broadcasting. When stamping
    // mutated the scene, return early — the updateScene re-enters
    // App.onChange → syncElements, and that second pass (author now
    // present → no mutation) does the actual broadcast. Idempotent, so
    // there is no infinite loop.
    if (this.applyTextAuthorship(elements)) {
      return;
    }
    this.broadcastElements(elements);
    this.queueSaveToFirebase();

    // CANVAS REPLAY (passive observer): record a throttled, delta-encoded frame
    // of the scene so a finished meeting can be scrubbed/played back in review.
    // This only READS `elements` (the array we just broadcast/saved) — it never
    // mutates an element, bumps a version, or touches the broadcast/save path,
    // and swallows its own errors, so it cannot affect live collaboration. We
    // never capture in read-only review (review never reaches syncElements; the
    // App.onChange guard and the central review seal both gate it, and
    // persistCanvasHistory re-checks meetingViewOnlyAtom before any R2 write).
    recordCanvasHistory(elements);
    this.persistCanvasHistory();
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  getUsername = () => this.state.username;

  private appendChatMessage = (msg: ChatMessage) => {
    const current = appJotaiStore.get(chatMessagesAtom) ?? [];
    if (current.some((m) => m.id === msg.id)) {
      // de-dup if our own echo arrives via broadcast somehow
      return;
    }
    appJotaiStore.set(chatMessagesAtom, [...current, msg]);
    this.persistChat();
  };

  // Debounced persistence of the full chat log to storage (R2, E2E with the
  // room key) so reopening the meeting — especially a finished one in
  // read-only review — shows the past conversation. Never writes while
  // reviewing (the meeting is immutable) or before the room key is known.
  private chatSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChatNow = (roomId: string, roomKey: string) => {
    const messages = appJotaiStore.get(chatMessagesAtom) ?? [];
    void saveChatToFirebase(roomId, roomKey, messages).catch((error) => {
      console.error(error);
    });
  };

  private persistChat = () => {
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    if (this.chatSaveTimer) {
      clearTimeout(this.chatSaveTimer);
    }
    this.chatSaveTimer = setTimeout(() => {
      this.chatSaveTimer = null;
      this.saveChatNow(roomId, roomKey);
    }, 800);
  };

  /** Load the persisted chat log for a room and merge it into the local
   *  atom (by id, oldest-first) so reopen / late-join sees past messages
   *  without dropping any live message that already arrived. */
  private loadChatHistory = async (roomId: string, roomKey: string) => {
    try {
      const history = await loadChatFromFirebase<ChatMessage>(roomId, roomKey);
      if (!history?.length || this.portal.roomId !== roomId) {
        return;
      }
      const byId = new Map<string, ChatMessage>();
      for (const m of history) {
        byId.set(m.id, m);
      }
      // Live messages win over stored ones (newer reactions/translations).
      for (const m of appJotaiStore.get(chatMessagesAtom) ?? []) {
        byId.set(m.id, m);
      }
      const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
      appJotaiStore.set(chatMessagesAtom, merged);
    } catch (error) {
      console.error(error);
    }
  };

  // --- Transcript persistence (STT log → R2, E2E with the room key) --------
  // Same treatment as the chat log so a finished meeting reviewed on ANY
  // machine shows what was said — localStorage stays as the fast local cache,
  // R2 is the durable copy. Debounced wider than chat (segments arrive in
  // bursts while someone talks). Never writes in read-only review.
  private transcriptSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTranscriptNow = (roomId: string, roomKey: string) => {
    const log = appJotaiStore.get(transcriptionLogAtom) ?? [];
    if (!log.length) {
      return;
    }
    void saveTranscriptToFirebase(roomId, roomKey, log).catch((error) => {
      console.error(error);
    });
  };

  private persistTranscript = () => {
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    if (this.transcriptSaveTimer) {
      clearTimeout(this.transcriptSaveTimer);
    }
    this.transcriptSaveTimer = setTimeout(() => {
      this.transcriptSaveTimer = null;
      this.saveTranscriptNow(roomId, roomKey);
    }, 5000);
  };

  /** Restore the transcript from R2 when the local cache is empty (fresh
   *  browser / review on another machine). Merges by id with whatever the
   *  live session already collected, mirrors the result back into the
   *  localStorage cache, and seeds the atom. */
  private loadTranscriptHistory = async (roomId: string, roomKey: string) => {
    try {
      if (loadTranscriptLog(roomId).length > 0) {
        // Local cache wins — it's at least as fresh as the blob we wrote.
        return;
      }
      const history = await loadTranscriptFromFirebase<TranscriptSegment>(
        roomId,
        roomKey,
      );
      if (!history?.length || this.portal.roomId !== roomId) {
        return;
      }
      const byId = new Map<string, TranscriptSegment>();
      for (const s of history) {
        byId.set(s.id, s);
      }
      // Live segments win over stored ones.
      for (const s of appJotaiStore.get(transcriptionLogAtom) ?? []) {
        byId.set(s.id, s);
      }
      const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
      appJotaiStore.set(transcriptionLogAtom, merged);
      saveTranscriptLog(roomId, merged);
    } catch (error) {
      console.error(error);
    }
  };

  // --- Canvas replay history persistence (delta log → R2, E2E room key) ----
  // Mirrors the chat / transcript persistence: the in-memory recorder (fed
  // passively from syncElements) is debounced to R2 as one encrypted blob, so a
  // finished meeting reviewed on ANY machine can scrub/replay the canvas
  // evolution on the existing review canvas. Never writes in read-only review.
  // Debounced wide (10s) — replay tolerates coarse persistence and edits arrive
  // in bursts.
  private canvasHistorySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveCanvasHistoryNow = (roomId: string, roomKey: string) => {
    // Flush any frame still inside the recorder's capture throttle so the latest
    // edits make it into the blob.
    canvasHistory.flush();
    const entries = canvasHistory.snapshot();
    if (!entries.length) {
      return;
    }
    void saveCanvasHistoryToStorage(roomId, roomKey, entries).catch((error) => {
      console.error(error);
    });
  };

  private persistCanvasHistory = () => {
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    if (this.canvasHistorySaveTimer) {
      clearTimeout(this.canvasHistorySaveTimer);
    }
    this.canvasHistorySaveTimer = setTimeout(() => {
      this.canvasHistorySaveTimer = null;
      this.saveCanvasHistoryNow(roomId, roomKey);
    }, 10000);
  };

  /** Seed the recorder from R2 on join so a reopen keeps appending to (not
   *  overwriting) the prior replay log. Never overwrites a recorder that already
   *  holds frames from THIS live session. */
  private loadCanvasHistory = async (roomId: string, roomKey: string) => {
    try {
      if (canvasHistory.size() > 0) {
        return;
      }
      const history = await loadCanvasHistoryFromStorage<CanvasHistoryEntry>(
        roomId,
        roomKey,
      );
      if (!history?.length || this.portal.roomId !== roomId) {
        return;
      }
      canvasHistory.hydrate(history);
    } catch (error) {
      console.error(error);
    }
  };

  // --- Meeting library persistence (DXF / IFC / PDF source + metadata) -----
  // The library lives in meetingFilesAtom, persisted per-browser to IndexedDB
  // and synced peer-to-peer. Neither survives a reopen on a fresh browser with
  // no live peer — so CAD/PDF content went blank. We mirror it to R2 as one
  // encrypted blob (saved on any library change, debounced) and restore it on
  // join, so reopening on any device shows the full material.
  private librarySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private libraryUnsub: (() => void) | null = null;
  private loadingLibrary = false;

  private saveLibraryNow = (roomId: string, roomKey: string) => {
    void (async () => {
      const files = appJotaiStore.get(meetingFilesAtom) ?? [];
      if (!files.length) {
        return;
      }
      // Keep the blob small: large files (IFC GLB) live on R2 per-file; the
      // blob carries only their metadata (dataURL stripped). Small files
      // stay inline so a single fetch restores them.
      const slim = await Promise.all(
        files.map(async (f) => {
          if (!this.isLargeLibraryFile(f)) {
            return f;
          }
          // ALWAYS strip large bytes from the blob — a multi-MB GLB inline
          // would balloon the blob and 503 the /v1/library PUT. Best-effort
          // push the bytes to per-file R2; if that fails, the entry stays
          // metadata-only (its thumbnail still paints; loadLibrary keeps it).
          try {
            await this.ensureLargeLibraryFileOnR2(f);
          } catch (error) {
            console.error(error);
          }
          return { ...f, dataURL: "" };
        }),
      );
      void saveLibraryToFirebase(roomId, roomKey, slim).catch((error) => {
        console.error(error);
      });
    })();
  };

  private persistLibrary = () => {
    // Don't write while restoring (we'd just re-save what we loaded), while
    // reviewing (the meeting is immutable), or before a room key is known.
    if (this.loadingLibrary || appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    if (this.librarySaveTimer) {
      clearTimeout(this.librarySaveTimer);
    }
    this.librarySaveTimer = setTimeout(() => {
      this.librarySaveTimer = null;
      this.saveLibraryNow(roomId, roomKey);
    }, 1200);
  };

  /** Restore the persisted library on join: feed bytes to the canvas file map
   *  (image/snapshot elements) AND the overlay-source atom. De-dups by id, so
   *  it composes with IndexedDB hydrate + peer broadcasts. */
  private loadLibrary = async (roomId: string, roomKey: string) => {
    // Hold `loadingLibrary` for the WHOLE load (incl. the R2 fetches), not just
    // the upsert loop — otherwise peer library broadcasts arriving mid-join
    // would trigger persistLibrary and write a PARTIAL library blob to R2
    // before we've merged in what's already stored.
    this.loadingLibrary = true;
    try {
      const files = await loadLibraryFromFirebase<MeetingFile>(roomId, roomKey);
      if (!files?.length || this.portal.roomId !== roomId) {
        return;
      }
      // Large files are stored metadata-only in the blob (dataURL stripped);
      // pull their bytes back from per-file R2 in parallel.
      const hydrated = await Promise.all(
        files.map(async (file) => {
          if (file.dataURL) {
            return file;
          }
          try {
            const { loadedFiles } = await loadFilesFromFirebase(
              `files/rooms/${roomId}`,
              roomKey,
              [file.id as FileId],
            );
            const dataURL = loadedFiles[0]?.dataURL;
            if (!dataURL) {
              // Bytes not on R2 yet — KEEP the metadata (its ifcMeta.thumbnail
              // still paints the anchor); the GLB can be pulled later.
              return file;
            }
            this.storedLibraryFileIds.add(file.id);
            return { ...file, dataURL: dataURL as string };
          } catch (error) {
            console.error(error);
            return file;
          }
        }),
      );
      const existing = this.excalidrawAPI.getFiles();
      const additions: BinaryFileData[] = [];
      for (const file of hydrated) {
        if (!file) {
          continue;
        }
        // Only feed real bytes to the canvas file map (skip metadata-only
        // entries whose dataURL is still empty).
        if (file.dataURL && !existing[file.id as FileId]) {
          additions.push({
            id: file.id as FileId,
            dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
            mimeType: file.mimeType as BinaryFileData["mimeType"],
            created: Date.now(),
          });
        }
        upsertMeetingFile(roomId, file, { allowContentDup: true });
      }
      if (additions.length) {
        this.excalidrawAPI.addFiles(additions);
      }
    } catch (error) {
      console.error(error);
    } finally {
      this.loadingLibrary = false;
    }
  };

  /** Wipe THIS tab's local chat + transcript logs. Not broadcast —
   *  each peer owns its own log (chat history isn't re-snapshotted to
   *  joiners). Used by the demo-recording workflow to clear stale
   *  history before a take. Call from a DevTools console after fiber-
   *  walking to the Collab instance: `collab.clearLogs()`. */
  clearLogs = () => {
    appJotaiStore.set(chatMessagesAtom, []);
    appJotaiStore.set(transcriptionLogAtom, []);
    appJotaiStore.set(liveTranscriptsAtom, {});
  };

  /** Mutate an existing message in place (by id). Used to attach
   *  translations to our own local echo once /translate-batch returns,
   *  so the sender sees the translation row without an extra fetch. */
  private updateChatMessage = (id: string, patch: Partial<ChatMessage>) => {
    const current = appJotaiStore.get(chatMessagesAtom) ?? [];
    const next = current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    appJotaiStore.set(chatMessagesAtom, next);
    this.persistChat();
  };

  /** Apply a reaction change (add / remove) coming from another peer
   *  — or from our own toggleReaction below (since we go through the
   *  same path so the local atom stays in sync without a separate echo). */
  private applyChatReaction = (payload: {
    messageId: string;
    emoji: string;
    reactor: string;
    action: "add" | "remove";
  }) => {
    const current = appJotaiStore.get(chatMessagesAtom) ?? [];
    const next = current.map((m) => {
      if (m.id !== payload.messageId) {
        return m;
      }
      const reactions = { ...(m.reactions ?? {}) };
      const set = new Set(reactions[payload.emoji] ?? []);
      if (payload.action === "add") {
        set.add(payload.reactor);
      } else {
        set.delete(payload.reactor);
      }
      if (set.size === 0) {
        delete reactions[payload.emoji];
      } else {
        reactions[payload.emoji] = Array.from(set);
      }
      return { ...m, reactions };
    });
    appJotaiStore.set(chatMessagesAtom, next);
    this.persistChat();
  };

  private applyRaiseHand = (socketId: string, raised: boolean) => {
    const current = appJotaiStore.get(raisedHandsAtom);
    const has = current.has(socketId);
    if (raised && has) {
      return;
    }
    if (!raised && !has) {
      return;
    }
    const next = new Map(current);
    if (raised) {
      next.set(socketId, true);
    } else {
      next.delete(socketId);
    }
    appJotaiStore.set(raisedHandsAtom, next);
  };

  /** Toggle our own raise-hand state and broadcast to peers. */
  toggleRaiseHand = () => {
    if (!this.portal.socket?.id) {
      return;
    }
    const me = this.portal.socket.id;
    const raised = !appJotaiStore.get(raisedHandsAtom).has(me);
    this.applyRaiseHand(me, raised);
    this.portal.broadcastRaiseHand(raised);
  };

  isHandRaised = (): boolean => {
    const me = this.portal.socket?.id;
    if (!me) {
      return false;
    }
    return appJotaiStore.get(raisedHandsAtom).has(me);
  };

  private applyScreenShare = (socketId: string, sharing: boolean) => {
    const current = appJotaiStore.get(screenShareStateAtom);
    const has = current.has(socketId);
    if (sharing && has) {
      return;
    }
    if (!sharing && !has) {
      return;
    }
    const next = new Map(current);
    if (sharing) {
      next.set(socketId, true);
    } else {
      next.delete(socketId);
    }
    appJotaiStore.set(screenShareStateAtom, next);
  };

  /** Set our own screen-share presence and broadcast it to peers. Called by
   *  the Daily manager once the share actually starts/stops — the media
   *  itself is carried by Daily, not this socket. */
  setScreenShare = (sharing: boolean) => {
    const me = this.portal.socket?.id;
    if (!me) {
      return;
    }
    this.applyScreenShare(me, sharing);
    this.portal.broadcastScreenShare(sharing);
  };

  private applyMeetingReaction = (payload: MeetingReactionEvent) => {
    const current = appJotaiStore.get(meetingReactionsAtom);
    // Keep the list bounded; if it ever grows huge under burst usage,
    // drop the oldest. Consumers also self-expire after ~3.5s.
    const next = [...current, payload].slice(-32);
    appJotaiStore.set(meetingReactionsAtom, next);
  };

  /** Expire a reaction from the floating-reactions atom after its
   *  animation finishes (the consumer schedules this with setTimeout). */
  removeMeetingReaction = (id: string) => {
    const current = appJotaiStore.get(meetingReactionsAtom);
    const next = current.filter((r) => r.id !== id);
    if (next.length !== current.length) {
      appJotaiStore.set(meetingReactionsAtom, next);
    }
  };

  // -----------------------------------------------------------------
  // Speech-to-text segments
  // -----------------------------------------------------------------

  /** Receive a finalized STT segment from a peer — append to the log
   *  atom and clear any matching interim entry from that speaker. Also
   *  persists the log to localStorage so refreshes don't lose
   *  transcripts. */
  private applySTTSegment = (payload: {
    id: string;
    socketId: string;
    username: string;
    text: string;
    lang?: string;
    ts: number;
  }) => {
    const segment: TranscriptSegment = {
      id: payload.id,
      socketId: payload.socketId,
      username: payload.username,
      text: payload.text,
      lang: payload.lang,
      ts: payload.ts,
    };
    const log = appJotaiStore.get(transcriptionLogAtom) ?? [];
    // De-dup by id in case the same message arrives twice (e.g.
    // sender's local echo + broadcast).
    if (log.some((s) => s.id === segment.id)) {
      return;
    }
    const next = [...log, segment];
    appJotaiStore.set(transcriptionLogAtom, next);

    // Clear the interim line for that speaker — finalised text now
    // lives in the log.
    const interims = appJotaiStore.get(liveTranscriptsAtom);
    if (interims[payload.socketId]) {
      const cleaned = { ...interims };
      delete cleaned[payload.socketId];
      appJotaiStore.set(liveTranscriptsAtom, cleaned);
    }

    // Persist by roomId so the log survives reload…
    const roomId = this.portal.roomId;
    if (roomId) {
      saveTranscriptLog(roomId, next);
    }
    // …and mirror to R2 (debounced) so it survives a machine change too.
    this.persistTranscript();
  };

  /** Called by the local STTSession when Deepgram emits a final
   *  segment. Echoes locally + broadcasts to peers. */
  publishSTTSegment = (segment: {
    text: string;
    lang?: string;
    ts: number;
  }) => {
    if (!this.portal.socket?.id) {
      return;
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `stt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.applySTTSegment({
      id,
      socketId: this.portal.socket.id,
      username: this.state.username || "Guest",
      text: segment.text,
      lang: segment.lang,
      ts: segment.ts,
    });
    this.portal.broadcastSTTSegment({ id, ...segment });
  };

  /** Update the local interim hypothesis for the current user. Not
   *  broadcast — interim is noisy and viewer-local UX. */
  setLocalInterimTranscript = (text: string) => {
    if (!this.portal.socket?.id) {
      return;
    }
    const me = this.portal.socket.id;
    const current = appJotaiStore.get(liveTranscriptsAtom);
    appJotaiStore.set(liveTranscriptsAtom, {
      ...current,
      [me]: {
        socketId: me,
        username: this.state.username || "Guest",
        text,
        ts: Date.now(),
      },
    });
  };

  /** Clear our own interim line — call when audio session stops or
   *  when the worklet sees end-of-speech. */
  clearLocalInterimTranscript = () => {
    if (!this.portal.socket?.id) {
      return;
    }
    const me = this.portal.socket.id;
    const current = appJotaiStore.get(liveTranscriptsAtom);
    if (!current[me]) {
      return;
    }
    const cleaned = { ...current };
    delete cleaned[me];
    appJotaiStore.set(liveTranscriptsAtom, cleaned);
  };

  /** Broadcast a one-shot emoji reaction. Also echoes locally so the
   *  sender sees their own floating emoji animate over their avatar. */
  sendMeetingReaction = (emoji: string) => {
    if (!this.portal.socket?.id) {
      return;
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload: MeetingReactionEvent = {
      id,
      socketId: this.portal.socket.id,
      emoji,
      ts: Date.now(),
    };
    this.applyMeetingReaction(payload);
    this.portal.broadcastMeetingReaction(emoji);
  };

  toggleChatReaction = (messageId: string, emoji: string) => {
    // Review = display-only: a reaction is a chat WRITE (broadcast + would
    // desync from the immutable stored log). UI hides the buttons; this is
    // the backstop.
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    if (!this.portal.socket?.id) {
      return;
    }
    const me = this.portal.socket.id;
    const messages = appJotaiStore.get(chatMessagesAtom) ?? [];
    const target = messages.find((m) => m.id === messageId);
    const alreadyReacted = target?.reactions?.[emoji]?.includes(me) ?? false;
    const action: "add" | "remove" = alreadyReacted ? "remove" : "add";
    // Apply locally first for snappy UI.
    this.applyChatReaction({
      messageId,
      emoji,
      reactor: me,
      action,
    });
    this.portal.broadcastChatReaction({
      messageId,
      emoji,
      action,
      reactorUsername: this.state.username || "Guest",
    });
  };

  sendChatMessage = async (text: string, replyTo?: ChatReplyRef) => {
    const trimmed = text.trim();
    if (!trimmed || !this.portal.socket?.id) {
      return;
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg: ChatMessage = {
      id,
      socketId: this.portal.socket.id,
      username: this.state.username || "Guest",
      text: trimmed,
      ts: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };
    // Local echo so sender sees their own message immediately; we
    // patch translations onto it below once the batch fetch lands.
    this.appendChatMessage(msg);

    // Best-effort: pre-translate the message into ALL three target
    // languages with ONE Gemini call. Once we have translations,
    // broadcast them along with the text so receivers never have to
    // call /translate themselves. Fall back to broadcasting without
    // translations on failure/timeout — receivers will use the legacy
    // per-viewer /translate path.
    const translations = await fetchBatchTranslation(trimmed);

    if (translations) {
      this.updateChatMessage(id, { translations });
    }

    this.portal.broadcastChatMessage({
      id,
      text: msg.text,
      ts: msg.ts,
      replyTo,
      ...(translations ? { translations } : {}),
    });
  };

  /** Inject a message authored by the in-chat AI assistant. Broadcast
   *  exactly like a regular chat message but with the bot's identity
   *  overriding our own — every receiver sees it as "MCM Bot" rather
   *  than the asker, so multiple users asking @bot doesn't create a
   *  confusing "who is the bot" question. */
  sendBotMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !this.portal.socket?.id) {
      return;
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg: ChatMessage = {
      id,
      socketId: BOT_SOCKET_ID,
      username: BOT_USERNAME,
      text: trimmed,
      ts: Date.now(),
    };
    this.appendChatMessage(msg);

    // Same pre-translate-at-send pattern as sendChatMessage: bot replies
    // arrive in the asker's preferred language, so other viewers still
    // need translations. One batch call serves all of them.
    const translations = await fetchBatchTranslation(trimmed);

    if (translations) {
      this.updateChatMessage(id, { translations });
    }

    this.portal.broadcastChatMessage({
      id,
      text: msg.text,
      ts: msg.ts,
      senderOverride: {
        socketId: BOT_SOCKET_ID,
        username: BOT_USERNAME,
      },
      ...(translations ? { translations } : {}),
    });
  };

  /** Called by MeetingLibrary when the local user adds a file (via upload
   *  or by pasting onto the canvas). Persists locally and broadcasts to
   *  peers so they get the binary too.
   *
   *  `opts.allowContentDup` skips the content fingerprint check inside
   *  upsertMeetingFile. Use it from EXPLICIT user upload paths (file
   *  picker, drag-drop) where re-importing a duplicate file is a
   *  deliberate action — the user expects to see a second library
   *  entry. Default (false) keeps dedup for auto-detect paths so a
   *  paste-on-canvas + library-button-upload of the same image still
   *  collapses into one entry. */
  publishLibraryFile = (
    file: MeetingFile,
    opts?: { allowContentDup?: boolean },
  ) => {
    const roomId = this.portal.roomId;
    const wasNew = upsertMeetingFile(roomId, file, {
      allowContentDup: opts?.allowContentDup,
    });
    if (!wasNew) {
      return;
    }
    // also seed the canvas's file map so subsequent inserts using this
    // fileId render without round-tripping
    this.excalidrawAPI.addFiles([
      {
        id: file.id as FileId,
        dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
        mimeType: file.mimeType as BinaryFileData["mimeType"],
        created: Date.now(),
      },
    ]);
    void this.broadcastLibraryFileSmart(file);
  };

  /** Broadcast a library file to peers. Small files (DXF, images) go inline
   *  over the socket — fast, no round-trip. LARGE files (IFC GLB, multi-MB)
   *  do NOT: pushing megabytes over the encrypted socket is slow + sequential
   *  and made IFC lag for peers ("loads but not realtime"). Instead we PUT the
   *  bytes to R2 first, then broadcast METADATA ONLY (dataURL stripped); the
   *  peer hydrates the bytes from R2 in parallel (`applyRemoteLibraryFile`).
   *  R2 is the durable store anyway, so this also makes the file survive a
   *  reopen. Falls back to an inline broadcast if the R2 PUT fails. */
  // Library file ids we've already PUT to (or pulled from) R2 this session,
  // so a rebroadcast (e.g. library snapshot to each new joiner) skips the
  // redundant re-upload.
  private storedLibraryFileIds = new Set<string>();
  // In-flight per-file R2 uploads, so the two callers (broadcast + persist)
  // share ONE upload instead of racing into duplicate PUTs of the same GLB.
  private uploadingLibraryFiles = new Map<string, Promise<boolean>>();

  /** Is this file "large" — its bytes should live on R2 per-file rather than
   *  inline in socket broadcasts / the library blob? */
  private isLargeLibraryFile = (file: MeetingFile): boolean =>
    !!file.dataURL && file.dataURL.length > LIBRARY_INLINE_MAX_BYTES;

  /** Ensure a large file's bytes are durably on R2 (per-file). Idempotent via
   *  `storedLibraryFileIds`; concurrent calls share one in-flight upload.
   *  Returns true once the bytes are on R2 (so the caller can safely strip the
   *  dataURL from inline transports). Throws if the upload fails, so callers
   *  can fall back to carrying the bytes inline. */
  private ensureLargeLibraryFileOnR2 = (
    file: MeetingFile,
  ): Promise<boolean> => {
    if (this.storedLibraryFileIds.has(file.id)) {
      return Promise.resolve(true);
    }
    const inFlight = this.uploadingLibraryFiles.get(file.id);
    if (inFlight) {
      return inFlight;
    }
    const upload = this.uploadLargeLibraryFileToR2(file);
    this.uploadingLibraryFiles.set(file.id, upload);
    void upload.finally(() => this.uploadingLibraryFiles.delete(file.id));
    return upload;
  };

  private uploadLargeLibraryFileToR2 = async (
    file: MeetingFile,
  ): Promise<boolean> => {
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return false;
    }
    // saveFilesToStorage does NOT throw on an HTTP error — it returns the id in
    // `erroredFiles`. Check it explicitly and throw, so callers (broadcast /
    // persist) treat a 503 as a real failure and fall back to inline.
    const { savedFiles, erroredFiles } = await saveFilesToFirebase({
      prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
      files: await encodeFilesForUpload({
        files: new Map<FileId, BinaryFileData>([
          [
            file.id as FileId,
            {
              id: file.id as FileId,
              dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
              mimeType: file.mimeType as BinaryFileData["mimeType"],
              created: Date.now(),
            },
          ],
        ]),
        encryptionKey: roomKey,
        maxBytes: LIBRARY_FILE_MAX_BYTES,
      }),
    });
    if (erroredFiles.length > 0 || savedFiles.length === 0) {
      throw new Error(`R2 upload failed for library file ${file.id}`);
    }
    this.storedLibraryFileIds.add(file.id);
    return true;
  };

  /** Upload a freshly-baked IFC anchor snapshot PNG to R2 (per-file) and
   *  resolve once it's stored. The overlay AWAITS this BEFORE broadcasting the
   *  image element that points at the new snapshot id, so peers never fetch a
   *  not-yet-uploaded file (404 → permanently errored → broken thumbnail). */
  uploadAnchorSnapshot = async (
    fileId: string,
    dataURL: string,
  ): Promise<boolean> => {
    // Review writes nothing to R2 — anchor snapshots (IFC/DXF/PDF focus bake)
    // PUT bytes directly, bypassing the scene-save seal.
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return false;
    }
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return false;
    }
    const { savedFiles, erroredFiles } = await saveFilesToFirebase({
      prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
      files: await encodeFilesForUpload({
        files: new Map<FileId, BinaryFileData>([
          [
            fileId as FileId,
            {
              id: fileId as FileId,
              dataURL: dataURL as unknown as BinaryFileData["dataURL"],
              mimeType: "image/png" as BinaryFileData["mimeType"],
              created: Date.now(),
            },
          ],
        ]),
        encryptionKey: roomKey,
        maxBytes: FILE_UPLOAD_MAX_BYTES,
      }),
    });
    return erroredFiles.length === 0 && savedFiles.length > 0;
  };

  // Snapshot ids we're currently pulling — avoids duplicate concurrent fetches
  // when the overlay effect re-runs.
  private loadingSnapshotIds = new Set<string>();

  /** Force-load an anchor snapshot (IFC/PDF) from R2 into the canvas file map,
   *  BYPASSING the normal loadImageFiles path. That path skips elements whose
   *  status is "error" and FileManager permanently blocks ids that errored
   *  once — so a snapshot that 404'd on a transient race (e.g. fetched before
   *  its upload finished) stays blank forever, even after it's on R2. The
   *  overlay calls this for any anchor whose snapshot is missing from the map;
   *  once the file is present Excalidraw paints it regardless of the element's
   *  stale "error" status. */
  ensureSnapshotLoaded = async (fileId: string): Promise<void> => {
    if (
      !fileId ||
      this.loadingSnapshotIds.has(fileId) ||
      this.excalidrawAPI.getFiles()[fileId as FileId]
    ) {
      return;
    }
    this.loadingSnapshotIds.add(fileId);
    try {
      const { loadedFiles } = await this.fileManager.getFiles([
        fileId as FileId,
      ]);
      const f = loadedFiles[0];
      if (f && !this.excalidrawAPI.getFiles()[fileId as FileId]) {
        this.excalidrawAPI.addFiles([
          {
            id: fileId as FileId,
            dataURL: f.dataURL,
            mimeType: f.mimeType,
            created: Date.now(),
          },
        ]);
      }
    } catch (error) {
      console.error(error);
    } finally {
      this.loadingSnapshotIds.delete(fileId);
    }
  };

  private broadcastLibraryFileSmart = async (file: MeetingFile) => {
    if (!this.isLargeLibraryFile(file)) {
      this.portal.broadcastLibraryFile(file);
      return;
    }
    // Broadcast the METADATA (incl. the small ifcMeta.thumbnail) IMMEDIATELY so
    // peers show the thumbnail at once — they don't wait for the multi-MB GLB.
    // The heavy bytes upload to R2 in the BACKGROUND; peers pull them lazily
    // (for focus/3D + reopen) via `hydrateRemoteLibraryFile`.
    this.portal.broadcastLibraryFile({ ...file, dataURL: "" });
    try {
      await this.ensureLargeLibraryFileOnR2(file);
    } catch (error) {
      console.error(error);
      // Bytes didn't reach R2. Re-send inline so peers still get the GLB for
      // focus — but ONLY if it's small enough to not blow the broadcast frame
      // (a >1 MiB frame DISCONNECTS the sender on the DO path). Bigger than
      // that → peers keep just the thumbnail. With LIBRARY_SOCKET_MAX_BYTES now
      // pinned under the DO 1 MiB cap, large files never re-flood inline.
      if (file.dataURL.length <= LIBRARY_SOCKET_MAX_BYTES) {
        this.portal.broadcastLibraryFile(file);
      }
    }
  };

  /** Called by MeetingLibrary when the local user deletes a file. Removes
   *  any canvas image elements referencing it and tells peers to do the
   *  same. */
  publishLibraryFileDelete = (fileId: string) => {
    const roomId = this.portal.roomId;
    this.removeCanvasImagesByFileId(fileId);
    clearDxfSnapshotsForFile(fileId);
    clearPdfSnapshotsForFile(fileId);
    clearIfcSnapshotsForFile(fileId);
    if (removeMeetingFile(roomId, fileId)) {
      this.portal.broadcastLibraryFileDelete(fileId);
    }
  };

  /** Called by MeetingLibrary when the local user locks/unlocks a file.
   *  `lockedBy === null` clears the lock. Also flips the matching canvas
   *  image elements' native `locked` flag so Excalidraw stops responding
   *  to drag/resize attempts on them — peers receive both the library
   *  lock event AND the element update through Excalidraw's normal
   *  sync pipeline. */
  publishLibraryFileLock = (fileId: string, lockedBy: string | null) => {
    const roomId = this.portal.roomId;
    if (setMeetingFileLock(roomId, fileId, lockedBy)) {
      this.setCanvasImagesLockedByFileId(fileId, lockedBy !== null);
      this.portal.broadcastLibraryFileLock(fileId, lockedBy);
    }
  };

  // Library files whose bytes we're currently pulling from R2 (large-file
  // path) — guards against a duplicate broadcast kicking off a second fetch.
  private hydratingLibraryFileIds = new Set<string>();

  private applyRemoteLibraryFile = (file: MeetingFile) => {
    if (isFileSeen(file.id)) {
      // Already applied. If this (re)broadcast carries the heavy bytes and our
      // entry is still metadata-only (e.g. the sender's R2 upload failed, so it
      // re-sent inline), fill the bytes in so focus/3D works.
      if (file.dataURL) {
        const existing = appJotaiStore
          .get(meetingFilesAtom)
          .find((f) => f.id === file.id);
        if (existing && !existing.dataURL) {
          this.excalidrawAPI.addFiles([
            {
              id: file.id as FileId,
              dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
              mimeType: file.mimeType as BinaryFileData["mimeType"],
              created: Date.now(),
            },
          ]);
          setMeetingFileBytes(this.portal.roomId, file.id, file.dataURL);
        }
      }
      return;
    }
    if (this.hydratingLibraryFileIds.has(file.id)) {
      return;
    }
    // Large files arrive METADATA-ONLY (dataURL stripped, bytes on R2). Apply
    // the metadata NOW — this carries ifcMeta.thumbnail, so the IFC anchor
    // shows its thumbnail immediately (the user's "realtime when done") — and
    // pull the heavy bytes (GLB) from R2 in the background for focus/3D.
    // `allowContentDup` because an empty dataURL fingerprint would otherwise
    // collide across distinct metadata-only files.
    if (!file.dataURL) {
      markFileSeen(file.id);
      upsertMeetingFile(this.portal.roomId, file, { allowContentDup: true });
      void this.hydrateRemoteLibraryFile(file);
      return;
    }
    this.applyHydratedLibraryFile(file);
  };

  private applyHydratedLibraryFile = (file: MeetingFile) => {
    markFileSeen(file.id);
    this.excalidrawAPI.addFiles([
      {
        id: file.id as FileId,
        dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
        mimeType: file.mimeType as BinaryFileData["mimeType"],
        created: Date.now(),
      },
    ]);
    upsertMeetingFile(this.portal.roomId, file);
    // upsertMeetingFile mutates meetingFilesAtom → the library subscription
    // (set up in startCollaboration) debounce-persists the whole library to
    // R2, so a reopen on any browser restores DXF/IFC/PDF source + metadata.
  };

  /** Fetch a large library file's heavy bytes (GLB) from R2 — where the sender
   *  is uploading them — and slot them into the already-applied metadata entry
   *  + the canvas file map. Retries a few times because the sender broadcasts
   *  the metadata BEFORE its background upload finishes, so the first read can
   *  404. The thumbnail is already showing from the metadata; this only enables
   *  focus/3D. */
  private hydrateRemoteLibraryFile = async (file: MeetingFile) => {
    const { roomId, roomKey } = this.portal;
    if (!roomId || !roomKey) {
      return;
    }
    this.hydratingLibraryFileIds.add(file.id);
    try {
      const backoffsMs = [0, 800, 1600, 3000];
      for (const wait of backoffsMs) {
        if (wait) {
          await new Promise((r) => setTimeout(r, wait));
        }
        if (this.portal.roomId !== roomId) {
          return;
        }
        const { loadedFiles } = await loadFilesFromFirebase(
          `files/rooms/${roomId}`,
          roomKey,
          [file.id as FileId],
        );
        const dataURL = loadedFiles[0]?.dataURL;
        if (dataURL) {
          // It's on R2 (we just read it) — don't re-PUT if we rebroadcast.
          this.storedLibraryFileIds.add(file.id);
          this.excalidrawAPI.addFiles([
            {
              id: file.id as FileId,
              dataURL: dataURL as unknown as BinaryFileData["dataURL"],
              mimeType: file.mimeType as BinaryFileData["mimeType"],
              created: Date.now(),
            },
          ]);
          setMeetingFileBytes(roomId, file.id, dataURL as string);
          return;
        }
        // Not on R2 yet — the sender's upload is still in flight; retry.
      }
    } catch (error) {
      // Gave up — the metadata (thumbnail) still shows; the R2 library load on
      // next join/reload recovers the bytes.
      console.error(error);
    } finally {
      this.hydratingLibraryFileIds.delete(file.id);
    }
  };

  private applyRemoteLibraryFileDelete = (fileId: string) => {
    this.removeCanvasImagesByFileId(fileId);
    clearDxfSnapshotsForFile(fileId);
    clearPdfSnapshotsForFile(fileId);
    clearIfcSnapshotsForFile(fileId);
    removeMeetingFile(this.portal.roomId, fileId);
  };

  private removeCanvasImagesByFileId = (fileId: string) => {
    // Use the "including deleted" set + isDeleted flag (with bumped version
    // via newElementWith) so Excalidraw broadcasts the deletion to peers
    // through its normal collab pipeline. Just filtering elements out of
    // updateScene leaves peers stuck on the old version.
    //
    // Matches plain image elements (el.fileId === fileId), DXF anchor
    // rectangles (customData.dxfFileId === fileId), PDF anchors
    // (customData.pdfFileId === fileId), and IFC anchors
    // (customData.ifcFileId === fileId). They all share a single
    // library-file id space, so deleting the file deletes every canvas
    // representation of it regardless of element type.
    const all = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    let changed = false;
    const next = all.map((el) => {
      if (el.isDeleted) {
        return el;
      }
      const data = (el as any).customData as
        | Record<string, unknown>
        | undefined;
      // PDF / DXF / IFC anchors can be rectangles (legacy) OR images
      // (post-refactor for native z-order). Match on customData so
      // both element types are covered. The plain-image branch
      // (el.fileId === fileId) still covers direct image-insert
      // cases — it skips these anchors because their customData
      // carries an mcmType, so the el.fileId there is the per-anchor
      // snapshot id, not the library id.
      const matches =
        (data?.mcmType === "dxf-anchor" && data?.dxfFileId === fileId) ||
        (data?.mcmType === "pdf-anchor" && data?.pdfFileId === fileId) ||
        (data?.mcmType === "ifc-anchor" && data?.ifcFileId === fileId) ||
        (el.type === "image" &&
          !data?.mcmType &&
          (el as any).fileId === fileId);
      if (!matches) {
        return el;
      }
      changed = true;
      return newElementWith(el, { isDeleted: true });
    });
    if (changed) {
      this.excalidrawAPI.updateScene({ elements: next });
      // bump our broadcast bookkeeping so the deletion is included in the
      // next sync
      this.syncElements(this.excalidrawAPI.getSceneElementsIncludingDeleted());
    }
  };

  /** Public element-only lock toggle for images that don't live in the
   *  meeting library (legacy paste, addFiles from outside, etc.). Just
   *  flips Excalidraw's native `locked` flag — broadcast happens via
   *  Excalidraw's own element sync. Returns true if anything changed. */
  toggleCanvasImageElementLock = (fileId: string, locked: boolean) => {
    this.setCanvasImagesLockedByFileId(fileId, locked);
  };

  /** Mirror library-file lock state onto every canvas image element
   *  that references it. Setting Excalidraw's native `locked` flag
   *  blocks drag/resize/select in the editor, and our PinnedImagesOverlay
   *  paints the 📌 badge on top — visual + functional in one pass.
   *  Broadcast through the normal sync pipeline so peers see it too. */
  private setCanvasImagesLockedByFileId = (fileId: string, locked: boolean) => {
    // Mirrors `removeCanvasImagesByFileId`'s element-kind matching:
    // image elements, DXF anchors, PDF anchors, and IFC anchors all back
    // library files and all need their `locked` flag flipped when the
    // file is (un)locked.
    const all = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    let changed = false;
    const next = all.map((el) => {
      if (el.isDeleted || el.locked === locked) {
        return el;
      }
      const data = (el as any).customData as
        | Record<string, unknown>
        | undefined;
      // PDF / DXF / IFC anchors can be rectangles (legacy) OR images
      // (post-refactor for native z-order). Match on customData so
      // both element types are covered. The plain-image branch
      // (el.fileId === fileId) still covers direct image-insert
      // cases — it skips these anchors because their customData
      // carries an mcmType, so the el.fileId there is the per-anchor
      // snapshot id, not the library id.
      const matches =
        (data?.mcmType === "dxf-anchor" && data?.dxfFileId === fileId) ||
        (data?.mcmType === "pdf-anchor" && data?.pdfFileId === fileId) ||
        (data?.mcmType === "ifc-anchor" && data?.ifcFileId === fileId) ||
        (el.type === "image" &&
          !data?.mcmType &&
          (el as any).fileId === fileId);
      if (!matches) {
        return el;
      }
      changed = true;
      return newElementWith(el, { locked });
    });
    if (changed) {
      this.excalidrawAPI.updateScene({ elements: next });
      this.syncElements(this.excalidrawAPI.getSceneElementsIncludingDeleted());
    }
  };

  /** Send all files we currently know about to a freshly-joined peer. We
   *  emit one broadcast per file so we don't blow past the per-message
   *  byte limit when libraries grow. Receivers de-dupe by fileId. */
  private broadcastLibrarySnapshot = () => {
    // Broadcasts are sealed centrally in Portal, but broadcastLibraryFileSmart
    // ALSO PUTs large-file bytes to R2 — short-circuit the whole loop in review
    // so a peer joining mid-review can't trigger a re-upload.
    if (appJotaiStore.get(meetingViewOnlyAtom)) {
      return;
    }
    const files = appJotaiStore.get(meetingFilesAtom);
    for (const f of files) {
      void this.broadcastLibraryFileSmart(f);
    }
  };

  /** Push our latest UserProfile to peers. Triggered both on new-user
   *  join (so the late-joiner learns who we are) and whenever the
   *  local user edits their profile via the settings modal. Falls back
   *  to Excalidraw's username if the profile atom hasn't been
   *  hydrated yet — that way peers still get a name even before the
   *  user opens the profile editor. */
  broadcastUserProfileSnapshot = () => {
    const profile = appJotaiStore.get(userProfileAtom);
    const username = profile?.username || this.state.username || "Guest";
    // joinedAt is a session value (set once on first broadcast and
    // reused thereafter); peers sort by it to pick the host
    // deterministically — see hostSocketIdAtom in userProfile.ts.
    const joinedAt = ensureMyJoinedAt();
    this.portal.broadcastUserProfile({
      username,
      ...(profile?.company ? { company: profile.company } : {}),
      ...(profile?.avatar ? { avatar: profile.avatar } : {}),
      ...(profile?.email ? { email: profile.email } : {}),
      joinedAt,
    });
    // Piggyback our audio state so a (late) joiner who just triggered this
    // also learns whether we're in the call + muted. Force past the dedup so
    // they get the current value even if it hasn't changed for us.
    this.broadcastAudioStateSnapshot(true);
  };

  private lastAudio: { inCall: boolean; muted: boolean } | null = null;

  /** Broadcast our own audio state (in-call + muted). Dedups against the last
   *  sent value so peer/speaking churn on audioStateAtom doesn't spam the room;
   *  pass force=true on join so a new peer gets the current value regardless. */
  broadcastAudioStateSnapshot = (force = false) => {
    if (!this.portal.socket) {
      return;
    }
    const a = appJotaiStore.get(audioStateAtom);
    const inCall = a.status === "live";
    const muted = inCall ? a.muted : false;
    if (
      !force &&
      this.lastAudio &&
      this.lastAudio.inCall === inCall &&
      this.lastAudio.muted === muted
    ) {
      return;
    }
    this.lastAudio = { inCall, muted };
    this.portal.broadcastAudioState({ inCall, muted });
  };

  /** Re-announce OUR screen-share presence so a (late) joiner who just fired
   *  "new-user" learns we're presenting. Each client only asserts its OWN
   *  state (presence model) — we read the local MEDIA truth (Daily-driven
   *  `localActive`), NOT the presence map, so we never re-broadcast on behalf
   *  of another peer. Only the sharer broadcasts; this is a no-op for everyone
   *  else, so it doesn't spam the room.
   *
   *  Idempotent: re-emitting SCREEN_SHARE(true) just re-sets the same
   *  socketId→true entry in the receiver's `screenShareStateAtom` (see
   *  `applyScreenShare`, which short-circuits when the value is unchanged) and
   *  the presence-driven `ensureJoined()` is itself de-duped — no double pane. */
  broadcastScreenShareSnapshot = () => {
    if (!this.portal.socket) {
      return;
    }
    const media = appJotaiStore.get(screenShareMediaAtom);
    if (!media.localActive) {
      return;
    }
    this.portal.broadcastScreenShare(true);
  };

  /** LEGACY host-only broadcast wrapper for RECORDING_STATE. SUPERSEDED by the
   *  DO recording lock (acquireRecordingLock / releaseRecordingLock, 06-24 #24)
   *  and no longer called by live code — the only remaining reference is the
   *  dead RecordingControls.tsx (no longer mounted; see MeetingCallControls).
   *  Kept so that file keeps type-checking; safe to delete with it. */
  publishRecordingState = (state: {
    recording: boolean;
    startedAt: number | null;
  }) => {
    const profile = appJotaiStore.get(userProfileAtom);
    const hostName = profile?.username || this.state.username || undefined;
    this.portal.broadcastRecordingState({
      recording: state.recording,
      startedAt: state.startedAt,
      ...(hostName ? { hostName } : {}),
    });
  };

  /** Resolve a recording owner's DISPLAY NAME from their authenticated email.
   *  The room DO is the lock authority but has NO database, so its `owner.name`
   *  is always null and only the EMAIL is meaningful. We map email → name from
   *  the live identities we DO know: my own profile/session, then any peer whose
   *  broadcast USER_PROFILE carried that email. Falls back to the email's
   *  local-part (e.g. "luan" from "luan@…"), then null. Pure-ish (reads atoms). */
  private resolveOwnerName = (ownerEmail: string | null): string | null => {
    if (!ownerEmail) {
      return null;
    }
    const target = ownerEmail.toLowerCase();
    // Me?
    const myEmail = (
      appJotaiStore.get(userProfileAtom)?.email ??
      appJotaiStore.get(sessionAtom)?.email
    )?.toLowerCase();
    if (myEmail && myEmail === target) {
      return (
        appJotaiStore.get(userProfileAtom)?.username ||
        appJotaiStore.get(sessionAtom)?.name ||
        this.state.username ||
        target.split("@")[0] ||
        null
      );
    }
    // A peer we've seen a profile for.
    for (const profile of appJotaiStore.get(peerProfilesAtom).values()) {
      if (profile.email?.toLowerCase() === target && profile.username) {
        return profile.username;
      }
    }
    return target.split("@")[0] || null;
  };

  /** Acquire the room's exclusive recording lock (06-24, #24). Emits
   *  `recording-acquire` and resolves on the NEXT `recording-lock` reply the DO
   *  unicasts back to us (one-shot listener), or {ok:false, owner:null} after an
   *  ~8s timeout. A re-acquire by the CURRENT owner returns ok:false with
   *  YOURSELF as owner — the caller treats `owner.email === my email` as success
   *  (I already hold it). On a successful intent-to-record we remember the
   *  session so a reconnect re-acquires the lock for the same files. */
  acquireRecordingLock = (
    sessionId: string,
    startedAt: number,
  ): Promise<{
    ok: boolean;
    owner: {
      email: string | null;
      name: string | null;
      startedAt: number | null;
      sessionId: string | null;
    } | null;
  }> => {
    const socket = this.portal.socket;
    if (!socket) {
      return Promise.resolve({ ok: false, owner: null });
    }
    // Remember intent up front so a reconnect that happens DURING the acquire
    // round-trip still re-acquires. Cleared by the caller on a failed acquire
    // (see CloudRecordingControls) and on release / recording-state:false.
    this.recordingIntent = { sessionId, startedAt };
    return new Promise((resolve) => {
      let settled = false;
      const onLock = (reply: {
        ok?: boolean;
        owner?: {
          email?: string | null;
          name?: string | null;
          startedAt?: number | null;
          sessionId?: string | null;
        } | null;
      }) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        socket.off("recording-lock", onLock);
        resolve({
          ok: !!reply?.ok,
          owner: reply?.owner
            ? {
                email: reply.owner.email ?? null,
                name: reply.owner.name ?? null,
                startedAt: reply.owner.startedAt ?? null,
                sessionId: reply.owner.sessionId ?? null,
              }
            : null,
        });
      };
      const timer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.off("recording-lock", onLock);
        resolve({ ok: false, owner: null });
      }, 8000);
      socket.on("recording-lock", onLock);
      socket.emit("recording-acquire", { sessionId, startedAt });
    });
  };

  /** Release the recording lock we hold (owner stop). Emits `recording-release`
   *  (the DO clears our attachment + broadcasts recording-state:false) and drops
   *  our re-acquire intent so a later reconnect doesn't resurrect the session. */
  releaseRecordingLock = (): void => {
    this.recordingIntent = null;
    this.portal.socket?.emit("recording-release");
  };

  /** Attach a click-through link from the currently-selected text element
   *  to the given file. If the file's image isn't on the canvas yet, we
   *  insert it next to the text first so the link target exists. */
  linkTextToFile = (file: MeetingFile, textElementId?: string) => {
    const appState = this.excalidrawAPI.getAppState();
    const all = this.excalidrawAPI.getSceneElements();
    let textEl;
    if (textElementId) {
      // explicit target (used by inline @-mention after edit ends)
      textEl = all.find((el) => el.id === textElementId && el.type === "text");
      if (!textEl) {
        // text was removed/changed before we could attach the link;
        // silently bail rather than alerting
        return;
      }
    } else {
      const selectedIds = appState.selectedElementIds || {};
      textEl = all.find((el) => selectedIds[el.id] && el.type === "text");
      if (!textEl) {
        window.alert(
          "Chọn 1 text element trên canvas trước, rồi bấm 🔗 để link tới file.",
        );
        return;
      }
    }

    let imageEl = all.find(
      (el) => el.type === "image" && (el as any).fileId === file.id,
    );

    let nextElements: any[] = [...all];

    if (!imageEl) {
      // make sure binary is in the canvas's file map
      this.excalidrawAPI.addFiles([
        {
          id: file.id as FileId,
          dataURL: file.dataURL as unknown as BinaryFileData["dataURL"],
          mimeType: file.mimeType as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      let w = file.width ?? 320;
      let h = file.height ?? 320;
      const MAX = 480;
      if (w > MAX || h > MAX) {
        const s = MAX / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
      }
      const newImg = newImageElement({
        type: "image",
        x: textEl.x + (textEl.width || 0) + 32,
        y: textEl.y,
        width: w,
        height: h,
        fileId: file.id as FileId,
        status: "saved",
      });
      imageEl = newImg as any;
      nextElements = [...nextElements, newImg];
    }

    // Build an Excalidraw element link URL — same host, same hash, with
    // ?element=<imageElementId> so the app's onLinkOpen handler scrolls
    // to that image when the text's link icon is clicked.
    const linkURL = (() => {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("element", imageEl!.id);
        return u.toString();
      } catch {
        return `?element=${imageEl!.id}`;
      }
    })();

    nextElements = nextElements.map((el) =>
      el.id === textEl.id ? newElementWith(el, { link: linkURL }) : el,
    );

    this.excalidrawAPI.updateScene({ elements: nextElements });
    this.syncElements(this.excalidrawAPI.getSceneElementsIncludingDeleted());
  };

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
