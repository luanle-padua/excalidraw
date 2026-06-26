// Minimal Gemini relay — forwards requests to generativelanguage.googleapis.com
// FROM A GEMINI-SUPPORTED REGION.
//
// WHY: the Canvas M worker (mcm-storage) runs on Cloudflare edge PoPs, which for
// Vietnam/SEA users land on the HONG KONG (HKG) PoP. The Gemini API rejects Hong
// Kong with 400 "User location is not supported for the API use". Routing the
// Gemini call through this relay makes the egress originate from wherever THIS
// service is hosted — so deploy it in a SUPPORTED region (US / Singapore / Japan
// / Korea — NOT Hong Kong). Then the worker points GEMINI_RELAY_URL at it.
//
// SECURITY: it forwards ONLY to the Gemini host, and ONLY when the X-Relay-Auth
// header matches RELAY_SECRET — so it can't be abused as an open proxy / can't
// leak the Gemini quota. The Gemini API key travels in the request the worker
// sends (?key=…); this relay just passes it through to Google.
//
// ENV:
//   PORT          — set automatically by Railway/Render/Fly.
//   RELAY_SECRET  — a long random string; set the SAME value on the worker as
//                   the secret GEMINI_RELAY_SECRET.

import { createServer } from "node:http";

const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const PORT = Number(process.env.PORT) || 8080;

const server = createServer(async (req, res) => {
  try {
    // Health check (Railway/uptime pings) — no auth needed.
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("gemini-relay ok");
      return;
    }

    if (!RELAY_SECRET || req.headers["x-relay-auth"] !== RELAY_SECRET) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    // Buffer the request body.
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Forward to Gemini: SAME path + query (the worker sends the full
    // /v1beta/models/…:generateContent?key=… path), same method + body.
    const upstream = await fetch(`${GEMINI_HOST}${req.url}`, {
      method: req.method,
      headers: {
        "content-type":
          req.headers["content-type"] || "application/json",
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`relay error: ${err && err.message ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`gemini-relay listening on :${PORT}`);
});
