// AI Tools card — sits at the bottom of the chat sidebar.
//
//   • Translate (번역)  — real toggle controlling Gemini chat translation.
//   • Summarize (요약)  — placeholder for the future Gemini meeting
//                         summariser (stays disabled for now).
//
// The AI Chatbot lives inline in chat via `@bot` mentions, not as a
// panel item — see ChatPanel for that integration.
//
// Layout is a fixed two-row card with each item the same height so the
// panel reads cleanly with only two entries.

import { useAtom, useAtomValue } from "../../app-jotai";
import {
  preferredLanguageAtom,
  setTranslationEnabled,
  translationEnabledAtom,
} from "../../data/translation";

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
  >
    <path d={d} />
  </svg>
);

const SECONDARY = {
  translate: { vi: "Dịch chat", en: "", ko: "채팅 번역" },
  translateDesc: {
    vi: "Tự động dịch tin nhắn sang ngôn ngữ của bạn",
    en: "",
    ko: "메시지를 자동으로 번역",
  },
  summarize: { vi: "Tóm tắt", en: "", ko: "요약" },
  summarizeDesc: {
    vi: "Tóm tắt các điểm thảo luận chính",
    en: "",
    ko: "주요 논점 요약",
  },
  comingSoon: { vi: "Sắp ra mắt", en: "Coming soon", ko: "출시 예정" },
} as const;

export const AIToolsPanel = () => {
  const [translationEnabled, setTransEnabled] = useAtom(translationEnabledAtom);
  const lang = useAtomValue(preferredLanguageAtom);

  const sec = (key: keyof typeof SECONDARY): string => SECONDARY[key][lang];
  const showSecondary = lang !== "en";

  const toggleTranslation = () => {
    const next = !translationEnabled;
    setTransEnabled(next);
    setTranslationEnabled(next);
  };

  return (
    <aside className="mcm-ai-tools" aria-label="AI Tools">
      <div className="mcm-ai-tools__head">
        <div className="mcm-ai-tools__head-title">
          <Icon d="M12 2v4 M12 18v4 M4.93 4.93l2.83 2.83 M16.24 16.24l2.83 2.83 M2 12h4 M18 12h4 M4.93 19.07l2.83-2.83 M16.24 7.76l2.83-2.83" />
          <span>
            AI Tools
            {showSecondary && (
              <span className="mcm-ai-tools__head-secondary"> AI 도구</span>
            )}
          </span>
          <span className="mcm-ai-tools__head-beta">BETA</span>
        </div>
      </div>

      {/* Translate — real on/off toggle */}
      <button
        type="button"
        className={`mcm-ai-tools__item mcm-ai-tools__item--toggleable${
          translationEnabled ? " mcm-ai-tools__item--on" : ""
        }`}
        onClick={toggleTranslation}
        aria-pressed={translationEnabled ? "true" : "false"}
      >
        <span className="mcm-ai-tools__item-icon">
          <Icon d="M5 8l6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6" />
        </span>
        <span className="mcm-ai-tools__item-text">
          <div className="mcm-ai-tools__item-name">
            Translate
            {showSecondary && (
              <span className="mcm-ai-tools__item-secondary">
                {" "}
                {sec("translate")}
              </span>
            )}
          </div>
          <div className="mcm-ai-tools__item-desc">
            {showSecondary
              ? sec("translateDesc")
              : "Auto-translate chat to your language"}
          </div>
        </span>
        <span
          className={`mcm-ai-tools__toggle${
            translationEnabled ? " mcm-ai-tools__toggle--on" : ""
          }`}
          aria-hidden="true"
        >
          <span className="mcm-ai-tools__toggle-knob" />
        </span>
      </button>

      {/* Summarize — placeholder, same shape as Translate for visual balance */}
      <button
        type="button"
        className="mcm-ai-tools__item mcm-ai-tools__item--disabled"
        disabled
        title={sec("comingSoon")}
      >
        <span className="mcm-ai-tools__item-icon">
          <Icon d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" />
        </span>
        <span className="mcm-ai-tools__item-text">
          <div className="mcm-ai-tools__item-name">
            Summarize
            {showSecondary && (
              <span className="mcm-ai-tools__item-secondary">
                {" "}
                {sec("summarize")}
              </span>
            )}
          </div>
          <div className="mcm-ai-tools__item-desc">
            {showSecondary
              ? sec("summarizeDesc")
              : "Summarize key discussion points"}
          </div>
        </span>
        <span className="mcm-ai-tools__badge">{sec("comingSoon")}</span>
      </button>
    </aside>
  );
};

export default AIToolsPanel;
