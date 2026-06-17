// Shared user avatar — ONE source of truth for how a person is drawn
// everywhere in the app (header chip, participant tiles, transcript,
// chat, rosters, people grid, on-canvas author badge…).
//
// Behaviour (single, identical contract):
//   • A real, user-chosen picture ALWAYS wins — either a `"lib:NN.png"`
//     gallery pick or an uploaded `data:image/…` URL (resolved via
//     `resolveAvatarUrl`).
//   • Otherwise the DEFAULT is a clean TEXT avatar: 1–2 name/email
//     initials on a stable identity colour (`personColor`) — NOT a random
//     gallery face. The same identity → the same initials + hue on every
//     surface and across sessions/devices.
//   • If a chosen image ever fails to load we degrade to the same initials
//     badge, so a broken file never shows an empty circle.
//
// The visual box (size / shape / ring) stays owned by each call site via
// its existing `className`; this component only owns the IMAGE-vs-INITIALS
// decision, the identity colour, and the initials text — so the look is
// consistent without rewriting every stylesheet. Pass `size` for one-off
// inline sizing when a site has no dedicated class.

import { useEffect, useState } from "react";

import { resolveAvatarUrl } from "../../data/userProfile";

import { personColor } from "./meetingColors";

/** 1–2 uppercase initials for a person. Prefers the display name (first
 *  letters of the first two words); falls back to the email local-part,
 *  then to "?". Strips emoji/punctuation so "🐼 Panda" → "P", not the
 *  pictograph. Deterministic — same identity → same initials everywhere. */
export const getInitials = (
  name?: string | null,
  email?: string | null,
): string => {
  const clean = (s: string) =>
    s
      // keep letters/numbers from any script (incl. Hangul); drop the rest
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .replace(/\s+/g, " ");

  const fromName = name ? clean(name) : "";
  if (fromName) {
    const words = fromName.split(" ");
    const initials =
      words.length >= 2 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2);
    return initials.toUpperCase();
  }

  const local = email ? clean(email.split("@")[0]) : "";
  if (local) {
    return local.slice(0, 2).toUpperCase();
  }

  return "?";
};

type Props = {
  /** Raw stored avatar value: `"lib:NN.png"`, a `data:image/…` URL, or
   *  null/undefined when the user hasn't picked one (→ initials). */
  avatar?: string | null;
  /** Display name — drives the initials. */
  name?: string | null;
  /** Login email — initials fallback + (with name) the stable colour key. */
  email?: string | null;
  /** Override the colour/initials identity key. Defaults to email ?? name —
   *  use this for anonymous link-join peers keyed on socketId. */
  identityKey?: string | null;
  /** Site CSS class that owns the box (size / shape / ring). */
  className?: string;
  /** Optional inline pixel size when the site has no dedicated class. */
  size?: number;
  /** Native tooltip. */
  title?: string;
};

/** Identity avatar: chosen image if any, else initials on a stable hue. */
export const MCMAvatar = ({
  avatar,
  name,
  email,
  identityKey,
  className,
  size,
  title,
}: Props) => {
  const imageUrl = resolveAvatarUrl(avatar);
  const [failed, setFailed] = useState(false);

  // A fresh pick deserves a fresh load attempt.
  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  const key = identityKey || email || name || "";
  const cls = className ? `mcm-avatar ${className}` : "mcm-avatar";
  const style: React.CSSProperties = {
    ["--pa" as string]: personColor(key),
    ...(size ? { width: size, height: size } : null),
  };

  if (imageUrl && !failed) {
    return (
      <span className={cls} style={style} title={title} aria-hidden="true">
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={`${cls} mcm-avatar--initials`}
      style={style}
      title={title}
      aria-hidden="true"
    >
      {getInitials(name, email)}
    </span>
  );
};

export default MCMAvatar;
