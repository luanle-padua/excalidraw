import { useEffect, useRef, useState } from "react";

import { MOCK_TRANSCRIPT } from "./meetingMock";

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="14"
    height="14"
  >
    <path d={d} />
  </svg>
);

const TARGETS = [
  { code: "vi", label: "Tiếng Việt" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
];

export const SpeechToTextPanel = () => {
  // Start collapsed — the live transcript can be noisy and we don't
  // want it covering the canvas on first load. User opens it via the
  // floating "Live transcript" pill.
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("vi");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        className="mcm-stt-show"
        onClick={() => setOpen(true)}
        title="Show live transcript"
      >
        <Icon d="M3 18v-1a4 4 0 014-4h.5a4.5 4.5 0 100-9H7 M19 18v-1a4 4 0 00-4-4h-.5a4.5 4.5 0 110-9H15" />
        Live transcript
      </button>
    );
  }

  return (
    <aside className="mcm-stt" aria-label="Real-time Speech to Text">
      <div className="mcm-stt__header">
        <div className="mcm-stt__title">
          <Icon d="M3 18v-1a4 4 0 014-4h.5a4.5 4.5 0 100-9H7 M19 18v-1a4 4 0 00-4-4h-.5a4.5 4.5 0 110-9H15" />
          Real-time Speech to Text
        </div>
        <select
          className="mcm-stt__select"
          aria-label="Translate to"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {TARGETS.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="mcm-stt__hide"
          onClick={() => setOpen(false)}
        >
          Hide
        </button>
      </div>

      <div className="mcm-stt__lines" ref={scrollRef}>
        {MOCK_TRANSCRIPT.map((line, i) => (
          <div key={i} className="mcm-stt__line">
            <div className="mcm-stt__line-head">
              <span className="mcm-stt__line-at">{line.at}</span>
              <span className="mcm-stt__line-spk">
                {line.speaker} ({line.country})
              </span>
            </div>
            <div className="mcm-stt__line-orig">{line.original}</div>
            <div className="mcm-stt__line-trans">{line.translated}</div>
          </div>
        ))}
      </div>

      <div className="mcm-stt__footer">
        <span className="mcm-stt__live-dot" />
        <span className="mcm-stt__live-text">Live</span>
      </div>
    </aside>
  );
};

export default SpeechToTextPanel;
