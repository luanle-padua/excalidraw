import { ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";

import { useT } from "../../i18n/mcm";

export type EditorField = {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  /** default "text" */
  type?: "text" | "select" | "date" | "image";
  /** option values for type:"select" — "" renders as the blank "—" choice */
  options?: string[];
  /** span both grid columns (titles, image, description) */
  fullWidth?: boolean;
};

/** Downscale a picked image to a small JPEG data URL so it stays light in
 *  storage while still looking crisp as a cover. */
const resizeToDataURL = (file: File, max = 760): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image load failed"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(reader.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });

const ImageField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) => {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) {
      return;
    }
    try {
      onChange(await resizeToDataURL(file));
    } catch {
      // ignore — keep previous value
    }
  };

  return (
    <div className="mcm-meditor__image">
      {value ? (
        <div className="mcm-meditor__image-preview">
          <img src={value} alt="" />
          <div className="mcm-meditor__image-actions">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
            >
              {t("folder.changeImage")}
            </button>
            <button type="button" onClick={() => onChange("")}>
              {t("folder.removeImage")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mcm-meditor__image-drop"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void pick(e.dataTransfer.files?.[0]);
          }}
        >
          <ImagePlus className="mcm-meditor__image-plus" size={26} />
          <span>{t("folder.uploadImage")}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void pick(e.target.files?.[0] ?? undefined)}
      />
    </div>
  );
};

const OTHER_SENTINEL = "__other__";

/** A dropdown of canonical options PLUS an "Other…" choice that reveals a
 *  free-text input — so users can pick a preset or type their own value.
 *  A stored value that isn't a known option opens straight into custom
 *  mode (the input pre-filled). The field value is always just the string
 *  (preset or custom). */
const SelectField = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) => {
  const t = useT();
  const [custom, setCustom] = useState(
    value !== "" && !options.includes(value),
  );

  return (
    <>
      <select
        className="mcm-meditor__select"
        aria-label={label}
        value={custom ? OTHER_SENTINEL : value}
        onChange={(e) => {
          if (e.target.value === OTHER_SENTINEL) {
            setCustom(true);
            onChange("");
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt === "" ? "—" : opt}
          </option>
        ))}
        <option value={OTHER_SENTINEL}>{t("folder.optionOther")}</option>
      </select>
      {custom && (
        <input
          type="text"
          className="mcm-meditor__input mcm-meditor__other-input"
          placeholder={t("folder.otherPlaceholder")}
          value={value}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
};

/**
 * Reusable modal to rename + edit metadata for a project or a meeting.
 * Field-set driven (caller supplies `fields`); a 2-column grid keeps it
 * wide rather than a long single column. `fullWidth` fields (titles,
 * image, description) span both columns.
 */
export const MetadataEditor = ({
  title,
  fields,
  onSave,
  onClose,
}: {
  title: string;
  fields: EditorField[];
  onSave: (values: Record<string, string>) => void | Promise<void>;
  onClose: () => void;
}) => {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.value])),
  );
  const [busy, setBusy] = useState(false);

  const canSave = fields.every(
    (f) => !f.required || values[f.key]?.trim().length,
  );

  const save = async () => {
    if (busy || !canSave) {
      return;
    }
    setBusy(true);
    try {
      await onSave(values);
    } finally {
      setBusy(false);
    }
  };

  const set = (key: string, v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  return (
    <div
      className="mcm-meditor"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="mcm-meditor__panel"
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
          {fields.map((f) => {
            const full = f.fullWidth || f.multiline || f.type === "image";
            return (
              <label
                key={f.key}
                className={`mcm-meditor__field${
                  full ? " mcm-meditor__field--full" : ""
                }`}
              >
                <span className="mcm-meditor__label">{f.label}</span>
                {f.type === "image" ? (
                  <ImageField
                    value={values[f.key]}
                    onChange={(v) => set(f.key, v)}
                  />
                ) : f.multiline ? (
                  <textarea
                    className="mcm-meditor__textarea"
                    placeholder={f.placeholder}
                    value={values[f.key]}
                    rows={3}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : f.type === "select" ? (
                  <SelectField
                    label={f.label}
                    value={values[f.key]}
                    options={f.options ?? []}
                    onChange={(v) => set(f.key, v)}
                  />
                ) : f.type === "date" ? (
                  <input
                    type="date"
                    className="mcm-meditor__input"
                    value={values[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : (
                  <input
                    type="text"
                    className="mcm-meditor__input"
                    placeholder={f.placeholder}
                    value={values[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void save();
                      }
                    }}
                  />
                )}
              </label>
            );
          })}
        </div>

        <footer className="mcm-meditor__foot">
          <button
            type="button"
            className="mcm-meditor__cancel"
            onClick={onClose}
          >
            {t("folder.cancel")}
          </button>
          <button
            type="button"
            className="mcm-meditor__save"
            onClick={save}
            disabled={busy || !canSave}
          >
            {t("folder.save")}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default MetadataEditor;
