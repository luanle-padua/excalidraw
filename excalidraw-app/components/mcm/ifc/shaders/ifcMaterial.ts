// Merged-geometry IFC material. Ported from the Digital Twins viewer
// (apps/client/src/components/viewer/shaders/IfcMaterial.ts).
//
// A MeshStandardMaterial whose per-element emissive (highlight) and
// visibility (hide / ghost) are driven by two DataTextures indexed by a
// per-vertex `elementIndex` attribute. This is the speed trick: the
// whole model renders as ONE mesh (one draw call per transparency
// bucket), and changing the selection / hiding an element is a single
// texel write instead of touching per-mesh materials.
//
//   colorTex  (RGBA float, N texels): .rgb = emissive colour,
//                                     .a   = emissive intensity [0..1]
//   flagsTex  (R float,    N texels): 0.0  = visible
//                                     0.07 = ghost (low opacity)
//                                     1.0  = hidden (fragment discarded)

import * as THREE from "three";

export const createIfcMaterial = (
  colorTex: THREE.DataTexture,
  flagsTex: THREE.DataTexture,
  baseColorTex: THREE.DataTexture,
  texWidth: number,
  texHeight: number,
  transparent = false,
): THREE.MeshStandardMaterial => {
  const mat = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    transparent,
    opacity: 1.0,
    roughness: 0.7,
    metalness: 0.0,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uColorTex = { value: colorTex };
    shader.uniforms.uFlagsTex = { value: flagsTex };
    shader.uniforms.uBaseColorTex = { value: baseColorTex };
    shader.uniforms.uTexWidth = { value: texWidth };
    shader.uniforms.uTexHeight = { value: texHeight };
    // uClay > 0.5 → ignore per-element colour and render a uniform clay
    // shade (the "white model" coordination look). Flipped live by the
    // renderer's setViewStyle via the captured shader below.
    shader.uniforms.uClay = { value: 0 };
    // Capture the compiled shader so setViewStyle can mutate uClay after
    // the material is built.
    mat.userData.ifcShader = shader;

    // Vertex shader: forward the integer elementIndex to the fragment
    // stage as a float varying.
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      /* glsl */ `
#include <common>
attribute uint elementIndex;
varying float vElementIndex;
`,
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
#include <begin_vertex>
vElementIndex = float(elementIndex);
`,
    );

    // Fragment shader: look up the per-element state from the two
    // DataTextures and apply it.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      /* glsl */ `
#include <common>
uniform sampler2D uColorTex;
uniform sampler2D uFlagsTex;
uniform sampler2D uBaseColorTex;
uniform float uTexWidth;
uniform float uTexHeight;
uniform float uClay;
varying float vElementIndex;

vec2 elemUV(float idx) {
  float col = mod(idx, uTexWidth);
  float row = floor(idx / uTexWidth);
  return vec2((col + 0.5) / uTexWidth, (row + 0.5) / uTexHeight);
}
`,
    );

    // Replace the uniform material diffuse with the element's own IFC
    // base colour (looked up per fragment from the base-colour texture),
    // so the merged mesh shows real materials rather than one flat shade.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      /* glsl */ `
#include <map_fragment>
diffuseColor.rgb = texture2D(uBaseColorTex, elemUV(vElementIndex)).rgb;
if (uClay > 0.5) { diffuseColor.rgb = vec3(0.82, 0.80, 0.78); }
`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `
vec2 eUV       = elemUV(vElementIndex);
vec4 elemColor = texture2D(uColorTex, eUV);
float hidden   = texture2D(uFlagsTex, eUV).r;

// Fully hidden elements are discarded on the GPU.
if (hidden > 0.75) discard;

// Ghost mode: elements flagged at 0.07 render semi-transparent.
// diffuseColor is already set by the time we reach this injection point.
if (hidden > 0.01) {
  diffuseColor.a *= 0.07;
}

totalEmissiveRadiance = elemColor.rgb * elemColor.a;
`,
    );
  };

  // Unique cache key so Three.js doesn't share this program with plain
  // MeshStandardMaterial instances that lack the custom uniforms.
  mat.customProgramCacheKey = () => `ifc-merged-${transparent ? "t" : "o"}`;

  return mat;
};
