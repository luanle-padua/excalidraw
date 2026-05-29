// Bakes a static PNG thumbnail of an IFC model at UPLOAD time, so a
// placed IFC shows its 3D model immediately instead of a blank tile (the
// live <IFCRenderer /> only spins up when the model is opened/focused).
//
// We reuse the same GLB -> merged-model parse the live viewer uses
// (loadIfcMergedFromGlb) and copy IFCRenderer's scene setup: its
// hemisphere + ambient + directional lights and its `fitToModel` iso
// camera math (direction (1, 0.8, 1), distance derived from the model
// radius + fov). The result is one off-screen render read back as a data
// URL.
//
// WebGL contexts are scarce, so this owns exactly one short-lived context
// and disposes everything (geometries, materials, textures, renderer +
// forced context loss) before returning. A thumbnail is a nicety, never a
// hard requirement: every failure path returns null and never throws, so
// a bad bake can't break the upload.

import { loadIfcMergedFromGlb } from "./ifcGltfMergedLoader";

// Lighting constants — copied from IFCRenderer so the thumbnail matches
// the live viewer's neutral studio lighting (IFC base colours read true).
const HEMI_SKY = 0xffffff;
const HEMI_GROUND = 0x888888;
const DIR_INTENSITY = 0.8;
const AMBIENT_INTENSITY = 0.6;

// Off-screen render size (4:3, matches the camera aspect below).
const THUMB_WIDTH = 512;
const THUMB_HEIGHT = 384;

/**
 * Render a one-off PNG thumbnail of the baked IFC GLB.
 * @returns a `data:image/png` URL, or null on any failure.
 */
export const bakeIfcThumbnail = async (
  glb: ArrayBuffer,
): Promise<string | null> => {
  const THREE = await import("three");

  let renderer: import("three").WebGLRenderer | null = null;
  let model: Awaited<ReturnType<typeof loadIfcMergedFromGlb>> | null = null;

  try {
    model = await loadIfcMergedFromGlb(glb);

    // Detached canvas + renderer. preserveDrawingBuffer MUST be true:
    // without it the buffer can be cleared after compositing and
    // toDataURL() reads back blank.
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(THUMB_WIDTH, THUMB_HEIGHT, false);
    renderer.setClearColor(0x000000, 0); // transparent

    const scene = new THREE.Scene();

    // Lighting — same hemisphere + ambient fill + key directional as the
    // live renderer.
    const hemi = new THREE.HemisphereLight(
      HEMI_SKY,
      HEMI_GROUND,
      AMBIENT_INTENSITY,
    );
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, DIR_INTENSITY);
    dir.position.set(1, 2, 1.5);
    scene.add(dir);

    if (model.mergedOpaque) {
      scene.add(model.mergedOpaque);
    }
    if (model.mergedTransparent) {
      scene.add(model.mergedTransparent);
    }

    const camera = new THREE.PerspectiveCamera(
      50,
      THUMB_WIDTH / THUMB_HEIGHT,
      0.1,
      1e6,
    );

    // Fit-to-model — same math as IFCRenderer.fitToModel (padding 1.2).
    const box = model.modelBounds;
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (radius * 1.2) / Math.sin(fov / 2);
      const camDir = new THREE.Vector3(1, 0.8, 1).normalize();
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.near = Math.max(dist / 1000, 0.01);
      camera.far = dist * 1000;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
    }

    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl;
  } catch (error) {
    console.error("[ifcThumbnail] failed to bake thumbnail", error);
    return null;
  } finally {
    // Free every GPU resource promptly — WebGL contexts are scarce.
    if (model) {
      for (const m of [model.mergedOpaque, model.mergedTransparent]) {
        if (!m) {
          continue;
        }
        m.geometry.dispose();
        const mat = m.material as
          | import("three").Material
          | import("three").Material[];
        if (Array.isArray(mat)) {
          mat.forEach((mm) => mm.dispose());
        } else {
          mat.dispose();
        }
      }
      model.colorTex.dispose();
      model.flagsTex.dispose();
      model.baseColorTex.dispose();
    }
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss?.();
    }
  }
};
