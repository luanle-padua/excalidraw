// Asset manifest for the canvas-image decorations layer.
// Paths are relative to the served root (Vite copies /public/* verbatim).
// To add new files: drop the PNG into the matching folder under
// /public/decorations/, then append its path here. The hash-based
// picker in PinnedImagesOverlay will start using it on the next reload.
//
// Keeping this as an explicit list (rather than a build-time directory
// scan) makes the dependency obvious in the bundle and lets us version-
// control exactly which assets are shipped.

export const TAPE_ASSETS: readonly string[] = [
  "/decorations/tape/03.png",
  "/decorations/tape/30.png",
  "/decorations/tape/33.png",
  "/decorations/tape/36.png",
  "/decorations/tape/42.png",
];

// Chibi-animal stickers — 01.png is a hand-made original, 02–16 were
// cropped from the ChatGPT sprite sheet via auto-detected bounding
// boxes (see PowerShell crop pipeline in the commit history).
export const STICKER_ASSETS: readonly string[] = [
  "/decorations/stickers/01.png",
  "/decorations/stickers/02.png",
  "/decorations/stickers/03.png",
  "/decorations/stickers/04.png",
  "/decorations/stickers/05.png",
  "/decorations/stickers/06.png",
  "/decorations/stickers/07.png",
  "/decorations/stickers/08.png",
  "/decorations/stickers/09.png",
  "/decorations/stickers/10.png",
  "/decorations/stickers/11.png",
  "/decorations/stickers/12.png",
  "/decorations/stickers/13.png",
  "/decorations/stickers/14.png",
  "/decorations/stickers/15.png",
  "/decorations/stickers/16.png",
];

// Postal-style stamp set — 12 chibi-animal stamps with MAP branding,
// cropped from a sprite sheet via auto-detected bounding boxes.
export const STAMP_ASSETS: readonly string[] = [
  "/decorations/stamps/01.png",
  "/decorations/stamps/02.png",
  "/decorations/stamps/03.png",
  "/decorations/stamps/04.png",
  "/decorations/stamps/05.png",
  "/decorations/stamps/06.png",
  "/decorations/stamps/07.png",
  "/decorations/stamps/08.png",
  "/decorations/stamps/09.png",
  "/decorations/stamps/10.png",
  "/decorations/stamps/11.png",
  "/decorations/stamps/12.png",
];
