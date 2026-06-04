import { useEffect, useRef } from "react";

import {
  DefaultSidebar,
  Sidebar,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { messageCircleIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import { useAtomValue } from "../app-jotai";
import { meetingViewOnlyAtom } from "../collab/Collab";

import { ChatView } from "./ChatPanel";
import { MeetingLibrary } from "./MeetingLibrary";

import "./AppSidebar.scss";

/** Sidebar opens only when the user explicitly toggles it from the
 *  top-right control. Earlier we pinned it open in dev for testing,
 *  but that covered too much of the canvas during real meetings. */
const ALWAYS_SHOW_SIDEBAR = false;

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
  const { openSidebar } = useUIAppState();
  const excalidrawAPI = useExcalidrawAPI();
  // Finished meeting opened for review. In Excalidraw view mode the sidebar
  // TRIGGER is hidden, so the user can't open the chat to read it. Auto-open
  // the comments tab once on entering review so the conversation is visible
  // (read-only). One-shot — the user can still close it to see the canvas.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const didAutoOpenChat = useRef(false);
  useEffect(() => {
    if (!viewOnly) {
      didAutoOpenChat.current = false;
      return;
    }
    if (didAutoOpenChat.current || !excalidrawAPI) {
      return;
    }
    didAutoOpenChat.current = true;
    const t = setTimeout(() => {
      excalidrawAPI.updateScene({
        appState: {
          ...excalidrawAPI.getAppState(),
          openSidebar: { name: "default", tab: "comments" },
        },
      });
    }, 100);
    return () => clearTimeout(t);
  }, [viewOnly, excalidrawAPI]);

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
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab="meeting-library">
        <MeetingLibrary />
      </Sidebar.Tab>
      <Sidebar.Tab tab="comments">
        <ChatView />
      </Sidebar.Tab>
    </DefaultSidebar>
  );
};
