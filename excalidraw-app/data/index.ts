import {
  compressData,
  decompressData,
} from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  generateEncryptionKey,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { isInvisiblySmallElement } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";
import { bytesToHexString } from "@excalidraw/common";

import type { UserIdleState } from "@excalidraw/common";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { SceneBounds } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { MakeBrand } from "@excalidraw/common/utility-types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  ROOM_ID_BYTES,
} from "../app_constants";

import { encodeFilesForUpload } from "./FileManager";
import { saveFilesToFirebase } from "./firebase";

import type { WS_SUBTYPES } from "../app_constants";

export type SyncableExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"SyncableExcalidrawElement">;

export const isSyncableElement = (
  element: OrderedExcalidrawElement,
): element is SyncableExcalidrawElement => {
  if (element.isDeleted) {
    if (element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT) {
      return true;
    }
    return false;
  }
  return !isInvisiblySmallElement(element);
};

export const getSyncableElements = (
  elements: readonly OrderedExcalidrawElement[],
) =>
  elements.filter((element) =>
    isSyncableElement(element),
  ) as SyncableExcalidrawElement[];

const BACKEND_V2_GET = import.meta.env.VITE_APP_BACKEND_V2_GET_URL;
const BACKEND_V2_POST = import.meta.env.VITE_APP_BACKEND_V2_POST_URL;

const generateRoomId = async () => {
  const buffer = new Uint8Array(ROOM_ID_BYTES);
  window.crypto.getRandomValues(buffer);
  return bytesToHexString(buffer);
};

export type EncryptedData = {
  data: ArrayBuffer;
  iv: Uint8Array;
};

export type SocketUpdateDataSource = {
  INVALID_RESPONSE: {
    type: WS_SUBTYPES.INVALID_RESPONSE;
  };
  SCENE_INIT: {
    type: WS_SUBTYPES.INIT;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  SCENE_UPDATE: {
    type: WS_SUBTYPES.UPDATE;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  MOUSE_LOCATION: {
    type: WS_SUBTYPES.MOUSE_LOCATION;
    payload: {
      socketId: SocketId;
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  USER_VISIBLE_SCENE_BOUNDS: {
    type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS;
    payload: {
      socketId: SocketId;
      username: string;
      sceneBounds: SceneBounds;
    };
  };
  IDLE_STATUS: {
    type: WS_SUBTYPES.IDLE_STATUS;
    payload: {
      socketId: SocketId;
      userState: UserIdleState;
      username: string;
    };
  };
  CHAT: {
    type: WS_SUBTYPES.CHAT;
    payload: {
      id: string;
      socketId: SocketId;
      username: string;
      text: string;
      ts: number;
      /** Optional reply pointer — set when the user replied to another
       *  message. Carries a frozen snippet so receivers can render the
       *  quote without needing the original (which may not be in their
       *  scrollback yet). */
      replyTo?: {
        id: string;
        author: string;
        snippet: string;
      };
      /** Pre-computed translations for vi/en/ko (or a subset). Sender's
       *  client calls /translate-batch on send so the message arrives at
       *  receivers with the translation already attached — eliminates
       *  per-receiver translate calls. Missing keys fall back to the
       *  legacy /translate path on the receiver. */
      translations?: Record<string, string>;
    };
  };
  CHAT_REACTION: {
    type: WS_SUBTYPES.CHAT_REACTION;
    payload: {
      messageId: string;
      emoji: string;
      reactor: SocketId;
      reactorUsername: string;
      /** "add" appends the reactor to that emoji's set, "remove"
       *  removes them — the same socketId can only be present once
       *  per emoji */
      action: "add" | "remove";
    };
  };
  LIBRARY_FILE: {
    type: WS_SUBTYPES.LIBRARY_FILE;
    payload: {
      file: {
        id: string;
        name: string;
        ts: number;
        author: string;
        mimeType: string;
        dataURL: string;
        width?: number;
        height?: number;
        lockedBy?: string | null;
      };
    };
  };
  LIBRARY_FILE_DELETE: {
    type: WS_SUBTYPES.LIBRARY_FILE_DELETE;
    payload: {
      fileId: string;
    };
  };
  LIBRARY_FILE_LOCK: {
    type: WS_SUBTYPES.LIBRARY_FILE_LOCK;
    payload: {
      fileId: string;
      lockedBy: string | null;
    };
  };
  RAISE_HAND: {
    type: WS_SUBTYPES.RAISE_HAND;
    payload: {
      socketId: SocketId;
      username: string;
      raised: boolean;
    };
  };
  MEETING_REACTION: {
    type: WS_SUBTYPES.MEETING_REACTION;
    payload: {
      id: string;
      socketId: SocketId;
      emoji: string;
      ts: number;
    };
  };
  STT_SEGMENT: {
    type: WS_SUBTYPES.STT_SEGMENT;
    payload: {
      id: string;
      socketId: SocketId;
      username: string;
      text: string;
      /** ISO 639-1 language detected by Deepgram, if available. */
      lang?: string;
      ts: number;
    };
  };
  USER_PROFILE: {
    type: WS_SUBTYPES.USER_PROFILE;
    payload: {
      socketId: SocketId;
      username: string;
      company?: string;
      /** Either `"lib:NN.png"` for a built-in gallery avatar OR a
       *  `data:image/...` URL for a user-uploaded image. Receivers
       *  treat anything else as "no avatar" and fall back to the
       *  emoji tile. */
      avatar?: string;
      /** Sender's session start timestamp (ms since epoch). Used by
       *  every peer to deterministically pick "the host" as the
       *  participant with the smallest joinedAt — see
       *  `hostSocketIdAtom` in `data/userProfile.ts`. Stays stable
       *  across re-broadcasts within the same browser session so
       *  late joiners see the same ordering as everyone else. */
      joinedAt?: number;
    };
  };
  RECORDING_STATE: {
    type: WS_SUBTYPES.RECORDING_STATE;
    payload: {
      /** Recording active (true) or just stopped (false). */
      recording: boolean;
      /** Socket id of the host that owns this recording. Receivers
       *  validate against the locally-computed host id before
       *  trusting the message — that way a stale tab whose user
       *  is no longer the host can't tell everyone they're
       *  recording. */
      hostSocketId: SocketId;
      /** Optional display name so the indicator can say
       *  "Luan đang ghi âm" without each peer looking the host up
       *  in the profile map. */
      hostName?: string;
      /** When the recording started, ms since epoch. Null when
       *  `recording === false`. Lets every peer render an elapsed
       *  timer that converges from the same baseline. */
      startedAt: number | null;
    };
  };
};

export type SocketUpdateDataIncoming =
  SocketUpdateDataSource[keyof SocketUpdateDataSource];

export type SocketUpdateData =
  SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
    _brand: "socketUpdateData";
  };

const RE_COLLAB_LINK = /^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

export const isCollaborationLink = (link: string) => {
  const hash = new URL(link).hash;
  return RE_COLLAB_LINK.test(hash);
};

export const getCollaborationLinkData = (link: string) => {
  const hash = new URL(link).hash;
  const match = hash.match(RE_COLLAB_LINK);
  if (match && match[2].length !== 22) {
    window.alert(t("alerts.invalidEncryptionKey"));
    return null;
  }
  return match ? { roomId: match[1], roomKey: match[2] } : null;
};

export const generateCollaborationLinkData = async () => {
  const roomId = await generateRoomId();
  const roomKey = await generateEncryptionKey();

  if (!roomKey) {
    throw new Error("Couldn't generate room key");
  }

  return { roomId, roomKey };
};

export const getCollaborationLink = (data: {
  roomId: string;
  roomKey: string;
}) => {
  return `${window.location.origin}${window.location.pathname}#room=${data.roomId},${data.roomKey}`;
};

/**
 * Decodes shareLink data using the legacy buffer format.
 * @deprecated
 */
const legacy_decodeFromBackend = async ({
  buffer,
  decryptionKey,
}: {
  buffer: ArrayBuffer;
  decryptionKey: string;
}) => {
  let decrypted: ArrayBuffer;

  try {
    // Buffer should contain both the IV (fixed length) and encrypted data
    const iv = buffer.slice(0, IV_LENGTH_BYTES);
    const encrypted = buffer.slice(IV_LENGTH_BYTES, buffer.byteLength);
    decrypted = await decryptData(new Uint8Array(iv), encrypted, decryptionKey);
  } catch (error: any) {
    // Fixed IV (old format, backward compatibility)
    const fixedIv = new Uint8Array(IV_LENGTH_BYTES);
    decrypted = await decryptData(fixedIv, buffer, decryptionKey);
  }

  // We need to convert the decrypted array buffer to a string
  const string = new window.TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  const data: ImportedDataState = JSON.parse(string);

  return {
    elements: data.elements || null,
    appState: data.appState || null,
  };
};

export const importFromBackend = async (
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> => {
  try {
    const response = await fetch(`${BACKEND_V2_GET}${id}`);

    if (!response.ok) {
      window.alert(t("alerts.importBackendFailed"));
      return {};
    }
    const buffer = await response.arrayBuffer();

    try {
      const { data: decodedBuffer } = await decompressData(
        new Uint8Array(buffer),
        {
          decryptionKey,
        },
      );
      const data: ImportedDataState = JSON.parse(
        new TextDecoder().decode(decodedBuffer),
      );

      return {
        elements: data.elements || null,
        appState: data.appState || null,
      };
    } catch (error: any) {
      console.warn(
        "error when decoding shareLink data using the new format:",
        error,
      );
      return legacy_decodeFromBackend({ buffer, decryptionKey });
    }
  } catch (error: any) {
    window.alert(t("alerts.importBackendFailed"));
    console.error(error);
    return {};
  }
};

type ExportToBackendResult =
  | { url: null; errorMessage: string }
  | { url: string; errorMessage: null };

export const exportToBackend = async (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): Promise<ExportToBackendResult> => {
  const encryptionKey = await generateEncryptionKey("string");

  const payload = await compressData(
    new TextEncoder().encode(
      serializeAsJSON(elements, appState, files, "database"),
    ),
    { encryptionKey },
  );

  try {
    const filesMap = new Map<FileId, BinaryFileData>();
    for (const element of elements) {
      if (isInitializedImageElement(element) && files[element.fileId]) {
        filesMap.set(element.fileId, files[element.fileId]);
      }
    }

    const filesToUpload = await encodeFilesForUpload({
      files: filesMap,
      encryptionKey,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });

    const response = await fetch(BACKEND_V2_POST, {
      method: "POST",
      body: payload.buffer,
    });
    const json = await response.json();
    if (json.id) {
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      url.hash = `json=${json.id},${encryptionKey}`;
      const urlString = url.toString();

      await saveFilesToFirebase({
        prefix: `/files/shareLinks/${json.id}`,
        files: filesToUpload,
      });

      return { url: urlString, errorMessage: null };
    } else if (json.error_class === "RequestTooLargeError") {
      return {
        url: null,
        errorMessage: t("alerts.couldNotCreateShareableLinkTooBig"),
      };
    }

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  } catch (error: any) {
    console.error(error);

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  }
};
