// Loads the pre-baked GLB (produced by the upload-time bake worker) and
// reshapes it into the Digital Twins merged-geometry form: two meshes
// (opaque + transparent) carrying a per-vertex `elementIndex` attribute,
// plus the DataTextures the shader reads.
//
// Why GLB instead of parsing IFC here (as DT's IfcMergedLoader does):
// meeting-canvas syncs files peer-to-peer, so we bake IFC -> GLB once on
// upload (small payload) and every peer loads the GLB. The GLB encodes
// one node per IFC element, named by its GlobalId (mirrors DT's
// ifc-pipeline convert-geometry output). We assign each GlobalId a
// compact elementIndex and merge — giving DT's 2-draw-call render while
// keeping transport light.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { buildDataTextures as buildTextures } from "./ifcDataTextures";
import { createIfcMaterial } from "./shaders/ifcMaterial";

export type IfcMergedModel = {
  /** Opaque merged mesh (all elements with material alpha = 1). */
  mergedOpaque: THREE.Mesh | null;
  /** Transparent merged mesh (material alpha < 1). */
  mergedTransparent: THREE.Mesh | null;

  /** RGBA float per element: emissive [r, g, b, intensity]. */
  colorTexData: Float32Array;
  /** Single float per element: 0 visible / 0.07 ghost / 1 hidden. */
  flagTexData: Float32Array;
  colorTex: THREE.DataTexture;
  flagsTex: THREE.DataTexture;
  /** Per-element diffuse base colour texture (static after load). */
  baseColorTex: THREE.DataTexture;

  /** GlobalId -> compact element index [0, N). */
  elementIndexByGlobalId: Map<string, number>;
  /** Compact element index -> GlobalId. */
  globalIdByElementIndex: string[];

  /** Per-element world-space AABB (camera-fit, storey isolation). */
  elementBBoxes: THREE.Box3[];
  /** Whole-model bounds for the initial camera fit. */
  modelBounds: THREE.Box3;

  elementCount: number;
};

const isMesh = (o: THREE.Object3D): o is THREE.Mesh =>
  (o as THREE.Mesh).isMesh === true;

const materialIsTransparent = (mat: THREE.Material | THREE.Material[]): boolean => {
  const m = Array.isArray(mat) ? mat[0] : mat;
  if (!m) {
    return false;
  }
  const std = m as THREE.MeshStandardMaterial;
  return std.transparent === true || (std.opacity !== undefined && std.opacity < 1);
};

/** Parse a GLB ArrayBuffer into the merged model form. */
export const loadIfcMergedFromGlb = async (
  glb: ArrayBuffer,
): Promise<IfcMergedModel> => {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(glb, "");

  let elementCounter = 0;
  const elementIndexByGlobalId = new Map<string, number>();
  const globalIdByElementIndex: string[] = [];
  const elementBBoxes: THREE.Box3[] = [];
  const modelBounds = new THREE.Box3();

  const opaqueGeoms: THREE.BufferGeometry[] = [];
  const transparentGeoms: THREE.BufferGeometry[] = [];
  const bboxVec = new THREE.Vector3();
  // Per-element diffuse colour [r,g,b] in 0..1, captured from each
  // element's GLTF material so the merged mesh keeps real IFC colours.
  const baseColorByIndex: Array<[number, number, number]> = [];

  gltf.scene.updateMatrixWorld(true);

  gltf.scene.traverse((obj) => {
    if (!isMesh(obj)) {
      return;
    }
    const globalId = obj.name;
    if (!globalId) {
      return;
    }

    // Compact per-element index (same id can span multiple primitives).
    let elementIdx = elementIndexByGlobalId.get(globalId);
    if (elementIdx === undefined) {
      elementIdx = elementCounter++;
      elementIndexByGlobalId.set(globalId, elementIdx);
      globalIdByElementIndex[elementIdx] = globalId;
      elementBBoxes[elementIdx] = new THREE.Box3();
    }

    // Capture the element's diffuse colour once (first primitive wins).
    if (!baseColorByIndex[elementIdx]) {
      const mat = (
        Array.isArray(obj.material) ? obj.material[0] : obj.material
      ) as THREE.MeshStandardMaterial | undefined;
      const c = mat?.color;
      baseColorByIndex[elementIdx] = c ? [c.r, c.g, c.b] : [1, 1, 1];
    }

    // Bake the node's world transform into the geometry so the merged
    // mesh needs no per-element matrix. Clear the GLTFLoader-set bounds
    // first: degenerate sub-geometries carry NaN accessor min/max, and
    // applyMatrix4 would otherwise recompute + warn on them in the
    // console before our NaN guard below skips them. The bounds are
    // rebuilt from the merged geometry anyway.
    const geom = (obj.geometry as THREE.BufferGeometry).clone();
    geom.boundingBox = null;
    geom.boundingSphere = null;
    geom.applyMatrix4(obj.matrixWorld);

    // Drop attributes that would break a heterogeneous merge — we only
    // keep position + normal (+ the elementIndex we add below).
    for (const name of Object.keys(geom.attributes)) {
      if (name !== "position" && name !== "normal") {
        geom.deleteAttribute(name);
      }
    }
    if (!geom.getAttribute("normal")) {
      geom.computeVertexNormals();
    }

    const vertexCount = geom.getAttribute("position").count;
    const elemIndices = new Uint32Array(vertexCount).fill(elementIdx);
    geom.setAttribute("elementIndex", new THREE.BufferAttribute(elemIndices, 1));

    // Expand per-element + whole-model AABB, and defend against NaN
    // positions. The bake worker drops degenerate (NaN) sub-geometries,
    // but a GLB baked before that fix — or any malformed input — could
    // still carry NaN, and a single NaN poisons the merged bounding box
    // so the entire model fails to render. Skip any such geometry here.
    const posAttr = geom.getAttribute("position") as THREE.BufferAttribute;
    const box = elementBBoxes[elementIdx];
    let geomHasNaN = false;
    for (let v = 0; v < vertexCount; v++) {
      bboxVec.fromBufferAttribute(posAttr, v);
      if (
        !Number.isFinite(bboxVec.x) ||
        !Number.isFinite(bboxVec.y) ||
        !Number.isFinite(bboxVec.z)
      ) {
        geomHasNaN = true;
        break;
      }
      box.expandByPoint(bboxVec);
      modelBounds.expandByPoint(bboxVec);
    }
    if (geomHasNaN) {
      geom.dispose();
      return;
    }

    if (materialIsTransparent(obj.material)) {
      transparentGeoms.push(geom);
    } else {
      opaqueGeoms.push(geom);
    }
  });

  const {
    colorTex,
    flagsTex,
    baseColorTex,
    colorTexData,
    flagTexData,
    baseColorData,
    texWidth,
    texHeight,
  } = buildTextures(elementCounter);

  // Fill the per-element base-colour texels from the captured materials.
  for (let i = 0; i < elementCounter; i++) {
    const c = baseColorByIndex[i] ?? [1, 1, 1];
    baseColorData[i * 4 + 0] = c[0];
    baseColorData[i * 4 + 1] = c[1];
    baseColorData[i * 4 + 2] = c[2];
    baseColorData[i * 4 + 3] = 1;
  }
  baseColorTex.needsUpdate = true;

  const mergedOpaque = buildMergedMesh(
    opaqueGeoms,
    false,
    colorTex,
    flagsTex,
    baseColorTex,
    texWidth,
    texHeight,
  );
  const mergedTransparent = buildMergedMesh(
    transparentGeoms,
    true,
    colorTex,
    flagsTex,
    baseColorTex,
    texWidth,
    texHeight,
  );

  return {
    mergedOpaque,
    mergedTransparent,
    colorTexData,
    flagTexData,
    colorTex,
    flagsTex,
    baseColorTex,
    elementIndexByGlobalId,
    globalIdByElementIndex,
    elementBBoxes,
    modelBounds,
    elementCount: elementCounter,
  };
};

// ── helpers ──────────────────────────────────────────────────────────

const buildMergedMesh = (
  geoms: THREE.BufferGeometry[],
  transparent: boolean,
  colorTex: THREE.DataTexture,
  flagsTex: THREE.DataTexture,
  baseColorTex: THREE.DataTexture,
  texWidth: number,
  texHeight: number,
): THREE.Mesh | null => {
  if (geoms.length === 0) {
    return null;
  }
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) {
    geoms.forEach((g) => g.dispose());
  }
  const mat = createIfcMaterial(
    colorTex,
    flagsTex,
    baseColorTex,
    texWidth,
    texHeight,
    transparent,
  );
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = transparent ? "__ifc_transparent__" : "__ifc_opaque__";
  mesh.frustumCulled = false;
  return mesh;
};
