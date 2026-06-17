// Shared "meeting context" builder for the canvas-bot and the chat @bot.
//
// Both bots POST to the SAME /chatbot endpoint, so they must send the SAME
// context shape. This module is the single place that derives the reusable
// `meetingContext` object — WHO is in the meeting, WHAT files/materials are
// present — from the live jotai state, so the two call sites can't drift.
//
// It is intentionally structured as a standalone object (participants[],
// files[], meetingTitle, meetingStatus) so a future retrieval-grounded
// project AI can reuse the exact same shape
// (docs/specs/ai-project-knowledge-strategy.md — retrieval, NOT fine-tuning).

import type { MeetingFile } from "./meetingLibrary";
import type { UserProfile } from "./userProfile";

/** One participant in the live meeting. `role` is optional/best-effort. */
export type MeetingParticipant = { name: string; role?: string };

/** One file/material on the meeting's shelf (canvas library). */
export type MeetingContextFile = { name: string; kind?: string };

/** The reusable meeting-context object both bots send to /chatbot. */
export type MeetingContext = {
  participants: MeetingParticipant[];
  files: MeetingContextFile[];
  meetingTitle?: string;
  meetingStatus?: string;
};

/** Map a library MeetingFile to a coarse kind label the bot can reason about
 *  ("what file types do we have"). Cheap — driven by the metadata the library
 *  already carries, no re-parsing. */
const fileKind = (f: MeetingFile): string => {
  if (f.ifcMeta) {
    return "IFC";
  }
  if (f.dxfMeta) {
    return "DXF";
  }
  if (f.pdfMeta) {
    return "PDF";
  }
  if (f.mimeType?.startsWith("image/")) {
    return "image";
  }
  return "file";
};

/** Build the participant roster from the local profile + the peer-profile map
 *  (socketId → UserProfile). Deduped by name, self listed first, capped at 50
 *  to mirror the worker's defensive cap. We send NAMES only as `role` (rank /
 *  division) isn't reliably present on UserProfile yet — see TODO below. */
export const buildParticipants = (
  myProfile: UserProfile | null,
  peerProfiles: ReadonlyMap<string, UserProfile>,
): MeetingParticipant[] => {
  const out: MeetingParticipant[] = [];
  const seen = new Set<string>();
  const add = (name?: string) => {
    const n = name?.trim();
    if (!n || seen.has(n.toLowerCase())) {
      return;
    }
    seen.add(n.toLowerCase());
    // TODO: enrich with role/rank (직급) from the org directory once it's
    // exposed to the room (reference_mcm-org-directory) — for now name-only,
    // which is what's cheaply available on UserProfile.
    out.push({ name: n });
  };
  add(myProfile?.username);
  for (const p of peerProfiles.values()) {
    add(p.username);
  }
  return out.slice(0, 50);
};

/** Build the file/material list from the meeting library atom. */
export const buildContextFiles = (
  files: readonly MeetingFile[],
): MeetingContextFile[] =>
  files.slice(0, 50).map((f) => ({ name: f.name, kind: fileKind(f) }));
