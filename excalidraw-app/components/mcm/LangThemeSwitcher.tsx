import { THEME } from "@excalidraw/excalidraw";
import { Moon, Sun } from "lucide-react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { useAppLangCode } from "../../app-language/language-state";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";
import { appThemeAtom } from "../../useHandleAppTheme";

// MCM language (vi/en/ko) maps to these Excalidraw lang codes. Setting the
// lang code via useAppLangCode persists it AND retitles Excalidraw's own
// UI — single source of truth. `preferredLanguageAtom` is derived from it.
const LANGS = [
  { mcm: "vi", code: "vi-VN", label: "VI" },
  { mcm: "en", code: "en", label: "EN" },
  { mcm: "ko", code: "ko-KR", label: "KO" },
] as const;

/** Compact language (VI/EN/KO) + light/dark theme control. Mounted in the
 *  lobby top bar and the in-canvas header. */
export const LangThemeSwitcher = () => {
  const t = useT();
  const [, setLangCode] = useAppLangCode();
  const current = useAtomValue(preferredLanguageAtom);
  const [appTheme, setAppTheme] = useAtom(appThemeAtom);
  const isDark = appTheme === THEME.DARK;

  return (
    <div className="mcm-langtheme" role="group" aria-label={t("switcher.label")}>
      <div className="mcm-langtheme__langs">
        {LANGS.map((l) => (
          <button
            key={l.mcm}
            type="button"
            className={`mcm-langtheme__lang${
              current === l.mcm ? " is-active" : ""
            }`}
            onClick={() => setLangCode(l.code)}
            aria-pressed={current === l.mcm}
          >
            {l.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mcm-langtheme__theme"
        onClick={() => setAppTheme(isDark ? THEME.LIGHT : THEME.DARK)}
        title={t("switcher.toggleTheme")}
        aria-label={t("switcher.toggleTheme")}
      >
        {isDark ? <Moon size={15} /> : <Sun size={15} />}
      </button>
    </div>
  );
};

export default LangThemeSwitcher;
