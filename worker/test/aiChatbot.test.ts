// /chatbot robustness + meeting-context tests (06-17).
//
// Two guarantees the canvas/chat bot relies on:
//   1. The Gemini call NEVER bubbles a 5xx. On a Gemini error / network
//      failure / empty answer, /chatbot returns HTTP 200 with a graceful
//      { answer } fallback so the bot just renders text (the 502-on-empty-
//      canvas bug). Intentional client signals (400/413/429/503) stay.
//   2. The new optional meeting-context fields (participants/files/
//      meetingTitle/meetingStatus) are accepted and woven into the prompt,
//      backward-compatibly (a request with none still answers).
//
//   npx vitest run worker/test/aiChatbot.test.ts   (from repo root)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRoutes } from "../src/ai";

// Hono's app.request(input, requestInit, Env) takes env as the THIRD arg.
const env = { GEMINI_API_KEY: "test-key" } as any;

// Unique IP per request so the per-isolate rate limiter (5/min, keyed by
// CF-Connecting-IP) doesn't 429 later tests that share the module state.
let ipCounter = 0;
function post(body: unknown): Request {
  ipCounter += 1;
  return new Request("https://w/chatbot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.0.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

function geminiOk(answer: string) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: answer }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/chatbot robustness", () => {
  it("400 when the question is missing (intentional client signal)", async () => {
    const res = await aiRoutes.request(
      post({ language: "en" }),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 + fallback answer when Gemini responds non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream boom", { status: 503 }),
    );
    const res = await aiRoutes.request(
      post({ question: "hi", language: "en" }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer?: string };
    expect(typeof json.answer).toBe("string");
    expect(json.answer && json.answer.length).toBeGreaterThan(0);
  });

  it("returns 200 + fallback answer when the Gemini fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const res = await aiRoutes.request(
      post({ question: "hi", language: "vi" }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer?: string };
    expect(typeof json.answer).toBe("string");
  });

  it("returns 200 + fallback when Gemini returns an empty answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await aiRoutes.request(
      post({ question: "hi", language: "ko" }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer?: string };
    expect(typeof json.answer).toBe("string");
  });

  it("answers normally with empty context (no canvas/recent/transcript)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(geminiOk("hello there"));
    const res = await aiRoutes.request(
      post({ question: "say hi", language: "en" }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer?: string };
    expect(json.answer).toBe("hello there");
  });
});

describe("/chatbot meeting-context enrichment", () => {
  it("accepts participants/files/meetingTitle/meetingStatus and weaves them into the prompt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(geminiOk("ok"));
    const res = await aiRoutes.request(
      post({
        question: "who is in the meeting",
        language: "en",
        participants: [
          { name: "Luan", role: "PM" },
          "Ivan",
          { name: "" }, // dropped (no name)
        ],
        files: [{ name: "plan.dxf", kind: "DXF" }, "render.png"],
        meetingTitle: "Facade review",
        meetingStatus: "live",
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);

    // Inspect the prompt we sent upstream - the context must be present.
    expect(fetchMock).toHaveBeenCalledOnce();
    const callBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const userText = callBody.contents[0].parts[0].text as string;
    expect(userText).toContain("Luan");
    expect(userText).toContain("PM");
    expect(userText).toContain("Ivan");
    expect(userText).toContain("plan.dxf");
    expect(userText).toContain("render.png");
    expect(userText).toContain("Facade review");
    expect(userText).toContain("live");
  });

  it("ignores non-array participants/files defensively", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(geminiOk("ok"));
    const res = await aiRoutes.request(
      post({
        question: "hi",
        language: "en",
        participants: "not-an-array",
        files: 42,
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
  });
});
