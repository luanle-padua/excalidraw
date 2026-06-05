// time constants (ms)
export const SAVE_TO_LOCAL_STORAGE_TIMEOUT = 300;
export const INITIAL_SCENE_UPDATE_TIMEOUT = 5000;
export const FILE_UPLOAD_TIMEOUT = 300;
export const LOAD_IMAGES_TIMEOUT = 500;
export const SYNC_FULL_SCENE_INTERVAL_MS = 20000;
export const SYNC_BROWSER_TABS_TIMEOUT = 50;
export const CURSOR_SYNC_TIMEOUT = 33; // ~30fps
export const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000; // 1 day

// should be aligned with MAX_ALLOWED_FILE_BYTES
export const FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024; // 30 MiB
// 1 year (https://stackoverflow.com/a/25201898/927631)
export const FILE_CACHE_MAX_AGE_SEC = 31536000;

export const WS_EVENTS = {
  SERVER_VOLATILE: "server-volatile-broadcast",
  SERVER: "server-broadcast",
  USER_FOLLOW_CHANGE: "user-follow",
  USER_FOLLOW_ROOM_CHANGE: "user-follow-room-change",
} as const;

export enum WS_SUBTYPES {
  INVALID_RESPONSE = "INVALID_RESPONSE",
  INIT = "SCENE_INIT",
  UPDATE = "SCENE_UPDATE",
  MOUSE_LOCATION = "MOUSE_LOCATION",
  IDLE_STATUS = "IDLE_STATUS",
  USER_VISIBLE_SCENE_BOUNDS = "USER_VISIBLE_SCENE_BOUNDS",
  CHAT = "CHAT",
  CHAT_REACTION = "CHAT_REACTION",
  LIBRARY_FILE = "LIBRARY_FILE",
  LIBRARY_FILE_DELETE = "LIBRARY_FILE_DELETE",
  LIBRARY_FILE_LOCK = "LIBRARY_FILE_LOCK",
  /** Toggle for the "raise hand" indicator on a participant's avatar.
   *  Sticky — receivers keep the badge until the sender broadcasts a
   *  lower (raised: false). */
  RAISE_HAND = "RAISE_HAND",
  /** Presence + single-share lock for screen sharing. The media itself
   *  flows over Daily.co; this only signals WHO is currently sharing so
   *  peers can show the badge, open the viewer, and block a second sharer.
   *  Sticky — cleared when the sharer broadcasts sharing:false or leaves. */
  SCREEN_SHARE = "SCREEN_SHARE",
  /** One-shot ephemeral emoji reaction (like Zoom's floating reactions).
   *  Receivers animate the emoji over the sender's avatar for a few
   *  seconds then drop it. */
  MEETING_REACTION = "MEETING_REACTION",
  /** Finalized speech-to-text segment from a participant. Broadcast so
   *  every peer sees subtitles for whoever's speaking. Interim
   *  hypotheses stay local to the speaker — too noisy to broadcast. */
  STT_SEGMENT = "STT_SEGMENT",
  /** User profile (display name + company + avatar) layered on top of
   *  Excalidraw's built-in Collaborator.username. Sent once on join
   *  AND on every change so late-joining peers get the latest values
   *  via the snapshot rebroadcast in `broadcastUserProfileSnapshot`. */
  USER_PROFILE = "USER_PROFILE",
  /** Host-driven meeting recording state. Broadcast every time the
   *  host flips between "recording" and "not recording" so peers can
   *  surface the red "Đang ghi âm" banner. Includes startedAt so
   *  late-joiners and re-renders compute the elapsed timer locally
   *  rather than waiting for a tick broadcast. */
  RECORDING_STATE = "RECORDING_STATE",
}

export const FIREBASE_STORAGE_PREFIXES = {
  shareLinkFiles: `/files/shareLinks`,
  collabFiles: `/files/rooms`,
};

export const ROOM_ID_BYTES = 10;

export const STORAGE_KEYS = {
  LOCAL_STORAGE_ELEMENTS: "excalidraw",
  LOCAL_STORAGE_APP_STATE: "excalidraw-state",
  LOCAL_STORAGE_COLLAB: "excalidraw-collab",
  LOCAL_STORAGE_THEME: "excalidraw-theme",
  LOCAL_STORAGE_DEBUG: "excalidraw-debug",
  VERSION_DATA_STATE: "version-dataState",
  VERSION_FILES: "version-files",

  IDB_LIBRARY: "excalidraw-library",
  IDB_TTD_CHATS: "excalidraw-ttd-chats",

  // do not use apart from migrations
  __LEGACY_LOCAL_STORAGE_LIBRARY: "excalidraw-library",
} as const;

export const COOKIES = {
  AUTH_STATE_COOKIE: "excplus-auth",
} as const;

export const isExcalidrawPlusSignedUser = document.cookie.includes(
  COOKIES.AUTH_STATE_COOKIE,
);
