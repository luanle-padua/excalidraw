// Live speech-to-text panel — bottom-left overlay on the canvas.
//
// Reads two atoms from data/transcription.ts:
//   • transcriptionLogAtom   — finalized segments, append-only.
//   • liveTranscriptsAtom    — per-speaker interim line. Replaces
//                              itself as Deepgram refines.
//
// Each row is anchored to a participant (matched by socketId) so the
// speaker label colour comes from the same deterministic gradient as
// the avatar in the ParticipantsBar — easy "this person said that"
// recognition.
//
// Dev affordance: an upload-file path that feeds an audio file
// through an offline STTSession (no mic / no peer broadcast — useful
// for testing Deepgram without joining a real call).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { STTSession } from "../../audio/sttSession";
import { collabAPIAtom, meetingViewOnlyAtom } from "../../collab/Collab";
import {
  STT_PROVIDERS,
  fmtPerMinute,
  providerMeta,
  setSttProvider,
  sttProviderAtom,
} from "../../data/sttProviders";
import {
  SPOKEN_LANGUAGES,
  liveTranscriptsAtom,
  setSttEnabled,
  setSttPanelStyle,
  setSttSpokenLanguage,
  setSttTranslateEnabled,
  sttCapturingAtom,
  sttEnabledAtom,
  sttLiveErrorAtom,
  sttPanelStyleAtom,
  sttSpokenLanguageAtom,
  sttTranslateEnabledAtom,
  transcriptionLogAtom,
} from "../../data/transcription";
import { preferredLanguageAtom, useTranslate } from "../../data/translation";
import { peerProfilesAtom, userProfileAtom } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { MCMAvatar } from "./Avatar";
import { shortDisplayName } from "./animalEmoji";

import type { STTLang, STTProvider } from "../../audio/sttSession";
import type { TranscriptSegment } from "../../data/transcription";
import type { SupportedLanguage } from "../../data/translation";

// localStorage key for the user's last drag position of the panel.
// Stored as `{ x: number, y: number }` — the translate offset from
// the SCSS default anchor (left:20, bottom:--mcm-bar-clearance).
const DRAG_POS_LS_KEY = "mcm:sttPanelPos";

// localStorage key for the user's last size of the panel, stored as
// `{ w: number, h: number }`. Native CSS `resize: both` behaves
// incorrectly here because the panel is anchored by `bottom` (not
// `top`), so the browser's resize math inverts vertically. We drive
// a custom corner handle instead and clamp against the same bounds
// that used to live in SCSS as min/max-width/height.
const SIZE_LS_KEY = "mcm:sttPanelSize";
const SIZE_MIN_W = 320;
const SIZE_MIN_H = 220;
const SIZE_MAX_W_CAP = 900;

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="14"
    height="14"
  >
    <path d={d} />
  </svg>
);

// Deterministic gradient for the speaker name colour. Mirrors the
// algorithm in ParticipantsBar/avatar — same socketId yields the
// same colour everywhere in the UI.
const PALETTE: [string, string][] = [
  ["#34d399", "#0ea5e9"],
  ["#f472b6", "#ef4444"],
  ["#fbbf24", "#f97316"],
  ["#60a5fa", "#6366f1"],
  ["#a78bfa", "#ec4899"],
  ["#22d3ee", "#3b82f6"],
  ["#fb7185", "#f59e0b"],
  ["#84cc16", "#10b981"],
];
const colorFor = (key: string): string => {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length][0];
};

// Native display names for the "language I speak" options. These are the
// languages themselves, so they're shown in their own script regardless of the
// app UI language (an English-UI user picking Korean still sees "한국어").
const SPOKEN_LANG_NAMES: Record<STTLang, string> = {
  en: "English",
  ko: "한국어",
  vi: "Tiếng Việt",
  ja: "日本語",
  zh: "中文",
  multi: "multi",
};

const formatClockTime = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
};

// ----- Segment row -------------------------------------------------
// One finalized segment in the transcript list. Pulled into its own
// component so each can run a `useTranslate` hook safely (you can't
// call hooks inside .map of the parent). When translation is enabled
// and the segment's detected language differs from the viewer's
// preferred language, an italic em-dash row appears below the
// original — same visual language as the chat translation.
const SegmentRow = ({
  seg,
  translateEnabled,
  compact = false,
}: {
  seg: TranscriptSegment;
  translateEnabled: boolean;
  /** Compact mode drops the avatar + language chip and tightens spacing
   *  so the row sips vertical space; the speaker colour + translation are
   *  kept (they're the load-bearing "who said what, in my language" cues). */
  compact?: boolean;
}) => {
  const t = useT();
  // `assumedSource` lets useTranslate short-circuit when Deepgram's
  // detected language already matches the viewer's preferred — no
  // pointless "translate Korean to Korean" round-trip.
  const { translated, isSameLanguage, loading } = useTranslate(seg.text, {
    assumedSource: seg.lang as SupportedLanguage | undefined,
  });
  const showTranslation = translateEnabled && !isSameLanguage;
  // Resolve the speaker's profile so the line carries their actual
  // chosen avatar + display name instead of the deterministic animal
  // emoji + raw socket username. Self reads its own profile atom
  // directly; everyone else falls back to whatever we last received
  // via USER_PROFILE.
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const selfSocketId = useAtomValue(collabAPIAtom)?.portal.socket?.id;
  const speakerProfile =
    seg.socketId === selfSocketId
      ? myProfile ?? undefined
      : peerProfiles.get(seg.socketId);
  const speakerName = speakerProfile?.username || seg.username;
  const shortName = shortDisplayName(speakerName);
  return (
    <div className={`mcm-stt__line${compact ? " mcm-stt__line--compact" : ""}`}>
      <div className="mcm-stt__line-head">
        {!compact && (
          <MCMAvatar
            className="mcm-stt__line-avatar"
            avatar={speakerProfile?.avatar}
            name={speakerName}
            email={speakerProfile?.email}
            identityKey={speakerProfile?.email ?? seg.socketId}
          />
        )}
        <span
          className="mcm-stt__line-spk"
          // per-speaker colour from the same palette as avatars
          // eslint-disable-next-line react/forbid-dom-props
          style={{ color: colorFor(seg.socketId) }}
        >
          {shortName}
        </span>
        <span className="mcm-stt__line-at">{formatClockTime(seg.ts)}</span>
        {!compact && seg.lang && (
          <span className="mcm-stt__line-lang">{seg.lang}</span>
        )}
      </div>
      <div className="mcm-stt__line-orig">{seg.text}</div>
      {showTranslation && (
        <div className="mcm-stt__line-trans">
          — {loading ? t("stt.translating") : translated}
        </div>
      )}
    </div>
  );
};

/** Live transcript row for the speaker's INTERIM (still-in-flight)
 *  hypothesis. Almost identical to SegmentRow's header but without
 *  the translate plumbing, and the speaker is usually the local user
 *  (their own audio being recognised by Deepgram in real time). */
const InterimLine = ({
  entry,
  compact = false,
}: {
  entry: { socketId: string; username: string; text: string };
  compact?: boolean;
}) => {
  const t = useT();
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const selfSocketId = useAtomValue(collabAPIAtom)?.portal.socket?.id;
  const speakerProfile =
    entry.socketId === selfSocketId
      ? myProfile ?? undefined
      : peerProfiles.get(entry.socketId);
  const name = speakerProfile?.username || entry.username;
  return (
    <div
      className={`mcm-stt__line mcm-stt__line--interim${
        compact ? " mcm-stt__line--compact" : ""
      }`}
    >
      <div className="mcm-stt__line-head">
        {!compact && (
          <MCMAvatar
            className="mcm-stt__line-avatar"
            avatar={speakerProfile?.avatar}
            name={name}
            email={speakerProfile?.email}
            identityKey={speakerProfile?.email ?? entry.socketId}
          />
        )}
        <span
          className="mcm-stt__line-spk"
          // eslint-disable-next-line react/forbid-dom-props
          style={{ color: colorFor(entry.socketId) }}
        >
          {shortDisplayName(name)}
        </span>
        <span className="mcm-stt__line-at">{t("stt.speakingNow")}</span>
      </div>
      <div className="mcm-stt__line-orig">{entry.text}</div>
    </div>
  );
};

export const SpeechToTextPanel = () => {
  const t = useT();
  // Start collapsed — the live transcript can be noisy and we don't
  // want it covering the canvas on first load. User opens it via the
  // floating "Live transcript" pill.
  const [open, setOpen] = useState(false);
  const sttLiveError = useAtomValue(sttLiveErrorAtom);
  // Ground-truth "mic is actually being captured into STT" — true only while PCM
  // is flowing (AudioRoomController drives it off STTSession.onCapture). Lets the
  // status pill distinguish a genuinely-live session from one that's enabled but
  // silent (suspended context / dead mic-clone on iPad).
  const sttCapturing = useAtomValue(sttCapturingAtom);
  const [sttEnabled, setSttEnabledState] = useAtom(sttEnabledAtom);
  const [translateEnabled, setTranslateEnabledState] = useAtom(
    sttTranslateEnabledAtom,
  );
  // Per-session STT provider for A/B testing. Default deepgram. Persisted per
  // device; AudioRoomController restarts the live mic session on change.
  const [sttProvider, setSttProviderState] = useAtom(sttProviderAtom);
  // Language the LOCAL user speaks — drives what Deepgram transcribes their mic
  // in, independent of the app UI language. Defaults to the UI preferred
  // language until the user picks one; AudioRoomController restarts the live
  // session on change.
  const [spokenLang, setSpokenLangState] = useAtom(sttSpokenLanguageAtom);
  // Panel chrome density: "full" (scrollable history) vs "compact" (only the
  // newest few lines, trimmed chrome). Persisted per device like the other STT
  // prefs so the user's choice survives reloads.
  const [panelDensity, setPanelDensityState] = useAtom(sttPanelStyleAtom);
  const compact = panelDensity === "compact";
  const preferredLang = useAtomValue(preferredLanguageAtom);
  const log = useAtomValue(transcriptionLogAtom);
  const interims = useAtomValue(liveTranscriptsAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Combined feed: finalized segments + per-speaker interim lines
  // appended at the end. Interims render italic and refresh in place
  // as Deepgram emits hypotheses.
  const interimEntries = useMemo(() => Object.values(interims), [interims]);
  // Concatenated interim text — a cheap dependency that changes whenever
  // ANY in-flight hypothesis grows, even when the number of interim rows
  // stays the same. Used to re-pin auto-scroll as a live sentence streams.
  const lastInterimText = useMemo(
    () => interimEntries.map((e) => e.text).join(""),
    [interimEntries],
  );

  // Compact mode renders only the newest few finalised segments so the
  // card stays small on the canvas. Full mode renders the entire log.
  // Auto-scroll still applies to the slice (a long single line can
  // overflow, and a fresh interim must pin to bottom).
  const COMPACT_VISIBLE_SEGMENTS = 3;
  const visibleLog = useMemo(
    () => (compact ? log.slice(-COMPACT_VISIBLE_SEGMENTS) : log),
    [compact, log],
  );

  // ----- auto-scroll (chat-style "stick to bottom") ----------------
  // Standard transcript/chat behaviour: keep the newest line in view as
  // segments/interims stream in, but DON'T yank the user down if they
  // scrolled up to read history.
  //
  // We track stickiness as a ref (not state) so reading it inside the
  // layout effect never lags behind a render. `onScroll` flips it the
  // instant the user moves away from the bottom; the layout effect only
  // pins to bottom while it's true. The decision is therefore made from
  // the user's LAST scroll position — independent of the content height
  // change that triggered the effect — which is what makes "I scrolled
  // up, leave me alone" reliable.
  const stickToBottomRef = useRef(true);
  // Distance (px) from the bottom still treated as "at the bottom". A
  // little slack absorbs sub-pixel rounding and the height jump of a
  // freshly-appended line so normal streaming stays glued.
  const NEAR_BOTTOM_PX = 60;

  const handleLinesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  // useLayoutEffect (not useEffect) so the scroll correction is applied
  // before the browser paints — no visible flash of the list sitting one
  // line short of the bottom when new content lands.
  useLayoutEffect(() => {
    if (!open || !scrollRef.current || !stickToBottomRef.current) {
      return;
    }
    const el = scrollRef.current;
    el.scrollTop = el.scrollHeight;
    // Re-running on the textual content of the latest interim (not just
    // its count) keeps us pinned while a single in-flight hypothesis
    // grows word-by-word — otherwise the list would only re-stick when a
    // NEW interim row appeared, letting long live sentences drift.
  }, [open, log.length, interimEntries.length, lastInterimText]);

  // Re-arm stickiness every time the panel is (re)opened so the user
  // always lands on the newest line — a fresh look at a transcript
  // should show the latest, not wherever they happened to leave the
  // scroll the previous time they peeked.
  useEffect(() => {
    if (open) {
      stickToBottomRef.current = true;
    }
  }, [open]);

  // ----- file-upload test path -------------------------------------
  // Spin up an offline STTSession from a picked audio file. Outputs
  // are pushed straight to the local log atom (not broadcast — we
  // don't pretend to be another participant). Useful for verifying
  // Deepgram quality / language detection without joining a call.
  //
  // Concurrency model: only ONE test runs at a time. Picking a new
  // file while another is in flight cancels the first. The previous
  // file's `source.onended` (which fires up to 1.5s later as a
  // grace window for Deepgram to flush) is gated by session/ctx
  // identity checks so it can't kill the new run.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const testSessionRef = useRef<STTSession | null>(null);
  const testFileCtxRef = useRef<AudioContext | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [testError, setTestError] = useState<string | null>(null);

  // ----- free-drag (header grab handle) ----------------------------
  // Panel anchors at its SCSS default position (left:20, bottom:--clearance)
  // when `pos` is null. The FIRST user interaction (drag OR resize)
  // captures the current bounding rect and switches the panel to
  // top/left absolute positioning (with bottom:auto). This is what
  // makes resize feel correct: the TOP edge stays pinned where the
  // user grabbed it, so dragging the bottom-right corner extends the
  // panel downward instead of inverting.
  //
  // Persisted across sessions via localStorage so power users get the
  // panel back where they left it.
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    baseTop: number;
    baseLeft: number;
  } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(DRAG_POS_LS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.top === "number" &&
        typeof parsed.left === "number"
      ) {
        return parsed;
      }
      // Legacy translate-offset format ({x, y}) from an older build —
      // ignore so we fall back cleanly to the SCSS default.
    } catch {
      // ignore parse / storage errors — fall back to default position
    }
    return null;
  });

  // Snapshot the panel's current screen position and pin it via
  // top/left so subsequent moves/resizes don't fight the bottom anchor.
  // Returns the position used (the freshly-read rect, NOT a stale
  // `pos` from state).
  const ensurePinnedPosition = (): { top: number; left: number } | null => {
    if (pos) {
      return pos;
    }
    if (!panelRef.current) {
      return null;
    }
    const rect = panelRef.current.getBoundingClientRect();
    const next = { top: rect.top, left: rect.left };
    setPos(next);
    return next;
  };

  // Header drag handlers. Pointer capture keeps move events flowing
  // even when the cursor briefly leaves the header (e.g. when dragging
  // fast). Clicks that originate on buttons (× close, toggles) are
  // skipped via the closest("button") check so they don't start a drag.
  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest("button")) {
      return;
    }
    const base = ensurePinnedPosition();
    if (!base) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseTop: base.top,
      baseLeft: base.left,
    };
  };

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    const { startClientX, startClientY, baseTop, baseLeft } = dragRef.current;
    setPos({
      top: baseTop + (e.clientY - startClientY),
      left: baseLeft + (e.clientX - startClientX),
    });
  };

  const handleHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    // Soft clamp: ensure the header bar is still grabbable after the
    // drag ends — at least 80px of the panel must remain inside the
    // viewport on every side so the user can always grab it again.
    if (panelRef.current && pos) {
      const rect = panelRef.current.getBoundingClientRect();
      const MIN_VISIBLE = 80;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let { top, left } = pos;
      if (rect.right < MIN_VISIBLE) {
        left += MIN_VISIBLE - rect.right;
      } else if (rect.left > vw - MIN_VISIBLE) {
        left -= rect.left - (vw - MIN_VISIBLE);
      }
      if (rect.top < 0) {
        top -= rect.top;
      } else if (rect.top > vh - MIN_VISIBLE) {
        top -= rect.top - (vh - MIN_VISIBLE);
      }
      const clamped = { top, left };
      if (clamped.top !== pos.top || clamped.left !== pos.left) {
        setPos(clamped);
        try {
          window.localStorage.setItem(DRAG_POS_LS_KEY, JSON.stringify(clamped));
        } catch {
          // ignore
        }
        return;
      }
    }
    try {
      window.localStorage.setItem(DRAG_POS_LS_KEY, JSON.stringify(pos));
    } catch {
      // ignore
    }
  };

  // Double-click on the header resets the panel back to the default
  // bottom-left position AND default size — quick rescue if it ends up
  // somewhere awkward or oversized.
  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest("button")) {
      return;
    }
    if (pos || size) {
      setPos(null);
      setSize(null);
      try {
        window.localStorage.removeItem(DRAG_POS_LS_KEY);
        window.localStorage.removeItem(SIZE_LS_KEY);
      } catch {
        // ignore
      }
    }
  };

  // ----- custom resize (bottom-right corner handle) ----------------
  // We replace the native CSS `resize: both` because that primitive
  // assumes top/left-anchored elements: with our `bottom`-anchored
  // panel, the browser's height math inverts vertically. Our handle
  // simply tracks pointer delta and applies it to width/height with
  // the same min/max bounds that used to live in SCSS.
  const resizeRef = useRef<{
    startClientX: number;
    startClientY: number;
    baseW: number;
    baseH: number;
  } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(SIZE_LS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.w === "number" &&
        typeof parsed.h === "number"
      ) {
        return parsed;
      }
    } catch {
      // ignore
    }
    return null;
  });

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !panelRef.current) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // Pin the panel's current top/left BEFORE changing size — without
    // this, the panel is still bottom-anchored and growing the height
    // would push the top edge up instead of extending the bottom edge
    // downward (the inversion the user reported).
    ensurePinnedPosition();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = panelRef.current.getBoundingClientRect();
    resizeRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseW: rect.width,
      baseH: rect.height,
    };
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    const { startClientX, startClientY, baseW, baseH } = resizeRef.current;
    const maxW = Math.min(SIZE_MAX_W_CAP, window.innerWidth - 40);
    const maxH = window.innerHeight - 180;
    setSize({
      w: Math.max(
        SIZE_MIN_W,
        Math.min(maxW, baseW + (e.clientX - startClientX)),
      ),
      h: Math.max(
        SIZE_MIN_H,
        Math.min(maxH, baseH + (e.clientY - startClientY)),
      ),
    });
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    resizeRef.current = null;
    if (size) {
      try {
        window.localStorage.setItem(SIZE_LS_KEY, JSON.stringify(size));
      } catch {
        // ignore
      }
    }
  };

  const stopTestSession = async () => {
    const session = testSessionRef.current;
    const fileCtx = testFileCtxRef.current;
    testSessionRef.current = null;
    testFileCtxRef.current = null;
    if (session) {
      await session.stop();
    }
    if (fileCtx && fileCtx.state !== "closed") {
      try {
        await fileCtx.close();
      } catch {
        // already closing — ignore
      }
    }
    setTestStatus("idle");
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file later
    if (!file) {
      return;
    }
    await stopTestSession();
    setTestError(null);
    setTestStatus("running");

    let fileCtx: AudioContext | null = null;
    try {
      // Decode the audio file in a temporary AudioContext, then route
      // the decoded buffer through a MediaStreamDestination so we get
      // a MediaStream the STTSession can consume just like a mic
      // stream. Playback happens at real time so transcripts arrive at
      // the same pace as a live talker.
      fileCtx = new AudioContext();
      testFileCtxRef.current = fileCtx;
      const arrayBuf = await file.arrayBuffer();
      const decoded = await fileCtx.decodeAudioData(arrayBuf);
      const source = fileCtx.createBufferSource();
      source.buffer = decoded;
      const destination = fileCtx.createMediaStreamDestination();
      source.connect(destination);
      // Wire speakers up front — connecting after .start() works but
      // doing it now keeps the graph fully built before playback.
      source.connect(fileCtx.destination);

      // Defer source.start() until Deepgram is actually ready to
      // accept audio. Otherwise the first 200-700ms of the file
      // (during WS open + worklet load) goes into a closed pipe and
      // the opening words of the recording silently vanish. This
      // race is invisible for the live-mic path because the mic
      // stream is continuous — there's no "start" frame to lose.
      let playbackStarted = false;
      const startPlayback = () => {
        if (playbackStarted) {
          return;
        }
        playbackStarted = true;
        try {
          source.start();
        } catch {
          // Already started — rare race; safe to ignore.
        }
      };

      const lang: STTLang = (preferredLang ?? "multi") as STTLang;
      const session = new STTSession({
        lang,
        meetingId: collabAPI?.portal.roomId ?? undefined,
        provider: sttProvider,
        onReady: () => {
          // Server signalled Deepgram upstream is open. Now safe to
          // pump audio.
          startPlayback();
        },
        onInterim: (text) => {
          collabAPI?.setLocalInterimTranscript(`(test) ${text}`);
        },
        onFinal: (text, ts) => {
          // Publish the segment so the local log atom records it. If
          // we're in a real room, peers also see it — that's fine, it
          // makes the test visible to teammates watching.
          collabAPI?.publishSTTSegment({ text, lang, ts });
        },
        onError: (msg) => {
          setTestError(msg);
          setTestStatus("error");
        },
      });
      testSessionRef.current = session;
      await session.start(destination.stream);

      // Safety net: if `ready` never fires (server doesn't send it,
      // or DEEPGRAM_API_KEY missing → server-closed WS), still play
      // the audio after 2s so the user hears their file. STT just
      // won't capture in that case — which the empty transcript
      // will make obvious.
      window.setTimeout(startPlayback, 2000);

      // Capture local handles so the closure doesn't accidentally
      // tear down a NEXT test that the user might have started
      // before this file's grace window elapsed.
      const mySession = session;
      const myFileCtx = fileCtx;
      source.onended = () => {
        window.setTimeout(() => {
          // Only act if this test is still the active one — if the
          // user uploaded another file in the meantime, the refs
          // already point at that newer session.
          if (
            testSessionRef.current !== mySession ||
            testFileCtxRef.current !== myFileCtx
          ) {
            return;
          }
          void stopTestSession();
        }, 1500);
      };
    } catch (err) {
      setTestError((err as Error)?.message ?? "Test failed");
      setTestStatus("error");
      // Make sure the half-built fileCtx is closed even if we never
      // reached the point of starting the STTSession.
      if (fileCtx && testFileCtxRef.current === fileCtx) {
        testFileCtxRef.current = null;
        try {
          await fileCtx.close();
        } catch {
          /* ignore */
        }
      }
      await stopTestSession();
    }
  };

  useEffect(() => {
    return () => {
      void stopTestSession();
    };
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        className="mcm-stt-show"
        onClick={() => setOpen(true)}
        title={t("stt.title")}
      >
        <Icon d="M3 18v-1a4 4 0 014-4h.5a4.5 4.5 0 100-9H7 M19 18v-1a4 4 0 00-4-4h-.5a4.5 4.5 0 110-9H15" />
        {t("stt.showButton")}
        {(log.length > 0 || interimEntries.length > 0) && (
          <span className="mcm-stt-show__count">{log.length}</span>
        )}
      </button>
    );
  }

  // Status badge state — single source of truth for the pill that anchors the
  // panel's identity row. The LIVE case splits in two by ground-truth capture:
  //   • capturing  → PCM is genuinely flowing → "Live" + pulsing dot & level bars
  //   • no-audio   → enabled but no PCM in the last ~2s → amber "No audio" warning
  // This is the diagnostic the PM needs on iPad: "enabled" alone never proved the
  // mic was actually reaching STT; only the capture heartbeat does.
  const status: {
    label: string;
    tone: "live" | "test" | "paused" | "error" | "noaudio";
  } =
    testStatus === "running"
      ? { label: t("stt.statusTest"), tone: "test" }
      : testStatus === "error"
      ? { label: t("stt.statusError"), tone: "error" }
      : sttEnabled
      ? sttCapturing
        ? { label: t("stt.statusCapturing"), tone: "live" }
        : { label: t("stt.statusNoAudio"), tone: "noaudio" }
      : { label: t("stt.statusPaused"), tone: "paused" };

  // Inline overrides for the user's pinned position + custom size.
  // The SCSS default (left:20, bottom:--clearance, 460×380) applies
  // until the FIRST interaction; thereafter `pos` switches the panel
  // to top/left-anchored so resize behaves intuitively (top fixed,
  // bottom extends).
  const panelStyle: React.CSSProperties | undefined =
    pos || size
      ? {
          ...(pos && {
            top: `${pos.top}px`,
            left: `${pos.left}px`,
            bottom: "auto",
          }),
          ...(size && { width: `${size.w}px`, height: `${size.h}px` }),
        }
      : undefined;

  return (
    <aside
      className={`mcm-stt${compact ? " mcm-stt--compact" : ""}`}
      aria-label={t("stt.title")}
      ref={panelRef}
      // eslint-disable-next-line react/forbid-dom-props
      style={panelStyle}
    >
      {/* Row 1 — identity + status + close. Always single-line.
            Also doubles as the drag handle (header bar) so the user
            can move the panel anywhere on the canvas. Double-click
            resets to the default bottom-left position. */}
      <div
        className="mcm-stt__header"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
        onPointerCancel={handleHeaderPointerUp}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="mcm-stt__title">
          <Icon d="M3 18v-1a4 4 0 014-4h.5a4.5 4.5 0 100-9H7 M19 18v-1a4 4 0 00-4-4h-.5a4.5 4.5 0 110-9H15" />
          <span>{t("stt.title")}</span>
        </div>
        <span
          className={`mcm-stt__status mcm-stt__status--${status.tone}`}
          aria-live="polite"
        >
          {status.tone === "live" && (
            // Live + actually capturing: pulsing dot beside a trio of mini level
            // bars that ripple — a calm, glass-y "your mic IS being heard" cue.
            <span className="mcm-stt__status-meter" aria-hidden="true">
              <span className="mcm-stt__status-dot" />
              <span className="mcm-stt__status-bars">
                <span />
                <span />
                <span />
              </span>
            </span>
          )}
          {status.tone === "noaudio" && (
            // Enabled but nothing reaching STT: hollow amber ring (no fill, no
            // pulse) — visually "waiting / not hearing" rather than "live".
            <span className="mcm-stt__status-dot--hollow" aria-hidden="true" />
          )}
          {status.label}
        </span>
        {/* Full ↔ Compact density toggle. Compact keeps only the newest
            ~3 lines + trimmed chrome so the panel barely covers the
            canvas. Glass-Desk pill, mirrors the controls-row toggles.
            It's a <button> so the header-drag handler skips it (the
            closest("button") guard in handleHeaderPointerDown). */}
        <button
          type="button"
          className={`mcm-stt__style-toggle${
            compact ? " mcm-stt__style-toggle--compact" : ""
          }`}
          onClick={() => {
            const next = compact ? "full" : "compact";
            setPanelDensityState(next);
            setSttPanelStyle(next);
          }}
          title={
            compact
              ? t("stt.styleToggleToFullTitle")
              : t("stt.styleToggleToCompactTitle")
          }
        >
          {compact ? t("stt.styleFull") : t("stt.styleCompact")}
        </button>
        <button
          type="button"
          className="mcm-stt__hide"
          onClick={() => setOpen(false)}
          aria-label={t("stt.hideAria")}
          title={t("stt.hideTitle")}
        >
          ×
        </button>
      </div>

      {/* Row 2 — controls. Wraps to 2 lines on very narrow widths.
          In review the transcript is a HISTORY view: no live-STT toggle, no
          test-file ingest — those produce new segments in an immutable log. */}
      <div className="mcm-stt__controls">
        {!viewOnly && (
          <button
            type="button"
            className={`mcm-stt__toggle${
              sttEnabled ? " mcm-stt__toggle--on" : ""
            }`}
            onClick={() => {
              const next = !sttEnabled;
              setSttEnabledState(next);
              setSttEnabled(next);
            }}
            title={
              sttEnabled
                ? t("stt.sttToggleOnTitle")
                : t("stt.sttToggleOffTitle")
            }
          >
            <Icon d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z M19 10v2a7 7 0 01-14 0v-2 M12 19v4 M8 23h8" />
            {sttEnabled ? t("stt.sttOn") : t("stt.sttOff")}
          </button>
        )}

        <button
          type="button"
          className={`mcm-stt__toggle mcm-stt__toggle--translate${
            translateEnabled ? " mcm-stt__toggle--on" : ""
          }`}
          onClick={() => {
            const next = !translateEnabled;
            setTranslateEnabledState(next);
            setSttTranslateEnabled(next);
          }}
          title={
            translateEnabled
              ? t("stt.translateToggleOnTitle")
              : t("stt.translateToggleOffTitle")
          }
        >
          <Icon d="M4 5h11 M9 3v2 M11 5a8 8 0 01-7 8 M5 9c0 4 4 7 9 7 M14 21l5-11 5 11 M15.5 17.5h7" />
          {translateEnabled ? t("stt.translateOn") : t("stt.translateOff")}
        </button>

        {/* Per-session STT provider selector (A/B accuracy test, 06-18).
            Each option carries its per-minute price so the PM sees cost
            while picking the most ACCURATE provider — default Deepgram.
            ?provider=<id> is forwarded to /stt by the next session. */}
        {!viewOnly && (
          <label className="mcm-stt__provider" title={t("stt.providerTitle")}>
            <span className="mcm-stt__provider-label">
              {t("stt.providerLabel")}
            </span>
            <select
              className="mcm-stt__provider-select"
              value={sttProvider}
              onChange={(e) => {
                const next = e.target.value as STTProvider;
                setSttProviderState(next);
                setSttProvider(next);
              }}
            >
              {STT_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id} disabled={p.comingSoon}>
                  {p.name} · {fmtPerMinute(p.usdPerMinute)}
                  {p.comingSoon ? ` — ${t("stt.providerSoon")}` : ""}
                </option>
              ))}
            </select>
            <span className="mcm-stt__provider-price">
              {fmtPerMinute(providerMeta(sttProvider).usdPerMinute)}
            </span>
          </label>
        )}

        {/* Language the LOCAL user speaks. Independent of the app UI language:
            Deepgram transcribes the mic in THIS language. Changing it restarts
            the live STT session (AudioRoomController deps on the atom). */}
        {!viewOnly && (
          <label
            className="mcm-stt__provider"
            title={t("stt.spokenLangTitle")}
          >
            <span className="mcm-stt__provider-label">
              {t("stt.spokenLangLabel")}
            </span>
            <select
              className="mcm-stt__provider-select"
              value={spokenLang}
              onChange={(e) => {
                const next = e.target.value as STTLang;
                setSpokenLangState(next);
                setSttSpokenLanguage(next);
              }}
            >
              {SPOKEN_LANGUAGES.map((lng) => (
                <option key={lng} value={lng}>
                  {SPOKEN_LANG_NAMES[lng]}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mcm-stt__controls-spacer" />

        {!viewOnly && (
          <button
            type="button"
            className="mcm-stt__test"
            onClick={() => fileInputRef.current?.click()}
            title={t("stt.testFileTitle")}
          >
            <Icon d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
            {testStatus === "running"
              ? t("stt.testRunning")
              : t("stt.testFile")}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          aria-label={t("stt.pickAudioFileAria")}
          title={t("stt.pickAudioFileAria")}
          className="mcm-stt__file-input"
          onChange={handleFilePick}
        />
      </div>

      <div
        className="mcm-stt__lines"
        ref={scrollRef}
        onScroll={handleLinesScroll}
      >
        {log.length === 0 && interimEntries.length === 0 && (
          <div className="mcm-stt__empty">
            {sttEnabled ? t("stt.waiting") : t("stt.paused")}
          </div>
        )}

        {visibleLog.map((seg) => (
          <SegmentRow
            key={seg.id}
            seg={seg}
            translateEnabled={translateEnabled}
            compact={compact}
          />
        ))}

        {interimEntries.map((entry) => (
          <InterimLine
            key={`interim-${entry.socketId}`}
            entry={entry}
            compact={compact}
          />
        ))}
      </div>

      {/* Footer now exists only to surface errors — normal status
          (LIVE/TEST/PAUSED) moved to the status pill in the header. The TEST
          path's error takes precedence; otherwise a LIVE session error (capture
          / handshake) is shown so a silent failure on iPad / no-mic is visible. */}
      {(testError || sttLiveError) && (
        <div className="mcm-stt__footer">
          <span className="mcm-stt__err">{testError ?? sttLiveError}</span>
        </div>
      )}

      {/* Custom resize handle at the bottom-right corner. Replaces
          CSS `resize: both`, which is unreliable on bottom-anchored
          elements. Pointer math is dead simple: delta added to base
          width/height, clamped against min/max. */}
      <div
        className="mcm-stt__resize-handle"
        role="separator"
        aria-label={t("stt.title")}
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      />
    </aside>
  );
};

export default SpeechToTextPanel;
