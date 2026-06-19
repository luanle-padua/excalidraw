// Client-side STT provider metadata mirror + per-session selection.
//
// The authoritative provider seam lives in the Worker
// (worker/src/stt-provider.ts: SttAdapter + ProviderMetadata + REGISTRY).
// This file is a SMALL client mirror so the in-meeting selector and the Admin
// Console can show each provider's name + accurate per-minute price + required
// API key WITHOUT round-tripping the Worker. Keep the ids and prices in sync
// with the worker REGISTRY.
//
// A/B-testing model (PM, 06-18): pick the most ACCURATE provider for VI/KO/EN
// meeting audio, not the cheapest. The per-session dropdown (?provider=<id>) is
// the LIVE lever; the global default is the STT_PROVIDER env var (wrangler), so
// changing it needs a deploy — surfaced read-only in the Admin Console.

import { atom } from "../app-jotai";

import type { STTProvider } from "../audio/sttSession";

export type STTProviderMeta = {
  id: STTProvider;
  /** Human label for the dropdown + admin card. */
  name: string;
  /** PM's exact model id under test (drives the cost number). */
  model: string;
  /** USD per audio minute. ACCURATE — feeds the admin Cost tab. */
  usdPerMinute: number;
  /** Worker env var that must hold this provider's API key. */
  requiredKey: string;
  /** Not wired for live use yet (no API key / adapter unverified). Shown in the
   *  picker as "to be added soon" + disabled — Deepgram is the only live one
   *  until the PM enables the others (06-18). */
  comingSoon?: boolean;
};

// Mirrors worker ProviderMetadata. Prices are the PM's exact A/B figures
// (06-18): Deepgram Nova-3 mono streaming, OpenAI realtime transcription
// (gpt-realtime-whisper streaming, verified ~$0.017/min Jun 2026), ElevenLabs
// Scribe v2 Realtime.
export const STT_PROVIDERS: readonly STTProviderMeta[] = [
  {
    id: "deepgram",
    name: "Deepgram Nova-3",
    model: "nova-3",
    usdPerMinute: 0.0048,
    requiredKey: "DEEPGRAM_API_KEY",
  },
  {
    id: "openai",
    name: "OpenAI Realtime (Whisper)",
    model: "gpt-realtime-whisper",
    usdPerMinute: 0.017,
    requiredKey: "OPENAI_API_KEY",
    comingSoon: true,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs Scribe v2",
    model: "scribe_v2_realtime",
    usdPerMinute: 0.0065,
    requiredKey: "ELEVENLABS_API_KEY",
    comingSoon: true,
  },
  {
    id: "gemini-live",
    name: "Gemini Live — dịch trực tiếp (preview)",
    model: "gemini-3.5-live-translate-preview",
    // PLACEHOLDER price — mirrors the worker adapter's "verify pricing later"
    // (0). Gemini Live bills on its own Live-API schedule; update once confirmed.
    usdPerMinute: 0,
    requiredKey: "GEMINI_LIVE_API_KEY",
    // No API key / real protocol yet → shown disabled as "to be added soon"
    // until the PM wires GeminiLiveAdapter.open() in the worker.
    comingSoon: true,
  },
] as const;

/** Default mirrors the Worker's DEFAULT_STT_PROVIDER. */
export const DEFAULT_STT_PROVIDER: STTProvider = "deepgram";

export const providerMeta = (id: STTProvider): STTProviderMeta =>
  STT_PROVIDERS.find((p) => p.id === id) ?? STT_PROVIDERS[0];

/** Format a per-minute price for a price chip, e.g. `$0.0048/min`. */
export const fmtPerMinute = (usd: number): string => `$${usd.toFixed(4)}/min`;

const STT_PROVIDER_LS_KEY = "mcm:sttProvider";

const readProvider = (): STTProvider => {
  if (typeof window === "undefined") {
    return DEFAULT_STT_PROVIDER;
  }
  try {
    const v = window.localStorage.getItem(STT_PROVIDER_LS_KEY);
    // Only restore a provider that is actually live (not "coming soon"), so a
    // stale pick of a not-yet-enabled provider can't break STT after a reload.
    if (v && STT_PROVIDERS.some((p) => p.id === v && !p.comingSoon)) {
      return v as STTProvider;
    }
  } catch {
    // ignore — fall back to default
  }
  return DEFAULT_STT_PROVIDER;
};

/** Per-session provider choice for A/B testing. Persisted per device so the
 *  PM's pick survives a reload while testing. */
export const sttProviderAtom = atom<STTProvider>(readProvider());

export const setSttProvider = (id: STTProvider): void => {
  try {
    window.localStorage.setItem(STT_PROVIDER_LS_KEY, id);
  } catch {
    // ignore — best-effort
  }
};
