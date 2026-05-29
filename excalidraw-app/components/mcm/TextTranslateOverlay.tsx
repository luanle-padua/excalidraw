// On-canvas translation for text elements.
//
// UX:
//   1. User selects a single text element (must NOT itself be a
//      translation child, see TRANSLATION_KIND below — we don't want
//      "translate the translation" loops).
//   2. A small floating "Translate ▾" button appears anchored above
//      the element; the dropdown picks vi / en / ko.
//   3. Picking a language fetches the translation via /translate and
//      either creates a NEW child text element directly under the
//      original or, if a translation already exists for this pair,
//      updates the existing one (no duplicate stack of children).
//
// Why a child element rather than an HTML overlay:
//   The user explicitly asked for peers to see translations too. A
//   real canvas text element rides Excalidraw's collab pipeline for
//   free — no socket plumbing, no per-user overlay state to reconcile.
//   We link it back to the original via customData so we can:
//     • reposition the child when the original moves / resizes
//     • mark the child as STALE (italic + grey) when the original's
//       text changes, exposing a "Cập nhật" button on the parent
//     • cascade-delete every child when the original is deleted
//
// The overlay only handles UI (button + dropdown); the scene mutations
// all flow through excalidrawAPI.updateScene so undo / redo, collab
// and persistence behave like for any other element.

import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { newElementWith, newTextElement } from "@excalidraw/element";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import {
  fetchBatchTranslation,
  getCachedTranslation,
  preferredLanguageAtom,
} from "../../data/translation";

import type { SupportedLanguage } from "../../data/translation";

/** Marker so the overlay can recognise our own translation children
 *  (we hide the Translate button when one is selected — translating
 *  a translation is a footgun). */
export const TRANSLATION_KIND = "mcm-translation";

/** customData carried on the child text element. */
type TranslationCustomData = {
  mcmType: typeof TRANSLATION_KIND;
  /** Element id of the source text this row was translated from. */
  mcmTranslationOf: string;
  /** The target language at translation time. We DON'T re-translate
   *  automatically when the user changes app language — the child
   *  stays in its original target so collab peers all see the same
   *  text. The button can be used again to swap. */
  mcmTranslationLang: SupportedLanguage;
  /** Exact source text the translation was produced from. When the
   *  source diverges, we mark the child stale + show a re-translate
   *  affordance. */
  mcmTranslationSource: string;
  /** Parent's (x, y) at the moment we last applied a position change.
   *  The reposition cascade uses this to compute a delta when the
   *  user drags the parent — we shift the child by the same (dx, dy)
   *  so any manual re-positioning the user did to the child is
   *  preserved instead of being snapped back under the parent. */
  mcmTranslationAnchorX: number;
  mcmTranslationAnchorY: number;
};

const LANG_OPTIONS: ReadonlyArray<{
  code: SupportedLanguage;
  label: string;
  flag: string;
}> = [
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
];

const isTextEl = (
  el: ExcalidrawElement | null | undefined,
): el is ExcalidrawTextElement => !!el && el.type === "text" && !el.isDeleted;

const isTranslationChild = (
  el: ExcalidrawElement | null | undefined,
): boolean =>
  !!el &&
  el.type === "text" &&
  !!el.customData &&
  (el.customData as Record<string, unknown>).mcmType === TRANSLATION_KIND;

const getTranslationData = (
  el: ExcalidrawElement,
): TranslationCustomData | null => {
  if (!isTranslationChild(el)) {
    return null;
  }
  const cd = el.customData as Record<string, unknown>;
  if (
    typeof cd.mcmTranslationOf !== "string" ||
    typeof cd.mcmTranslationLang !== "string" ||
    typeof cd.mcmTranslationSource !== "string"
  ) {
    return null;
  }
  return {
    mcmType: TRANSLATION_KIND,
    mcmTranslationOf: cd.mcmTranslationOf,
    mcmTranslationLang: cd.mcmTranslationLang as SupportedLanguage,
    mcmTranslationSource: cd.mcmTranslationSource,
    // Anchors are optional in older customData payloads; fall back
    // to 0 so the first reposition pass treats anything as "moved"
    // and seeds the anchor from the current parent.
    mcmTranslationAnchorX:
      typeof cd.mcmTranslationAnchorX === "number"
        ? cd.mcmTranslationAnchorX
        : 0,
    mcmTranslationAnchorY:
      typeof cd.mcmTranslationAnchorY === "number"
        ? cd.mcmTranslationAnchorY
        : 0,
  };
};

type ButtonPosition = {
  /** Viewport pixel position of the button's top-left, derived from
   *  the selected text's scene rect through the current scroll +
   *  zoom. Updated by an Excalidraw onChange subscription so the
   *  button tracks pans / zooms in real time. */
  left: number;
  top: number;
};

export const TextTranslateOverlay = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const preferred = useAtomValue(preferredLanguageAtom);
  const [selectedText, setSelectedText] =
    useState<ExcalidrawTextElement | null>(null);
  const [buttonPos, setButtonPos] = useState<ButtonPosition | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [busyLang, setBusyLang] = useState<SupportedLanguage | null>(null);
  const buttonRef = useRef<HTMLDivElement | null>(null);

  // Track selected text + recompute the button position on every
  // scene change. Position is derived in viewport space so it sits
  // ABOVE the text and follows pan/zoom. We don't position relative
  // to the text element directly because Excalidraw's canvas is a
  // single <canvas>, not real DOM — there's nothing to "anchor to".
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const recompute = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      const selectedIds = Object.keys(appState.selectedElementIds).filter(
        (id) => appState.selectedElementIds[id],
      );
      if (selectedIds.length !== 1) {
        setSelectedText(null);
        setButtonPos(null);
        return;
      }
      const el = elements.find((e) => e.id === selectedIds[0]);
      // Resolve the translatable text: either the selected text element,
      // OR — for a container such as the framed bot answer (a rectangle
      // with bound text) — the text bound inside it. The pill is positioned
      // over whichever element is actually selected (`anchor`).
      let textEl: ExcalidrawTextElement | null = isTextEl(el) ? el : null;
      if (!textEl && el) {
        const boundId = (el as any).boundElements?.find(
          (b: { type: string; id: string }) => b.type === "text",
        )?.id;
        const bound = boundId
          ? elements.find((e) => e.id === boundId)
          : undefined;
        if (isTextEl(bound)) {
          textEl = bound;
        }
      }
      if (!textEl || isTranslationChild(textEl) || !el) {
        // Hide on translation children to avoid translate-of-translate
        // loops; the user can still pick the SOURCE text and run again.
        setSelectedText(null);
        setButtonPos(null);
        return;
      }
      setSelectedText(textEl);
      // World → viewport using the same formula as PDFCanvasOverlay /
      // DXFCanvasOverlay so the button lines up with the canvas
      // selection rectangle Excalidraw paints. Anchor on the SELECTED
      // element (the container for a framed answer) so the pill sits on
      // the frame's corner, not inside it.
      const zoom = appState.zoom.value;
      const viewportLeft = (el.x + appState.scrollX) * zoom;
      const viewportTop = (el.y + appState.scrollY) * zoom;
      // Place the button ~28px above the text top, left-aligned to
      // the text's left edge. Clamp to keep it inside the viewport.
      setButtonPos({
        left: Math.max(8, viewportLeft),
        top: Math.max(8, viewportTop - 36),
      });
    };
    recompute(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    return excalidrawAPI.onChange(recompute);
  }, [excalidrawAPI]);

  // Close dropdown on outside click / Esc.
  useEffect(() => {
    if (!dropdownOpen) {
      return undefined;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && buttonRef.current?.contains(t)) {
        return;
      }
      setDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [dropdownOpen]);

  // Find an existing translation child of `parent` for `lang`. We
  // identify children purely from customData — no separate registry —
  // so collab peers and reloads all converge on the same answer
  // without extra state.
  const findChildFor = useCallback(
    (
      parentId: string,
      lang: SupportedLanguage,
    ): ExcalidrawTextElement | null => {
      if (!excalidrawAPI) {
        return null;
      }
      for (const el of excalidrawAPI.getSceneElements()) {
        if (!isTextEl(el)) {
          continue;
        }
        const data = getTranslationData(el);
        if (
          data &&
          data.mcmTranslationOf === parentId &&
          data.mcmTranslationLang === lang
        ) {
          return el;
        }
      }
      return null;
    },
    [excalidrawAPI],
  );

  // Find ALL translation children of `parent` (across languages) —
  // used by the stale-detection / re-translate flow that runs against
  // every existing child.
  const findAllChildrenFor = useCallback(
    (parentId: string): ExcalidrawTextElement[] => {
      if (!excalidrawAPI) {
        return [];
      }
      const out: ExcalidrawTextElement[] = [];
      for (const el of excalidrawAPI.getSceneElements()) {
        if (!isTextEl(el)) {
          continue;
        }
        const data = getTranslationData(el);
        if (data && data.mcmTranslationOf === parentId) {
          out.push(el);
        }
      }
      return out;
    },
    [excalidrawAPI],
  );

  /** Run a translation and upsert the child element below the parent.
   *  Uses fetchBatchTranslation (single Gemini round-trip across all
   *  three target languages) so picking "vi" warms the cache for
   *  "en" + "ko" too — the next click on a different language is
   *  instant. */
  const translateInto = useCallback(
    async (lang: SupportedLanguage) => {
      if (!excalidrawAPI || !selectedText) {
        return;
      }
      const sourceText = selectedText.text;
      if (!sourceText.trim()) {
        return;
      }
      setBusyLang(lang);
      setDropdownOpen(false);
      try {
        const cached = getCachedTranslation(sourceText, lang);
        let translated = cached;
        if (!translated) {
          const batch = await fetchBatchTranslation(sourceText);
          translated = batch?.[lang] ?? getCachedTranslation(sourceText, lang);
        }
        if (!translated || translated === sourceText) {
          // Provider unavailable or returned the original — nothing
          // useful to show. Bail silently rather than littering the
          // canvas with a duplicate line.
          return;
        }
        upsertTranslationChild(sourceText, lang, translated);
      } finally {
        setBusyLang(null);
      }
    },
    // upsertTranslationChild is defined below and closes over the
    // current excalidrawAPI / selectedText — both already deps here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [excalidrawAPI, selectedText],
  );

  // Imperative upsert — creates the child if absent or rewrites its
  // text + clears its stale flag if present. Position is anchored to
  // the bottom-left of the parent's bbox with a small gap.
  const upsertTranslationChild = (
    sourceText: string,
    lang: SupportedLanguage,
    translated: string,
  ) => {
    if (!excalidrawAPI || !selectedText) {
      return;
    }
    const parent = selectedText;
    const existing = findChildFor(parent.id, lang);
    // Stack any same-parent children we already created, so a second
    // language doesn't overlap the first one. We use the child count
    // here (not the existing element's y) because the parent might
    // have been resized — recomputing keeps placement deterministic.
    const siblingCount = findAllChildrenFor(parent.id).filter(
      (c) => c.id !== existing?.id,
    ).length;
    const VERTICAL_GAP = 6;
    // When the source is text bound inside a container (the framed bot
    // answer), anchor the translation below the CONTAINER's bbox — not the
    // bound text, which sits inside the frame. Otherwise anchor below the
    // text itself.
    const container = (parent as any).containerId
      ? excalidrawAPI
          .getSceneElements()
          .find((e) => e.id === (parent as any).containerId)
      : null;
    const anchorX = container ? container.x : parent.x;
    const anchorBottom = container
      ? container.y + container.height
      : parent.y + parent.height;
    const baselineY = anchorBottom + VERTICAL_GAP;
    const customData: TranslationCustomData = {
      mcmType: TRANSLATION_KIND,
      mcmTranslationOf: parent.id,
      mcmTranslationLang: lang,
      mcmTranslationSource: sourceText,
      // Anchor tracks the parent position THIS write was relative to
      // — the reposition cascade reads it on the next parent move to
      // compute (dx, dy). Updating it on every upsert means a fresh
      // translation always starts in the "anchored" state.
      mcmTranslationAnchorX: parent.x,
      mcmTranslationAnchorY: parent.y,
    };
    const all = excalidrawAPI.getSceneElementsIncludingDeleted();
    let next: ExcalidrawElement[];
    if (existing) {
      // Rewriting the text changes the element's intrinsic width /
      // height; we reuse newTextElement to recompute the metrics
      // (Excalidraw doesn't auto-measure on an updateScene patch).
      const replacement = newTextElement({
        text: translated,
        originalText: translated,
        fontFamily: parent.fontFamily,
        fontSize: Math.max(12, Math.round(parent.fontSize * 0.85)),
        textAlign: parent.textAlign,
        verticalAlign: parent.verticalAlign,
        x: existing.x,
        y: existing.y,
        strokeColor: existing.strokeColor,
        backgroundColor: existing.backgroundColor,
        opacity: 100,
      });
      const updated = newElementWith(existing, {
        text: replacement.text,
        originalText: replacement.text,
        width: replacement.width,
        height: replacement.height,
        opacity: 100,
        customData,
      });
      next = all.map((el) => (el.id === existing.id ? updated : el));
    } else {
      const child = newTextElement({
        text: translated,
        originalText: translated,
        fontFamily: parent.fontFamily,
        fontSize: Math.max(12, Math.round(parent.fontSize * 0.85)),
        textAlign: parent.textAlign,
        verticalAlign: parent.verticalAlign,
        x: anchorX,
        y: baselineY + siblingCount * (parent.fontSize + VERTICAL_GAP),
        strokeColor: "#6b7280", // a muted grey so the translation
        // reads as secondary
        opacity: 95,
      });
      // newTextElement assigns a random id but newElementWith preserves
      // it, so we just push the new element with our customData applied.
      const stamped = newElementWith(child, { customData });
      next = [...all, stamped];
    }
    excalidrawAPI.updateScene({ elements: next });
  };

  // Detect whether ANY translation children of the selected parent are
  // stale (their cached source !== parent.text). Used to badge the
  // button so the user knows clicking will refresh.
  const staleChildren = useMemo(() => {
    if (!selectedText) {
      return [];
    }
    const children = findAllChildrenFor(selectedText.id);
    return children.filter((c) => {
      const d = getTranslationData(c);
      return d && d.mcmTranslationSource !== selectedText.text;
    });
  }, [selectedText, findAllChildrenFor]);

  /** Re-translate every stale child against the parent's current
   *  text in one batch call. Avoids N round-trips when the user has
   *  three languages pinned and edits the source. */
  const refreshStale = useCallback(async () => {
    if (!excalidrawAPI || !selectedText || staleChildren.length === 0) {
      return;
    }
    const sourceText = selectedText.text;
    if (!sourceText.trim()) {
      return;
    }
    setBusyLang(preferred); // visual hint — overloaded but cheap
    try {
      // Warm the cache for everything in one trip.
      await fetchBatchTranslation(sourceText);
      for (const child of staleChildren) {
        const d = getTranslationData(child);
        if (!d) {
          continue;
        }
        const updated =
          getCachedTranslation(sourceText, d.mcmTranslationLang) ?? sourceText;
        upsertTranslationChild(sourceText, d.mcmTranslationLang, updated);
      }
    } finally {
      setBusyLang(null);
    }
    // upsertTranslationChild closes over current excalidrawAPI/
    // selectedText. They're already deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, selectedText, staleChildren, preferred]);

  // Mark stale children visually (italic + lower opacity) so they
  // read as "out of date" without the user having to inspect the
  // text. We do this on every change pass so peer edits also trigger
  // the marking on viewers who didn't make the edit themselves.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    let scheduled = false;
    const scheduleMark = (
      elements: readonly ExcalidrawElement[],
      _appState: AppState,
      _files: BinaryFiles,
    ) => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const byId = new Map(elements.map((e) => [e.id, e]));
        const patches: Array<{ id: string; opacity: number }> = [];
        for (const el of elements) {
          if (!isTextEl(el)) {
            continue;
          }
          const data = getTranslationData(el);
          if (!data) {
            continue;
          }
          const parent = byId.get(data.mcmTranslationOf);
          if (!parent || !isTextEl(parent)) {
            // Parent gone — caller's responsibility (delete cascade
            // below). Skip opacity changes.
            continue;
          }
          const stale = data.mcmTranslationSource !== parent.text;
          // 95 = fresh, 55 = stale. Avoid writing if already correct
          // to dodge an updateScene → onChange feedback loop.
          const want = stale ? 55 : 95;
          if (el.opacity !== want) {
            patches.push({ id: el.id, opacity: want });
          }
        }
        if (patches.length === 0) {
          return;
        }
        const next = elements.map((el) => {
          const p = patches.find((x) => x.id === el.id);
          return p ? newElementWith(el, { opacity: p.opacity }) : el;
        });
        excalidrawAPI.updateScene({ elements: next });
      });
    };
    scheduleMark(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
    return excalidrawAPI.onChange(scheduleMark);
  }, [excalidrawAPI]);

  // Reposition cascade: when the parent text moves (or the user
  // resizes it and its x/y shifts as a result), shift every
  // translation child by the same delta so they keep their relative
  // position. We track the parent's last position in the child's
  // customData anchor — this preserves any manual re-positioning the
  // user did to the child (it just moves the child + parent as a
  // rigid pair instead of snapping the child back under the parent).
  //
  // The effect runs on every onChange, debounced to one rAF so a
  // rapid drag doesn't fire N updateScene calls.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    let scheduled = false;
    const reposition = (
      elements: readonly ExcalidrawElement[],
      _appState: AppState,
      _files: BinaryFiles,
    ) => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const byId = new Map(elements.map((e) => [e.id, e]));
        const patches: Array<{
          id: string;
          x: number;
          y: number;
          anchorX: number;
          anchorY: number;
        }> = [];
        for (const el of elements) {
          if (!isTextEl(el)) {
            continue;
          }
          const data = getTranslationData(el);
          if (!data) {
            continue;
          }
          const parent = byId.get(data.mcmTranslationOf);
          if (!parent || !isTextEl(parent)) {
            continue;
          }
          const dx = parent.x - data.mcmTranslationAnchorX;
          const dy = parent.y - data.mcmTranslationAnchorY;
          // No-op if the parent hasn't moved since the last cascade.
          // The 0.001 epsilon dodges float-drift loops; Excalidraw
          // stores coords as floats from pointer-pixel ratios.
          if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
            continue;
          }
          patches.push({
            id: el.id,
            x: el.x + dx,
            y: el.y + dy,
            anchorX: parent.x,
            anchorY: parent.y,
          });
        }
        if (patches.length === 0) {
          return;
        }
        const next = elements.map((el) => {
          const p = patches.find((x) => x.id === el.id);
          if (!p) {
            return el;
          }
          return newElementWith(el, {
            x: p.x,
            y: p.y,
            customData: {
              ...el.customData,
              mcmTranslationAnchorX: p.anchorX,
              mcmTranslationAnchorY: p.anchorY,
            },
          });
        });
        excalidrawAPI.updateScene({ elements: next });
      });
    };
    return excalidrawAPI.onChange(reposition);
  }, [excalidrawAPI]);

  // Cascade-delete: if a parent text element is deleted, also delete
  // every translation child that points at it. Excalidraw treats
  // tombstones (`isDeleted: true`) as deletions — so we set the same
  // flag rather than splicing them out of the array.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    let scheduled = false;
    const sweep = (
      elements: readonly ExcalidrawElement[],
      _appState: AppState,
      _files: BinaryFiles,
    ) => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const live = excalidrawAPI.getSceneElementsIncludingDeleted();
        const liveById = new Map(live.map((e) => [e.id, e]));
        const orphans: string[] = [];
        for (const el of live) {
          if (el.isDeleted) {
            continue;
          }
          if (!isTextEl(el)) {
            continue;
          }
          const data = getTranslationData(el);
          if (!data) {
            continue;
          }
          const parent = liveById.get(data.mcmTranslationOf);
          if (!parent || parent.isDeleted) {
            orphans.push(el.id);
          }
        }
        if (orphans.length === 0) {
          return;
        }
        const next = live.map((el) =>
          orphans.includes(el.id)
            ? newElementWith(el, { isDeleted: true })
            : el,
        );
        excalidrawAPI.updateScene({ elements: next });
      });
    };
    return excalidrawAPI.onChange(sweep);
  }, [excalidrawAPI]);

  if (!selectedText || !buttonPos) {
    return null;
  }
  const hasStale = staleChildren.length > 0;

  return (
    <div className="mcm-text-translate" aria-label="Translate text">
      <div
        ref={buttonRef}
        className="mcm-text-translate__anchor"
        // The anchor sits at the per-frame button position; the
        // computed (left, top) flow from the live appState so we
        // can't put them in a stylesheet.
        // eslint-disable-next-line react/forbid-dom-props
        style={{ left: buttonPos.left, top: buttonPos.top }}
      >
        {hasStale ? (
          <button
            type="button"
            className="mcm-text-translate__btn mcm-text-translate__btn--stale"
            onClick={() => void refreshStale()}
            disabled={busyLang !== null}
            title="Bản dịch đã cũ — bấm để cập nhật"
          >
            <span aria-hidden>🔁</span>
            <span>Cập nhật bản dịch</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              className="mcm-text-translate__btn"
              onClick={() => void translateInto(preferred)}
              disabled={busyLang !== null}
              title={`Dịch sang ${
                LANG_OPTIONS.find((l) => l.code === preferred)?.label ??
                preferred
              }`}
            >
              <span aria-hidden>🌐</span>
              <span>{busyLang === preferred ? "Đang dịch…" : "Dịch"}</span>
            </button>
            <button
              type="button"
              className="mcm-text-translate__caret"
              onClick={(e) => {
                e.stopPropagation();
                setDropdownOpen((v) => !v);
              }}
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen ? "true" : "false"}
              title="Chọn ngôn ngữ khác"
            >
              ▾
            </button>
          </>
        )}
        {dropdownOpen && (
          <div className="mcm-text-translate__menu" role="listbox">
            {LANG_OPTIONS.map((opt) => (
              <button
                key={opt.code}
                type="button"
                role="option"
                aria-selected={busyLang === opt.code ? "true" : "false"}
                className="mcm-text-translate__menu-item"
                onClick={() => void translateInto(opt.code)}
                disabled={busyLang !== null}
              >
                <span aria-hidden>{opt.flag}</span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TextTranslateOverlay;
