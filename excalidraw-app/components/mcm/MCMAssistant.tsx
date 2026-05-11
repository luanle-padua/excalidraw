export const MCMAssistant = () => (
  <button
    type="button"
    className="mcm-assistant"
    onClick={() => window.alert("MCM Assistant — coming soon")}
  >
    <span className="mcm-assistant__avatar">M</span>
    <span className="mcm-assistant__text">
      <span className="mcm-assistant__title">MCM Assistant</span>
      <span className="mcm-assistant__sub">How can I help you today?</span>
    </span>
    <span className="mcm-assistant__arrow" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        width="16"
        height="16"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </span>
  </button>
);

export default MCMAssistant;
