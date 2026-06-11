import clsx from "clsx";

import type { ExcalidrawProps, UIAppState } from "../types";

export const LibraryMenuControlButtons = ({
  children,
  style,
  className,
}: {
  // mcm: kept in the signature so call sites don't change, but the upstream
  // "Browse libraries" button (links out to libraries.excalidraw.com) is
  // removed — MCM has its own per-meeting material library; the public
  // shape-library site is dead weight for an internal tool.
  libraryReturnUrl: ExcalidrawProps["libraryReturnUrl"];
  theme: UIAppState["theme"];
  id: string;
  style: React.CSSProperties;
  children?: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={clsx("library-menu-control-buttons", className)}
      style={style}
    >
      {children}
    </div>
  );
};
