// Shared mount node for MCM's portalled toolbar buttons (sticker /
// stamp picker + CAD-view trigger). Without this, each portal would
// be a direct child of Excalidraw's `.App-toolbar`, and in mobile
// mode (narrow viewport) the toolbar flips to `flex-direction: column`
// — so each of our buttons becomes its own full-width row stacked
// under the mobile toolbar instead of sitting next to it.
//
// By collapsing every MCM extras portal into a single wrapper child,
// the buttons stay grouped as ONE row no matter which direction the
// parent flexes:
//   • desktop: a horizontal strip on the right of the shape switcher
//   • mobile : a single horizontal strip BELOW the mobile toolbar
//              (rather than 3 separate vertically-stacked rows).
//
// The host element is reused — the first picker to mount creates it,
// subsequent pickers find it. When the parent toolbar re-mounts
// (zen mode, layout switch) the picker's MutationObserver will see
// the new `.App-toolbar` and call this helper again, which creates
// a fresh host inside the new toolbar.

const HOST_CLASS = "mcm-toolbar-extras";

export const findOrCreateToolbarExtras = (): HTMLElement | null => {
  const toolbar = document.querySelector(".App-toolbar");
  if (!toolbar) {
    return null;
  }
  const existing = toolbar.querySelector<HTMLElement>(`.${HOST_CLASS}`);
  if (existing) {
    return existing;
  }
  const host = document.createElement("div");
  host.className = HOST_CLASS;
  toolbar.appendChild(host);
  return host;
};
