import { useEffect, useRef, useState } from "react";

import {
  DefaultSidebar,
  Sidebar,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { messageCircleIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import { useAtomValue } from "../app-jotai";
import {
  chatMessagesAtom,
  isCollaboratingAtom,
  meetingViewOnlyAtom,
} from "../collab/Collab";
import { useT } from "../i18n/mcm";

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
  const t = useT();
  // Finished meeting opened for review. In Excalidraw view mode the sidebar
  // TRIGGER is hidden, so the user can't open the chat to read it. Auto-open
  // the comments tab once on entering review so the conversation is visible
  // (read-only). One-shot — the user can still close it to see the canvas.
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const didAutoOpenChat = useRef(false);

  // Default the chat sidebar to OPEN every time a user lands in a live meeting,
  // so it's immediately discoverable (PM: "panel chat mặc định hiện ra"). The
  // ref-guard keeps it a ONE-SHOT per room session — the user can still close
  // it and it won't pop back open within the session. We deliberately DROPPED
  // the old localStorage flag (LOCAL_STORAGE_CHAT_DEFAULT_OPENED) so it's no
  // longer a once-ever default; the key is left in app_constants for back-compat
  // but is no longer read or written here.
  const didDefaultOpenChat = useRef(false);
  useEffect(() => {
    if (viewOnly || !isCollaborating || !excalidrawAPI) {
      // Left the meeting → RE-ARM the one-shot so the NEXT meeting re-opens the
      // chat. Without this the ref stayed true for the whole session, so only
      // the FIRST meeting opened the chat and every re-entry left it collapsed
      // (the "vào lại thì chat không bung" bug).
      if (!isCollaborating) {
        didDefaultOpenChat.current = false;
      }
      return;
    }
    if (didDefaultOpenChat.current) {
      return;
    }
    didDefaultOpenChat.current = true;
    // Open the chat as the default right panel on entry. We RE-ASSERT across the
    // first ~1.7s because the LocalData appState restore (and Excalidraw's own
    // scene init) can land AFTER our first open and reset openSidebar — a race
    // that left the chat collapsed on entry. This short window can't fight a
    // deliberate user-close (those come later); after it we stop re-opening.
    const openChat = () =>
      excalidrawAPI.updateScene({
        appState: {
          ...excalidrawAPI.getAppState(),
          openSidebar: { name: "default", tab: "comments" },
        },
      });
    const timers = [100, 500, 1100, 1700].map((ms) =>
      window.setTimeout(openChat, ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [viewOnly, isCollaborating, excalidrawAPI]);
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

  // --- Unread chat indicator (#7) -----------------------------------------
  // A subtle pip on the chat trigger when new messages arrive while the chat
  // tab isn't the one on screen, so users notice without anything intrusive.
  // Tracked locally (the badge only renders here) and cleared the moment the
  // chat tab is shown. Seeds its baseline on first observation so pre-existing
  // history (e.g. a reopened/review meeting) never shows as unread.
  const chatMessages = useAtomValue(chatMessagesAtom);
  const [unreadChat, setUnreadChat] = useState(0);
  const lastChatCount = useRef<number | null>(null);
  const chatTabOpen =
    openSidebar?.name === "default" && openSidebar?.tab === "comments";
  useEffect(() => {
    const count = chatMessages.length;
    const prev = lastChatCount.current;
    if (prev === null) {
      lastChatCount.current = count;
      return;
    }
    if (chatTabOpen) {
      lastChatCount.current = count;
      setUnreadChat(0);
      return;
    }
    if (count > prev) {
      setUnreadChat((u) => u + (count - prev));
      lastChatCount.current = count;
    }
  }, [chatMessages, chatTabOpen]);

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

  // Excalidraw's view mode (review) hides its own sidebar trigger — once the
  // auto-opened chat is closed there is NO control left to reopen it. Float
  // our own reopen button while reviewing with the sidebar shut.
  const reopenChat = () => {
    excalidrawAPI?.updateScene({
      appState: {
        ...excalidrawAPI.getAppState(),
        openSidebar: { name: "default", tab: "comments" },
      },
    });
  };

  return (
    <>
      {viewOnly && !openSidebar && (
        <button
          type="button"
          className="mcm-review-chat-fab"
          onClick={reopenChat}
          title={t("chat.title")}
          aria-label={t("chat.title")}
        >
          {messageCircleIcon}
        </button>
      )}
      <DefaultSidebar docked={ALWAYS_SHOW_SIDEBAR ? true : undefined}>
        <DefaultSidebar.TabTriggers>
          {/* Review = look-don't-touch, CHAT ONLY (quyết định 06-11): the
              library tab disappears entirely — inserting/copying/uploading
              material all live there, and a finished meeting accepts none
              of it. The in-tab guards stay as defense-in-depth. */}
          {!viewOnly && (
            <Sidebar.TabTrigger
              tab="meeting-library"
              style={{
                opacity: openSidebar?.tab === "meeting-library" ? 1 : 0.4,
              }}
            >
              {meetingLibraryIcon}
            </Sidebar.TabTrigger>
          )}
          <Sidebar.TabTrigger
            tab="comments"
            style={{
              opacity: openSidebar?.tab === "comments" ? 1 : 0.4,
              position: "relative",
            }}
          >
            {messageCircleIcon}
            {!chatTabOpen && unreadChat > 0 && (
              <span
                className="mcm-chat-unread"
                aria-label={t("chat.unread", { count: String(unreadChat) })}
              >
                {unreadChat > 9 ? "9+" : unreadChat}
              </span>
            )}
          </Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
        {!viewOnly && (
          <Sidebar.Tab tab="meeting-library">
            <MeetingLibrary />
          </Sidebar.Tab>
        )}
        <Sidebar.Tab tab="comments">
          <ChatView />
        </Sidebar.Tab>
      </DefaultSidebar>
    </>
  );
};
