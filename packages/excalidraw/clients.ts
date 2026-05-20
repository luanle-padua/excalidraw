import {
  COLOR_CHARCOAL_BLACK,
  COLOR_VOICE_CALL,
  COLOR_WHITE,
  THEME,
  UserIdleState,
} from "@excalidraw/common";

import { roundRect } from "./renderer/roundRect";

import type { InteractiveCanvasRenderConfig } from "./scene/types";
import type {
  Collaborator,
  InteractiveCanvasAppState,
  SocketId,
} from "./types";

function hashToInteger(id: string) {
  let hash = 0;
  if (id.length === 0) {
    return hash;
  }
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = (hash << 5) - hash + char;
  }
  return hash;
}

// ---------------------------------------------------------------------
// MCM cursor labels — friendly emoji avatar + short name for remote
// peers' canvas cursors. Mirrors the logic in
// excalidraw-app/components/mcm/animalEmoji.ts (kept in sync by hand;
// extracting to a shared package would require restructuring imports
// across the monorepo for one feature).
// ---------------------------------------------------------------------

// Map known "Adjective Animal" usernames straight to the species
// emoji. Anything not in this map falls back to a deterministic pick
// from the cute-critter pool, so EVERY peer gets a face.
//
// CRITICAL: this map MUST stay in sync with `ANIMAL_EMOJI` in
// excalidraw-app/components/mcm/animalEmoji.ts — otherwise the same
// peer renders with different emojis in the participants bar (which
// uses the app-side map) vs. the canvas cursor (this file). Keep the
// keys + emoji choices identical, including aliases (hare↔rabbit,
// rhino↔rhinoceros, hippo↔hippopotamus, dodo, etc.).
const MCM_ANIMAL_EMOJI: Record<string, string> = {
  // Mammals
  cat: "🐱",
  dog: "🐶",
  fox: "🦊",
  wolf: "🐺",
  lion: "🦁",
  tiger: "🐯",
  leopard: "🐆",
  cheetah: "🐆",
  bear: "🐻",
  panda: "🐼",
  koala: "🐨",
  monkey: "🐵",
  gorilla: "🦍",
  orangutan: "🦧",
  chimpanzee: "🐒",
  baboon: "🐒",
  rabbit: "🐰",
  hare: "🐰",
  squirrel: "🐿️",
  chipmunk: "🐿️",
  beaver: "🦫",
  otter: "🦦",
  hedgehog: "🦔",
  mouse: "🐭",
  rat: "🐀",
  hamster: "🐹",
  horse: "🐴",
  zebra: "🦓",
  donkey: "🫏",
  cow: "🐮",
  buffalo: "🐃",
  ox: "🐂",
  bull: "🐂",
  pig: "🐷",
  boar: "🐗",
  sheep: "🐑",
  ram: "🐏",
  goat: "🐐",
  deer: "🦌",
  elk: "🦌",
  moose: "🫎",
  reindeer: "🦌",
  giraffe: "🦒",
  camel: "🐫",
  llama: "🦙",
  alpaca: "🦙",
  elephant: "🐘",
  rhinoceros: "🦏",
  rhino: "🦏",
  hippopotamus: "🦛",
  hippo: "🦛",
  kangaroo: "🦘",
  bat: "🦇",
  sloth: "🦥",
  raccoon: "🦝",
  skunk: "🦨",
  badger: "🦡",
  mole: "🐭",
  // Birds
  bird: "🐦",
  chicken: "🐔",
  rooster: "🐓",
  duck: "🦆",
  swan: "🦢",
  goose: "🪿",
  turkey: "🦃",
  peacock: "🦚",
  parrot: "🦜",
  owl: "🦉",
  eagle: "🦅",
  hawk: "🦅",
  flamingo: "🦩",
  dodo: "🦤",
  penguin: "🐧",
  // Reptiles + amphibians
  crocodile: "🐊",
  alligator: "🐊",
  turtle: "🐢",
  tortoise: "🐢",
  snake: "🐍",
  lizard: "🦎",
  gecko: "🦎",
  iguana: "🦎",
  frog: "🐸",
  toad: "🐸",
  // Aquatic
  fish: "🐟",
  shark: "🦈",
  dolphin: "🐬",
  whale: "🐳",
  octopus: "🐙",
  squid: "🦑",
  crab: "🦀",
  lobster: "🦞",
  shrimp: "🦐",
  oyster: "🦪",
  jellyfish: "🪼",
  seal: "🦭",
  // Insects + small critters
  bee: "🐝",
  ant: "🐜",
  butterfly: "🦋",
  beetle: "🪲",
  ladybug: "🐞",
  spider: "🕷️",
  scorpion: "🦂",
  worm: "🪱",
  snail: "🐌",
  // Mythical
  dragon: "🐉",
  unicorn: "🦄",
  dinosaur: "🦖",
  trex: "🦖",
  pterodactyl: "🦕",
  brontosaurus: "🦕",
  mammoth: "🦣",
};

const MCM_FALLBACK_POOL = [
  "🦊",
  "🐼",
  "🐨",
  "🦁",
  "🐯",
  "🐻",
  "🐰",
  "🐱",
  "🐶",
  "🐭",
  "🐹",
  "🦝",
  "🦔",
  "🦦",
  "🦥",
  "🦘",
  "🦒",
  "🐵",
  "🐧",
  "🦉",
  "🦆",
  "🦩",
  "🐢",
  "🐙",
  "🐳",
  "🐬",
  "🦋",
  "🐝",
  "🐞",
  "🦄",
];

const mcmCleanName = (raw: string): string =>
  raw.replace(/\(.*?\)/g, "").trim();

const mcmShortName = (username: string): string => {
  const cleaned = mcmCleanName(username);
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return cleaned;
  }
  const tail = parts[parts.length - 1].toLowerCase();
  return MCM_ANIMAL_EMOJI[tail] ? parts[parts.length - 1] : cleaned;
};

// MUST stay identical to `stableHash` in excalidraw-app/components/mcm/
// animalEmoji.ts — otherwise the same socketId picks different
// emojis in the participants bar vs. the canvas cursor and the
// visual link between the two breaks. Specifically: x * 31 + char
// with explicit `| 0` to force 32-bit signed truncation, so long
// strings overflow exactly the same way in both places.
const mcmHash = (key: string): number => {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};

const mcmPickEmoji = (identityKey: string, username: string): string => {
  const cleaned = mcmCleanName(username);
  const tail = (cleaned.split(/\s+/).pop() || "").toLowerCase();
  if (MCM_ANIMAL_EMOJI[tail]) {
    return MCM_ANIMAL_EMOJI[tail];
  }
  const key = identityKey || username || "anon";
  return MCM_FALLBACK_POOL[mcmHash(key) % MCM_FALLBACK_POOL.length];
};

export const getClientColor = (
  socketId: SocketId,
  collaborator: Collaborator | undefined,
) => {
  // to get more even distribution in case `id` is not uniformly distributed to
  // begin with, we hash it
  const hash = Math.abs(hashToInteger(collaborator?.id || socketId));
  // we want to get a multiple of 10 number in the range of 0-360 (in other
  // words a hue value of step size 10). There are 37 such values including 0.
  const hue = (hash % 37) * 10;
  const saturation = 100;
  const lightness = 83;

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

// ---------------------------------------------------------------------
// MCM avatar image cache for remote cursors. We can't synchronously
// load images inside the per-frame canvas render, so each unique
// avatar URL gets a single Image element lazy-loaded once and cached
// here. The render path checks `loaded` — if true, draws the image;
// if false, falls through to the emoji disc until the next frame
// where the load may have completed (cursor renders re-fire on every
// MOUSE_LOCATION update, so this catches up within a few hundred ms
// without any explicit scene-invalidate plumbing).
// ---------------------------------------------------------------------
type MCMAvatarEntry = { img: HTMLImageElement; loaded: boolean };
const MCM_AVATAR_CACHE = new Map<string, MCMAvatarEntry>();

const mcmGetLoadedAvatar = (url: string): HTMLImageElement | null => {
  const cached = MCM_AVATAR_CACHE.get(url);
  if (cached) {
    return cached.loaded ? cached.img : null;
  }
  const img = new Image();
  const entry: MCMAvatarEntry = { img, loaded: false };
  MCM_AVATAR_CACHE.set(url, entry);
  // crossOrigin so future canvas reads (exportPng etc) don't taint the
  // canvas. Library + data: URLs are same-origin so this is a no-op,
  // but harmless if a future profile points at a CDN avatar.
  img.crossOrigin = "anonymous";
  img.onload = () => {
    entry.loaded = true;
  };
  img.onerror = () => {
    // Eviction so a transient 404 doesn't trap callers forever — the
    // next frame's render will retry the load.
    MCM_AVATAR_CACHE.delete(url);
  };
  img.src = url;
  return null;
};

/**
 * returns first char, capitalized
 */
export const getNameInitial = (name?: string | null) => {
  // first char can be a surrogate pair, hence using codePointAt
  const firstCodePoint = name?.trim()?.codePointAt(0);
  return (
    firstCodePoint ? String.fromCodePoint(firstCodePoint) : "?"
  ).toUpperCase();
};

export const renderRemoteCursors = ({
  context,
  renderConfig,
  appState,
  normalizedWidth,
  normalizedHeight,
}: {
  context: CanvasRenderingContext2D;
  renderConfig: InteractiveCanvasRenderConfig;
  appState: InteractiveCanvasAppState;
  normalizedWidth: number;
  normalizedHeight: number;
}) => {
  // Paint remote pointers
  for (const [socketId, pointer] of renderConfig.remotePointerViewportCoords) {
    let { x, y } = pointer;

    const collaborator = appState.collaborators.get(socketId);

    x -= appState.offsetLeft;
    y -= appState.offsetTop;

    const width = 11;
    const height = 14;

    const isOutOfBounds =
      x < 0 ||
      x > normalizedWidth - width ||
      y < 0 ||
      y > normalizedHeight - height;

    x = Math.max(x, 0);
    x = Math.min(x, normalizedWidth - width);
    y = Math.max(y, 0);
    y = Math.min(y, normalizedHeight - height);

    const background = getClientColor(socketId, collaborator);

    context.save();
    // Counter Excalidraw's dark-theme canvas filter
    // (`invert(93%) hue-rotate(180deg)`, see css/theme.scss). Applying
    // the SAME filter at the context level double-inverts our draws,
    // so the cursor + label end up looking identical to light theme
    // — avatar colours stay true, white pill stays white, charcoal
    // text stays charcoal.
    if (appState.theme === THEME.DARK) {
      context.filter = "invert(93%) hue-rotate(180deg)";
    }
    context.strokeStyle = background;
    context.fillStyle = background;

    const userState = renderConfig.remotePointerUserStates.get(socketId);
    const isInactive =
      isOutOfBounds ||
      userState === UserIdleState.IDLE ||
      userState === UserIdleState.AWAY;

    if (isInactive) {
      context.globalAlpha = 0.3;
    }

    if (renderConfig.remotePointerButton.get(socketId) === "down") {
      context.beginPath();
      context.arc(x, y, 15, 0, 2 * Math.PI, false);
      context.lineWidth = 3;
      context.strokeStyle = "#ffffff88";
      context.stroke();
      context.closePath();

      context.beginPath();
      context.arc(x, y, 15, 0, 2 * Math.PI, false);
      context.lineWidth = 1;
      context.strokeStyle = background;
      context.stroke();
      context.closePath();
    }

    // TODO remove the dark theme color after we stop inverting canvas colors
    const IS_SPEAKING_COLOR =
      appState.theme === THEME.DARK ? "#2f6330" : COLOR_VOICE_CALL;

    const isSpeaking = collaborator?.isSpeaking;

    if (isSpeaking) {
      // cursor outline for currently speaking user
      context.fillStyle = IS_SPEAKING_COLOR;
      context.strokeStyle = IS_SPEAKING_COLOR;
      context.lineWidth = 10;
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 0, y + 14);
      context.lineTo(x + 4, y + 9);
      context.lineTo(x + 11, y + 8);
      context.closePath();
      context.stroke();
      context.fill();
    }

    // Background (white outline) for arrow
    context.fillStyle = COLOR_WHITE;
    context.strokeStyle = COLOR_WHITE;
    context.lineWidth = 6;
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 0, y + 14);
    context.lineTo(x + 4, y + 9);
    context.lineTo(x + 11, y + 8);
    context.closePath();
    context.stroke();
    context.fill();

    // Arrow
    context.fillStyle = background;
    context.strokeStyle = background;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    if (isInactive) {
      context.moveTo(x - 1, y - 1);
      context.lineTo(x - 1, y + 15);
      context.lineTo(x + 5, y + 10);
      context.lineTo(x + 12, y + 9);
      context.closePath();
      context.fill();
    } else {
      context.moveTo(x, y);
      context.lineTo(x + 0, y + 14);
      context.lineTo(x + 4, y + 9);
      context.lineTo(x + 11, y + 8);
      context.closePath();
      context.fill();
      context.stroke();
    }

    // MCM cursor label — under the arrow we draw a circular avatar
    // (gradient fill, big emoji centred) plus a small short-name pill
    // beneath. Matches the participant bar so peers' faces feel
    // consistent across canvas + chrome.
    const rawUsername = renderConfig.remotePointerUsernames.get(socketId) || "";
    const shortName = mcmShortName(rawUsername);
    const cursorEmoji = mcmPickEmoji(socketId, rawUsername);

    if (!isOutOfBounds && shortName) {
      // Anchor below the arrow tip so the arrow still indicates the
      // click point cleanly. Shrunk from 18 → 14 once the company
      // sub-line was added: the full label stack was getting heavy
      // enough to dominate the cursor, so trimming the avatar +
      // tightening the gap keeps the column compact.
      const avatarRadius = 14;
      const arrowTailY = y + 14;
      const avatarCenterX = x + 8;
      const avatarCenterY = arrowTailY + avatarRadius + 3;

      // Save text-state we touch so we don't bleed into other
      // renderers (canvas state is global per frame here).
      const prevAlign = context.textAlign;
      const prevBaseline = context.textBaseline;

      // Speaking ring — green halo around the avatar.
      if (isSpeaking) {
        context.beginPath();
        context.arc(
          avatarCenterX,
          avatarCenterY,
          avatarRadius + 4,
          0,
          2 * Math.PI,
        );
        context.fillStyle = IS_SPEAKING_COLOR;
        context.fill();
      }

      // White outline so the disc reads on any canvas background.
      context.beginPath();
      context.arc(
        avatarCenterX,
        avatarCenterY,
        avatarRadius + 2,
        0,
        2 * Math.PI,
      );
      context.fillStyle = COLOR_WHITE;
      context.fill();

      // Avatar disc — same colour family as the user's pointer. Used
      // as a backdrop so transparent avatars still read clearly, and
      // as the only fill if the image hasn't loaded yet.
      context.beginPath();
      context.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, 2 * Math.PI);
      context.fillStyle = background;
      context.fill();

      // If the collaborator has an avatar URL (custom upload OR
      // library image picked in the MCM profile modal) AND it has
      // finished loading, paint that as the avatar disc. We clip to
      // the same circle as the backdrop so the image stays round.
      // No image yet → fall through to the emoji glyph below, which
      // is what every peer rendered before the profile feature.
      const avatarImg = collaborator?.avatarUrl
        ? mcmGetLoadedAvatar(collaborator.avatarUrl)
        : null;
      if (avatarImg) {
        context.save();
        context.beginPath();
        context.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, 2 * Math.PI);
        context.clip();
        context.drawImage(
          avatarImg,
          avatarCenterX - avatarRadius,
          avatarCenterY - avatarRadius,
          avatarRadius * 2,
          avatarRadius * 2,
        );
        context.restore();
      } else {
        // Centred emoji at the new smaller size. The optical-Y nudge
        // accounts for emoji glyphs having their visual centre
        // slightly below the typographic centre.
        context.font =
          '18px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(cursorEmoji, avatarCenterX, avatarCenterY + 1);
      }

      // Stacked label: name pill + optional company sub-line.
      // Company comes off the Collaborator (sourced from
      // userProfileAtom in Collab), and only renders when set so
      // peers without a profile stay compact.
      const company = collaborator?.company?.trim() ?? "";
      const namePadH = 6;
      const namePadV = 3;

      context.font = "600 11px sans-serif";
      context.textBaseline = "middle";
      // The image-avatar branch above never sets textAlign (only the
      // emoji branch does), so without this line the name + company
      // would render LEFT-anchored at avatarCenterX instead of
      // centred — i.e. the labels would visibly drift left of the
      // pill on any peer who picked a custom avatar.
      context.textAlign = "center";
      const nameMeasure = context.measureText(shortName);
      const nameBoxW = nameMeasure.width + namePadH * 2;
      const nameBoxH = 11 + namePadV * 2 + 2;
      const nameBoxX = avatarCenterX - nameBoxW / 2;
      const nameBoxY = avatarCenterY + avatarRadius + 5;

      if (context.roundRect) {
        context.beginPath();
        context.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6);
        context.fillStyle = background;
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = COLOR_WHITE;
        context.stroke();
      } else {
        roundRect(
          context,
          nameBoxX,
          nameBoxY,
          nameBoxW,
          nameBoxH,
          6,
          COLOR_WHITE,
        );
      }
      context.fillStyle = COLOR_CHARCOAL_BLACK;
      context.fillText(shortName, avatarCenterX, nameBoxY + nameBoxH / 2);

      // Company sub-line — smaller font, white text with a thin dark
      // shadow halo so it reads against any canvas background without
      // needing its own pill. Truncated visually by the natural
      // measureText limit; we don't bother with ellipsis since
      // company strings are bounded to 48 chars at the profile modal.
      if (company) {
        const companyY = nameBoxY + nameBoxH + 4 + 5;
        context.font = "500 10px sans-serif";
        context.textBaseline = "middle";
        context.textAlign = "center";
        // 4-direction halo so the text reads on light AND dark
        // backgrounds without a second pill draw.
        context.fillStyle = "rgba(0, 0, 0, 0.55)";
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          context.fillText(company, avatarCenterX + dx, companyY + dy);
        }
        context.fillStyle = COLOR_WHITE;
        context.fillText(company, avatarCenterX, companyY);
      }

      // Restore text alignment for whatever runs next.
      context.textAlign = prevAlign;
      context.textBaseline = prevBaseline;
    }

    context.restore();
    context.closePath();
  }
};
