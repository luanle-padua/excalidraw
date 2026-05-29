// Canvas authorship badges — shows WHO created each text/bot element.
// Badges appear for the selected + hovered text element; a toolbar toggle
// reveals badges for ALL authored text. Text-only by design (keeps the
// canvas calm). Author is read from customData.mcmAuthor = { id, name }
// (stamped by Collab on the creator's client; bot answers pre-stamped by
// CanvasBotTool with the MCM Bot identity).
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import {
  BOT_SOCKET_ID,
  BOT_USERNAME,
  collabAPIAtom,
} from "../../collab/Collab";
import {
  peerProfilesAtom,
  resolveAvatarUrlWithDefault,
  userProfileAtom,
} from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { shortDisplayName } from "./animalEmoji";
import { findOrCreateToolbarExtras } from "./toolbarExtras";

type Author = { id: string; name: string };
type Badge = { key: string; author: Author; left: number; top: number };

const readAuthor = (el: ExcalidrawElement): Author | null => {
  const a = (el.customData as any)?.mcmAuthor;
  return a && typeof a.id === "string"
    ? { id: a.id, name: typeof a.name === "string" ? a.name : "" }
    : null;
};
const isAuthoredText = (el: ExcalidrawElement): boolean =>
  el.type === "text" &&
  !el.isDeleted &&
  // Skip container-bound text (e.g. the bot frame's label) — the frame
  // itself already shows who it belongs to, so a badge would be noise.
  !(el as any).containerId &&
  !!readAuthor(el);

const PeopleIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8" />
    <path d="M18.5 14c2 .8 3.5 2.7 3.5 5" />
  </svg>
);

export const AuthorBadgeOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const t = useT();
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const mySocketId = collabAPI?.portal.socket?.id ?? null;

  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [badges, setBadges] = useState<Badge[]>([]);

  const sceneRef = useRef<{
    elements: readonly ExcalidrawElement[];
    appState: AppState | null;
  }>({ elements: [], appState: null });
  const selectedRef = useRef<string[]>([]);
  const hoveredRef = useRef<string | null>(null);
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;

  // Locate (and lazily create) the MCM toolbar extras host so the toggle
  // sits in the same horizontal strip as the sticker / bot triggers.
  // Re-locate on remount (zen mode, layout flip) via the observer.
  useEffect(() => {
    setToolbarEl(findOrCreateToolbarExtras());
    const obs = new MutationObserver(() => {
      const next = findOrCreateToolbarExtras();
      setToolbarEl((prev) => (prev === next ? prev : next));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // Recompute which badges to render + their viewport positions from the
  // last-seen scene snapshot. Reads selection / hover / showAll through
  // refs so it can be called from both the onChange subscription and the
  // pointermove listener without re-binding either.
  const recompute = useCallback(() => {
    const { elements, appState } = sceneRef.current;
    if (!appState) {
      setBadges([]);
      return;
    }
    const zoom = appState.zoom.value;
    const ids = new Set<string>(selectedRef.current);
    if (hoveredRef.current) {
      ids.add(hoveredRef.current);
    }
    const all = showAllRef.current;
    // When exactly one text is selected, TextTranslateOverlay paints its
    // "🌐 Dịch ▾" pill at (left, top-36) over that element's top-left
    // corner. Our badge normally sits at top-26 on the same corner, so it
    // would collide. Detect that one element and lift its badge ABOVE the
    // pill instead. Hover / show-all badges (no translate pill) keep the
    // normal offset.
    const translateActiveId =
      selectedRef.current.length === 1 ? selectedRef.current[0] : null;
    const NORMAL_TOP_OFFSET = 26;
    const ABOVE_TRANSLATE_OFFSET = 60;
    const out: Badge[] = [];
    for (const el of elements) {
      if (!isAuthoredText(el)) {
        continue;
      }
      if (!all && !ids.has(el.id)) {
        continue;
      }
      const topOffset =
        el.id === translateActiveId
          ? ABOVE_TRANSLATE_OFFSET
          : NORMAL_TOP_OFFSET;
      out.push({
        key: el.id,
        author: readAuthor(el)!,
        // World → viewport using the same formula as TextTranslateOverlay
        // / PDFCanvasOverlay so badges line up with the canvas.
        left: Math.max(4, (el.x + appState.scrollX) * zoom),
        top: Math.max(4, (el.y + appState.scrollY) * zoom - topOffset),
      });
    }
    setBadges(out);
  }, []);

  // Track scene + selection on every Excalidraw change. onChange's third
  // arg is BinaryFiles (matches TextTranslateOverlay); we ignore it.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const onChange = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      sceneRef.current = { elements, appState };
      selectedRef.current = Object.keys(appState.selectedElementIds).filter(
        (id) => appState.selectedElementIds[id],
      );
      recompute();
    };
    onChange(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    return excalidrawAPI.onChange(onChange);
  }, [excalidrawAPI, recompute]);

  // Hover detection — Excalidraw paints to a single <canvas>, so there's
  // no DOM element to listen on. We hit-test the pointer against text
  // element bboxes in scene space, rAF-throttled to stay cheap.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) {
        return;
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        const container = document.querySelector(
          ".excalidraw-container",
        ) as HTMLElement | null;
        const { elements, appState } = sceneRef.current;
        if (
          !container ||
          !appState ||
          !(e.target instanceof Node) ||
          !container.contains(e.target)
        ) {
          if (hoveredRef.current !== null) {
            hoveredRef.current = null;
            recompute();
          }
          return;
        }
        const rect = container.getBoundingClientRect();
        const zoom = appState.zoom.value;
        const sx = (e.clientX - rect.left) / zoom - appState.scrollX;
        const sy = (e.clientY - rect.top) / zoom - appState.scrollY;
        let hit: string | null = null;
        for (let i = elements.length - 1; i >= 0; i--) {
          const el = elements[i];
          if (!isAuthoredText(el)) {
            continue;
          }
          if (
            sx >= el.x &&
            sx <= el.x + el.width &&
            sy >= el.y &&
            sy <= el.y + el.height
          ) {
            hit = el.id;
            break;
          }
        }
        if (hit !== hoveredRef.current) {
          hoveredRef.current = hit;
          recompute();
        }
      });
    };
    window.addEventListener("pointermove", onMove, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [excalidrawAPI, recompute]);

  // Re-render badges when the global toggle flips.
  useEffect(() => {
    recompute();
  }, [showAll, recompute]);

  // Resolve display identity from the stamped author id. Bot answers get
  // the fixed MCM Bot identity; everyone else resolves through the same
  // profile cache as ChatPanel's GroupRow (self vs. peer), falling back to
  // the snapshotted name so the badge survives the author leaving.
  const resolveIdentity = (author: Author) => {
    if (author.id === BOT_SOCKET_ID) {
      return { name: BOT_USERNAME, avatar: null as string | null, isBot: true };
    }
    const profile =
      author.id === mySocketId ? myProfile : peerProfiles.get(author.id);
    const rawName = author.name || profile?.username || t("participants.guest");
    return {
      name: shortDisplayName(rawName) || rawName,
      avatar: resolveAvatarUrlWithDefault(profile?.avatar, author.id),
      isBot: false,
    };
  };

  const overlayRoot =
    (document.querySelector(".excalidraw-container") as HTMLElement | null) ??
    null;

  return (
    <>
      {toolbarEl &&
        createPortal(
          <button
            type="button"
            className={`ToolIcon ToolIcon_type_button ToolIcon_size_medium ToolIcon--plain mcm-deco-trigger mcm-author-toggle${
              showAll ? " mcm-author-toggle--on" : ""
            }`}
            aria-label={
              showAll ? t("authors.toggleHide") : t("authors.toggleShow")
            }
            title={showAll ? t("authors.toggleHide") : t("authors.toggleShow")}
            onClick={() => setShowAll((v) => !v)}
          >
            <div className="ToolIcon__icon">
              <PeopleIcon />
            </div>
          </button>,
          toolbarEl,
        )}

      {overlayRoot &&
        createPortal(
          <div className="mcm-author-badge-layer" aria-hidden="true">
            {badges.map((b) => {
              const id = resolveIdentity(b.author);
              return (
                <div
                  key={b.key}
                  className={`mcm-author-badge${
                    id.isBot ? " mcm-author-badge--bot" : ""
                  }`}
                  // Per-frame position flows from the live appState, so it
                  // can't live in a stylesheet.
                  // eslint-disable-next-line react/forbid-dom-props
                  style={{ left: b.left, top: b.top }}
                >
                  <span className="mcm-author-badge__avatar">
                    {id.isBot ? (
                      "🤖"
                    ) : (
                      <img
                        src={id.avatar ?? undefined}
                        alt=""
                        draggable={false}
                      />
                    )}
                  </span>
                  <span className="mcm-author-badge__name">{id.name}</span>
                </div>
              );
            })}
          </div>,
          overlayRoot,
        )}
    </>
  );
};

export default AuthorBadgeOverlay;
