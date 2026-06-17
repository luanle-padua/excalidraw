// AI / cost routes (Gemini) — ported from the Fly room server
// (room/src/index.ts:46-848) to the mcm-storage Worker as part of the
// Durable Objects migration (I-1, docs/plans/durable-objects-migration.md §6).
//
// Same request/response contract as the room server so the client switch is a
// pure base-URL change (room-server URL → STORAGE_URL):
//   POST /translate         { text, target }                 -> { translated, cached }
//   POST /translate-batch   { text, targets[] }              -> { translations, cached }
//   POST /chatbot           { question, language, recent, transcript, canvasText }
//                                                            -> { answer }
//   POST /summarize         { segments[], chat[], canvasText[], language }
//                                                            -> structured recap JSON
//
// Differences from the room server (deliberate, plan §6 / P4):
//   - Rate-limit is a per-isolate in-memory counter (NOT express-rate-limit,
//     NOT a Durable Object). Per-isolate is "enough for internal"; harden to a
//     DO/KV limiter only if external abuse shows up (B7).
//   - Translation cache is a per-isolate Map (lost when the isolate rotates;
//     Gemini Flash is ~$0.075/1M tokens, so the occasional miss is fine).
//   - The Gemini key comes from env (GEMINI_API_KEY) — never hardcoded; the
//     human sets it via `wrangler secret put GEMINI_API_KEY`.

import { Hono } from "hono";

import { geminiFlashCostUsd, logUsageEvent } from "./usage";

// Bindings consumed by the AI routes. Kept narrow so the routes can mount on
// the main app's Bindings (which is a superset) without a circular import.
export type AiBindings = {
  // Gemini (Google Generative Language) API key — SECRET.
  // Local: worker/.dev.vars · Prod: `wrangler secret put GEMINI_API_KEY`.
  GEMINI_API_KEY?: string;
  // Optional model override (plain var). Defaults to gemini-2.5-flash.
  GEMINI_TRANSLATION_MODEL?: string;
  // D1 — for best-effort AI cost metering (usage_events). The main app's
  // Bindings is a superset; this keeps the AI sub-app self-contained.
  DB?: D1Database;
};

// Variables the main app's JWT gate attaches; the AI sub-app reads `email` off
// the SAME context (it's mounted via app.route, so the context is shared) to
// stamp usage_events. `meeting_id` comes from the request body/query.
type AiVariables = {
  userId?: string;
  email?: string;
  role?: string;
};

// Token usage Gemini reports on a successful generateContent response.
type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number };

// Gemini response shape (candidates text + usageMetadata for cost metering).
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: GeminiUsage;
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const TRANSLATION_LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ko: "Korean",
  ja: "Japanese",
  zh: "Simplified Chinese",
};

const ASSISTANT_LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ko: "Korean",
};

// ---------------------------------------------------------------------
// Per-isolate rate limiting (plan §6 — replaces express-rate-limit).
//
// A simple in-memory sliding-window-ish counter keyed by IP + route. NOT a
// distributed store — each Worker isolate keeps its own counters, which is
// enough for internal use. Keyed by the request IP (CF-Connecting-IP); the
// routes carry no user identity. 429 on limit.
// ---------------------------------------------------------------------
type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

const rateLimited = (
  ip: string,
  route: string,
  max: number,
  windowMs: number,
): boolean => {
  const key = `${route}:${ip}`;
  const nowMs = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || nowMs >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
};

const clientIp = (req: Request): string =>
  req.headers.get("CF-Connecting-IP") ||
  req.headers.get("x-forwarded-for") ||
  "unknown";

// ---------------------------------------------------------------------
// Translation cache (per-isolate Map; plan §6).
// ---------------------------------------------------------------------
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

const geminiUrl = (model: string, apiKey: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${apiKey}`;

// Best-effort cost metering for ONE successful Gemini call: read the token
// counts off usageMetadata, compute the Flash cost, write a usage_events row.
// Fire-and-forget (logUsageEvent never throws) so it can't slow/break the route.
const meterGemini = (
  c: { env: AiBindings; get: (k: "email") => string | undefined },
  kind: string,
  usage: GeminiUsage | undefined,
  meetingId?: string,
): void => {
  if (!c.env.DB) {
    return;
  }
  const tokensIn = usage?.promptTokenCount ?? 0;
  const tokensOut = usage?.candidatesTokenCount ?? 0;
  const cost = geminiFlashCostUsd(tokensIn, tokensOut);
  void logUsageEvent(
    c.env.DB,
    "gemini",
    kind,
    tokensIn,
    tokensOut,
    0,
    cost,
    meetingId,
    c.get("email"),
  );
};

// `meetingId` from the request body/query, when the client supplies it. Best
// effort — the AI routes are otherwise meeting-agnostic, so this just enriches
// the usage row when present.
const readMeetingId = (
  body: { meetingId?: unknown; roomId?: unknown } | undefined,
  query: string | undefined,
): string | undefined => {
  const fromBody =
    typeof body?.meetingId === "string"
      ? body.meetingId
      : typeof body?.roomId === "string"
      ? body.roomId
      : undefined;
  return fromBody || query || undefined;
};

const translateWithGemini = async (
  text: string,
  targetLangName: string,
  apiKey: string,
  model: string,
): Promise<{ translated: string; usage?: GeminiUsage }> => {
  const userPrompt = `Target language: ${targetLangName}

Text to translate:
${text}`;

  const res = await fetch(geminiUrl(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSLATOR_SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        // small temperature so the model has just enough leeway to fix typos /
        // infer intent without paraphrasing — pure 0 was too literal for chat.
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as GeminiResponse;
  const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof out !== "string" || !out.trim()) {
    throw new Error("Gemini returned empty translation");
  }
  return { translated: out.trim(), usage: json.usageMetadata };
};

const translateBatchWithGemini = async (
  text: string,
  targets: string[],
  apiKey: string,
  model: string,
): Promise<{ translations: Record<string, string>; usage?: GeminiUsage }> => {
  // Build a stable property list in the order the client asked, so the schema
  // is deterministic and Gemini can't drop a key.
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

  const res = await fetch(geminiUrl(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSLATOR_SYSTEM_PROMPT }] },
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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as GeminiResponse;
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
  return { translations: result, usage: json.usageMetadata };
};

// Hono sub-app holding the four AI routes. Mounted on the main app so it shares
// the same Bindings (a superset of AiBindings) and CORS middleware.
export const aiRoutes = new Hono<{
  Bindings: AiBindings;
  Variables: AiVariables;
}>();

aiRoutes.post("/translate-batch", async (c) => {
  if (rateLimited(clientIp(c.req.raw), "translate", 20, 60_000)) {
    return c.json({ error: "Too many requests, please slow down" }, 429);
  }
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Translation provider not configured" }, 503);
  }
  const model = c.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;

  const body = (await c.req.json().catch(() => undefined)) as
    | {
        text?: unknown;
        targets?: unknown;
        meetingId?: unknown;
        roomId?: unknown;
      }
    | undefined;
  const meetingId = readMeetingId(body, c.req.query("meetingId"));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const targetsRaw = Array.isArray(body?.targets) ? body.targets : [];
  const targets = targetsRaw
    .filter((t): t is string => typeof t === "string")
    .filter((t) => TRANSLATION_LANGUAGE_NAMES[t]);

  if (!text) {
    return c.json({ error: "Missing text" }, 400);
  }
  if (targets.length === 0) {
    return c.json({ error: "No supported targets" }, 400);
  }
  if (text.length > 5000) {
    return c.json({ error: "Text too long (>5000 chars)" }, 413);
  }

  // One cache key per (sorted target set, text).
  const sortedTargets = [...targets].sort().join(",");
  const cacheKey = `batch:${sortedTargets}:${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < TRANSLATION_CACHE_TTL_MS) {
    try {
      const translations = JSON.parse(cached.translated) as Record<
        string,
        string
      >;
      return c.json({ translations, cached: true });
    } catch {
      // corrupt cache entry — fall through and re-fetch
    }
  }

  try {
    const { translations, usage } = await translateBatchWithGemini(
      text,
      targets,
      apiKey,
      model,
    );
    meterGemini(c, "translate", usage, meetingId);
    translationCache.set(cacheKey, {
      translated: JSON.stringify(translations),
      createdAt: Date.now(),
    });
    // Warm the per-target cache too, so any legacy /translate caller (or
    // fallback path on the client) gets a free hit.
    for (const [code, value] of Object.entries(translations)) {
      translationCache.set(`${code}:${text}`, {
        translated: value,
        createdAt: Date.now(),
      });
    }
    pruneTranslationCache();
    return c.json({ translations, cached: false });
  } catch (err) {
    console.error("Batch translation failed:", err);
    return c.json(
      { error: (err as Error)?.message ?? "Translation failed" },
      502,
    );
  }
});

aiRoutes.post("/translate", async (c) => {
  if (rateLimited(clientIp(c.req.raw), "translate", 20, 60_000)) {
    return c.json({ error: "Too many requests, please slow down" }, 429);
  }
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Translation provider not configured" }, 503);
  }
  const model = c.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;

  const body = (await c.req.json().catch(() => undefined)) as
    | {
        text?: unknown;
        target?: unknown;
        meetingId?: unknown;
        roomId?: unknown;
      }
    | undefined;
  const meetingId = readMeetingId(body, c.req.query("meetingId"));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const target = typeof body?.target === "string" ? body.target : "";
  const targetLangName = TRANSLATION_LANGUAGE_NAMES[target];

  if (!text) {
    return c.json({ error: "Missing text" }, 400);
  }
  if (!targetLangName) {
    return c.json({ error: `Unsupported target language: ${target}` }, 400);
  }
  if (text.length > 5000) {
    return c.json({ error: "Text too long (>5000 chars)" }, 413);
  }

  const cacheKey = `${target}:${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < TRANSLATION_CACHE_TTL_MS) {
    return c.json({ translated: cached.translated, cached: true });
  }

  try {
    const { translated, usage } = await translateWithGemini(
      text,
      targetLangName,
      apiKey,
      model,
    );
    meterGemini(c, "translate", usage, meetingId);
    translationCache.set(cacheKey, { translated, createdAt: Date.now() });
    pruneTranslationCache();
    return c.json({ translated, cached: false });
  } catch (err) {
    console.error("Translation failed:", err);
    return c.json(
      { error: (err as Error)?.message ?? "Translation failed" },
      502,
    );
  }
});

aiRoutes.post("/chatbot", async (c) => {
  if (rateLimited(clientIp(c.req.raw), "chatbot", 5, 60_000)) {
    return c.json({ error: "Too many requests, please slow down" }, 429);
  }
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Assistant provider not configured" }, 503);
  }
  const model = c.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;

  const body = (await c.req.json().catch(() => undefined)) as
    | {
        question?: unknown;
        language?: unknown;
        recent?: unknown;
        transcript?: unknown;
        canvasText?: unknown;
        meetingId?: unknown;
        roomId?: unknown;
      }
    | undefined;
  const meetingId = readMeetingId(body, c.req.query("meetingId"));
  const question =
    typeof body?.question === "string" ? body.question.trim() : "";
  const language = typeof body?.language === "string" ? body.language : "vi";
  const recent = Array.isArray(body?.recent)
    ? (body.recent as Array<{ username?: string; text?: string }>).slice(-10)
    : [];
  const transcript = Array.isArray(body?.transcript)
    ? (body.transcript as Array<{
        speaker?: string;
        text?: string;
        lang?: string;
      }>)
    : [];
  // Soft safety cap — keep the latest segments if a very long meeting would
  // otherwise produce a pathological payload. Mirrors /summarize.
  const MAX_TRANSCRIPT = 3000;
  const transcriptCapped =
    transcript.length > MAX_TRANSCRIPT
      ? transcript.slice(-MAX_TRANSCRIPT)
      : transcript;
  const canvasText = Array.isArray(body?.canvasText)
    ? (body.canvasText as unknown[])
        .filter(
          (t): t is string => typeof t === "string" && t.trim().length > 0,
        )
        .slice(0, 40)
    : [];

  if (!question) {
    return c.json({ error: "Missing question" }, 400);
  }
  if (question.length > 4000) {
    return c.json({ error: "Question too long (>4000 chars)" }, 413);
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

  try {
    const cfRes = await fetch(geminiUrl(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
      }),
    });
    if (!cfRes.ok) {
      const text = await cfRes.text();
      console.error("Chatbot Gemini error:", cfRes.status, text);
      return c.json({ error: `Gemini ${cfRes.status}` }, 502);
    }
    const json = (await cfRes.json()) as GeminiResponse;
    const answer = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      return c.json({ error: "Empty answer from Gemini" }, 502);
    }
    meterGemini(c, "chatbot", json.usageMetadata, meetingId);
    return c.json({ answer });
  } catch (err) {
    console.error("Chatbot fetch failed", err);
    return c.json({ error: "Chatbot request failed" }, 500);
  }
});

aiRoutes.post("/summarize", async (c) => {
  if (rateLimited(clientIp(c.req.raw), "summarize", 1, 60_000)) {
    return c.json({ error: "Too many requests, please slow down" }, 429);
  }
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Summary provider (Gemini) not configured" }, 503);
  }
  const model = c.env.GEMINI_TRANSLATION_MODEL || DEFAULT_GEMINI_MODEL;

  const body = (await c.req.json().catch(() => undefined)) as
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
        meetingId?: unknown;
        roomId?: unknown;
      }
    | undefined;
  const meetingId = readMeetingId(body, c.req.query("meetingId"));

  const segments = Array.isArray(body?.segments) ? body.segments : [];
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
    ? body.chat
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
    ? (body.canvasText as unknown[])
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
    return c.json({ error: "No content to summarise" }, 400);
  }

  const lang =
    typeof body?.language === "string" &&
    ["vi", "en", "ko"].includes(body.language)
      ? body.language
      : "vi";
  const languageName = TRANSLATION_LANGUAGE_NAMES[lang] || "Vietnamese";

  // Cap payload size — Gemini Flash handles ~1M tokens but we don't want to
  // upload a 50k-segment transcript by accident.
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
    ? `\n\nCHAT MESSAGES:\n${chat
        .map((m) => `${m.username}: ${m.text}`)
        .join("\n")}`
    : "";
  const canvasBlock = canvasText.length
    ? `\n\nNOTES/TEXT ON CANVAS (participant notes labeled "Name: text" — attribute to that person; unlabeled lines are plain labels/dimensions/file names):\n${canvasText.join(
        "\n",
      )}`
    : "";

  const userPrompt = `OUTPUT LANGUAGE: ${languageName}${transcriptBlock}${chatBlock}${canvasBlock}`;

  try {
    const response = await fetch(geminiUrl(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
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
              decisions: { type: "array", items: { type: "string" } },
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
              participants: { type: "array", items: { type: "string" } },
              keyTopics: { type: "array", items: { type: "string" } },
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
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(
        "Gemini summary failed:",
        response.status,
        errBody.slice(0, 200),
      );
      return c.json({ error: "Summary provider error" }, 502);
    }

    const json = (await response.json()) as GeminiResponse;
    const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof out !== "string" || !out.trim()) {
      return c.json({ error: "Empty summary response" }, 502);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch (parseErr) {
      return c.json(
        { error: `Summary JSON parse failed: ${(parseErr as Error).message}` },
        502,
      );
    }
    meterGemini(c, "summarize", json.usageMetadata, meetingId);
    return c.json(parsed as Record<string, unknown>);
  } catch (err) {
    console.error("Summary request error:", err);
    return c.json({ error: "Summary request failed" }, 500);
  }
});
