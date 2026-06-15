// A small themed confirm dialog — the proper-UI replacement for window.confirm
// (anh Luân 06-15: "leader confirmation need proper UI"). Reuses the
// .mcm-meditor modal shell so it matches the project/meeting editors. The
// confirm button can be tinted danger (destructive) or accent (default).

import { X } from "lucide-react";
import { useState } from "react";

import { useT } from "../../i18n/mcm";

import "./MeetingShell.scss";

export const ConfirmModal = ({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  /** Tint the confirm button as destructive (red) rather than the accent. */
  danger?: boolean;
  /** Runs on confirm; may be async. The modal stays up (busy) until it
   *  resolves, then closes. */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) => {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mcm-meditor"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="mcm-meditor__panel mcm-meditor__panel--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mcm-meditor__header">
          <span className="mcm-meditor__title">{title}</span>
          <button
            type="button"
            className="mcm-meditor__close"
            onClick={onClose}
            aria-label={t("folder.cancel")}
          >
            <X size={16} />
          </button>
        </header>

        <div className="mcm-meditor__body">
          <p className="mcm-confirm__message">{message}</p>
        </div>

        <footer className="mcm-meditor__foot">
          <button
            type="button"
            className="mcm-meditor__cancel"
            onClick={onClose}
            disabled={busy}
          >
            {t("folder.cancel")}
          </button>
          <button
            type="button"
            className={`mcm-meditor__save${
              danger ? " mcm-meditor__save--danger" : ""
            }`}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default ConfirmModal;
