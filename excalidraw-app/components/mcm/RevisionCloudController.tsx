import { useEffect, useRef } from "react";

import { randomId } from "@excalidraw/common";
import {
  newArrowElement,
  newElementWith,
  newLinearElement,
  newTextElement,
} from "@excalidraw/element";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { CaptureUpdateAction } from "@excalidraw/excalidraw/index";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";

import { useAtomValue } from "../../app-jotai";
import { collabAPIAtom } from "../../collab/Collab";

import {
  findNearestCloudPoint,
  generateCloudPoints,
} from "./revisionCloudGeometry";

const MIN_SIZE = 12;
const DEFAULT_NOTE_TEXT = "Ghi chú";
const NOTE_FONT_SIZE = 20;

type AwaitingTextPhase = {
  kind: "awaitingText";
  cloudId: string;
  cloudX: number;
  cloudY: number;
  cloudPoints: readonly LocalPoint[];
  groupId: string;
  strokeColor: string;
  strokeWidth: number;
  roughness: number;
  opacity: number;
  frameId: string | null;
};

type Phase = { kind: "idle" } | AwaitingTextPhase;

export const RevisionCloudController = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);

  const phaseRef = useRef<Phase>({ kind: "idle" });
  const tempRectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    // onPointerDown: while the cloud tool is active, snapshot the
    // rectangle Excalidraw inserts so we can look it up at pointer-up.
    // We do NOT touch the awaitingText phase here — Excalidraw auto-
    // switches the active tool to "selection" right after drawing a
    // generic element, and we want the *next* click to still resolve as
    // "place the note" rather than be treated as a stray tool change.
    const unsubDown = excalidrawAPI.onPointerDown((activeTool) => {
      if (activeTool.type !== "revisionCloud") {
        tempRectIdRef.current = null;
        return;
      }
      const all = excalidrawAPI.getSceneElementsIncludingDeleted();
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i];
        if (!el.isDeleted && el.type === "rectangle") {
          tempRectIdRef.current = el.id;
          break;
        }
      }
    });

    // onPointerUp: phase-driven dispatch.
    //
    //   • awaitingText  → use the pointer-down origin (scene coords,
    //                     provided by Excalidraw) as the note position,
    //                     irrespective of which tool is currently active.
    //                     This sidesteps Excalidraw's post-commit
    //                     auto-switch to "selection" without us having to
    //                     race to put the cloud tool back on.
    //   • idle + drag   → build a cloud from the temp rectangle.
    //   • idle + click  → nothing to do; drop the zero-size placeholder
    //                     Excalidraw inserted.
    const unsubUp = excalidrawAPI.onPointerUp(
      (activeTool, pointerDownState) => {
        const phase = phaseRef.current;

        if (phase.kind === "awaitingText") {
          // Step 2 — place the note at the click and wire it back to the
          // cloud with an arrow whose tip snaps to the closest scallop.
          const noteX = pointerDownState.origin.x;
          const noteY = pointerDownState.origin.y;

          // Clean up any temp rectangle Excalidraw inserted during this
          // pointer-down (if the cloud tool happened to still be active
          // because of fast clicking).
          const tempId = tempRectIdRef.current;
          tempRectIdRef.current = null;

          const tip = findNearestCloudPoint(
            phase.cloudX,
            phase.cloudY,
            phase.cloudPoints,
            noteX,
            noteY,
          );

          const note = newTextElement({
            text: DEFAULT_NOTE_TEXT,
            fontSize: NOTE_FONT_SIZE,
            textAlign: "left",
            verticalAlign: "top",
            x: noteX,
            y: noteY,
            strokeColor: phase.strokeColor,
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: phase.roughness,
            opacity: phase.opacity,
            roundness: null,
            locked: false,
            frameId: phase.frameId,
            groupIds: [phase.groupId],
          });

          const arrow = newArrowElement({
            type: "arrow",
            x: noteX,
            y: noteY,
            strokeColor: phase.strokeColor,
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: phase.strokeWidth,
            strokeStyle: "solid",
            roughness: phase.roughness,
            opacity: phase.opacity,
            roundness: null,
            locked: false,
            frameId: phase.frameId,
            groupIds: [phase.groupId],
            startArrowhead: null,
            endArrowhead: "arrow",
            points: [
              pointFrom<LocalPoint>(0, 0),
              pointFrom<LocalPoint>(tip.x - noteX, tip.y - noteY),
            ],
          });

          // Bind the arrow's tail to the note so the arrow follows when
          // the note is moved/resized/edited. Cloud (line element) isn't
          // an arrow-bindable type, so we leave the tip free — the shared
          // groupId keeps everything visually attached during normal
          // select/drag.
          const noteWithBinding = newElementWith(note, {
            boundElements: [{ id: arrow.id, type: "arrow" }],
          });
          const arrowWithBinding = newElementWith(arrow, {
            startBinding: {
              elementId: note.id,
              fixedPoint: [0.5, 0.5],
              mode: "orbit",
            },
            endBinding: null,
          } as any);

          const all = excalidrawAPI.getSceneElementsIncludingDeleted();
          const next: any[] = all.map((el) =>
            tempId && el.id === tempId
              ? newElementWith(el, { isDeleted: true })
              : el,
          );
          next.push(noteWithBinding, arrowWithBinding);

          excalidrawAPI.updateScene({
            elements: next,
            appState: {
              selectedElementIds: {
                [phase.cloudId]: true,
                [noteWithBinding.id]: true,
                [arrowWithBinding.id]: true,
              },
              selectedGroupIds: { [phase.groupId]: true },
            },
          });
          collabAPI?.syncElements(
            excalidrawAPI.getSceneElementsIncludingDeleted(),
          );

          phaseRef.current = { kind: "idle" };
          return;
        }

        // Idle phase: only the cloud tool can start step 1.
        if (activeTool.type !== "revisionCloud") {
          return;
        }
        const tempId = tempRectIdRef.current;
        tempRectIdRef.current = null;
        if (!tempId) {
          return;
        }

        const all = excalidrawAPI.getSceneElementsIncludingDeleted();
        const tempRect = all.find(
          (el) => el.id === tempId && el.type === "rectangle",
        );
        if (!tempRect) {
          return;
        }

        const isDrag =
          tempRect.width >= MIN_SIZE && tempRect.height >= MIN_SIZE;

        if (!isDrag) {
          // Just a click in idle, no drag — drop the placeholder rectangle.
          const next = all.map((el) =>
            el.id === tempRect.id
              ? newElementWith(el, { isDeleted: true })
              : el,
          );
          excalidrawAPI.updateScene({
            elements: next,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          return;
        }

        // Step 1 — drag committed: build the cloud and arm awaitingText.
        const strokeColor = tempRect.strokeColor;
        const strokeWidth = tempRect.strokeWidth;
        const roughness = tempRect.roughness;
        const opacity = tempRect.opacity;
        const frameId = tempRect.frameId ?? null;
        const groupId = randomId();

        const cloudShape = generateCloudPoints(tempRect.width, tempRect.height);
        const cloud = newLinearElement({
          type: "line",
          x: tempRect.x,
          y: tempRect.y,
          width: cloudShape.width,
          height: cloudShape.height,
          strokeColor,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth,
          strokeStyle: "solid",
          roughness,
          opacity,
          roundness: null,
          locked: false,
          frameId,
          groupIds: [groupId],
          points: cloudShape.points,
          polygon: true,
        });

        const next: any[] = all.map((el) =>
          el.id === tempRect.id ? newElementWith(el, { isDeleted: true }) : el,
        );
        next.push(cloud);

        excalidrawAPI.updateScene({
          elements: next,
          appState: {
            selectedElementIds: { [cloud.id]: true },
            selectedGroupIds: { [groupId]: true },
          },
        });
        collabAPI?.syncElements(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );

        phaseRef.current = {
          kind: "awaitingText",
          cloudId: cloud.id,
          cloudX: cloud.x,
          cloudY: cloud.y,
          cloudPoints: cloudShape.points,
          groupId,
          strokeColor,
          strokeWidth,
          roughness,
          opacity,
          frameId,
        };
        excalidrawAPI.setToast({
          message: "Bấm vào vị trí muốn đặt ghi chú",
          closable: false,
          duration: 4000,
        });
      },
    );

    return () => {
      unsubDown();
      unsubUp();
    };
  }, [excalidrawAPI, collabAPI]);

  return null;
};

export default RevisionCloudController;
