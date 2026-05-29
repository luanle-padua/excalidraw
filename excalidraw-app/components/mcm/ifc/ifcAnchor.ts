// Shared definition of an IFC canvas anchor — an invisible Excalidraw
// rectangle that marks where an IFC model sits on the canvas. Mirrors
// the DXF anchor (isDxfAnchorElement): Excalidraw owns the rectangle's
// position / size / lock / collab-sync, and IFCCanvasOverlay paints the
// 3D viewer on top.
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
  };
} => {
  return (
    !el.isDeleted &&
    el.type === "rectangle" &&
    !!el.customData &&
    (el.customData as Record<string, unknown>).mcmType === IFC_ANCHOR_KIND &&
    typeof (el.customData as Record<string, unknown>).ifcFileId === "string"
  );
};
