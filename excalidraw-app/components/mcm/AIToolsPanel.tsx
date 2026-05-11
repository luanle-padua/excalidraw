import { useState } from "react";

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

const TOOLS = [
  {
    id: "translate",
    title: "AI Translate",
    desc: "Translate messages in real-time",
    icon: "M5 8l6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6",
  },
  {
    id: "summary",
    title: "AI Summary",
    desc: "Summarize this meeting",
    icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  },
  {
    id: "chatbot",
    title: "AI Chatbot",
    desc: "Ask anything about this project",
    icon: "M12 2a10 10 0 1010 10c0-1.5-.3-3-1-4 M8 12h.01 M12 12h.01 M16 12h.01",
  },
];

export const AIToolsPanel = () => {
  const [open, setOpen] = useState(true);

  if (!open) {
    return null;
  }

  return (
    <aside className="mcm-ai-tools" aria-label="AI Tools">
      <div className="mcm-ai-tools__head">
        <div className="mcm-ai-tools__head-title">
          <Icon d="M12 2v4 M12 18v4 M4.93 4.93l2.83 2.83 M16.24 16.24l2.83 2.83 M2 12h4 M18 12h4 M4.93 19.07l2.83-2.83 M16.24 7.76l2.83-2.83" />
          AI Tools
          <span className="mcm-ai-tools__head-beta">BETA</span>
        </div>
        <button
          type="button"
          className="mcm-ai-tools__head-close"
          aria-label="Close"
          onClick={() => setOpen(false)}
        >
          <Icon d="M18 6L6 18 M6 6l12 12" />
        </button>
      </div>

      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="mcm-ai-tools__item"
          onClick={() => window.alert(`${t.title} — coming soon`)}
        >
          <span className="mcm-ai-tools__item-icon">
            <Icon d={t.icon} />
          </span>
          <span className="mcm-ai-tools__item-text">
            <div className="mcm-ai-tools__item-name">{t.title}</div>
            <div className="mcm-ai-tools__item-desc">{t.desc}</div>
          </span>
        </button>
      ))}
    </aside>
  );
};

export default AIToolsPanel;
