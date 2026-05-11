import { useEffect } from "react";

import {
  DefaultSidebar,
  Sidebar,
  THEME,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import {
  messageCircleIcon,
  presentationIcon,
} from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import { ChatView } from "./ChatPanel";
import { MeetingLibrary } from "./MeetingLibrary";

import "./AppSidebar.scss";

/** During development we keep the sidebar pinned open on the meeting-library
 *  tab so reviewers / testers don't have to keep re-opening it. Flip via an
 *  env var if we want this off later. */
const ALWAYS_SHOW_SIDEBAR = import.meta.env.DEV;

const meetingLibraryIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="20"
    height="20"
  >
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M9 13h6" />
  </svg>
);

export const AppSidebar = () => {
  const { theme, openSidebar } = useUIAppState();
  const excalidrawAPI = useExcalidrawAPI();

  useEffect(() => {
    if (!ALWAYS_SHOW_SIDEBAR || !excalidrawAPI) {
      return;
    }
    if (openSidebar) {
      return;
    }
    // Sidebar is closed and we're in dev mode — force it back open on the
    // chat tab. Re-runs whenever openSidebar becomes null, so closing it
    // is essentially disabled in dev. We use updateScene + setTimeout
    // instead of toggleSidebar to avoid racing Excalidraw's own state
    // init (toggleSidebar silently no-ops if called too early).
    const t = setTimeout(() => {
      excalidrawAPI.updateScene({
        appState: {
          ...excalidrawAPI.getAppState(),
          openSidebar: { name: "default", tab: "comments" },
          defaultSidebarDockedPreference: true,
        },
      });
    }, 0);
    return () => clearTimeout(t);
  }, [excalidrawAPI, openSidebar]);

  return (
    <DefaultSidebar docked={ALWAYS_SHOW_SIDEBAR ? true : undefined}>
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger
          tab="meeting-library"
          style={{
            opacity: openSidebar?.tab === "meeting-library" ? 1 : 0.4,
          }}
        >
          {meetingLibraryIcon}
        </Sidebar.TabTrigger>
        <Sidebar.TabTrigger
          tab="comments"
          style={{ opacity: openSidebar?.tab === "comments" ? 1 : 0.4 }}
        >
          {messageCircleIcon}
        </Sidebar.TabTrigger>
        <Sidebar.TabTrigger
          tab="presentation"
          style={{ opacity: openSidebar?.tab === "presentation" ? 1 : 0.4 }}
        >
          {presentationIcon}
        </Sidebar.TabTrigger>
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab="meeting-library">
        <MeetingLibrary />
      </Sidebar.Tab>
      <Sidebar.Tab tab="comments">
        <ChatView />
      </Sidebar.Tab>
      <Sidebar.Tab tab="presentation" className="px-3">
        <div className="app-sidebar-promo-container">
          <div
            className="app-sidebar-promo-image"
            style={{
              ["--image-source" as any]: `url(/oss_promo_presentations_${
                theme === THEME.DARK ? "dark" : "light"
              }.svg)`,
              backgroundSize: "60%",
              opacity: 0.4,
            }}
          />
          <div className="app-sidebar-promo-text">
            Create presentations with Excalidraw+
          </div>
          <LinkButton
            href={`${
              import.meta.env.VITE_APP_PLUS_LP
            }/plus?utm_source=excalidraw&utm_medium=app&utm_content=presentations_promo#excalidraw-redirect`}
          >
            Sign up now
          </LinkButton>
        </div>
      </Sidebar.Tab>
    </DefaultSidebar>
  );
};
