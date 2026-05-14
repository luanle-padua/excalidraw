// Tiny dropdown for the viewer's chat-translation target language. The
// chosen language is persisted to localStorage by `setPreferredLanguage`
// inside data/translation.ts so refresh keeps the choice.

import { useAtom } from "../app-jotai";
import {
  SUPPORTED_LANGUAGES,
  preferredLanguageAtom,
  setPreferredLanguage,
} from "../data/translation";

import type { SupportedLanguage } from "../data/translation";

export const LanguagePicker = () => {
  const [lang, setLang] = useAtom(preferredLanguageAtom);

  return (
    <label className="LanguagePicker" title="Ngôn ngữ hiển thị chat">
      <span className="LanguagePicker__icon" aria-hidden="true">
        🌐
      </span>
      <select
        className="LanguagePicker__select"
        value={lang}
        onChange={(e) => {
          const next = e.target.value as SupportedLanguage;
          setLang(next);
          setPreferredLanguage(next);
        }}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
};

export default LanguagePicker;
