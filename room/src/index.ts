import debug from "debug";
import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";

import { mountSTT } from "./stt";

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

type RTCSignalPayload = {
  /** target peer in the same room (socket.id) */
  to: string;
  /** WebRTC SDP or ICE candidate, opaque to the server */
  data: unknown;
  /** signal subtype — informational only, server just forwards */
  type: "offer" | "answer" | "ice";
};

type CloudflareTurnIceServers = {
  iceServers: {
    urls: string[] | string;
    username?: string;
    credential?: string;
  };
};

const serverDebug = debug("server");
const ioDebug = debug("io");
const socketDebug = debug("socket");

require("dotenv").config(
  process.env.NODE_ENV !== "development"
    ? { path: ".env.production" }
    : { path: ".env.development" },
);

const app = express();
const port =
  process.env.PORT || (process.env.NODE_ENV !== "development" ? 80 : 3002); // default port to listen

app.use(express.static("public"));
// Chat translation accepts JSON bodies — the rest of the server uses
// socket.io binary frames so this is opt-in to that one endpoint.
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

// ---------------------------------------------------------------------
// Cloudflare TURN credentials proxy
//
// We never ship the long-lived API token to the browser. Instead the
// browser calls /turn-credentials, the server hits Cloudflare's
// credentials endpoint with the long-lived token, and forwards back the
// short-lived TURN username/password the browser needs to relay media
// through Cloudflare's TURN servers.
//
// Cached in-memory for ~23h (credentials TTL is 24h) so we don't burn
// API calls on every page load.
// ---------------------------------------------------------------------
type TurnCredentialCache = {
  expiresAt: number;
  body: CloudflareTurnIceServers;
};
let turnCache: TurnCredentialCache | null = null;
const TURN_TTL_SECONDS = 24 * 60 * 60;
const TURN_CACHE_REFRESH_BEFORE_MS = 60 * 60 * 1000; // refresh 1h before expiry

app.get("/turn-credentials", async (_req, res) => {
  const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!tokenId || !apiToken) {
    res.status(503).json({ error: "TURN not configured on this server" });
    return;
  }

  const now = Date.now();
  if (turnCache && turnCache.expiresAt - TURN_CACHE_REFRESH_BEFORE_MS > now) {
    res.json(turnCache.body);
    return;
  }

  try {
    const cfRes = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${tokenId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );
    if (!cfRes.ok) {
      const text = await cfRes.text();
      console.error("Cloudflare TURN error:", cfRes.status, text);
      res
        .status(502)
        .json({ error: "Failed to fetch TURN credentials from Cloudflare" });
      return;
    }
    const body = (await cfRes.json()) as CloudflareTurnIceServers;
    turnCache = {
      body,
      expiresAt: now + TURN_TTL_SECONDS * 1000,
    };
    res.json(body);
  } catch (err) {
    console.error("TURN credentials fetch failed", err);
    res.status(500).json({ error: "TURN credentials fetch failed" });
  }
});

// ---------------------------------------------------------------------
// Chat translation proxy (Gemini)
//
// The browser asks "translate this text to {lang}", the server forwards
// to Gemini Flash with the API key (never shipped to the client) and
// returns the translated text. Small in-memory cache so multiple
// viewers asking for the same message in the same language only cost
// one round-trip to the API.
//
// We keep it provider-pluggable by reading both GEMINI_API_KEY and a
// generic `TRANSLATION_PROVIDER` flag, but for now Gemini is the only
// branch.
// ---------------------------------------------------------------------

const TRANSLATION_LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ko: "Korean",
  ja: "Japanese",
  zh: "Simplified Chinese",
};

type TranslationCacheEntry = { translated: string; createdAt: number };
const translationCache = new Map<string, TranslationCacheEntry>();
const TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSLATION_CACHE_MAX = 5000;

const pruneTranslationCache = () => {
  if (translationCache.size <= TRANSLATION_CACHE_MAX) {
    return;
  }
  // Drop the oldest ~10% to amortise cleanup cost.
  const cutoff = Math.floor(TRANSLATION_CACHE_MAX * 0.9);
  const entries = Array.from(translationCache.entries()).sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );
  for (let i = 0; i < entries.length - cutoff; i++) {
    translationCache.delete(entries[i][0]);
  }
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const TRANSLATOR_SYSTEM_PROMPT = `You are a professional interpreter for international design review meetings. You translate chat messages between Vietnamese, English, and Korean.

EXPERTISE
- Architecture, construction, structural engineering, industrial design vocabulary (e.g. "load-bearing wall" → "vách chịu lực" / "내력벽", not generic "wall")
- Korean ↔ Vietnamese business context, including how project briefs, RFIs, and review comments are phrased in each culture
- Standard drawing notation, dimension formats, grid references, and material codes

HANDLE MESSY INPUT INTELLIGENTLY
- Real-time chat is full of typos, mixed scripts, abbreviations, slang ("k" = "không", "ko" = "không", "đc" = "được", "vs" = "với", "r" = "rồi", "tks" = "thanks").
- Silently correct typos and infer the speaker's intent. Translate what they MEANT, not what they literally typed.
- If a message is mixed-language (e.g. Vietnamese sentence containing Korean technical terms), translate naturally to the target — keep technical terms in the original language only when there's no widely-used equivalent.
- If the message contains very obvious slang/dialect, translate to natural equivalent in the target language; don't ask for clarification.
- If after best effort the message is genuinely unintelligible (random keystrokes, fragments), return it unchanged.

STYLE RULES
- Match the register of the original: formal stays formal, casual stays casual.
- Preserve Korean honorific levels (-요/-습니다/-십시오) by mapping to the equivalent polite Vietnamese register (vui lòng…, xin…, kính đề nghị…), and vice versa.
- Use industry-standard terms; when uncertain, append the English term in parentheses on first use.
- Keep these UNCHANGED, byte for byte:
  · @mentions like "@filename" or "@bot"
  · markdown link syntax [@label](file:id)
  · dimensions, areas, angles, scales (3,600mm, 22m², 45°, 1:100)
  · material/code references (A-501, Φ20, RC, GL+1500)
  · numbers, percentages, dates, times
  · emoji and reaction symbols
- Don't add explanations, apologies, or "Note:" lines — just the translation.
- Don't wrap in quotes.
- If the text is already in the target language, return it verbatim (no re-phrasing).

OUTPUT
Return ONLY the translated sentence(s). Nothing else.`;

const translateWithGemini = async (
  text: string,
  targetLangName: string,
  apiKey: string,
): Promise<string> => {
  const userPrompt = `Target language: ${targetLangName}

Text to translate:
${text}`;

  const model = process.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: TRANSLATOR_SYSTEM_PROMPT }],
        },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          // small temperature so the model has just enough leeway to
          // fix typos / infer intent without paraphrasing — pure 0 was
          // too literal for chat messages full of abbreviations.
          temperature: 0.2,
          maxOutputTokens: 1024,
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const candidate = json?.candidates?.[0];
  const out = candidate?.content?.parts?.[0]?.text;
  if (typeof out !== "string" || !out.trim()) {
    throw new Error("Gemini returned empty translation");
  }
  return out.trim();
};

// ---------------------------------------------------------------------
// Batch translation — one Gemini call returns ALL target translations
// for a single source text. Sender's client calls this on send so the
// message can be broadcast with translations already attached; every
// receiver picks `translations[theirLang]` for free, eliminating the
// fan-out problem where N readers each fired a /translate request.
// ---------------------------------------------------------------------

const translateBatchWithGemini = async (
  text: string,
  targets: string[],
  apiKey: string,
): Promise<Record<string, string>> => {
  // Build a stable property list in the order the client asked, so the
  // schema is deterministic and Gemini can't drop a key.
  const propEntries = targets
    .map((code) => [code, TRANSLATION_LANGUAGE_NAMES[code]] as const)
    .filter(([, name]) => Boolean(name));
  if (propEntries.length === 0) {
    throw new Error("No supported targets");
  }

  const properties: Record<string, { type: string; description: string }> = {};
  for (const [code, name] of propEntries) {
    properties[code] = {
      type: "string",
      description: `Translation in ${name}. If the source IS already ${name}, return it verbatim.`,
    };
  }

  const userPrompt = `Produce translations of the following message into ALL listed languages. Apply the same style rules. If the source is already a target language, return it verbatim for that key.

Languages: ${propEntries.map(([, n]) => n).join(", ")}

Text:
${text}`;

  const model = process.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: TRANSLATOR_SYSTEM_PROMPT }],
        },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          // Force JSON output — eliminates fragile string parsing.
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties,
            required: propEntries.map(([code]) => code),
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof out !== "string" || !out.trim()) {
    throw new Error("Gemini returned empty batch translation");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`Gemini returned non-JSON: ${(err as Error).message}`);
  }
  const result: Record<string, string> = {};
  for (const [code] of propEntries) {
    const v = parsed[code];
    if (typeof v === "string" && v.trim()) {
      result[code] = v.trim();
    }
  }
  if (Object.keys(result).length === 0) {
    throw new Error("Gemini batch result had no usable strings");
  }
  return result;
};

app.post("/translate-batch", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Translation provider not configured" });
    return;
  }

  const body = req.body as { text?: unknown; targets?: unknown } | undefined;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const targetsRaw = Array.isArray(body?.targets) ? body!.targets : [];
  const targets = targetsRaw
    .filter((t): t is string => typeof t === "string")
    .filter((t) => TRANSLATION_LANGUAGE_NAMES[t]);

  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  if (targets.length === 0) {
    res.status(400).json({ error: "No supported targets" });
    return;
  }
  if (text.length > 5000) {
    res.status(413).json({ error: "Text too long (>5000 chars)" });
    return;
  }

  // One cache key per (sorted target set, text). When 3 users in the
  // room ask for vi+en+ko on the same text, only the first hits Gemini.
  const sortedTargets = [...targets].sort().join(",");
  const cacheKey = `batch:${sortedTargets}:${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < TRANSLATION_CACHE_TTL_MS) {
    try {
      const translations = JSON.parse(cached.translated) as Record<
        string,
        string
      >;
      res.json({ translations, cached: true });
      return;
    } catch {
      // corrupt cache entry — fall through and re-fetch
    }
  }

  try {
    const translations = await translateBatchWithGemini(text, targets, apiKey);
    translationCache.set(cacheKey, {
      translated: JSON.stringify(translations),
      createdAt: Date.now(),
    });
    // Warm the per-target cache too, so any legacy /translate caller
    // (or fallback path on the client) gets a free hit.
    for (const [code, value] of Object.entries(translations)) {
      translationCache.set(`${code}:${text}`, {
        translated: value,
        createdAt: Date.now(),
      });
    }
    pruneTranslationCache();
    res.json({ translations, cached: false });
  } catch (err) {
    console.error("Batch translation failed:", err);
    res
      .status(502)
      .json({ error: (err as Error)?.message ?? "Translation failed" });
  }
});

app.post("/translate", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Translation provider not configured" });
    return;
  }

  const body = req.body as { text?: unknown; target?: unknown } | undefined;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const target = typeof body?.target === "string" ? body.target : "";
  const targetLangName = TRANSLATION_LANGUAGE_NAMES[target];

  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  if (!targetLangName) {
    res.status(400).json({
      error: `Unsupported target language: ${target}`,
    });
    return;
  }
  if (text.length > 5000) {
    res.status(413).json({ error: "Text too long (>5000 chars)" });
    return;
  }

  const cacheKey = `${target}:${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < TRANSLATION_CACHE_TTL_MS) {
    res.json({ translated: cached.translated, cached: true });
    return;
  }

  try {
    const translated = await translateWithGemini(text, targetLangName, apiKey);
    translationCache.set(cacheKey, {
      translated,
      createdAt: Date.now(),
    });
    pruneTranslationCache();
    res.json({ translated, cached: false });
  } catch (err) {
    console.error("Translation failed:", err);
    res
      .status(502)
      .json({ error: (err as Error)?.message ?? "Translation failed" });
  }
});

// ---------------------------------------------------------------------
// In-chat AI assistant (`@bot` mentions)
//
// The frontend strips the @bot trigger from the user's message, ships
// the question plus a slice of recent chat as "context" here, and the
// server hits Gemini with an assistant-flavoured system prompt. The
// answer comes back as plain text — the frontend then broadcasts it
// into the room as a chat message with a bot identity so every
// participant sees it.
// ---------------------------------------------------------------------

type ChatbotContextMessage = {
  username?: string;
  text?: string;
};
type ChatbotRequestBody = {
  question?: unknown;
  language?: unknown;
  recent?: unknown;
  transcript?: unknown;
  canvasText?: unknown;
};

const ASSISTANT_LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ko: "Korean",
};

const CHATBOT_SYSTEM_PROMPT = `You are MCM Bot, an AI assistant embedded in a live architecture/construction design review meeting.

Context the participants share:
- A canvas (floor plans, renders, annotations). You receive the TEXT on it
  (labels, dimensions, drawing/file names) — you do NOT see the images, so
  never claim to "see" a drawing; reason from the text and from what was said.
- A voice transcript of what is being said out loud in the meeting.
- A chat panel where this conversation happens.
- Mixed Vietnamese / Korean / English team

Attribution — who said what:
- Chat lines, voice transcript lines, AND canvas notes are labeled "Name: text". When asked WHO said / asked / proposed / suggested / objected to something, ATTRIBUTE it to that labeled name. The answer is usually right there in a labeled line — do NOT reflexively reply "I don't have that info". In particular, people frequently discuss by writing notes directly ON the canvas, so a labeled canvas note like "luan: cần thêm kính không?" means LUAN asked that.
- Treat a question someone asked as that person RAISING the topic. E.g. if "Ivan: does this facade need more glass?" appears, then Ivan is the one who brought up adding glass; "không cần đâu vì nắng" from Ivan means Ivan argued against more glass.
- Only say "Mình chưa có thông tin đó" when NO labeled line in the chat or transcript covers it — never as a default.

Style:
- Reply in {USER_LANGUAGE}. Match the register (formal vs casual) of the question.
- Be CONCISE: 1–3 sentences. Use a short bullet list only if the user explicitly asks "list", "compare", or similar.
- Use proper industry terminology (load-bearing wall → vách chịu lực / 내력벽, NOT "wall").
- If the user's question lacks context to answer well, say so briefly and ask ONE clarifying question.
- Never invent facts about the specific project. If unsure, say "Mình chưa có thông tin đó" / "I don't have that info" / "그 정보가 없습니다".
- If a question needs visual detail you can't get from text (e.g. "is this window placement ok?"), say you can't see the drawing itself and ask ONE clarifying question.
- Don't preface with "Bot:" or your name — just answer.
- Don't use markdown headings. Bold sparingly.

OUTPUT: just the reply.`;

app.post("/chatbot", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Assistant provider not configured" });
    return;
  }

  const body = req.body as ChatbotRequestBody | undefined;
  const question =
    typeof body?.question === "string" ? body.question.trim() : "";
  const language = typeof body?.language === "string" ? body.language : "vi";
  const recent = Array.isArray(body?.recent)
    ? (body!.recent as ChatbotContextMessage[]).slice(-10)
    : [];
  const transcript = Array.isArray(body?.transcript)
    ? (body!.transcript as Array<{
        speaker?: string;
        text?: string;
        lang?: string;
      }>)
    : [];
  // Soft safety cap — keep the latest segments if a very long meeting
  // would otherwise produce a pathological payload. Mirrors /summarize.
  const MAX_TRANSCRIPT = 3000;
  const transcriptCapped =
    transcript.length > MAX_TRANSCRIPT
      ? transcript.slice(-MAX_TRANSCRIPT)
      : transcript;
  const canvasText = Array.isArray(body?.canvasText)
    ? (body!.canvasText as unknown[])
        .filter(
          (t): t is string => typeof t === "string" && t.trim().length > 0,
        )
        .slice(0, 40)
    : [];

  if (!question) {
    res.status(400).json({ error: "Missing question" });
    return;
  }
  if (question.length > 4000) {
    res.status(413).json({ error: "Question too long (>4000 chars)" });
    return;
  }

  const targetLangName = ASSISTANT_LANGUAGE_NAMES[language] || "Vietnamese";
  const systemPrompt = CHATBOT_SYSTEM_PROMPT.replace(
    "{USER_LANGUAGE}",
    targetLangName,
  );

  const chatLines = recent
    .filter((m) => typeof m?.text === "string" && m.text!.trim())
    .map((m) => `${m.username || "Guest"}: ${m.text}`)
    .join("\n");

  const voiceLines = transcriptCapped
    .filter((s) => typeof s?.text === "string" && s.text!.trim())
    .map(
      (s) =>
        `${s.speaker || "Speaker"}${s.lang ? ` (${s.lang})` : ""}: ${s.text}`,
    )
    .join("\n");

  const canvasLines = canvasText.join("\n");

  const contextBlocks: string[] = [];
  if (canvasLines) {
    contextBlocks.push(
      `Notes/text on the canvas. Participant notes are labeled "Name: text" (people often discuss by writing on the canvas, not just in chat) — attribute them to that name. Unlabeled lines are plain labels/dimensions/drawing or file names:\n${canvasLines}`,
    );
  }
  if (voiceLines) {
    contextBlocks.push(
      `Voice transcript of the meeting so far (oldest first):\n${voiceLines}`,
    );
  }
  if (chatLines) {
    contextBlocks.push(`Recent chat messages:\n${chatLines}`);
  }

  const userPrompt = contextBlocks.length
    ? `${contextBlocks.join(
        "\n\n",
      )}\n\n(The above is context only — do NOT summarise it back unless asked.)\n\nNew question:\n${question}`
    : `New question:\n${question}`;

  const model = process.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;
  try {
    const cfRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 1024,
          },
        }),
      },
    );
    if (!cfRes.ok) {
      const text = await cfRes.text();
      console.error("Chatbot Gemini error:", cfRes.status, text);
      res.status(502).json({ error: `Gemini ${cfRes.status}` });
      return;
    }
    const json: any = await cfRes.json();
    const answer = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      res.status(502).json({ error: "Empty answer from Gemini" });
      return;
    }
    res.json({ answer });
  } catch (err) {
    console.error("Chatbot fetch failed", err);
    res.status(500).json({ error: "Chatbot request failed" });
  }
});

// ---------------------------------------------------------------------
// Meeting summary — Gemini called once after the meeting to produce
// a structured recap of the transcript log.
//
// Returns JSON shaped like:
//   { summary, decisions[], actionItems[], participants[] }
//
// Client posts the full transcript log + the viewer's preferred output
// language so the recap reads naturally for whoever's reviewing.
// ---------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are a meeting recap assistant for a multilingual design-review meeting between Vietnamese and Korean architecture / construction teams.

Given the full transcript (a list of {speaker, text, lang, ts} segments — speakers may have spoken in different languages), produce a STRUCTURED recap.

Besides the transcript, the input MAY also include chat messages and text taken from the meeting canvas (labels, dimensions, drawing/file names); treat all of it as source material for the same structured recap.

OUTPUT (JSON, no markdown):
{
  "summary":   "3-6 sentence overview of what was discussed. Plain prose, in the requested OUTPUT LANGUAGE.",
  "decisions": ["short bullet — e.g. 'mở rộng cửa giữa phòng khách & sân thượng thêm 600mm'"],
  "actionItems": [{ "owner": "name or role", "task": "what to do", "due": "date or null" }],
  "participants": ["unique speaker names sorted by first appearance"],
  "keyTopics": ["short list of high-level themes — 'natural lighting', 'wet area routing', ..."]
}

RULES
- Translate everything in the output to the requested OUTPUT LANGUAGE (vi / en / ko). If you can't tell, default to Vietnamese.
- Be faithful: don't invent decisions or action items the transcript doesn't actually contain. Empty array is correct when there were none.
- Preserve technical terms (dimensions, material codes, room names) verbatim — don't translate "RC", "GL+1500", "200x600mm".
- Preserve @mentions like @bot, @filename.
- Keep "owner" names as written in the transcript — don't anglicise.
- If transcript is too short / fragmented to recap (< 2 substantive segments), set summary to a polite "Cuộc họp chưa có đủ nội dung để tóm tắt" / equivalent and leave arrays empty.

Return ONLY the JSON object. No backticks, no preamble.`;

app.post("/summarize", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Summary provider (Gemini) not configured" });
    return;
  }

  const body = req.body as
    | {
        segments?: Array<{
          speaker?: string;
          text?: string;
          lang?: string;
          ts?: number;
        }>;
        chat?: Array<{ username?: string; text?: string }>;
        canvasText?: unknown;
        language?: string;
      }
    | undefined;

  const segments = Array.isArray(body?.segments) ? body!.segments : [];
  const cleanSegments = segments
    .filter(
      (s): s is { speaker: string; text: string; lang?: string; ts?: number } =>
        !!s &&
        typeof s.speaker === "string" &&
        typeof s.text === "string" &&
        s.text.trim().length > 0,
    )
    .map((s) => ({
      speaker: s.speaker.slice(0, 60),
      text: s.text.slice(0, 2000),
      lang: typeof s.lang === "string" ? s.lang : undefined,
      ts: typeof s.ts === "number" ? s.ts : undefined,
    }));

  const chat = Array.isArray(body?.chat)
    ? body!.chat
        .filter(
          (m): m is { username?: string; text: string } =>
            !!m && typeof m.text === "string" && m.text.trim().length > 0,
        )
        .map((m) => ({
          username: (m.username || "Guest").slice(0, 60),
          text: m.text.slice(0, 2000),
        }))
    : [];
  const canvasText = Array.isArray(body?.canvasText)
    ? (body!.canvasText as unknown[])
        .filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        )
        .slice(0, 40)
        .map((s) => s.slice(0, 200))
    : [];

  if (
    cleanSegments.length === 0 &&
    chat.length === 0 &&
    canvasText.length === 0
  ) {
    res.status(400).json({ error: "No content to summarise" });
    return;
  }

  const lang =
    typeof body?.language === "string" &&
    ["vi", "en", "ko"].includes(body.language)
      ? body.language
      : "vi";
  const languageName = TRANSLATION_LANGUAGE_NAMES[lang] || "Vietnamese";

  // Cap payload size — Gemini Flash handles ~1M tokens but we don't
  // want to upload a 50k-segment transcript by accident.
  const MAX_SEGMENTS = 1500;
  const trimmed =
    cleanSegments.length > MAX_SEGMENTS
      ? cleanSegments.slice(cleanSegments.length - MAX_SEGMENTS)
      : cleanSegments;

  const transcriptBlock = trimmed.length
    ? `\n\nTRANSCRIPT (${trimmed.length} segments):\n${trimmed
        .map(
          (s, i) =>
            `${i + 1}. [${s.speaker}${s.lang ? `, ${s.lang}` : ""}] ${s.text}`,
        )
        .join("\n")}`
    : "";
  const chatBlock = chat.length
    ? `\n\nCHAT MESSAGES:\n${chat.map((m) => `${m.username}: ${m.text}`).join("\n")}`
    : "";
  const canvasBlock = canvasText.length
    ? `\n\nNOTES/TEXT ON CANVAS (participant notes labeled "Name: text" — attribute to that person; unlabeled lines are plain labels/dimensions/file names):\n${canvasText.join("\n")}`
    : "";

  const userPrompt =
    `OUTPUT LANGUAGE: ${languageName}` +
    transcriptBlock +
    chatBlock +
    canvasBlock;

  const model = process.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SUMMARY_SYSTEM_PROMPT }],
          },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096,
            // Strict JSON output — eliminates fragile post-parsing.
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                decisions: {
                  type: "array",
                  items: { type: "string" },
                },
                actionItems: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      owner: { type: "string" },
                      task: { type: "string" },
                      due: { type: "string" },
                    },
                    required: ["owner", "task"],
                  },
                },
                participants: {
                  type: "array",
                  items: { type: "string" },
                },
                keyTopics: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: [
                "summary",
                "decisions",
                "actionItems",
                "participants",
                "keyTopics",
              ],
            },
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error(
        "Gemini summary failed:",
        response.status,
        errBody.slice(0, 200),
      );
      res.status(502).json({ error: "Summary provider error" });
      return;
    }

    const json: any = await response.json();
    const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof out !== "string" || !out.trim()) {
      res.status(502).json({ error: "Empty summary response" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch (parseErr) {
      res.status(502).json({
        error: `Summary JSON parse failed: ${(parseErr as Error).message}`,
      });
      return;
    }
    res.json(parsed);
  } catch (err) {
    console.error("Summary request error:", err);
    res.status(500).json({ error: "Summary request failed" });
  }
});

const server = http.createServer(app);

// Mount the realtime STT WebSocket proxy at /stt. Must be attached
// BEFORE socket.io binds to the same http server — socket.io will
// otherwise intercept all upgrade requests. The proxy filters by
// request URL so socket.io only sees non-/stt upgrades.
mountSTT(server);

server.listen(port, () => {
  serverDebug(`listening on port: ${port}`);
});

try {
  const io = new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
      allowedHeaders: ["Content-Type", "Authorization"],
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    },
    allowEIO3: true,
    // raise the per-message limit so we can ship file binaries (images,
    // small docs) inline through the encrypted broadcast channel for the
    // Meeting Library sync feature. Sized for files up to 30MB +
    // base64 expansion (~33%) + socket.io framing overhead.
    maxHttpBufferSize: 50 * 1024 * 1024, // 50MB
  });

  io.on("connection", (socket) => {
    ioDebug("connection established!");
    io.to(`${socket.id}`).emit("init-room");
    socket.on("join-room", async (roomID) => {
      socketDebug(`${socket.id} has joined ${roomID}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }

      io.in(roomID).emit(
        "room-user-change",
        sockets.map((socket) => socket.id),
      );
    });

    socket.on(
      "server-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on(
      "server-volatile-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast
          .to(roomID)
          .emit("client-broadcast", encryptedData, iv);
      },
    );

    // -----------------------------------------------------------------
    // WebRTC signaling relay for voice/video mesh calls. The server is
    // dumb — it just forwards `rtc-signal` payloads to the addressed
    // peer. Anything peer-to-peer (offer SDP, answer SDP, ICE
    // candidates) goes through here. Media itself goes peer-to-peer
    // (or through the Cloudflare TURN relay if NAT traversal needs it).
    // -----------------------------------------------------------------
    // Client just enabled audio inside an already-joined collab room
    // and missed the original `room-user-change` broadcast. Ask the
    // server to re-send the current peer list so we can build up our
    // mesh retroactively.
    socket.on("request-room-clients", async () => {
      for (const roomID of Array.from(socket.rooms)) {
        if (roomID === socket.id) {
          continue;
        }
        const sockets = await io.in(roomID).fetchSockets();
        socket.emit(
          "room-user-change",
          sockets.map((s) => s.id),
        );
      }
    });

    socket.on("rtc-signal", (payload: RTCSignalPayload) => {
      if (!payload || typeof payload.to !== "string") {
        return;
      }
      socketDebug(`${socket.id} -> ${payload.to} rtc-signal (${payload.type})`);
      io.to(payload.to).emit("rtc-signal", {
        from: socket.id,
        type: payload.type,
        data: payload.data,
      });
    });

    socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
      const roomID = `follow@${payload.userToFollow.socketId}`;

      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
        case "UNFOLLOW": {
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
      }
    });

    socket.on("disconnecting", async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith("follow@");

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            "room-user-change",
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace("follow@", "");
          io.to(socketId).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });
} catch (error) {
  console.error(error);
}
