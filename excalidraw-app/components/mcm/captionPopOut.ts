// Plain-DOM caption renderer for the Document-PiP (pop-out) window.
//
// The pop-out flow (screenshare/popOut.ts) MOVES a node into a separate
// document; popOut.ts itself warns that moving a React-reconciled node across
// documents fights reconciliation. So instead of portalling the React dock into
// `pip.document`, we mount a SMALL, self-contained DOM strip there and drive it
// by subscribing directly to `appJotaiStore`. No React, no reconciliation —
// just read the same atoms the in-app dock reads and rebuild a few <div>s.
//
// Translation: finals are shown in the viewer's preferred language using the
// SHARED translation cache (getCachedTranslation). The in-app dock already
// kicked off the fetch for the same (text, lang) and warmed that cache, so the
// pop-out almost always reads a hit; on a miss it shows the original (captions
// never blank). We don't fire new fetches from here — the pop-out is a mirror.
//
// Style: copyStyles() in popOut.ts has already cloned the app's stylesheets into
// the PiP document, so the `.mcm-caption*` classes resolve there. We add the
// `--mcm-caption-scale` var + an `--in-popout` marker class for the fixed
// full-width placement at the bottom of the PiP window.

import { appJotaiStore } from "../../app-jotai";
import { activeSpeakerAtom } from "../../audio/videoPerf";
import {
  CAPTION_FONT_SCALE_VALUE,
  captionDockEnabledAtom,
  captionFontScaleAtom,
  captionLineCountAtom,
} from "../../data/captionState";
import {
  liveTranscriptsAtom,
  sttTranslateEnabledAtom,
  transcriptionLogAtom,
} from "../../data/transcription";
import {
  getCachedTranslation,
  preferredLanguageAtom,
} from "../../data/translation";
import { peerProfilesAtom, userProfileAtom } from "../../data/userProfile";
import { collabAPIAtom } from "../../collab/Collab";

import { shortDisplayName } from "./animalEmoji";

const PALETTE = [
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#60a5fa",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#84cc16",
];
const colorFor = (key: string): string => {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
};

const speakerName = (socketId: string, fallback: string): string => {
  const selfId = appJotaiStore.get(collabAPIAtom)?.portal.socket?.id;
  const profile =
    socketId === selfId
      ? appJotaiStore.get(userProfileAtom) ?? undefined
      : appJotaiStore.get(peerProfilesAtom).get(socketId);
  return profile?.username || fallback;
};

type Built = { socketId: string; name: string; text: string; interim: boolean };

// Mirror of LiveCaptionDock's line-selection, but reading the store imperatively
// and resolving translations from the cache. Returns the lines to paint.
const buildLines = (): Built[] => {
  if (!appJotaiStore.get(captionDockEnabledAtom)) {
    return [];
  }
  const log = appJotaiStore.get(transcriptionLogAtom);
  const interims = Object.values(appJotaiStore.get(liveTranscriptsAtom));
  const active = appJotaiStore.get(activeSpeakerAtom);
  const lineCount = appJotaiStore.get(captionLineCountAtom);
  const preferred = appJotaiStore.get(preferredLanguageAtom);
  // Mirror the in-app dock: caption translation follows the STT panel toggle
  // (`sttTranslateEnabledAtom`), NOT useTranslate's chat toggle, so the pop-out
  // shows the SAME language state as the in-app strip (case 4: ngôn ngữ phải
  // đúng user, regardless of which surface owns the caption).
  const translateOn = appJotaiStore.get(sttTranslateEnabledAtom);

  const lastFinal = log.length > 0 ? log[log.length - 1] : null;
  const newestInterim = interims.reduce<typeof interims[number] | null>(
    (newest, e) => (!newest || e.ts > newest.ts ? e : newest),
    null,
  );
  const speakerId =
    active ?? newestInterim?.socketId ?? lastFinal?.socketId ?? null;
  if (!speakerId) {
    return [];
  }

  const interim = interims.find((e) => e.socketId === speakerId) ?? null;
  const hasInterim = !!interim && interim.text.trim().length > 0;
  const finalSlots = hasInterim ? Math.max(0, lineCount - 1) : lineCount;

  const out: Built[] = [];
  for (const seg of log
    .filter((s) => s.socketId === speakerId)
    .slice(-finalSlots)) {
    // Same-language or translation-off → original; else cache hit → translated;
    // else original (no blanking). `seg.lang === "multi"` (mixed/unknown) is
    // NOT treated as same-language, so it still resolves via the cache the
    // in-app dock warmed (which sent assumedSource=undefined for "multi").
    const sameLang = !translateOn || seg.lang === preferred;
    const text = sameLang
      ? seg.text
      : getCachedTranslation(seg.text, preferred) ?? seg.text;
    out.push({
      socketId: seg.socketId,
      name: speakerName(seg.socketId, seg.username),
      text,
      interim: false,
    });
  }
  if (hasInterim && interim) {
    out.push({
      socketId: interim.socketId,
      name: speakerName(interim.socketId, interim.username),
      text: interim.text,
      interim: true,
    });
  }
  return out.slice(-lineCount);
};

/**
 * Mount a live caption strip inside `doc.body` (the PiP window) and keep it in
 * sync with the app store. Returns a teardown fn that removes the node and all
 * subscriptions — call it when the pop-out returns.
 */
export const mountPopOutCaption = (doc: Document): (() => void) => {
  const root = doc.createElement("div");
  root.className = "mcm-caption mcm-caption--popout";
  doc.body.appendChild(root);

  const SILENCE_HIDE_MS = 4000;
  let hideTimer: number | null = null;
  let lastSig = "";

  const render = () => {
    const lines = buildLines();
    const scale =
      CAPTION_FONT_SCALE_VALUE[appJotaiStore.get(captionFontScaleAtom)];
    root.style.setProperty("--mcm-caption-scale", String(scale));

    const sig = lines
      .map((l) => `${l.interim ? "i" : "f"}:${l.text}`)
      .join("|");
    if (sig !== lastSig) {
      lastSig = sig;
      // New content → show + re-arm the silence timer.
      if (hideTimer !== null) {
        doc.defaultView?.clearTimeout(hideTimer);
      }
      if (lines.length > 0) {
        root.classList.add("mcm-caption--active");
        root.classList.remove("mcm-caption--idle");
        hideTimer = doc.defaultView?.setTimeout(() => {
          root.classList.remove("mcm-caption--active");
          root.classList.add("mcm-caption--idle");
        }, SILENCE_HIDE_MS) as unknown as number;
      } else {
        root.classList.remove("mcm-caption--active");
        root.classList.add("mcm-caption--idle");
      }
    }

    // Rebuild the strip cheaply — at most 3 lines, so a full replace is fine.
    root.replaceChildren();
    if (lines.length === 0) {
      return;
    }
    const strip = doc.createElement("div");
    strip.className = "mcm-caption__strip";
    for (const l of lines) {
      const row = doc.createElement("div");
      row.className = `mcm-caption__line${
        l.interim ? " mcm-caption__line--interim" : ""
      }`;
      const spk = doc.createElement("span");
      spk.className = "mcm-caption__spk";
      spk.style.color = colorFor(l.socketId);
      spk.textContent = shortDisplayName(l.name);
      if (l.interim) {
        const dot = doc.createElement("span");
        dot.className = "mcm-caption__live-dot";
        spk.appendChild(dot);
      }
      const txt = doc.createElement("span");
      txt.className = "mcm-caption__text";
      txt.textContent = l.text;
      row.appendChild(spk);
      row.appendChild(txt);
      strip.appendChild(row);
    }
    root.appendChild(strip);
  };

  // Subscribe to every atom that affects the strip. jotai's store.sub fires on
  // any change; we just re-render (cheap — ≤3 lines).
  const unsubs = [
    appJotaiStore.sub(transcriptionLogAtom, render),
    appJotaiStore.sub(liveTranscriptsAtom, render),
    appJotaiStore.sub(activeSpeakerAtom, render),
    appJotaiStore.sub(captionDockEnabledAtom, render),
    appJotaiStore.sub(captionLineCountAtom, render),
    appJotaiStore.sub(captionFontScaleAtom, render),
    appJotaiStore.sub(preferredLanguageAtom, render),
    appJotaiStore.sub(sttTranslateEnabledAtom, render),
  ];
  render();

  return () => {
    for (const u of unsubs) {
      u();
    }
    if (hideTimer !== null) {
      doc.defaultView?.clearTimeout(hideTimer);
    }
    root.remove();
  };
};
