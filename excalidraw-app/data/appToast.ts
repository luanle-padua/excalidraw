// App-level error toast state. A tiny one-slot queue: setting a new toast
// replaces the current one (errors are rare enough that stacking isn't
// worth the UI complexity). The `id` exists so AppToast can re-arm its
// auto-hide timer when the SAME message is shown twice in a row.

import { atom, appJotaiStore } from "../app-jotai";

export type AppToastState = { id: number; message: string } | null;

export const appToastAtom = atom<AppToastState>(null);

/** Show a toast from anywhere — including outside React (data-layer
 *  fetch helpers, event handlers on non-component objects). */
export const showAppToast = (message: string): void => {
  appJotaiStore.set(appToastAtom, { id: Date.now(), message });
};
