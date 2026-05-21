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
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
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
  setMeetingFileLock,
  upsertMeetingFile,
} from "../data/meetingLibrary";

import { fetchBatchTranslation } from "../data/translation";
import {
  liveTranscriptsAtom,
  saveTranscriptLog,
  transcriptionLogAtom,
} from "../data/transcription";

import { clearDxfSnapshotsForFile } from "../components/mcm/dxf/dxfSnapshotCache";
import { clearPdfSnapshotsForFile } from "../components/mcm/pdf/pdfSnapshotCache";

import {
  ensureMyJoinedAt,
  importUserProfileFromLocalStorage,
  markMeAsFirstInRoom,
  peerProfilesAtom,
  persistHostClaimForRoom,
  removePeerJoinedAt,
  removePeerProfile,
  resetMyJoinedAt,
  resolveAvatarUrlWithDefault,
  restoreHostClaimForRoom,
  setMySocketId,
  upsertPeerJoinedAt,
  upsertPeerProfile,
  userProfileAtom,
} from "../data/userProfile";
import { resetRoomRecording, setRoomRecording } from "../data/roomRecording";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type { TranscriptSegment } from "../data/transcription";

import type { MeetingFile } from "../data/meetingLibrary";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

/** Map of socketId → true for participants currently signaling "hand
 *  raised". Sticky until that peer broadcasts a lower (or leaves). */
export const raisedHandsAtom = atom<ReadonlyMap<string, true>>(new Map());

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
  sendMeetingReaction: CollabInstance["sendMeetingReaction"];
  removeMeetingReaction: CollabInstance["removeMeetingReaction"];
  publishSTTSegment: CollabInstance["publishSTTSegment"];
  setLocalInterimTranscript: CollabInstance["setLocalInterimTranscript"];
  clearLocalInterimTranscript: CollabInstance["clearLocalInterimTranscript"];
  publishLibraryFile: CollabInstance["publishLibraryFile"];
  publishLibraryFileDelete: CollabInstance["publishLibraryFileDelete"];
  publishLibraryFileLock: CollabInstance["publishLibraryFileLock"];
  publishRecordingState: CollabInstance["publishRecordingState"];
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
  private collaborators = new Map<SocketId, Collaborator>();

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

    // When a peer's profile arrives or changes, push the new name /
    // avatar onto their Collaborator entry so the on-canvas cursor
    // label + Excalidraw's built-in UserList refresh immediately —
    // without this they'd only update on the peer's next mouse move.
    const unsubPeerProfiles = appJotaiStore.sub(peerProfilesAtom, () => {
      const peers = appJotaiStore.get(peerProfilesAtom);
      for (const [socketId, profile] of peers) {
        // Default to a deterministic library image when the peer
        // hasn't picked an avatar — keeps Excalidraw's on-canvas
        // cursor + built-in UserList off the placeholder initials.
        const avatarUrl = resolveAvatarUrlWithDefault(profile.avatar, socketId);
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
      sendMeetingReaction: this.sendMeetingReaction,
      removeMeetingReaction: this.removeMeetingReaction,
      publishSTTSegment: this.publishSTTSegment,
      setLocalInterimTranscript: this.setLocalInterimTranscript,
      clearLocalInterimTranscript: this.clearLocalInterimTranscript,
      publishLibraryFile: this.publishLibraryFile,
      publishLibraryFileDelete: this.publishLibraryFileDelete,
      publishLibraryFileLock: this.publishLibraryFileLock,
      publishRecordingState: this.publishRecordingState,
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
    syncableElements = cloneJSON(syncableElements);
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (this.isCollaborating() && storedElements) {
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

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
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
  ) => {
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

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

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
      // In tunnel mode, ignore VITE_APP_WS_SERVER_URL (which still defaults to
      // localhost:3002 via .env.development) and connect to current origin so
      // socket.io requests get proxied through the tunnel back to the room.
      const tunnelMode = import.meta.env.VITE_DEV_TUNNEL === "true";
      const wsServerUrl = tunnelMode
        ? ""
        : import.meta.env.VITE_APP_WS_SERVER_URL;
      const wsOptions = { transports: ["websocket", "polling"] };
      const socket = wsServerUrl
        ? socketIOClient(wsServerUrl, wsOptions)
        : socketIOClient(wsOptions);
      this.portal.socket = this.portal.open(socket, roomId, roomKey);

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

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    if (existingRoomLinkData) {
      // when joining existing room, don't merge it with current scene data
      this.excalidrawAPI.resetScene();
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
            // Always send a real image URL — falls back to a library
            // avatar deterministic from socketId when no profile has
            // arrived yet, so the on-canvas cursor never shows the
            // default initials placeholder.
            const avatarUrl = resolveAvatarUrlWithDefault(
              profile?.avatar,
              socketId,
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

          case WS_SUBTYPES.MEETING_REACTION: {
            this.applyMeetingReaction(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.STT_SEGMENT: {
            this.applySTTSegment(decryptedData.payload);
            break;
          }

          case WS_SUBTYPES.USER_PROFILE: {
            const { socketId, username, company, avatar, joinedAt } =
              decryptedData.payload;
            upsertPeerProfile(socketId, {
              username,
              ...(company ? { company } : {}),
              ...(avatar ? { avatar } : {}),
            });
            if (typeof joinedAt === "number" && Number.isFinite(joinedAt)) {
              upsertPeerJoinedAt(socketId, joinedAt);
            }
            break;
          }

          case WS_SUBTYPES.RECORDING_STATE: {
            // Trust the message blindly — the host id check is done at
            // RENDER time against `hostSocketIdAtom` so a late-arriving
            // late-joiner who hasn't seen the host's USER_PROFILE yet
            // still gets the banner once the host id resolves locally.
            const { recording, hostSocketId, hostName, startedAt } =
              decryptedData.payload;
            setRoomRecording({
              recording,
              hostSocketId,
              hostName: hostName ?? null,
              startedAt: startedAt ?? null,
            });
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

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
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

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: socketId === this.portal.socket?.id,
        }),
      );
    }
    this.collaborators = collaborators;
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
      }
    }
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
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

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);
    this.queueSaveToFirebase();
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

    // Persist by roomId so the log survives reload.
    const roomId = this.portal.roomId;
    if (roomId) {
      saveTranscriptLog(roomId, next);
    }
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
    this.portal.broadcastLibraryFile(file);
  };

  /** Called by MeetingLibrary when the local user deletes a file. Removes
   *  any canvas image elements referencing it and tells peers to do the
   *  same. */
  publishLibraryFileDelete = (fileId: string) => {
    const roomId = this.portal.roomId;
    this.removeCanvasImagesByFileId(fileId);
    clearDxfSnapshotsForFile(fileId);
    clearPdfSnapshotsForFile(fileId);
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

  private applyRemoteLibraryFile = (file: MeetingFile) => {
    if (isFileSeen(file.id)) {
      return;
    }
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
  };

  private applyRemoteLibraryFileDelete = (fileId: string) => {
    this.removeCanvasImagesByFileId(fileId);
    clearDxfSnapshotsForFile(fileId);
    clearPdfSnapshotsForFile(fileId);
    removeMeetingFile(this.portal.roomId, fileId);
  };

  private removeCanvasImagesByFileId = (fileId: string) => {
    // Use the "including deleted" set + isDeleted flag (with bumped version
    // via newElementWith) so Excalidraw broadcasts the deletion to peers
    // through its normal collab pipeline. Just filtering elements out of
    // updateScene leaves peers stuck on the old version.
    //
    // Matches plain image elements (el.fileId === fileId), DXF anchor
    // rectangles (customData.dxfFileId === fileId), and PDF anchor
    // rectangles (customData.pdfFileId === fileId). All three share a
    // single library-file id space, so deleting the file deletes every
    // canvas representation of it regardless of element type.
    const all = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    let changed = false;
    const next = all.map((el) => {
      if (el.isDeleted) {
        return el;
      }
      const data = (el as any).customData as
        | Record<string, unknown>
        | undefined;
      // PDF / DXF anchors can be EITHER rectangles (legacy) OR images
      // (post-refactor for native z-order). Match on customData so
      // both element types are covered. The plain-image branch
      // (el.fileId === fileId) still covers direct image-insert
      // cases — it skips PDF/DXF anchors because their customData
      // carries an mcmType, so the el.fileId there is the per-anchor
      // snapshot id, not the library id.
      const matches =
        (data?.mcmType === "dxf-anchor" && data?.dxfFileId === fileId) ||
        (data?.mcmType === "pdf-anchor" && data?.pdfFileId === fileId) ||
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
    // image elements, DXF anchors, and PDF anchors all back library
    // files and all need their `locked` flag flipped when the file is
    // (un)locked.
    const all = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    let changed = false;
    const next = all.map((el) => {
      if (el.isDeleted || el.locked === locked) {
        return el;
      }
      const data = (el as any).customData as
        | Record<string, unknown>
        | undefined;
      // PDF / DXF anchors can be EITHER rectangles (legacy) OR images
      // (post-refactor for native z-order). Match on customData so
      // both element types are covered. The plain-image branch
      // (el.fileId === fileId) still covers direct image-insert
      // cases — it skips PDF/DXF anchors because their customData
      // carries an mcmType, so the el.fileId there is the per-anchor
      // snapshot id, not the library id.
      const matches =
        (data?.mcmType === "dxf-anchor" && data?.dxfFileId === fileId) ||
        (data?.mcmType === "pdf-anchor" && data?.pdfFileId === fileId) ||
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
    const files = appJotaiStore.get(meetingFilesAtom);
    for (const f of files) {
      this.portal.broadcastLibraryFile(f);
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
      joinedAt,
    });
  };

  /** Host-only broadcast wrapper for RECORDING_STATE. Called by the
   *  RecordingControls component on start / stop. We do NOT check
   *  hostship here — that's the UI layer's responsibility (only the
   *  host's UI exposes the button); if some other peer tried to call
   *  this, every receiver still validates by comparing `hostSocketId`
   *  against their locally-computed `hostSocketIdAtom`. */
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
