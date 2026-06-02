import { X } from "lucide-react";

import { atom, useAtom } from "../../app-jotai";
import { useT } from "../../i18n/mcm";

import { ProjectBrowser } from "./ProjectBrowser";

/** Controls the in-canvas project-folder modal (opened from the header
 *  by the host). The lobby home embeds <ProjectBrowser> directly and
 *  doesn't use this. */
export const projectFolderOpenAtom = atom(false);

/**
 * In-canvas project folder — a modal wrapper around <ProjectBrowser> so
 * the host can switch projects / reopen a past meeting / start a new one
 * without leaving the current canvas. Visibility is driven by
 * `projectFolderOpenAtom`.
 */
export const ProjectFolder = () => {
  const t = useT();
  const [open, setOpen] = useAtom(projectFolderOpenAtom);

  if (!open) {
    return null;
  }

  return (
    <div className="mcm-folder" role="dialog" aria-modal="true">
      <div className="mcm-folder__panel">
        <header className="mcm-folder__header">
          <span className="mcm-folder__title">{t("folder.title")}</span>
          <button
            type="button"
            className="mcm-folder__close"
            onClick={() => setOpen(false)}
            aria-label={t("folder.close")}
          >
            <X size={16} />
          </button>
        </header>
        <ProjectBrowser onEntered={() => setOpen(false)} />
      </div>
    </div>
  );
};

export default ProjectFolder;
