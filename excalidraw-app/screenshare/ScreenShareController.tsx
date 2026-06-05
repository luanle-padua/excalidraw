// Invisible orchestrator that binds the DailyScreenShare manager to Jotai —
// mirrors audio/AudioRoomController.tsx. Mounted once at app-shell level so any
// component (the Present button, the viewer pane, the participants bar) reads
// state + dispatches via atoms.
//
// Two effects:
//   1. Lifecycle — create the manager when we're in a (non-review) collab room,
//      destroy it when the room clears. The manager holds NO Daily connection
//      until someone actually shares (lazy).
//   2. Presence-driven join/leave — watches the socket presence atom
//      (screenShareStateAtom): when a *remote* peer starts sharing we join Daily
//      to receive their screen; when nobody is sharing we disconnect to stop the
//      per-minute meter. Our own share is started/stopped via the manager from
//      the Present button, not here.

import { useEffect, useRef } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  meetingViewOnlyAtom,
  screenShareStateAtom,
} from "../collab/Collab";
import { getDailyToken } from "../data/projects";

import { DailyScreenShare } from "./DailyScreenShare";
import {
  SCREEN_SHARE_IDLE,
  screenShareInstanceAtom,
  screenShareMediaAtom,
} from "./screenShareState";

const extractRoomId = (link: string | null | undefined): string | null =>
  link?.match(/#room=([a-zA-Z0-9_-]+),/)?.[1] ?? null;

export const ScreenShareController = () => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const viewOnly = useAtomValue(meetingViewOnlyAtom);
  const presence = useAtomValue(screenShareStateAtom);
  const setMedia = useSetAtom(screenShareMediaAtom);
  const setInstance = useSetAtom(screenShareInstanceAtom);

  const managerRef = useRef<DailyScreenShare | null>(null);

  // (1) Provision / tear down the manager with the collab room. A finished
  // meeting in read-only review never gets a manager (viewOnly gate).
  useEffect(() => {
    if (!collabAPI || !activeRoomLink || viewOnly) {
      const m = managerRef.current;
      if (m) {
        void m.destroy();
        managerRef.current = null;
        setInstance(null);
        setMedia(SCREEN_SHARE_IDLE);
      }
      return;
    }
    if (managerRef.current) {
      return;
    }
    const roomId = extractRoomId(activeRoomLink);
    if (!roomId) {
      return;
    }
    const userName = collabAPI.getUsername() || "Guest";
    console.info(`[screenshare] controller provisioning manager (${roomId})`);
    const manager = new DailyScreenShare({
      roomId,
      userName,
      getToken: (rid, name) => getDailyToken(rid, name),
      events: {
        onState: (s) => setMedia(s),
        onLocalShareChange: (sharing) => collabAPI.setScreenShare(sharing),
      },
    });
    managerRef.current = manager;
    setInstance(manager);
  }, [collabAPI, activeRoomLink, viewOnly, setMedia, setInstance]);

  // Hard cleanup on unmount independent of React render timing.
  useEffect(() => {
    return () => {
      const m = managerRef.current;
      if (m) {
        void m.destroy();
        managerRef.current = null;
      }
    };
  }, []);

  // (2) Lazy join/leave driven by who is sharing (socket presence).
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !collabAPI) {
      return;
    }
    const me = collabAPI.portal.socket?.id;
    const someoneElseSharing = Array.from(presence.keys()).some(
      (id) => id !== me,
    );
    const iAmSharing = !!me && presence.has(me);

    if (someoneElseSharing && !manager.isConnected()) {
      // a remote peer started presenting → join to watch
      void manager.ensureJoined();
    } else if (
      !someoneElseSharing &&
      !iAmSharing &&
      !manager.isLocalSharing() &&
      manager.isConnected()
    ) {
      // nobody is sharing anymore → drop the Daily connection (lazy)
      void manager.leave();
    }
  }, [presence, collabAPI]);

  return null;
};

export default ScreenShareController;
