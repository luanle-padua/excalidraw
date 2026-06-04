// MCM canvas bot tool — a toolbar entry next to the sticker/stamp
// pickers. Click the bot icon → a ghost follows the pointer (placing
// mode, mirroring StickerPicker) → click the canvas to drop → a floating
// prompt input appears at the drop point. The user types ANY request
// (summarize, list decisions, translate this, …); on submit we call
// /chatbot with the full meeting context (chat + voice transcript +
// canvas text) and write the answer onto the canvas at the drop point.
//
// Nothing fires automatically: the bot only runs on an explicit, locally-
// initiated request, so there is no multiplayer double-trigger (the prompt
// UI is local; only the resulting text element is collab-synced).
import {
  convertToExcalidrawElements,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAtomValue } from "../../app-jotai";
import {
  BOT_SOCKET_ID,
  BOT_USERNAME,
  chatMessagesAtom,
} from "../../collab/Collab";
import { meetingFilesAtom } from "../../data/meetingLibrary";
import { preferredLanguageAtom } from "../../data/translation";
import { transcriptionLogAtom } from "../../data/transcription";
import { useT } from "../../i18n/mcm";

import { findOrCreateToolbarExtras } from "./toolbarExtras";

type PendingPrompt = {
  sceneX: number;
  sceneY: number;
  clientX: number;
  clientY: number;
};

const BotIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4.5" />
    <circle cx="12" cy="3" r="1.3" fill="currentColor" stroke="none" />
    <line x1="9.5" y1="13" x2="9.5" y2="14.5" />
    <line x1="14.5" y1="13" x2="14.5" y2="14.5" />
    <path d="M1.8 12v3M22.2 12v3" />
  </svg>
);

export const CanvasBotTool = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const t = useT();
  const transcriptLog = useAtomValue(transcriptionLogAtom);
  const messages = useAtomValue(chatMessagesAtom);
  const files = useAtomValue(meetingFilesAtom);
  const preferredLang = useAtomValue(preferredLanguageAtom);

  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const [placing, setPlacing] = useState(false);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const placeStartRef = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const ctxRef = useRef({ transcriptLog, messages, files, preferredLang });
  ctxRef.current = { transcriptLog, messages, files, preferredLang };

  useEffect(() => {
    setToolbarEl(findOrCreateToolbarExtras());
    const obs = new MutationObserver(() => {
      const next = findOrCreateToolbarExtras();
      setToolbarEl((prev) => (prev === next ? prev : next));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // SKIP the bot's own Q&A blocks (authored by BOT_SOCKET_ID) so the bot
  // never receives its previous answers back as "canvas text" — that
  // feedback loop made it parrot its own "no info" replies.
  const collectCanvasText = useCallback((): string[] => {
    if (!excalidrawAPI) {
      return [];
    }
    const texts: string[] = [];
    for (const el of excalidrawAPI.getSceneElements()) {
      if (
        el.type === "text" &&
        !el.isDeleted &&
        (el as any).text?.trim() &&
        (el as any).customData?.mcmAuthor?.id !== BOT_SOCKET_ID
      ) {
        // Prefix the author so the bot can attribute canvas notes —
        // discussions often happen as text written ON the canvas, not
        // just in chat. Without the name the bot sees them as anonymous.
        const author = (el as any).customData?.mcmAuthor?.name?.trim();
        const body = (el as any).text.trim();
        texts.push(author ? `${author}: ${body}` : body);
      }
    }
    for (const f of ctxRef.current.files) {
      texts.push(f.name);
    }
    return Array.from(new Set(texts))
      .slice(0, 40)
      .map((s) => s.slice(0, 200));
  }, [excalidrawAPI]);

  const dropAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!excalidrawAPI) {
        return;
      }
      const container = document.querySelector(
        ".excalidraw-container",
      ) as HTMLElement | null;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setPlacing(false);
        return;
      }
      const appState = excalidrawAPI.getAppState();
      const zoom = appState.zoom.value;
      const sceneX = -appState.scrollX + (clientX - rect.left) / zoom;
      const sceneY = -appState.scrollY + (clientY - rect.top) / zoom;
      setPlacing(false);
      setDraft("");
      setPending({ sceneX, sceneY, clientX, clientY });
    },
    [excalidrawAPI],
  );

  useEffect(() => {
    if (!placing) {
      setGhostPos(null);
      return undefined;
    }
    const isCanvasTarget = (e: PointerEvent) => {
      const container = document.querySelector(".excalidraw-container");
      return (
        !!container && e.target instanceof Node && container.contains(e.target)
      );
    };
    const onMove = (e: PointerEvent) =>
      setGhostPos({ x: e.clientX, y: e.clientY });
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !isCanvasTarget(e)) {
        return;
      }
      placeStartRef.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = (e: PointerEvent) => {
      const start = placeStartRef.current;
      placeStartRef.current = null;
      if (!start || !isCanvasTarget(e)) {
        return;
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      dropAt(e.clientX, e.clientY);
    };
    const onClick = (e: MouseEvent) => {
      const container = document.querySelector(".excalidraw-container");
      if (
        container &&
        e.target instanceof Node &&
        container.contains(e.target)
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlacing(false);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [placing, dropAt]);

  useEffect(() => {
    if (pending) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pending]);

  // Render the bot block as a framed panel — a dark, cyan-bordered,
  // monospace rectangle with a "🤖 MCM BOT" header, echoing the IBM /
  // terminal look of the IFC & DXF viewers. Uses an Excalidraw container
  // (rectangle + bound text) so the text wraps and it stays a real,
  // collab-synced, movable element. Returns the container id; replacing
  // deletes the previous container AND its bound text.
  const FRAME_WIDTH = 360;
  const writeText = (
    replaceId: string | null,
    body: string,
    x: number,
    y: number,
  ): string | null => {
    if (!excalidrawAPI) {
      return null;
    }
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    // Reuse the old frame's position when replacing so the answer lands
    // where the loading frame was, even if the user nudged it.
    let px = x;
    let py = y;
    if (replaceId) {
      const old = all.find((e) => e.id === replaceId);
      if (old) {
        px = old.x;
        py = old.y;
      }
    }
    const created = convertToExcalidrawElements([
      {
        type: "rectangle",
        x: px,
        y: py,
        width: FRAME_WIDTH,
        strokeColor: "#22d3ee",
        backgroundColor: "#0b0f17",
        fillStyle: "solid",
        strokeWidth: 2,
        roundness: null,
        label: {
          text: `🤖 MCM BOT\n\n${body}`,
          textAlign: "left",
          verticalAlign: "top",
          fontSize: 16,
          fontFamily: 3,
          strokeColor: "#e6f6ff",
        },
      } as any,
    ]);
    // Stamp the bot identity on every created element (rectangle + bound
    // text) so Collab's auto-stamp skips them and they read as "MCM Bot".
    // We also FORCE the IBM/terminal palette directly on the elements —
    // convertToExcalidrawElements doesn't reliably honour backgroundColor /
    // label colours from the skeleton, so set them here: dark panel, cyan
    // border, light monospace text.
    const stamped = created.map((el) => {
      const base = {
        ...el,
        customData: {
          ...((el as any).customData || {}),
          mcmAuthor: { id: BOT_SOCKET_ID, name: BOT_USERNAME },
        },
      };
      if (el.type === "rectangle") {
        return {
          ...base,
          backgroundColor: "#0b0f17",
          strokeColor: "#22d3ee",
          fillStyle: "solid",
          strokeWidth: 1.5,
          roundness: null,
        };
      }
      if (el.type === "text") {
        return {
          ...base,
          strokeColor: "#dff6ff",
          fontFamily: 3,
        };
      }
      return base;
    });
    const container = stamped.find((e) => e.type === "rectangle");
    const next = replaceId
      ? all.map((e) =>
          e.id === replaceId || (e as any).containerId === replaceId
            ? // newElementWith bumps version + versionNonce so the deletion
              // actually BROADCASTS to peers. A raw `{ ...e, isDeleted: true }`
              // keeps the old version, so Portal.broadcastScene (which only
              // sends elements whose version increased) skips it — peers never
              // learn the loading frame was removed and end up with BOTH the
              // loading and answer panels (the duplicate-panel bug).
              newElementWith(e, { isDeleted: true })
            : e,
        )
      : [...all];
    next.push(...(stamped as any));
    excalidrawAPI.updateScene({ elements: next });
    return container?.id ?? null;
  };

  const submitPrompt = useCallback(async () => {
    const request = draft.trim();
    if (!request || !pending || !excalidrawAPI || busy) {
      return;
    }
    const { sceneX, sceneY } = pending;
    setBusy(true);
    // Answer-only block — we do NOT echo the question back onto the canvas
    // (the user often already wrote it as a note, so repeating it reads as
    // a duplicate). One element, replaced in place: loading → answer.
    const loadingId = writeText(null, t("canvasBot.loading"), sceneX, sceneY);
    setPending(null);
    setDraft("");
    try {
      const { transcriptLog, messages, preferredLang } = ctxRef.current;
      const recent = messages
        .slice(-10)
        .map((m) => ({ username: m.username, text: m.text }));
      const transcript = transcriptLog.map((s) => ({
        speaker: s.username,
        text: s.text,
        lang: s.lang,
      }));
      const canvasText = collectCanvasText();
      const res = await fetch("/chatbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: request,
          language: preferredLang,
          recent,
          transcript,
          canvasText,
        }),
      });
      if (!res.ok) {
        throw new Error(`chatbot ${res.status}`);
      }
      const body = (await res.json()) as { answer?: string };
      const answer = body?.answer?.trim() || t("canvasBot.error");
      writeText(loadingId, answer, sceneX, sceneY);
    } catch (err) {
      console.warn("[canvas bot tool] failed", err);
      writeText(loadingId, t("canvasBot.error"), sceneX, sceneY);
    } finally {
      setBusy(false);
    }
    // writeText is a stable in-render helper; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, pending, excalidrawAPI, busy, t, collectCanvasText]);

  const cancelPrompt = () => {
    setPending(null);
    setDraft("");
  };

  if (!toolbarEl) {
    return null;
  }

  return (
    <>
      {createPortal(
        <button
          type="button"
          className={`ToolIcon ToolIcon_type_button ToolIcon_size_medium ToolIcon--plain mcm-deco-trigger mcm-deco-trigger--bot${
            placing ? " mcm-deco-trigger--placing" : ""
          }`}
          aria-label={t("canvasBot.toolLabel")}
          title={t("canvasBot.toolLabel")}
          onClick={() => setPlacing((v) => !v)}
        >
          <div className="ToolIcon__icon">
            <BotIcon />
          </div>
        </button>,
        toolbarEl,
      )}

      {placing &&
        ghostPos &&
        createPortal(
          <div
            className="mcm-placing-ghost mcm-placing-ghost--bot"
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: ghostPos.x, top: ghostPos.y }}
            aria-hidden="true"
          >
            <BotIcon />
          </div>,
          document.body,
        )}

      {pending &&
        createPortal(
          <div
            className="mcm-bot-prompt"
            // eslint-disable-next-line react/forbid-dom-props
            style={{ left: pending.clientX, top: pending.clientY }}
            role="dialog"
            aria-label={t("canvasBot.toolLabel")}
          >
            <textarea
              ref={inputRef}
              className="mcm-bot-prompt__input"
              placeholder={t("canvasBot.promptPlaceholder")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitPrompt();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPrompt();
                }
              }}
              rows={2}
            />
            <div className="mcm-bot-prompt__actions">
              <button
                type="button"
                className="mcm-bot-prompt__cancel"
                onClick={cancelPrompt}
                aria-label="Cancel"
              >
                ×
              </button>
              <button
                type="button"
                className="mcm-bot-prompt__send"
                onClick={() => void submitPrompt()}
                disabled={!draft.trim() || busy}
              >
                {t("canvasBot.send")}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default CanvasBotTool;
