# E2E realtime parity suite (Durable Objects migration)

`do-realtime.spec.ts` is a **Playwright** parity suite for the socket.io →
Durable Objects realtime migration
(`docs/plans/durable-objects-migration.md`, "Parity acceptance checklist
(Team C)").

> **It requires a deployed DO.** Every test drives 2+ real browser clients
> against a running app whose target meeting has `realtime_backend='do'` in D1.
> There is no live DO yet, so the suite cannot pass today. It is written so it
> runs the moment a DO is deployed.

Playwright is **not** currently a dependency of this monorepo (confirmed: no
`@playwright/test`, no `playwright.config.*`). This README is the wiring guide
so the spec stays a runnable skeleton without force-installing a heavy
framework.

## Wire it up (one-time)

From the repo root:

```bash
# 1. Install Playwright test runner + browsers (dev-only).
npm i -D @playwright/test
npx playwright install chromium

# 2. Add a config. A minimal one (e2e/playwright.config.ts) is provided below —
#    copy it or create your own. It points the runner at this folder.
```

Minimal `e2e/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // collab tests coordinate 2+ contexts; keep serial
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "on-first-retry",
    // For the STT test you also need fake audio:
    //   launchOptions: { args: [
    //     "--use-fake-device-for-media-stream",
    //     "--use-file-for-fake-audio-capture=/path/to/sample.wav",
    //   ] },
  },
});
```

## Required env vars

| Var | Meaning | Required |
|---|---|---|
| `E2E_BASE_URL` | App origin, e.g. `https://canvas-m.local` | yes |
| `E2E_ROOM_URL` | Full meeting URL incl. `#room=<id>,<roomKey>` | yes |
| `E2E_USER_A` / `E2E_PASS_A` | Internal host credentials | yes |
| `E2E_USER_B` / `E2E_PASS_B` | Second internal participant | yes |
| `E2E_GUEST_EMAIL` | External non-admitted guest (knock-deny test) | optional |

The target meeting **must** have `realtime_backend='do'` set in D1, e.g.:

```bash
cd worker
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meetings SET realtime_backend='do' WHERE id='<ROOM_ID>'"
```

## Run (after deploy)

```bash
export E2E_BASE_URL="https://canvas-m.example"
export E2E_ROOM_URL="https://canvas-m.example/#room=<id>,<roomKey>"
export E2E_USER_A="host@map.internal";  export E2E_PASS_A="..."
export E2E_USER_B="member@map.internal"; export E2E_PASS_B="..."

npx playwright test e2e/do-realtime.spec.ts
# single group:
npx playwright test e2e/do-realtime.spec.ts -g "scene-sync"
```

If the env vars are unset the whole file `test.skip`s with a clear message —
it never fails silently.

## Selector wiring

The spec marks each app-specific hook with a `// SELECTOR:` comment. Most
collab UI already ships `data-testid`; point those comments at the real ids
when you stand the suite up. The spec also reads an optional
`window.__mcmSceneElementCount` (and falls back to the Excalidraw dev handle
`window.h.elements`) for scene-count assertions — expose that in the E2E build
if the dev handle isn't available.

## Coverage map

See `docs/runbooks/do-test-plan.md` for the full parity-item → test mapping
(GO/NO-GO matrix). Groups covered here: scene-sync, presence (incl.
first-in-room-once + reconnect-no-double), follow, screen-share lock,
chat/reactions/raise-hand, STT segment (`fixme` until fake-audio fixture),
knock auth (denied cannot open WS), reconnect-after-disconnect.
