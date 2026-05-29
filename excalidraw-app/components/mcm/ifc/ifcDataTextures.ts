// DataTexture backing store for the merged IFC material. Ported from
// the Digital Twins viewer (the buildDataTextures helper in
// IfcMergedLoader.ts).
//
// Two textures, one texel per element, indexed by the per-vertex
// `elementIndex` attribute:
//   colorTex (RGBA float): emissive rgb + intensity (highlight state)
//   flagsTex (R float):    0 visible / 0.07 ghost / 1 hidden
//
// Width is capped at 4096 (max safe texture dimension) and we wrap into
// rows beyond that — the shader's elemUV() recomputes row/col from the
// element index.

import * as THREE from "three";

export type IfcDataTextures = {
  colorTex: THREE.DataTexture;
  flagsTex: THREE.DataTexture;
  /** Per-element diffuse base colour (RGBA float), so the merged mesh
   *  preserves each IFC element's material colour instead of rendering a
   *  uniform shade. Static after load (unlike colorTex, which the
   *  MergedRenderer rewrites for highlight/selection). */
  baseColorTex: THREE.DataTexture;
  colorTexData: Float32Array;
  flagTexData: Float32Array;
  baseColorData: Float32Array;
  texWidth: number;
  texHeight: number;
};

export const buildDataTextures = (elementCount: number): IfcDataTextures => {
  const texWidth = Math.min(Math.max(1, elementCount), 4096);
  const texHeight = Math.max(1, Math.ceil(elementCount / 4096));

  const colorTexData = new Float32Array(texWidth * texHeight * 4); // RGBA
  const flagTexData = new Float32Array(texWidth * texHeight); // R only
  // Base colour defaults to white so any element the loader doesn't fill
  // renders at full diffuse (no accidental black).
  const baseColorData = new Float32Array(texWidth * texHeight * 4).fill(1);

  const colorTex = new THREE.DataTexture(
    colorTexData,
    texWidth,
    texHeight,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  colorTex.needsUpdate = true;
  colorTex.generateMipmaps = false;
  colorTex.minFilter = THREE.NearestFilter;
  colorTex.magFilter = THREE.NearestFilter;

  const flagsTex = new THREE.DataTexture(
    flagTexData,
    texWidth,
    texHeight,
    THREE.RedFormat,
    THREE.FloatType,
  );
  flagsTex.needsUpdate = true;
  flagsTex.generateMipmaps = false;
  flagsTex.minFilter = THREE.NearestFilter;
  flagsTex.magFilter = THREE.NearestFilter;

  const baseColorTex = new THREE.DataTexture(
    baseColorData,
    texWidth,
    texHeight,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  baseColorTex.needsUpdate = true;
  baseColorTex.generateMipmaps = false;
  baseColorTex.minFilter = THREE.NearestFilter;
  baseColorTex.magFilter = THREE.NearestFilter;

  return {
    colorTex,
    flagsTex,
    baseColorTex,
    colorTexData,
    flagTexData,
    baseColorData,
    texWidth,
    texHeight,
  };
};
