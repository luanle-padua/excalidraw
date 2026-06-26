# gemini-relay

Tiny forwarder that makes the Canvas M worker's **Gemini** calls (translate /
summarize / chatbot) egress from a **Gemini-supported region** instead of the
Hong Kong Cloudflare PoP.

## The problem it solves

The `mcm-storage` worker runs on Cloudflare edge PoPs. For Vietnam / SEA users
the PoP is often **Hong Kong (HKG)**, and the Gemini API **rejects Hong Kong**:

```
400 FAILED_PRECONDITION — "User location is not supported for the API use."
```

(Korea works; Deepgram/STT works — it's Gemini's region rule on HK.) This relay,
hosted in a **supported region**, receives the worker's Gemini request and
forwards it to Google from there. Egress = the relay's region → Gemini accepts.

## Deploy (Railway — pick a SUPPORTED region)

> Supported regions include **US, Singapore, Japan, Korea, EU** — **NOT Hong
> Kong**. On Railway choose e.g. **US West** or **Southeast Asia (Singapore)**.

1. Create a new Railway project → **Deploy from repo** (or `railway up` from this
   `gemini-relay/` folder). Railway auto-detects Node and runs `npm start`.
2. In the service **Settings → Region**, pick a supported region (US / Singapore).
3. In **Variables**, add:
   - `RELAY_SECRET` = a long random string (e.g. `openssl rand -hex 32`).
   - (`PORT` is set by Railway automatically — don't set it.)
4. Deploy → note the public URL, e.g. `https://gemini-relay-production-xxxx.up.railway.app`.
5. Health check: open the URL in a browser → should print `gemini-relay ok`.

(Render / Fly.io work the same way — any Node host in a supported region.)

## Wire it into the worker (mcm-storage)

Set on the worker (from `excalidraw/worker/`):

```bash
# the relay's public base URL (NO trailing slash)
npx wrangler secret put GEMINI_RELAY_URL      # paste https://…up.railway.app
# the SAME secret value you set as RELAY_SECRET on the relay
npx wrangler secret put GEMINI_RELAY_SECRET   # paste the random string
```

The worker auto-detects these: when both are set it routes every Gemini call
through the relay; if unset it calls Gemini directly (current behaviour). No
redeploy of the worker is needed after setting the secrets — they take effect on
the next request. To roll back, delete the two secrets.

## Security

- Forwards **only** to `generativelanguage.googleapis.com`, **only** when
  `X-Relay-Auth` matches `RELAY_SECRET` — not an open proxy.
- The Gemini API key lives on the worker and passes through in the request; the
  relay does not store it.
