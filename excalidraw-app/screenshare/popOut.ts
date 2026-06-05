// Document Picture-in-Picture helper — pops a DOM node out into a separate,
// always-on-top OS window the user can drag to a second monitor (the "present
// on screen 1, watch on screen 2" flow). Chromium-only today; callers must
// feature-detect via isPopOutSupported() and keep the in-app pane as fallback
// (Firefox/Safari have no Document-PiP yet).
//
// The popped node is the SAME element (moved, not cloned) so a <video> inside
// it keeps playing without re-binding its stream.

type DocumentPiPWindow = Window;

type DocumentPiP = {
  requestWindow: (opts?: {
    width?: number;
    height?: number;
  }) => Promise<DocumentPiPWindow>;
  window: DocumentPiPWindow | null;
};

const getDPiP = (): DocumentPiP | null =>
  (window as unknown as { documentPictureInPicture?: DocumentPiP })
    .documentPictureInPicture ?? null;

export const isPopOutSupported = (): boolean => !!getDPiP();

const copyStyles = (target: Document) => {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("");
      const style = target.createElement("style");
      style.textContent = rules;
      target.head.appendChild(style);
    } catch {
      // cross-origin sheet — can't read rules; re-link by href instead
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
};

/** Move `node` into a Document-PiP window. Resolves to a close() function (or
 *  null if unsupported / blocked). `onReturn` fires when the PiP window closes
 *  (user closed it, or close() was called) so the caller can re-home the node. */
export const popOut = async (
  node: HTMLElement,
  opts: {
    width?: number;
    height?: number;
    onReturn: () => void;
  },
): Promise<(() => void) | null> => {
  const dpip = getDPiP();
  if (!dpip) {
    return null;
  }
  let pip: DocumentPiPWindow;
  try {
    pip = await dpip.requestWindow({
      width: opts.width ?? 1280,
      height: opts.height ?? 760,
    });
  } catch {
    return null;
  }
  copyStyles(pip.document);
  pip.document.body.style.margin = "0";
  pip.document.body.style.background = "#000";
  pip.document.body.appendChild(node);

  let returned = false;
  const handlePageHide = () => {
    if (returned) {
      return;
    }
    returned = true;
    opts.onReturn();
  };
  pip.addEventListener("pagehide", handlePageHide);

  return () => {
    try {
      pip.close();
    } catch {
      // window already gone — pagehide will (or did) fire onReturn
    }
  };
};
