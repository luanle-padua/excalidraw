// Geometry helpers for revision-cloud and revision-number-tag generation.
// Outputs LocalPoint tuples [x, y] relative to the element's own (x, y).

import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";

const TARGET_BUMP_SIZE = 48;
const SEGMENTS_PER_BUMP = 10;
// Bumps extend this fraction of the chord length out from the bbox edge.
// 1.0 = perfect semicircle. <1 looks more like soft scallops; >1 looks
// inflated. 1.0 is the architectural-drawing convention.
const BUMP_HEIGHT_RATIO = 1.0;

const semiCircleSegment = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  outwardX: number,
  outwardY: number,
  segments: number,
): LocalPoint[] => {
  // For a true semicircle the arc center is the chord midpoint and the
  // radius is half the chord length. We sample angles from 0..π and place
  // each point at midpoint + (along-chord) * cos + (outward) * sin so the
  // arc bulges in the chosen outward direction regardless of chord
  // orientation or y-axis convention (screen y is flipped vs math).
  const cx = (fromX + toX) / 2;
  const cy = (fromY + toY) / 2;
  const halfDx = (toX - fromX) / 2;
  const halfDy = (toY - fromY) / 2;
  const radius = Math.hypot(halfDx, halfDy);
  // unit vector along chord (from -> to)
  const axX = halfDx / radius;
  const axY = halfDy / radius;
  // outward unit vector (caller passes a unit-ish vector)
  const outLen = Math.hypot(outwardX, outwardY) || 1;
  const oX = outwardX / outLen;
  const oY = outwardY / outLen;

  const out: LocalPoint[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    // θ goes from π → 0 as t goes 0 → 1, so cos(θ) goes -1 → +1: at t=0
    // we sit at "from" (along=-1 unit toward "to"), at t=1 we sit at "to"
    // (along=+1), and at t=0.5 we sit at the apex (perp=+1 outward).
    const theta = Math.PI * (1 - t);
    const along = Math.cos(theta);
    const perp = Math.sin(theta) * BUMP_HEIGHT_RATIO;
    const px = cx + axX * along * radius + oX * perp * radius;
    const py = cy + axY * along * radius + oY * perp * radius;
    out.push(pointFrom<LocalPoint>(px, py));
  }
  return out;
};

// ------------------------------------------------------------------
// Scene pointer event bus
//
// Excalidraw exposes onPointerDown/Up via its imperative API but not a
// scene-coords mouse-move stream — we need that to track the cursor while
// the user is choosing where to drop the revision-cloud note. App.tsx
// wraps the editor's `onPointerUpdate` prop and routes each update into
// this bus; the controller subscribes for the duration of the awaiting-
// text phase.
// ------------------------------------------------------------------
type ScenePointerHandler = (x: number, y: number) => void;
const pointerSubs = new Set<ScenePointerHandler>();

export const subscribeScenePointer = (
  handler: ScenePointerHandler,
): (() => void) => {
  pointerSubs.add(handler);
  return () => {
    pointerSubs.delete(handler);
  };
};

export const emitScenePointer = (x: number, y: number) => {
  for (const sub of pointerSubs) {
    sub(x, y);
  }
};

// ------------------------------------------------------------------
// Nearest-point lookup on the generated cloud polyline. Used to snap the
// arrow tip onto the closest scallop instead of always anchoring at the
// top-right corner.
// ------------------------------------------------------------------
export const findNearestCloudPoint = (
  cloudX: number,
  cloudY: number,
  cloudPoints: readonly LocalPoint[],
  targetX: number,
  targetY: number,
): { x: number; y: number } => {
  let bestX = cloudX + cloudPoints[0][0];
  let bestY = cloudY + cloudPoints[0][1];
  let bestDist = Infinity;
  for (const [lx, ly] of cloudPoints) {
    const sx = cloudX + lx;
    const sy = cloudY + ly;
    const dx = sx - targetX;
    const dy = sy - targetY;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestX = sx;
      bestY = sy;
    }
  }
  return { x: bestX, y: bestY };
};

export type CloudShape = {
  /** Polyline points relative to the cloud element's (x, y) — the first
   *  point is always (0, 0) to satisfy Excalidraw's linear-element
   *  normalization invariant (LinearElementEditor enforces it). Bump
   *  apexes on the top and left edges have *negative* coordinates,
   *  which is supported by Excalidraw (see e.g. chart axis lines). */
  points: LocalPoint[];
  /** Logical width/height of the cloud — matches the bbox the user
   *  dragged. The visible cloud extends ~bumpRadius beyond this on each
   *  side; selection/hit-test sticks to the logical bbox to keep things
   *  intuitive when grabbing nearby. */
  width: number;
  height: number;
};

export const generateCloudPoints = (
  bboxWidth: number,
  bboxHeight: number,
): CloudShape => {
  // At least 2 bumps per side; scale with bbox so big clouds get more bumps.
  const bumpsX = Math.max(2, Math.round(bboxWidth / TARGET_BUMP_SIZE));
  const bumpsY = Math.max(2, Math.round(bboxHeight / TARGET_BUMP_SIZE));
  const bumpW = bboxWidth / bumpsX;
  const bumpH = bboxHeight / bumpsY;

  // Points are kept relative to the bbox top-left (0, 0). The polyline
  // walks the perimeter and the bump apexes on the top/left edges sit
  // at negative offsets — Excalidraw renders them just fine.
  const points: LocalPoint[] = [pointFrom<LocalPoint>(0, 0)];

  // Top edge: left → right, bumps bulge up (-y).
  for (let i = 0; i < bumpsX; i++) {
    points.push(
      ...semiCircleSegment(
        i * bumpW,
        0,
        (i + 1) * bumpW,
        0,
        0,
        -1,
        SEGMENTS_PER_BUMP,
      ),
    );
  }
  // Right edge: top → bottom, bumps bulge right (+x).
  for (let i = 0; i < bumpsY; i++) {
    points.push(
      ...semiCircleSegment(
        bboxWidth,
        i * bumpH,
        bboxWidth,
        (i + 1) * bumpH,
        1,
        0,
        SEGMENTS_PER_BUMP,
      ),
    );
  }
  // Bottom edge: right → left, bumps bulge down (+y).
  for (let i = 0; i < bumpsX; i++) {
    points.push(
      ...semiCircleSegment(
        bboxWidth - i * bumpW,
        bboxHeight,
        bboxWidth - (i + 1) * bumpW,
        bboxHeight,
        0,
        1,
        SEGMENTS_PER_BUMP,
      ),
    );
  }
  // Left edge: bottom → top, bumps bulge left (-x).
  for (let i = 0; i < bumpsY; i++) {
    points.push(
      ...semiCircleSegment(
        0,
        bboxHeight - i * bumpH,
        0,
        bboxHeight - (i + 1) * bumpH,
        -1,
        0,
        SEGMENTS_PER_BUMP,
      ),
    );
  }

  return {
    points,
    width: bboxWidth,
    height: bboxHeight,
  };
};
