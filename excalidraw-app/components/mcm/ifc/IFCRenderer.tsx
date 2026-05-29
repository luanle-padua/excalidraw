// Reusable Three.js leaf for the IFC (3D BIM) viewer. One
// <IFCRenderer /> owns exactly one WebGL context — the inline canvas
// overlay and the split-pane viewer each mount this leaf to display an
// IFC model.
//
// Mirrors DXFRenderer's structure + lifecycle:
//   • lazy-loads the heavy GLB → merged-model work off the mount path
//   • registers with ifcInstanceRegistry (enforces the 2-instance cap)
//   • owns the WebGL context (full dispose on unmount)
//   • tracks container size via ResizeObserver
//   • renders ON-DEMAND (on OrbitControls `change` + a setNeedsRender
//     flag pumped through rAF) — no unconditional render loop, so an
//     idle model costs nothing
//   • exposes imperative controls via the optional `onReady` callback
//
// Decoupled from the library: the caller supplies `glbUrl` (object/data
// URL to the baked GLB) + `metadata`. We never read meetingFilesAtom —
// the overlay/library layer owns file resolution and `glbUrl` ownership
// (we never revoke it).

import { useEffect, useRef, useState } from "react";

import { loadIfcMergedFromGlb } from "./ifcGltfMergedLoader";
import { pickIfcElement } from "./ifcPicker";
import { MergedRenderer } from "./mergedRenderer";
import {
  claimIfcSlot,
  releaseIfcSlot,
  subscribeIfcEvict,
} from "./ifcInstanceRegistry";

import type { MergedRendererContext } from "./mergedRenderer";
import type { IfcMergedModel } from "./ifcGltfMergedLoader";
import type { IfcElementMeta, IfcMetadataPayload, IfcStorey } from "./ifcTypes";

/** Serialisable camera state — enough to round-trip a view across
 *  remount (focus → exit → re-enter) or to key a thumbnail snapshot. */
export type IFCViewState = {
  /** Camera world position [x, y, z]. */
  pos: [number, number, number];
  /** OrbitControls target (look-at point) [x, y, z]. */
  target: [number, number, number];
};

export type IFCRendererControls = {
  /** Frame the whole model. `padding` is a fraction of the model
   *  radius added as breathing room (default 1.2 = +20%). */
  fitToModel: (padding?: number) => void;
  /** Building storeys from the metadata, sorted by elevation. */
  getStoreys: () => IfcStorey[];
  /** Show only elements in the given storey (by storey GlobalId), or
   *  pass null to show every storey again. */
  isolateStorey: (id: string | null) => void;
  /** Replace the set of explicitly-hidden element GlobalIds. */
  setHidden: (ids: string[]) => void;
  /** Ghost mode: when on, everything but the selected element renders
   *  semi-transparent. No-op visually unless something is selected. */
  setGhost: (on: boolean) => void;
  /** Single-plane section cut along a world axis. Shows a translucent,
   *  draggable plane (move it along its normal via the gizmo). `value`
   *  optionally seeds the world coordinate. Pass axis null to clear. */
  setSection: (axis: "x" | "y" | "z" | null, value?: number) => void;
  /** Flip which half-space the active section keeps. No-op without an
   *  active section. */
  flipSection: () => void;
  /** Render style: "shaded" (per-element IFC colours), "clay" (uniform
   *  shade), or "wireframe". */
  setViewStyle: (style: "shaded" | "clay" | "wireframe") => void;
  /** Select an element by GlobalId (null clears). `focus` frames the
   *  camera on it — used by the object browser. */
  select: (id: string | null, opts?: { focus?: boolean }) => void;
  /** Two-click distance measure. When turned on, the next two element
   *  clicks place measure points and draw a line between them; the
   *  distance (in model units) is delivered via `onMeasure`. Turning it
   *  off clears the line + resets the pending points. */
  toggleMeasure: (on: boolean) => void;
  /** Read the current camera view for persistence. */
  getView: () => IFCViewState | null;
  /** Apply a saved camera view. */
  setView: (view: IFCViewState) => void;
  /** PNG blob of the current frame — for thumbnails. Renders
   *  immediately before reading the buffer (preserveDrawingBuffer is
   *  false, so a stale frame would otherwise read back blank). */
  exportPng: () => Promise<Blob | null>;
  /** The currently selected element's metadata, or null. */
  getSelected: () => IfcElementMeta | null;
  /** Clear the current selection (and its highlight). */
  clearSelection: () => void;
};

type Props = {
  /** Object URL or data URL pointing at the baked GLB. Caller owns it
   *  (we never revoke). */
  glbUrl: string;
  /** Element + storey metadata produced by the bake worker. */
  metadata: IfcMetadataPayload;
  /** Library file id — used for the registry + snapshot keying. */
  fileId: string;
  /** Container size in CSS px. Caller is responsible for sizing. */
  width: number;
  height: number;
  /** Stable per-mount UUID so the registry can track this specific
   *  renderer (the same fileId may appear inline AND in a pane). */
  instanceId: string;
  /** When true the renderer captures pointer events (OrbitControls +
   *  picking). When false, pointer-events pass through to the canvas
   *  underneath. Default false. */
  interactive?: boolean;
  /** Called on pick (and on clear) with the selected element or null. */
  onSelect?: (el: IfcElementMeta | null) => void;
  /** Called once the model is loaded + first frame rendered, with the
   *  imperative controls. */
  onReady?: (controls: IFCRendererControls) => void;
  /** Called when load fails. */
  onError?: (err: Error) => void;
};

type Status = "loading" | "ready" | "error" | "capacity-exceeded";

// Lit material constants — neutral studio lighting so IFC base colours
// read true (no coloured rim).
const HEMI_SKY = 0xffffff;
const HEMI_GROUND = 0x888888;
const DIR_INTENSITY = 0.8;
const AMBIENT_INTENSITY = 0.6;

export const IFCRenderer = ({
  glbUrl,
  metadata,
  fileId,
  width,
  height,
  instanceId,
  interactive = false,
  onSelect,
  onReady,
  onError,
}: Props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest callbacks — held in refs so the loader effect doesn't re-run
  // when a parent passes a fresh closure.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onSelectRef = useRef(onSelect);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onSelectRef.current = onSelect;

  // Latest size + interactivity — read inside the async loader / event
  // handlers from the latest closure (so resizes that land mid-load are
  // honoured, and interactive flips don't tear the scene down).
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // External eviction (registry asks us to unmount): report upward via
  // a DOM event; the parent owns the actual unmount.
  useEffect(() => {
    return subscribeIfcEvict((evictedId) => {
      if (evictedId === instanceId && containerRef.current) {
        containerRef.current.dispatchEvent(
          new CustomEvent("mcm-ifc-evict", { bubbles: true }),
        );
      }
    });
  }, [instanceId]);

  // Combined slot-claim + load + lifecycle effect. Atomic claim + load
  // (same reasoning as DXFRenderer) avoids the status→cleanup→rebuild
  // feedback loop.
  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }
    const ok = claimIfcSlot(instanceId, fileId);
    if (!ok) {
      setStatus("capacity-exceeded");
      return undefined;
    }

    const container = containerRef.current;
    let cancelled = false;
    let rafId = 0;
    let resizeObserver: ResizeObserver | null = null;

    // Three.js / scene handles — populated by run(), torn down by the
    // cleanup. Typed loosely (THREE is imported dynamically) to keep
    // the heavy module off the synchronous mount path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let THREE: typeof import("three") | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let renderer: import("three").WebGLRenderer | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scene: import("three").Scene | null = null;
    let camera: import("three").PerspectiveCamera | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let controls: any = null; // OrbitControls
    let model: IfcMergedModel | null = null;
    let mergedRenderer: MergedRenderer | null = null;
    let raycaster: import("three").Raycaster | null = null;

    // ── On-demand render bookkeeping ──────────────────────────────
    let needsRender = true;
    const setNeedsRender = () => {
      needsRender = true;
    };

    // ── Live state driven by the imperative controls ──────────────
    const hiddenObjectIds = new Set<string>();
    let ghostMode = false;
    let isolatedStoreyId: string | null = null;
    let selectedId: string | null = null;

    // element GlobalId → storey GlobalId (for isolateStorey + ghost).
    const elementStorey = new Map<string, string>();
    for (const [gid, el] of Object.entries(metadata.elements)) {
      if (el.storeyId) {
        elementStorey.set(gid, el.storeyId);
      }
    }

    // ── Section plane state ───────────────────────────────────────
    let sectionPlane: import("three").Plane | null = null;
    let sectionAxis: "x" | "y" | "z" | null = null;
    // Which half-space the cut keeps; flipSection negates it.
    let sectionSign = 1;
    // Movable proxy (carries the visible quad + outline); TransformControls
    // drags this, and the clip plane's constant is derived from its
    // position along the section axis.
    let sectionGroup: import("three").Object3D | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sectionTC: any = null; // TransformControls (loose type — dyn import)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let TransformControlsClass: any = null;

    // ── Measure state ─────────────────────────────────────────────
    let measureOn = false;
    let measureLine: import("three").Line | null = null;
    let measurePoints: import("three").Vector3[] = [];

    const meshes = (): Array<import("three").Mesh | null> =>
      model ? [model.mergedOpaque, model.mergedTransparent] : [];

    const render = () => {
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
    };

    const applyClippingPlanes = () => {
      const planes = sectionPlane ? [sectionPlane] : [];
      if (!model) {
        return;
      }
      for (const m of [model.mergedOpaque, model.mergedTransparent]) {
        if (m) {
          const mat = m.material as import("three").Material;
          mat.clippingPlanes = planes;
          mat.clipShadows = false;
          mat.needsUpdate = true;
        }
      }
    };

    const fitToModel = (padding = 1.2) => {
      if (!THREE || !camera || !controls || !model) {
        return;
      }
      const box = model.modelBounds;
      if (box.isEmpty()) {
        return;
      }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (radius * padding) / Math.sin(fov / 2);

      // Pull back along a pleasant 3/4 iso direction.
      const dir = new THREE.Vector3(1, 0.8, 1).normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.near = Math.max(dist / 1000, 0.01);
      camera.far = dist * 1000;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      setNeedsRender();
    };

    const handleInteractiveChange = (ev: Event) => {
      const detail = (ev as CustomEvent<{ interactive: boolean }>).detail;
      if (controls) {
        controls.enabled = detail.interactive;
      }
      if (sectionTC) {
        sectionTC.enabled = detail.interactive;
      }
      setNeedsRender();
    };

    const handlePointerDown = (ev: PointerEvent) => {
      // Track for a click vs drag distinction below.
      (handlePointerDown as { _x?: number; _y?: number })._x = ev.clientX;
      (handlePointerDown as { _x?: number; _y?: number })._y = ev.clientY;
    };

    const handleClick = (ev: MouseEvent) => {
      if (
        !interactiveRef.current ||
        !THREE ||
        !camera ||
        !raycaster ||
        !model ||
        sectionTC?.dragging
      ) {
        return;
      }
      // Ignore clicks that were really drags (orbit).
      const start = handlePointerDown as { _x?: number; _y?: number };
      if (
        start._x !== undefined &&
        start._y !== undefined &&
        Math.hypot(ev.clientX - start._x, ev.clientY - start._y) > 4
      ) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);

      // Measure mode intercepts the click for distance points.
      if (measureOn) {
        const hits = raycaster.intersectObjects(
          meshes().filter((m): m is import("three").Mesh => m !== null),
          false,
        );
        if (hits.length > 0) {
          addMeasurePoint(hits[0].point.clone());
        }
        return;
      }

      const globalId = pickIfcElement(
        raycaster,
        meshes(),
        model.globalIdByElementIndex,
        model.flagTexData,
      );
      const el = globalId ? metadata.elements[globalId] ?? null : null;
      setSelected(globalId, el);
    };

    const setSelected = (gid: string | null, el: IfcElementMeta | null) => {
      const prev = selectedId;
      selectedId = gid;
      if (mergedRenderer) {
        if (prev) {
          mergedRenderer.refresh(prev);
        }
        if (gid) {
          mergedRenderer.refresh(gid);
        }
        if (ghostMode) {
          // Ghost state depends on the selection, so a selection change
          // re-flags every element.
          mergedRenderer.refreshAll();
        }
      }
      setNeedsRender();
      onSelectRef.current?.(el);
    };

    const addMeasurePoint = (p: import("three").Vector3) => {
      if (!THREE || !scene) {
        return;
      }
      if (measurePoints.length >= 2) {
        // Third click starts a fresh measurement.
        measurePoints = [];
        if (measureLine) {
          scene.remove(measureLine);
          measureLine.geometry.dispose();
          (measureLine.material as import("three").Material).dispose();
          measureLine = null;
        }
      }
      measurePoints.push(p);
      if (measurePoints.length === 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(measurePoints);
        const mat = new THREE.LineBasicMaterial({ color: 0xff3b30 });
        measureLine = new THREE.Line(geom, mat);
        measureLine.frustumCulled = false;
        scene.add(measureLine);
        const dist = measurePoints[0].distanceTo(measurePoints[1]);
        container.dispatchEvent(
          new CustomEvent("mcm-ifc-measure", {
            bubbles: true,
            detail: { distance: dist },
          }),
        );
      }
      setNeedsRender();
    };

    // ── Section visual + drag gizmo ───────────────────────────────
    const disposeSectionVisual = () => {
      if (sectionTC) {
        sectionTC.detach();
        if (scene) {
          scene.remove(sectionTC);
        }
        sectionTC.dispose?.();
        sectionTC = null;
      }
      if (sectionGroup) {
        if (scene) {
          scene.remove(sectionGroup);
        }
        sectionGroup.traverse((o) => {
          const mesh = o as import("three").Mesh;
          mesh.geometry?.dispose?.();
          const mm = mesh.material as import("three").Material | undefined;
          mm?.dispose?.();
        });
        sectionGroup = null;
      }
    };

    // Recompute the clip plane from the proxy's position along the axis.
    const recomputeSectionPlane = () => {
      if (!THREE || !sectionAxis || !sectionGroup) {
        return;
      }
      const axisVec =
        sectionAxis === "x"
          ? new THREE.Vector3(1, 0, 0)
          : sectionAxis === "y"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      const normal = axisVec.clone().multiplyScalar(-sectionSign);
      const coord = sectionGroup.position[sectionAxis];
      const constant = -normal.dot(axisVec.clone().multiplyScalar(coord));
      sectionPlane = new THREE.Plane(normal, constant);
      applyClippingPlanes();
      setNeedsRender();
    };

    const buildSectionVisual = (axis: "x" | "y" | "z", value?: number) => {
      if (
        !THREE ||
        !scene ||
        !camera ||
        !renderer ||
        !model ||
        !TransformControlsClass
      ) {
        return;
      }
      disposeSectionVisual();
      sectionAxis = axis;

      const center = model.modelBounds.getCenter(new THREE.Vector3());
      const size = model.modelBounds.getSize(new THREE.Vector3());
      const diag = Math.max(size.x, size.y, size.z) * 1.2 || 1;

      sectionGroup = new THREE.Group();
      sectionGroup.position.copy(center);
      if (value !== undefined) {
        sectionGroup.position[axis] = value;
      }

      const planeGeom = new THREE.PlaneGeometry(diag, diag);
      const quad = new THREE.Mesh(
        planeGeom,
        new THREE.MeshBasicMaterial({
          color: 0x4a9eff,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(planeGeom),
        new THREE.LineBasicMaterial({ color: 0x4a9eff }),
      );
      // PlaneGeometry's normal is +Z; orient it to the section axis.
      if (axis === "x") {
        quad.rotation.y = Math.PI / 2;
        edges.rotation.y = Math.PI / 2;
      } else if (axis === "y") {
        quad.rotation.x = Math.PI / 2;
        edges.rotation.x = Math.PI / 2;
      }
      sectionGroup.add(quad);
      sectionGroup.add(edges);
      scene.add(sectionGroup);

      sectionTC = new TransformControlsClass(camera, renderer.domElement);
      sectionTC.setMode("translate");
      sectionTC.attach(sectionGroup);
      sectionTC.showX = axis === "x";
      sectionTC.showY = axis === "y";
      sectionTC.showZ = axis === "z";
      sectionTC.enabled = interactiveRef.current;
      sectionTC.addEventListener(
        "dragging-changed",
        (e: { value: boolean }) => {
          if (controls) {
            controls.enabled = !e.value && interactiveRef.current;
          }
        },
      );
      sectionTC.addEventListener("objectChange", recomputeSectionPlane);
      sectionTC.addEventListener("change", setNeedsRender);
      scene.add(sectionTC);

      recomputeSectionPlane();
    };

    // ── View style ────────────────────────────────────────────────
    const setViewStyleImpl = (style: "shaded" | "clay" | "wireframe") => {
      if (!model) {
        return;
      }
      for (const m of [model.mergedOpaque, model.mergedTransparent]) {
        if (!m) {
          continue;
        }
        const mat = m.material as import("three").MeshStandardMaterial & {
          userData: {
            ifcShader?: { uniforms: Record<string, { value: number }> };
          };
        };
        mat.wireframe = style === "wireframe";
        const sh = mat.userData?.ifcShader;
        if (sh?.uniforms?.uClay) {
          sh.uniforms.uClay.value = style === "clay" ? 1 : 0;
        }
      }
      setNeedsRender();
    };

    // ── Programmatic select (object browser) ──────────────────────
    const selectImpl = (id: string | null, opts?: { focus?: boolean }) => {
      const el = id ? metadata.elements[id] ?? null : null;
      setSelected(id, el);
      if (id && opts?.focus && THREE && camera && controls && model) {
        const idx = model.elementIndexByGlobalId.get(id);
        const box = idx !== undefined ? model.elementBBoxes[idx] : null;
        if (box && !box.isEmpty()) {
          const c = box.getCenter(new THREE.Vector3());
          const s = box.getSize(new THREE.Vector3());
          const r = Math.max(s.x, s.y, s.z) * 0.5 || 1;
          const fov = (camera.fov * Math.PI) / 180;
          const dist = (r * 3) / Math.sin(fov / 2);
          const dir = new THREE.Vector3(1, 0.8, 1).normalize();
          camera.position.copy(c).addScaledVector(dir, dist);
          controls.target.copy(c);
          controls.update();
          setNeedsRender();
        }
      }
    };

    const run = async () => {
      try {
        const threeMod = await import("three");
        const { OrbitControls } = await import(
          "three/examples/jsm/controls/OrbitControls.js"
        );
        const { TransformControls } = await import(
          "three/examples/jsm/controls/TransformControls.js"
        );
        if (cancelled || !containerRef.current) {
          return;
        }
        THREE = threeMod;
        TransformControlsClass = TransformControls;

        const res = await fetch(glbUrl);
        const glb = await res.arrayBuffer();
        if (cancelled) {
          return;
        }
        model = await loadIfcMergedFromGlb(glb);
        if (cancelled) {
          return;
        }

        const { width: w, height: h } = sizeRef.current;

        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: false,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(Math.max(1, w), Math.max(1, h));
        renderer.setClearColor(0x000000, 0); // transparent
        renderer.localClippingEnabled = true;
        container.appendChild(renderer.domElement);

        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(
          50,
          Math.max(1, w) / Math.max(1, h),
          0.1,
          1e6,
        );

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enabled = interactiveRef.current;
        controls.addEventListener("change", setNeedsRender);

        // Lighting — hemisphere + ambient fill + a key directional.
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

        raycaster = new THREE.Raycaster();

        // Per-element visual-state renderer (selection / hide / ghost).
        const ctx: MergedRendererContext = {
          getSelectedId: () => selectedId,
          hiddenObjectIds,
          getGhostMode: () => ghostMode,
          getIsolatedStoreyId: () => isolatedStoreyId,
          elementStorey,
          setNeedsRender,
        };
        mergedRenderer = new MergedRenderer(
          ctx,
          model.colorTexData,
          model.flagTexData,
          model.colorTex,
          model.flagsTex,
          model.elementIndexByGlobalId,
        );

        fitToModel();

        // Pointer / click wiring (picking + measure). We always listen;
        // the handler early-returns when not interactive.
        renderer.domElement.addEventListener("pointerdown", handlePointerDown);
        renderer.domElement.addEventListener("click", handleClick);

        // The `interactive` prop is read via ref for picking; for orbit
        // we must flip the live controls.enabled. The prop effect below
        // dispatches this event so we can react without rebuilding.
        container.addEventListener(
          "mcm-ifc-interactive",
          handleInteractiveChange as EventListener,
        );

        // ResizeObserver → camera aspect + renderer size.
        resizeObserver = new ResizeObserver(() => {
          const cw = Math.max(1, sizeRef.current.width);
          const ch = Math.max(1, sizeRef.current.height);
          if (renderer && camera) {
            renderer.setSize(cw, ch);
            camera.aspect = cw / ch;
            camera.updateProjectionMatrix();
            setNeedsRender();
          }
        });
        resizeObserver.observe(container);

        // On-demand render pump: only re-render when controls report a
        // change, a control mutates state, or damping is mid-flight.
        const tick = () => {
          if (cancelled) {
            return;
          }
          // Damping needs an update each frame WHILE it settles; once
          // settled, update() returns without scheduling more work.
          if (controls?.enableDamping) {
            controls.update();
          }
          if (needsRender) {
            needsRender = false;
            render();
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);

        setStatus("ready");

        const buildControls = (): IFCRendererControls => ({
          fitToModel: (padding) => fitToModel(padding),
          getStoreys: () =>
            [...metadata.storeys].sort((a, b) => a.elevation - b.elevation),
          isolateStorey: (id) => {
            isolatedStoreyId = id;
            mergedRenderer?.refreshAll();
            setNeedsRender();
          },
          setHidden: (ids) => {
            hiddenObjectIds.clear();
            for (const id of ids) {
              hiddenObjectIds.add(id);
            }
            mergedRenderer?.refreshAll();
            setNeedsRender();
          },
          setGhost: (on) => {
            ghostMode = on;
            mergedRenderer?.refreshAll();
            setNeedsRender();
          },
          setSection: (axis, value) => {
            if (axis === null) {
              sectionAxis = null;
              sectionPlane = null;
              disposeSectionVisual();
              applyClippingPlanes();
              setNeedsRender();
              return;
            }
            buildSectionVisual(axis, value);
          },
          flipSection: () => {
            sectionSign *= -1;
            recomputeSectionPlane();
          },
          setViewStyle: (style) => setViewStyleImpl(style),
          select: (id, opts) => selectImpl(id, opts),
          toggleMeasure: (on) => {
            measureOn = on;
            if (!on && measureLine && scene) {
              scene.remove(measureLine);
              measureLine.geometry.dispose();
              (measureLine.material as import("three").Material).dispose();
              measureLine = null;
              measurePoints = [];
              setNeedsRender();
            }
          },
          getView: () => {
            if (!camera || !controls) {
              return null;
            }
            return {
              pos: [camera.position.x, camera.position.y, camera.position.z],
              target: [controls.target.x, controls.target.y, controls.target.z],
            };
          },
          setView: (view) => {
            if (!camera || !controls) {
              return;
            }
            camera.position.set(view.pos[0], view.pos[1], view.pos[2]);
            controls.target.set(view.target[0], view.target[1], view.target[2]);
            controls.update();
            setNeedsRender();
          },
          exportPng: async () => {
            if (!renderer) {
              return null;
            }
            // Force a fresh render immediately before reading back:
            // preserveDrawingBuffer is false, so the buffer can be
            // cleared after compositing and toBlob() would read blank.
            render();
            const canvas = renderer.domElement;
            return new Promise<Blob | null>((resolve) =>
              canvas.toBlob((b) => resolve(b), "image/png"),
            );
          },
          getSelected: () =>
            selectedId ? metadata.elements[selectedId] ?? null : null,
          clearSelection: () => {
            setSelected(null, null);
          },
        });

        onReadyRef.current?.(buildControls());
      } catch (err) {
        if (cancelled) {
          return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        setStatus("error");
        setErrorMsg(e.message);
        onErrorRef.current?.(e);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      releaseIfcSlot(instanceId);
      resizeObserver?.disconnect();

      if (renderer) {
        renderer.domElement.removeEventListener(
          "pointerdown",
          handlePointerDown,
        );
        renderer.domElement.removeEventListener("click", handleClick);
      }
      container.removeEventListener(
        "mcm-ifc-interactive",
        handleInteractiveChange as EventListener,
      );
      controls?.removeEventListener?.("change", setNeedsRender);
      controls?.dispose?.();

      // Dispose the section gizmo + visual.
      disposeSectionVisual();

      // Dispose measure helpers.
      if (measureLine) {
        measureLine.geometry.dispose();
        (measureLine.material as import("three").Material).dispose();
        measureLine = null;
      }

      // Dispose the merged model: geometries, materials, textures.
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
        if (renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      }

      renderer = null;
      scene = null;
      camera = null;
      controls = null;
      model = null;
      mergedRenderer = null;
      raycaster = null;
      THREE = null;
    };
    // glbUrl identity drives reload (peer republish → new bake). status
    // is intentionally NOT a dep (set inside the loader). interactive is
    // read via ref so flipping it doesn't tear the scene down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl, instanceId, fileId]);

  // Flip OrbitControls + pointer capture when `interactive` changes,
  // without rebuilding the scene. CSS owns the actual pointer-events
  // gating via the className modifier (same as DXF). Picking reads the
  // ref directly; OrbitControls' live `.enabled` is flipped by the
  // loader effect's `mcm-ifc-interactive` listener (dispatched here).
  useEffect(() => {
    interactiveRef.current = interactive;
    containerRef.current?.dispatchEvent(
      new CustomEvent("mcm-ifc-interactive", {
        bubbles: false,
        detail: { interactive },
      }),
    );
  }, [interactive]);

  if (status === "capacity-exceeded") {
    return (
      <div className="mcm-ifc-renderer mcm-ifc-renderer--capacity">
        <div className="mcm-ifc-renderer__capacity-icon" aria-hidden="true">
          ⚠️
        </div>
        <div className="mcm-ifc-renderer__capacity-text">
          Đã mở tối đa mô hình 3D cùng lúc. Đóng bớt 1 file khác để xem file
          này.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`mcm-ifc-renderer mcm-ifc-renderer--${status}${
        interactive ? " mcm-ifc-renderer--interactive" : ""
      }`}
      // eslint-disable-next-line react/forbid-dom-props
      style={{ width, height }}
      data-ifc-instance-id={instanceId}
      data-ifc-file-id={fileId}
    >
      {status === "loading" && (
        <div className="mcm-ifc-renderer__loading">
          <span className="mcm-ifc-renderer__spinner" />
          <span>Đang tải mô hình 3D…</span>
        </div>
      )}
      {status === "error" && (
        <div className="mcm-ifc-renderer__error">
          Không đọc được mô hình IFC: {errorMsg}
        </div>
      )}
    </div>
  );
};

export default IFCRenderer;
