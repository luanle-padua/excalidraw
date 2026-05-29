// Shared definition of an IFC canvas anchor — an Excalidraw IMAGE
// element that displays a baked 3D snapshot of the model. Mirrors the
// PDF anchor (isPdfAnchorElement): Excalidraw owns the image's position
// / size / lock / collab-sync AND paints the snapshot natively on the
// canvas, so pen strokes / shapes / text the user adds AFTER the model
// stack on top of it via regular element-order / "Bring to Front"
// semantics. IFCCanvasOverlay only mounts the live interactive renderer
// while an anchor is FOCUSED, then bakes the view back into the
// snapshot file on focus exit.
//
// Lives in its own module so the overlay, the 3D pane, and the triggers
// can all import the predicate without an import cycle through the
// overlay component.

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { IFCViewState } from "./IFCRenderer";

/** Marker stored on `element.customData.mcmType` for IFC placeholders. */
export const IFC_ANCHOR_KIND = "ifc-anchor";

export const isIfcAnchorElement = (
  el: ExcalidrawElement,
): el is ExcalidrawElement & {
  customData: {
    mcmType: string;
    ifcFileId: string;
    /** Persisted camera view so the anchor restores the user's last
     *  orbit across focus exit / reload / peer sync. Absent = fit. */
    ifcView?: IFCViewState;
    /** Isolated storey GlobalId (null/absent = all storeys). Synced
     *  through collab so peers see the same isolation. */
    ifcStoreyId?: string | null;
    /** File id (in Excalidraw's binary-file map) of the snapshot PNG
     *  this anchor displays. Mirrors PDF's pdfSnapshotFileId — we know
     *  which file to rewrite when the view changes on focus exit. */
    ifcSnapshotFileId?: string;
  };
} => {
  return (
    !el.isDeleted &&
    el.type === "image" &&
    !!el.customData &&
    (el.customData as Record<string, unknown>).mcmType === IFC_ANCHOR_KIND &&
    typeof (el.customData as Record<string, unknown>).ifcFileId === "string"
  );
};
