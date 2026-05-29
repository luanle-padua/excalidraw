// Upload-time IFC -> GLB + metadata bake step, run in a Vite module
// web worker so the main thread stays responsive during the (heavy)
// web-ifc geometry tessellation.
//
// Ported from the Digital Twins ifc-pipeline (convert-geometry.ts +
// extract-metadata.ts). Those run in Node with `Buffer`; here we open
// the model ONCE in the browser, extract geometry (for the GLB) and
// metadata in that single open, and assemble the GLB with browser APIs
// (TextEncoder / DataView / Uint8Array) instead of Node Buffer.
//
// GLB contract (a sibling loader, ifcGltfMergedLoader.ts, depends on it):
//   - one glTF node per IFC element, node.name = element GlobalId
//   - each primitive: POSITION + NORMAL + indices only (no UV)
//   - material = pbrMetallicRoughness.baseColorFactor [r,g,b,a]; when
//     a < 1 the material is alphaMode:"BLEND" so GLTFLoader marks it
//     transparent (the loader splits opaque vs transparent on that).
//   - materials deduped by color (incl. alpha).
//   - per-geometry flatTransformation is baked into vertex positions.

import { IFCBUILDINGSTOREY } from "web-ifc";
import {
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELDEFINESBYTYPE,
  IFCSPACE,
} from "web-ifc";

import { getIfcApi } from "./ifcApiSingleton";

import type { IfcAPI } from "web-ifc";

import type {
  IfcBakeRequest,
  IfcBakeResponse,
  IfcElementMeta,
  IfcMetadataPayload,
  IfcStorey,
} from "./ifcTypes";

// ── geometry types ───────────────────────────────────────────────────

type MeshData = {
  globalId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: { r: number; g: number; b: number; a: number };
};

// ── small IFC line helpers (browser ports of the DT extract-metadata) ─

type IfcLine = Record<string, unknown>;

const isObj = (value: unknown): value is IfcLine =>
  typeof value === "object" && value !== null;

const isVectorLike = (
  value: unknown,
): value is { size: () => number; get: (i: number) => unknown } =>
  isObj(value) &&
  typeof (value as { size?: unknown }).size === "function" &&
  typeof (value as { get?: unknown }).get === "function";

const wrapped = (value: unknown): unknown =>
  isObj(value) ? (value as { value?: unknown }).value : null;

const ifcString = (value: unknown): string | null => {
  const w = wrapped(value);
  return typeof w === "string" ? w : null;
};

const ifcStringOrPrimitive = (value: unknown): string | null => {
  const source = wrapped(value) ?? value;
  if (typeof source === "string") {
    const t = source.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof source === "number" && Number.isFinite(source)) {
    return String(source);
  }
  if (typeof source === "boolean") {
    return source ? "true" : "false";
  }
  return null;
};

const ifcNumber = (value: unknown): number | null => {
  const w = wrapped(value);
  return typeof w === "number" ? w : null;
};

const ifcRef = (value: unknown): number | null => {
  const w = wrapped(value);
  return typeof w === "number" ? w : null;
};

const ifcRefArray = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return value
      .map((e) => ifcRef(e))
      .filter((e): e is number => typeof e === "number");
  }
  if (isVectorLike(value)) {
    const out: number[] = [];
    for (let i = 0; i < value.size(); i += 1) {
      const r = ifcRef(value.get(i));
      if (typeof r === "number") {
        out.push(r);
      }
    }
    return out;
  }
  return [];
};

const getLineSafe = (
  api: IfcAPI,
  modelId: number,
  expressId: number,
): IfcLine | null => {
  try {
    const line = api.GetLine(modelId, expressId);
    return isObj(line) ? (line as IfcLine) : null;
  } catch {
    return null;
  }
};

const normalizeText = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const t = value.trim();
  return t.length > 0 ? t : null;
};

const getIfcTypeName = (
  api: IfcAPI,
  modelId: number,
  expressId: number,
  line: IfcLine,
): string => {
  try {
    const lineType = api.GetLineType(modelId, expressId);
    const typeName = api.GetNameFromTypeCode(lineType);
    if (typeof typeName === "string" && typeName.length > 0) {
      return typeName;
    }
  } catch {
    // fall through to best-effort extraction
  }

  const ctor = (line as { constructor?: unknown }).constructor;
  if (isObj(ctor)) {
    const ctorName = (ctor as { name?: unknown }).name;
    if (typeof ctorName === "string" && ctorName !== "Object") {
      return ctorName;
    }
  }

  const objectType = ifcString(line.ObjectType);
  if (objectType) {
    return objectType;
  }
  return "IfcElement";
};

const formatIfcTypeLabel = (raw: string): string => {
  const stripped = raw.replace(/^Ifc/i, "");
  return stripped.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
};

const splitFamilyAndType = (
  value: string | null,
): { family: string; typeName: string } | null => {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const separators = [":", " - ", " | "];
  for (const sep of separators) {
    const idx = normalized.indexOf(sep);
    if (idx <= 0 || idx >= normalized.length - sep.length) {
      continue;
    }
    const family = normalizeText(normalized.slice(0, idx));
    const typeName = normalizeText(normalized.slice(idx + sep.length));
    if (family && typeName) {
      return { family, typeName };
    }
  }
  return null;
};

const getLineString = (line: IfcLine | null, key: string): string | null =>
  line ? normalizeText(ifcString(line[key])) : null;

// ── property sets ────────────────────────────────────────────────────
//
// Unlike DT (which only picks a handful of keys) meeting-canvas wants a
// rich properties panel, so we flatten EVERY IfcPropertySingleValue into
// a Record<string, string> keyed by the property's display Name.

const getPropertySingleValue = (propertyLine: IfcLine): string | null => {
  const nominalValue = propertyLine.NominalValue;
  const direct = ifcStringOrPrimitive(nominalValue);
  if (direct) {
    return direct;
  }
  const inner = wrapped(nominalValue);
  if (!isObj(inner)) {
    return null;
  }
  return ifcStringOrPrimitive((inner as { value?: unknown }).value);
};

const extractPropertySetValues = (
  api: IfcAPI,
  modelId: number,
  propertySetExpressId: number,
): Map<string, string> => {
  const out = new Map<string, string>();
  const psetLine = getLineSafe(api, modelId, propertySetExpressId);
  if (!psetLine) {
    return out;
  }
  const propertyRefs = ifcRefArray(psetLine.HasProperties);
  for (const propExpressId of propertyRefs) {
    const propLine = getLineSafe(api, modelId, propExpressId);
    if (!propLine) {
      continue;
    }
    const name = normalizeText(ifcString(propLine.Name));
    const value = getPropertySingleValue(propLine);
    if (!name || !value) {
      continue;
    }
    // first writer wins (keep the display name verbatim for the panel)
    if (!out.has(name)) {
      out.set(name, value);
    }
  }
  return out;
};

// expressId -> { property display name -> value string }
const buildElementPropertyMap = (
  api: IfcAPI,
  modelId: number,
): Map<number, Map<string, string>> => {
  const map = new Map<number, Map<string, string>>();
  const relIds = api.GetLineIDsWithType(modelId, IFCRELDEFINESBYPROPERTIES);

  for (let i = 0; i < relIds.size(); i += 1) {
    const rel = getLineSafe(api, modelId, relIds.get(i));
    if (!rel) {
      continue;
    }
    const psetExpressId = ifcRef(rel.RelatingPropertyDefinition);
    if (psetExpressId === null) {
      continue;
    }
    const values = extractPropertySetValues(api, modelId, psetExpressId);
    if (values.size === 0) {
      continue;
    }
    const relatedRefs = ifcRefArray(rel.RelatedObjects);
    for (const relatedExpressId of relatedRefs) {
      const target = map.get(relatedExpressId) ?? new Map<string, string>();
      values.forEach((v, k) => {
        if (!target.has(k)) {
          target.set(k, v);
        }
      });
      map.set(relatedExpressId, target);
    }
  }
  return map;
};

// expressId -> RelatingType expressId
const buildElementTypeAssignmentMap = (
  api: IfcAPI,
  modelId: number,
): Map<number, number> => {
  const map = new Map<number, number>();
  const relIds = api.GetLineIDsWithType(modelId, IFCRELDEFINESBYTYPE);

  for (let i = 0; i < relIds.size(); i += 1) {
    const rel = getLineSafe(api, modelId, relIds.get(i));
    if (!rel) {
      continue;
    }
    const typeExpressId = ifcRef(rel.RelatingType);
    if (typeExpressId === null) {
      continue;
    }
    const relatedRefs = ifcRefArray(rel.RelatedObjects);
    for (const relatedExpressId of relatedRefs) {
      map.set(relatedExpressId, typeExpressId);
    }
  }
  return map;
};

// `props` is a case-insensitive lookup of the flattened Pset values used
// only to derive category / family / typeName classification.
const pickProp = (
  props: Map<string, string> | undefined,
  keys: string[],
): string | null => {
  if (!props) {
    return null;
  }
  const lower = new Map<string, string>();
  props.forEach((v, k) => lower.set(k.trim().toLowerCase(), v));
  for (const key of keys) {
    const value = lower.get(key);
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const resolveClassification = (
  elementLine: IfcLine,
  ifcType: string,
  ifcName: string,
  longName: string | null,
  typeLine: IfcLine | null,
  props: Map<string, string> | undefined,
): {
  category: string | null;
  family: string | null;
  typeName: string | null;
} => {
  const familyAndType = pickProp(props, ["family and type"]);
  const split = splitFamilyAndType(familyAndType);

  const propCategory = pickProp(props, [
    "category",
    "revit category",
    "model category",
  ]);
  const propFamily = pickProp(props, ["family", "family name", "type family"]);
  const propTypeName = pickProp(props, [
    "type",
    "type name",
    "symbol",
    "family type",
  ]);

  const typeLineName = getLineString(typeLine, "Name");
  const typeLineElementType = getLineString(typeLine, "ElementType");
  const elementObjectType = getLineString(elementLine, "ObjectType");
  const fallbackCategory = normalizeText(formatIfcTypeLabel(ifcType));

  const category = propCategory ?? fallbackCategory;
  const family =
    propFamily ??
    split?.family ??
    getLineString(typeLine, "ObjectType") ??
    fallbackCategory;
  const typeName =
    propTypeName ??
    split?.typeName ??
    typeLineName ??
    typeLineElementType ??
    elementObjectType ??
    normalizeText(longName) ??
    normalizeText(ifcName) ??
    fallbackCategory;

  return { category, family, typeName };
};

// ── metadata extraction (storeys + spatial structure + elements) ──────

const extractMetadata = (api: IfcAPI, modelId: number): IfcMetadataPayload => {
  const storeyExpressToGlobalId = new Map<number, string>();
  const storeys: IfcStorey[] = [];

  const storeyIds = api.GetLineIDsWithType(modelId, IFCBUILDINGSTOREY);
  for (let i = 0; i < storeyIds.size(); i += 1) {
    const expressId = storeyIds.get(i);
    const line = getLineSafe(api, modelId, expressId);
    if (!line) {
      continue;
    }
    const globalId = ifcString(line.GlobalId) ?? `storey-${expressId}`;
    const name = ifcString(line.Name) ?? `Storey ${storeys.length + 1}`;
    const elevation = ifcNumber(line.Elevation) ?? 0;
    storeyExpressToGlobalId.set(expressId, globalId);
    storeys.push({ id: globalId, name, elevation });
  }
  storeys.sort((a, b) => a.elevation - b.elevation);

  const spaceToStoreyExpress = new Map<number, number>();
  const elementToStoreyExpress = new Map<number, number>();

  const allSpaceExpressIds = new Set<number>();
  const spaceIds = api.GetLineIDsWithType(modelId, IFCSPACE);
  for (let i = 0; i < spaceIds.size(); i += 1) {
    allSpaceExpressIds.add(spaceIds.get(i));
  }

  // IfcRelContainedInSpatialStructure: elements/spaces directly contained
  // in a storey.
  const relIds = api.GetLineIDsWithType(
    modelId,
    IFCRELCONTAINEDINSPATIALSTRUCTURE,
  );
  for (let i = 0; i < relIds.size(); i += 1) {
    const rel = getLineSafe(api, modelId, relIds.get(i));
    if (!rel) {
      continue;
    }
    const relatingStructure = ifcRef(rel.RelatingStructure);
    if (relatingStructure === null) {
      continue;
    }
    if (!storeyExpressToGlobalId.has(relatingStructure)) {
      continue;
    }
    const related = ifcRefArray(rel.RelatedElements);
    for (const relatedExpressId of related) {
      if (allSpaceExpressIds.has(relatedExpressId)) {
        spaceToStoreyExpress.set(relatedExpressId, relatingStructure);
      } else {
        elementToStoreyExpress.set(relatedExpressId, relatingStructure);
      }
    }
  }

  // IfcRelAggregates: storey -> space decomposition.
  const aggIds = api.GetLineIDsWithType(modelId, IFCRELAGGREGATES);
  for (let i = 0; i < aggIds.size(); i += 1) {
    const rel = getLineSafe(api, modelId, aggIds.get(i));
    if (!rel) {
      continue;
    }
    const relatingObject = ifcRef(rel.RelatingObject);
    if (
      relatingObject === null ||
      !storeyExpressToGlobalId.has(relatingObject)
    ) {
      continue;
    }
    const relatedObjects = ifcRefArray(rel.RelatedObjects);
    for (const relatedExpressId of relatedObjects) {
      if (allSpaceExpressIds.has(relatedExpressId)) {
        spaceToStoreyExpress.set(relatedExpressId, relatingObject);
      }
    }
  }

  // Second pass: elements contained in a space inherit the space's storey.
  for (let i = 0; i < relIds.size(); i += 1) {
    const rel = getLineSafe(api, modelId, relIds.get(i));
    if (!rel) {
      continue;
    }
    const relatingStructure = ifcRef(rel.RelatingStructure);
    if (relatingStructure === null) {
      continue;
    }
    const storeyExpress = spaceToStoreyExpress.get(relatingStructure);
    if (storeyExpress === undefined) {
      continue;
    }
    const related = ifcRefArray(rel.RelatedElements);
    for (const relatedExpressId of related) {
      elementToStoreyExpress.set(relatedExpressId, storeyExpress);
    }
  }

  const typeAssignments = buildElementTypeAssignmentMap(api, modelId);
  const propertyMap = buildElementPropertyMap(api, modelId);

  const candidateExpressIds = new Set<number>([
    ...allSpaceExpressIds,
    ...spaceToStoreyExpress.keys(),
    ...elementToStoreyExpress.keys(),
    ...typeAssignments.keys(),
    ...propertyMap.keys(),
  ]);

  const elements: Record<string, IfcElementMeta> = {};

  candidateExpressIds.forEach((expressId) => {
    const line = getLineSafe(api, modelId, expressId);
    if (!line) {
      return;
    }
    const globalId = ifcString(line.GlobalId);
    if (!globalId) {
      return;
    }

    const type = getIfcTypeName(api, modelId, expressId, line);
    const name = ifcString(line.Name) ?? globalId;
    const longName = ifcString(line.LongName);

    const typeExpressId = typeAssignments.get(expressId) ?? null;
    const typeLine =
      typeExpressId !== null ? getLineSafe(api, modelId, typeExpressId) : null;

    const props = propertyMap.get(expressId);
    const classification = resolveClassification(
      line,
      type,
      name,
      longName,
      typeLine,
      props,
    );

    const storeyExpressId =
      elementToStoreyExpress.get(expressId) ??
      spaceToStoreyExpress.get(expressId) ??
      null;
    const storeyId =
      storeyExpressId !== null
        ? storeyExpressToGlobalId.get(storeyExpressId) ?? null
        : null;

    // Flatten every Pset value into a plain string record for the panel.
    const flatProps: Record<string, string> = {};
    props?.forEach((value, key) => {
      flatProps[key] = value;
    });

    elements[globalId] = {
      globalId,
      expressId,
      type,
      name,
      longName,
      category: classification.category,
      family: classification.family,
      typeName: classification.typeName,
      storeyId,
      props: flatProps,
    };
  });

  return { storeys, elements };
};

// ── geometry extraction ──────────────────────────────────────────────

const extractGeometry = (api: IfcAPI, modelId: number): MeshData[] => {
  const meshes: MeshData[] = [];
  const flatMeshes = api.LoadAllGeometry(modelId);

  for (let i = 0; i < flatMeshes.size(); i += 1) {
    const flatMesh = flatMeshes.get(i);
    const expressId = flatMesh.expressID;

    // GlobalId per element (geometry without a line entry falls back).
    let globalId = `e${expressId}`;
    const line = getLineSafe(api, modelId, expressId);
    const gid = line ? ifcString(line.GlobalId) : null;
    if (gid) {
      globalId = gid;
    }

    for (let j = 0; j < flatMesh.geometries.size(); j += 1) {
      const placedGeom = flatMesh.geometries.get(j);
      const geom = api.GetGeometry(modelId, placedGeom.geometryExpressID);

      const verts = api.GetVertexArray(
        geom.GetVertexData(),
        geom.GetVertexDataSize(),
      );
      const idx = api.GetIndexArray(
        geom.GetIndexData(),
        geom.GetIndexDataSize(),
      );

      if (verts.length === 0 || idx.length === 0) {
        geom.delete();
        continue;
      }

      // web-ifc interleaves vertices as [x,y,z,nx,ny,nz] (stride 6).
      const vertCount = verts.length / 6;
      const positions = new Float32Array(vertCount * 3);
      const normals = new Float32Array(vertCount * 3);

      const t = placedGeom.flatTransformation; // 4x4, column-major

      let hasNaN = false;
      for (let v = 0; v < vertCount; v += 1) {
        const px = verts[v * 6 + 0];
        const py = verts[v * 6 + 1];
        const pz = verts[v * 6 + 2];

        // Bake the placement transform into the positions.
        const x = t[0] * px + t[4] * py + t[8] * pz + t[12];
        const y = t[1] * px + t[5] * py + t[9] * pz + t[13];
        const z = t[2] * px + t[6] * py + t[10] * pz + t[14];
        positions[v * 3 + 0] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          hasNaN = true;
          break;
        }

        normals[v * 3 + 0] = verts[v * 6 + 3];
        normals[v * 3 + 1] = verts[v * 6 + 4];
        normals[v * 3 + 2] = verts[v * 6 + 5];
      }

      // web-ifc occasionally emits NaN vertices for sub-geometries it
      // failed to triangulate (it logs "bad bound" / "unexpected mesh
      // type" for these). A single NaN position poisons the whole merged
      // mesh's bounding box on the client, so the model silently fails to
      // render. Drop the degenerate sub-geometry entirely — the rest of
      // the element's geometry (and the rest of the model) is unaffected.
      if (hasNaN) {
        geom.delete();
        continue;
      }

      const color = placedGeom.color;
      meshes.push({
        globalId,
        positions,
        normals,
        // copy out of the WASM-backed view before geom.delete()
        indices: new Uint32Array(idx),
        color: { r: color.x, g: color.y, b: color.z, a: color.w },
      });

      geom.delete();
    }
  }

  return meshes;
};

// ── GLB assembly (browser port of DT's hand-written writer) ───────────
//
// GLB layout produced:
//   12-byte header: magic 'glTF' (0x46546c67) | version 2 | totalLength
//   JSON chunk:     length | type 'JSON' (0x4e4f534a) | padded JSON
//   BIN chunk:      length | type 'BIN\0' (0x004e4942) | padded binary
// The single embedded buffer holds, per mesh and in this order:
//   POSITION (f32 VEC3, target 34962)
//   NORMAL   (f32 VEC3, target 34962)
//   indices  (u32 SCALAR, target 34963)
// each block 4-byte aligned. One node per IFC element (name = GlobalId),
// all parented under a single root node.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_TYPE = 0x4e4f534a; // 'JSON'
const BIN_TYPE = 0x004e4942; // 'BIN\0'

const colorKeyOf = (c: MeshData["color"]): string =>
  `${c.r.toFixed(3)}_${c.g.toFixed(3)}_${c.b.toFixed(3)}_${c.a.toFixed(3)}`;

const writeGlb = (meshes: MeshData[]): ArrayBuffer => {
  const nodes: object[] = [];
  const meshDefs: object[] = [];
  const accessors: object[] = [];
  const bufferViews: object[] = [];
  const materials: object[] = [];
  const materialMap = new Map<string, number>();

  // Binary blocks accumulated as Uint8Array chunks, concatenated at end.
  const binChunks: Uint8Array[] = [];
  let byteOffset = 0;

  const pushBytes = (bytes: Uint8Array) => {
    binChunks.push(bytes);
    byteOffset += bytes.byteLength;
  };

  const align4 = () => {
    const padding = (4 - (byteOffset % 4)) % 4;
    if (padding > 0) {
      pushBytes(new Uint8Array(padding));
    }
  };

  for (const mesh of meshes) {
    if (mesh.positions.length === 0 || mesh.indices.length === 0) {
      continue;
    }

    // Material dedup by color (alpha included): a < 1 => BLEND so the
    // loader treats it as transparent.
    const key = colorKeyOf(mesh.color);
    if (!materialMap.has(key)) {
      materialMap.set(key, materials.length);
      const transparent = mesh.color.a < 1;
      materials.push({
        pbrMetallicRoughness: {
          baseColorFactor: [
            mesh.color.r,
            mesh.color.g,
            mesh.color.b,
            mesh.color.a,
          ],
          metallicFactor: 0.1,
          roughnessFactor: 0.8,
        },
        ...(transparent ? { alphaMode: "BLEND" } : {}),
        doubleSided: true,
      });
    }

    // POSITION
    const posBytes = new Uint8Array(
      mesh.positions.buffer,
      mesh.positions.byteOffset,
      mesh.positions.byteLength,
    );
    const posViewIdx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: posBytes.byteLength,
      target: 34962,
    });
    pushBytes(posBytes);

    const minPos = [Infinity, Infinity, Infinity];
    const maxPos = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let j = 0; j < 3; j += 1) {
        const value = mesh.positions[i + j];
        if (value < minPos[j]) {
          minPos[j] = value;
        }
        if (value > maxPos[j]) {
          maxPos[j] = value;
        }
      }
    }
    const posAccIdx = accessors.length;
    accessors.push({
      bufferView: posViewIdx,
      componentType: 5126, // FLOAT
      count: mesh.positions.length / 3,
      type: "VEC3",
      min: minPos,
      max: maxPos,
    });

    // NORMAL
    const normBytes = new Uint8Array(
      mesh.normals.buffer,
      mesh.normals.byteOffset,
      mesh.normals.byteLength,
    );
    const normViewIdx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: normBytes.byteLength,
      target: 34962,
    });
    pushBytes(normBytes);

    const normAccIdx = accessors.length;
    accessors.push({
      bufferView: normViewIdx,
      componentType: 5126, // FLOAT
      count: mesh.normals.length / 3,
      type: "VEC3",
    });

    // indices
    const idxBytes = new Uint8Array(
      mesh.indices.buffer,
      mesh.indices.byteOffset,
      mesh.indices.byteLength,
    );
    const idxViewIdx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: idxBytes.byteLength,
      target: 34963,
    });
    pushBytes(idxBytes);

    const idxAccIdx = accessors.length;
    accessors.push({
      bufferView: idxViewIdx,
      componentType: 5125, // UNSIGNED_INT
      count: mesh.indices.length,
      type: "SCALAR",
    });

    align4();

    const meshIdx = meshDefs.length;
    meshDefs.push({
      primitives: [
        {
          attributes: { POSITION: posAccIdx, NORMAL: normAccIdx },
          indices: idxAccIdx,
          material: materialMap.get(key),
        },
      ],
    });

    nodes.push({ name: mesh.globalId, mesh: meshIdx });
  }

  // Root node parents every element node.
  const rootNodeIdx = nodes.length;
  nodes.push({
    name: "IfcModel",
    children: Array.from({ length: rootNodeIdx }, (_, i) => i),
  });

  const gltf = {
    asset: { version: "2.0", generator: "meeting-canvas-ifc-bake" },
    scene: 0,
    scenes: [{ nodes: [rootNodeIdx] }],
    nodes,
    meshes: meshDefs,
    accessors,
    bufferViews,
    materials,
    buffers: [{ byteLength: byteOffset }],
  };

  // JSON chunk (pad with spaces to 4-byte alignment).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const paddedJson = new Uint8Array(jsonBytes.byteLength + jsonPad);
  paddedJson.set(jsonBytes, 0);
  paddedJson.fill(0x20, jsonBytes.byteLength); // space padding

  // BIN chunk (already 4-byte aligned via align4()).
  const binLength = byteOffset;
  const bin = new Uint8Array(binLength);
  let cursor = 0;
  for (const chunk of binChunks) {
    bin.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  // header(12) + JSON chunk header(8) + JSON + BIN chunk header(8) + BIN
  const totalLength = 12 + 8 + paddedJson.byteLength + 8 + bin.byteLength;

  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  let p = 0;
  // GLB header
  view.setUint32(p, GLB_MAGIC, true);
  p += 4;
  view.setUint32(p, 2, true); // version
  p += 4;
  view.setUint32(p, totalLength, true);
  p += 4;

  // JSON chunk
  view.setUint32(p, paddedJson.byteLength, true);
  p += 4;
  view.setUint32(p, JSON_TYPE, true);
  p += 4;
  bytes.set(paddedJson, p);
  p += paddedJson.byteLength;

  // BIN chunk
  view.setUint32(p, bin.byteLength, true);
  p += 4;
  view.setUint32(p, BIN_TYPE, true);
  p += 4;
  bytes.set(bin, p);

  return out;
};

// ── worker entry ─────────────────────────────────────────────────────

const bake = async (
  data: ArrayBuffer,
): Promise<{
  glb: ArrayBuffer;
  metadata: IfcMetadataPayload;
  elementCount: number;
}> => {
  const api = await getIfcApi();

  // Open the model ONCE; extract both geometry and metadata, then close.
  const modelId = api.OpenModel(new Uint8Array(data), {
    COORDINATE_TO_ORIGIN: true,
    CIRCLE_SEGMENTS: 6,
  });

  try {
    const meshes = extractGeometry(api, modelId);
    const metadata = extractMetadata(api, modelId);
    const glb = writeGlb(meshes);
    const elementCount = new Set(meshes.map((m) => m.globalId)).size;
    return { glb, metadata, elementCount };
  } finally {
    api.CloseModel(modelId);
  }
};

self.onmessage = async (event: MessageEvent<IfcBakeRequest>) => {
  const { id, ifc } = event.data;
  try {
    const { glb, metadata, elementCount } = await bake(ifc);
    const response: IfcBakeResponse = {
      id,
      ok: true,
      glb,
      metadata,
      elementCount,
    };
    (self as unknown as Worker).postMessage(response, [glb]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response: IfcBakeResponse = { id, ok: false, error: message };
    (self as unknown as Worker).postMessage(response);
  }
};
