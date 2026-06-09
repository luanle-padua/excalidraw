import "@excalidraw/excalidraw/global";
import "@excalidraw/excalidraw/css";

// Plain-CSS side-effect imports (e.g. Schedule-X's theme stylesheet,
// `@schedule-x/theme-default/dist/index.css`). The Excalidraw global only
// declares `*.scss`, so without this `tsc` can't resolve a `.css` import.
declare module "*.css";

interface Window {
  __EXCALIDRAW_SHA__: string | undefined;
}
