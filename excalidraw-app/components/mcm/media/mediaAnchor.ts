// Shared definition of a MEDIA (video / audio) canvas anchor — an
// Excalidraw IMAGE element that displays a static poster on the canvas
// while MediaCanvasOverlay mounts a live <video controls>/<audio
// controls> player on top of it. Mirrors the PDF anchor
// (isPdfAnchorElement) and the IFC anchor (isIfcAnchorElement):
// Excalidraw owns the image's position / size / lock / collab-sync AND
// paints the poster natively on the canvas, so pen strokes / shapes /
// text the user adds AFTER the media stack on top of it via regular
// element-order / "Bring to Front" semantics. The overlay only adds the
// interactive HTML player layer.
//
// Lives in its own module (like ifcAnchor.ts) so the overlay and the
// library insertion code can both import the predicate without an
// import cycle through the overlay component.

import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Marker stored on `element.customData.mcmType` for media placeholders.
 *  Mirrors PDF_ANCHOR_KIND / IFC_ANCHOR_KIND. */
export const MEDIA_ANCHOR_KIND = "media-anchor";

/** The two playable media kinds an anchor can carry. */
export type MediaKind = "video" | "audio";

/** A media anchor is identified by its customData: an IMAGE element whose
 *  `mcmType === MEDIA_ANCHOR_KIND`, carrying the library `mediaFileId`
 *  (where the actual bytes live) and a `mediaType` of "video" | "audio".
 *  The image element's own `fileId` points at a poster PNG in
 *  Excalidraw's file map (a dark play-glyph for video, a compact bar for
 *  audio) so the canvas shows SOMETHING before the player mounts. */
export const isMediaAnchorElement = (
  el: ExcalidrawElement,
): el is ExcalidrawElement & {
  customData: {
    mcmType: string;
    /** Library file id (in meetingFilesAtom + Excalidraw's binary-file
     *  map) of the uploaded media whose bytes the overlay plays. */
    mediaFileId: string;
    /** Whether to render a <video> or an <audio> player. */
    mediaType: MediaKind;
    /** File id of the poster PNG this anchor's image displays. Mirrors
     *  PDF's pdfSnapshotFileId — present so peers + reload can find the
     *  per-anchor poster in Excalidraw's map without inspecting
     *  `el.fileId`. */
    mediaPosterFileId?: string;
  };
} => {
  const data = el.customData as Record<string, unknown> | undefined;
  return (
    !el.isDeleted &&
    el.type === "image" &&
    !!data &&
    data.mcmType === MEDIA_ANCHOR_KIND &&
    typeof data.mediaFileId === "string" &&
    (data.mediaType === "video" || data.mediaType === "audio")
  );
};
