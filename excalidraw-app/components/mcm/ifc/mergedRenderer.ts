// Per-element visual state renderer for the merged-geometry IFC scene.
// Ported (and simplified) from the Digital Twins viewer's
// MergedRenderer (apps/client/src/components/viewer/MergedRenderer.ts).
//
// Instead of touching per-mesh materials, this writes directly into the
// two DataTexture backing arrays that the merged shader reads each
// frame: changing the selection or hiding an element becomes a single
// texel write + a `needsUpdate` flag, not an O(N) material traversal.
//
//   colorTex (RGBA float): .rgb = emissive colour, .a = intensity
//   flagsTex (R float):    0 visible / 0.07 ghost / 1 hidden
//
// Simplified vs DT: no heatmap, pins, sensors, room-spaces or
// selection-sets. Just single-selection highlight + hide + ghost +
// storey isolation.

import type * as THREE from "three";

const HIGHLIGHT_HEX = 0xff8c42;
const HIGHLIGHT_INTENSITY = 0.55;

/**
 * Live state the renderer needs to compute per-element visuals. Passed
 * as getters / live references so the renderer always reads the current
 * scene state without coupling to whatever owns it.
 */
export interface MergedRendererContext {
  /** GlobalId of the single selected element, or null. */
  getSelectedId: () => string | null;
  /** GlobalIds explicitly hidden by the user. */
  hiddenObjectIds: Set<string>;
  /** When true, everything but the selected element renders as a ghost. */
  getGhostMode: () => boolean;
  /** Storey GlobalId to isolate to, or null for "show all storeys". */
  getIsolatedStoreyId: () => string | null;
  /** element GlobalId → containing storey GlobalId. */
  elementStorey: Map<string, string>;
  /** Request a render on the next animation frame. */
  setNeedsRender: () => void;
}

export class MergedRenderer {
  private readonly ctx: MergedRendererContext;
  private readonly colorTexData: Float32Array;
  private readonly flagTexData: Float32Array;
  private readonly colorTex: THREE.DataTexture;
  private readonly flagsTex: THREE.DataTexture;
  private readonly elementIndexByGlobalId: Map<string, number>;

  constructor(
    ctx: MergedRendererContext,
    colorTexData: Float32Array,
    flagTexData: Float32Array,
    colorTex: THREE.DataTexture,
    flagsTex: THREE.DataTexture,
    elementIndexByGlobalId: Map<string, number>,
  ) {
    this.ctx = ctx;
    this.colorTexData = colorTexData;
    this.flagTexData = flagTexData;
    this.colorTex = colorTex;
    this.flagsTex = flagsTex;
    this.elementIndexByGlobalId = elementIndexByGlobalId;
  }

  /** Recompute one element's texels from current context state. */
  refresh(id: string): void {
    const idx = this.elementIndexByGlobalId.get(id);
    if (idx === undefined) {
      return;
    }

    const ctx = this.ctx;

    // ── Visibility ───────────────────────────────────────────────────
    const isolatedStoreyId = ctx.getIsolatedStoreyId();
    const isHiddenByIsolation =
      isolatedStoreyId !== null &&
      ctx.elementStorey.get(id) !== isolatedStoreyId;
    const isHidden = ctx.hiddenObjectIds.has(id) || isHiddenByIsolation;

    if (isHidden) {
      this.flagTexData[idx] = 1.0;
      this.colorTexData[idx * 4] = 0;
      this.colorTexData[idx * 4 + 1] = 0;
      this.colorTexData[idx * 4 + 2] = 0;
      this.colorTexData[idx * 4 + 3] = 0;
      this.markDirty();
      return;
    }

    // ── Ghost mode ───────────────────────────────────────────────────
    const selectedId = ctx.getSelectedId();
    const isSelected = id === selectedId;
    const ghostMode = ctx.getGhostMode();

    if (ghostMode && selectedId && !isSelected) {
      this.flagTexData[idx] = 0.07; // ghost opacity value read by shader
    } else {
      this.flagTexData[idx] = 0.0;
    }

    // ── Emissive (selection highlight only) ──────────────────────────
    let r = 0;
    let g = 0;
    let b = 0;
    let intensity = 0;

    if (isSelected) {
      r = ((HIGHLIGHT_HEX >> 16) & 0xff) / 255;
      g = ((HIGHLIGHT_HEX >> 8) & 0xff) / 255;
      b = (HIGHLIGHT_HEX & 0xff) / 255;
      intensity = HIGHLIGHT_INTENSITY;
    }
    // else: all zeros → no emissive, IFC base colour shows through

    this.colorTexData[idx * 4] = r;
    this.colorTexData[idx * 4 + 1] = g;
    this.colorTexData[idx * 4 + 2] = b;
    this.colorTexData[idx * 4 + 3] = intensity;

    this.markDirty();
  }

  /** Recompute every element (e.g. after a global state flip). */
  refreshAll(): void {
    this.elementIndexByGlobalId.forEach((_idx, id) => this.refresh(id));
    // markDirty is called by each refresh(); textures are already flagged.
  }

  /** Note: the DataTextures are owned by the loaded model and disposed
   *  by the renderer's full teardown — we only flag them dirty here. */
  private markDirty(): void {
    this.colorTex.needsUpdate = true;
    this.flagsTex.needsUpdate = true;
    this.ctx.setNeedsRender();
  }
}
