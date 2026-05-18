// Cute animal face for an Excalidraw-generated username.
//
// The collab layer assigns names like "Luminous Rhinoceros", "Artistic
// Gorilla", "Decisive Hippopotamus" — a single adjective followed by
// an animal noun. We extract the trailing animal word and map it to
// the Unicode emoji face for that creature, so the participant rail
// reads like a tiny zoo at a glance.
//
// Falls back gracefully:
//   - manual usernames ("Mai", "luan") → no match → caller renders
//     initials in a coloured circle (current behaviour).
//   - unknown animals → no match → same fallback.
//
// We also export the cleaned display name (drops the adjective prefix
// when the animal is recognised) so the UI shows "Rhinoceros" instead
// of "Luminous Rhinoceros" — much shorter and easier to scan.

const ANIMAL_EMOJI: Record<string, string> = {
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
  // Mythical (Excalidraw uses these too)
  dragon: "🐉",
  unicorn: "🦄",
  dinosaur: "🦖",
  trex: "🦖",
  pterodactyl: "🦕",
  brontosaurus: "🦕",
  mammoth: "🦣",
};

/** Pull the trailing word from `Adjective Animal`-style usernames. */
const lastWord = (raw: string): string => {
  const parts = raw
    .replace(/\(.*?\)/g, "") // drop any "(extra)" suffix
    .trim()
    .split(/\s+/);
  return (parts[parts.length - 1] || "").toLowerCase();
};

/**
 * Return the emoji face for the animal in the username, or null if
 * the username doesn't end in a recognised animal (manual names,
 * non-English usernames, etc.). Caller decides what to render in the
 * no-match case (initials fallback).
 */
export const emojiForUsername = (username: string): string | null => {
  if (!username) {
    return null;
  }
  const tail = lastWord(username);
  return ANIMAL_EMOJI[tail] ?? null;
};

// Curated cute-animal pool for the FALLBACK emoji (when username
// isn't an animal name). Hand-picked from emojipedia.org/nature for
// "friendly meeting vibe" — no spiders, no snakes, no skunks.
const FALLBACK_POOL = [
  "🦊", // fox
  "🐼", // panda
  "🐨", // koala
  "🦁", // lion
  "🐯", // tiger
  "🐻", // bear
  "🐰", // rabbit
  "🐱", // cat
  "🐶", // dog
  "🐭", // mouse
  "🐹", // hamster
  "🦝", // raccoon
  "🦔", // hedgehog
  "🦦", // otter
  "🦥", // sloth
  "🦘", // kangaroo
  "🦒", // giraffe
  "🐵", // monkey
  "🐧", // penguin
  "🦉", // owl
  "🦆", // duck
  "🦩", // flamingo
  "🐢", // turtle
  "🐙", // octopus
  "🐳", // whale
  "🐬", // dolphin
  "🦋", // butterfly
  "🐝", // bee
  "🐞", // ladybug
  "🦄", // unicorn
] as const;

const stableHash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};

/**
 * Always return an emoji — preferred order:
 *   1. Animal noun extracted from the username (so "Luminous Rhinoceros"
 *      always reads as 🦏 — meaning preserved).
 *   2. Deterministic pick from FALLBACK_POOL keyed off a stable
 *      identity (socketId preferred, falls back to username). Same
 *      user → same emoji across sessions, so the eye learns the
 *      face for each person.
 *
 * Use this for AVATARS (every participant should have one). Use
 * `emojiForUsername` directly when you want "only if it's actually
 * an animal name" semantics.
 */
export const pickEmojiFor = (
  identityKey: string,
  username?: string,
): string => {
  if (username) {
    const matched = emojiForUsername(username);
    if (matched) {
      return matched;
    }
  }
  const key = identityKey || username || "anon";
  return FALLBACK_POOL[stableHash(key) % FALLBACK_POOL.length];
};

/**
 * Cleaned display name. When the username matches the `Adjective
 * Animal` pattern we drop the adjective so labels read "Rhinoceros"
 * instead of "Luminous Rhinoceros" — the avatar emoji + animal noun
 * is enough to disambiguate, and the UI gets much tighter.
 *
 * Manual names ("Mai", "luan", "Park Junho") pass through untouched.
 */
export const shortDisplayName = (username: string): string => {
  if (!username) {
    return "";
  }
  const cleaned = username.replace(/\(.*?\)/g, "").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return cleaned;
  }
  const tail = parts[parts.length - 1].toLowerCase();
  if (ANIMAL_EMOJI[tail]) {
    return parts[parts.length - 1];
  }
  return cleaned;
};
