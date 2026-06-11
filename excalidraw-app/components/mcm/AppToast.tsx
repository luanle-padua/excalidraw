import { AlertTriangle, X } from "lucide-react";
import { useEffect } from "react";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import { appToastAtom } from "../../data/appToast";

/**
 * App-level error toast — the visual half of data/appToast.ts. Mounted
 * once by MeetingShell (next to MeetingDueNotice, same bottom-right
 * corner). One toast at a time; a new `showAppToast` call replaces the
 * current message and restarts the countdown.
 */

const AUTO_HIDE_MS = 5000;

export const AppToast = () => {
  const toast = useAtomValue(appToastAtom);
  const setToast = useSetAtom(appToastAtom);

  // Auto-hide. Keyed on the toast id (not the object) so a re-render
  // can't restart the countdown, while a genuinely new toast — even one
  // with the same message — gets its own full 5 seconds. Cleared on
  // unmount and on id change.
  const toastId = toast?.id;
  useEffect(() => {
    if (toastId === undefined) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [toastId, setToast]);

  if (!toast) {
    return null;
  }

  return (
    <div className="mcm-toast" role="alert">
      <AlertTriangle size={18} className="mcm-toast__icon" />
      <span className="mcm-toast__message">{toast.message}</span>
      <button
        type="button"
        className="mcm-toast__close"
        onClick={() => setToast(null)}
        aria-label="Close"
      >
        <X size={15} />
      </button>
    </div>
  );
};

export default AppToast;
