// Element picking for the merged-geometry IFC scene. Ported from the
// Digital Twins viewer (apps/client/src/components/viewer/IfcPicker.ts).
//
// The merged meshes carry a per-vertex `elementIndex` attribute rather
// than per-object names. After a raycast hit we read the attribute on
// the first vertex of the intersected triangle to identify the element,
// then map it back to its IFC GlobalId. Hidden elements (flag > 0.75 in
// the GPU visibility texture) are skipped so you can't pick something
// you can't see.

import type * as THREE from "three";

export const pickIfcElement = (
  raycaster: THREE.Raycaster,
  meshes: Array<THREE.Mesh | null>,
  globalIdByElementIndex: string[],
  flagTexData: Float32Array,
): string | null => {
  const validMeshes = meshes.filter((m): m is THREE.Mesh => m !== null);
  if (validMeshes.length === 0) {
    return null;
  }

  const hits = raycaster.intersectObjects(validMeshes, false);

  for (const hit of hits) {
    if (!hit.face) {
      continue;
    }

    const mesh = hit.object as THREE.Mesh;
    const elemAttr = mesh.geometry.getAttribute("elementIndex") as
      | THREE.BufferAttribute
      | undefined;
    if (!elemAttr) {
      continue;
    }

    const elementIndex = elemAttr.getX(hit.face.a);

    if (
      flagTexData[elementIndex] !== undefined &&
      flagTexData[elementIndex] > 0.75
    ) {
      continue;
    }

    const globalId = globalIdByElementIndex[elementIndex];
    if (globalId) {
      return globalId;
    }
  }

  return null;
};
