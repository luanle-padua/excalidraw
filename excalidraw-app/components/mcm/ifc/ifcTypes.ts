// Shared types for the IFC viewer. The bake worker produces a GLB +
// this metadata payload; the loader, renderer, properties panel and
// storey tree all consume it.

export type IfcStorey = {
  /** IFC GlobalId of the IfcBuildingStorey. */
  id: string;
  name: string;
  elevation: number;
};

export type IfcElementMeta = {
  globalId: string;
  expressId: number;
  /** IFC entity type, e.g. "IfcWall". */
  type: string;
  name: string;
  longName: string | null;
  category: string | null;
  family: string | null;
  typeName: string | null;
  /** GlobalId of the containing storey, or null if unplaced. */
  storeyId: string | null;
  /** Flattened "Pset name → value" pairs for the properties panel. */
  props: Record<string, string>;
};

export type IfcMetadataPayload = {
  storeys: IfcStorey[];
  /** Keyed by element GlobalId. */
  elements: Record<string, IfcElementMeta>;
};

/** Worker request: raw IFC bytes (ArrayBuffer is transferred). */
export type IfcBakeRequest = {
  id: string;
  ifc: ArrayBuffer;
};

/** Worker success response: GLB bytes (transferred) + metadata. */
export type IfcBakeResponse =
  | {
      id: string;
      ok: true;
      glb: ArrayBuffer;
      metadata: IfcMetadataPayload;
      elementCount: number;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };
