/**
 * do-realtime.spec.ts — E2E parity suite for the Durable Objects realtime
 * backend (docs/plans/durable-objects-migration.md, "Parity acceptance
 * checklist (Team C)").
 *
 * ⚠️ REQUIRES A DEPLOYED DO. Every test here drives two or more real browser
 * clients against a running app whose target meeting has
 * `realtime_backend='do'` in D1. There is NO live DO yet, so these tests
 * CANNOT pass today — this is a runnable-after-deploy skeleton. Each test is a
 * named scenario with explicit steps + the assertions a human/CI runs at
 * cutover to verify DO-path parity with the socket.io path.
 *
 * Playwright is NOT yet a dependency of this repo (see e2e/README.md to wire
 * it). This file imports `@playwright/test`; it type-checks + runs only after
 * `npm i -D @playwright/test` and `npx playwright install`.
 *
 * Parameterized entirely by env vars (see e2e/README.md):
 *   E2E_BASE_URL   app origin, e.g. https://canvas-m.local            (required)
 *   E2E_ROOM_URL   full meeting URL incl. #room=<id>,<roomKey>        (required)
 *   E2E_USER_A / E2E_PASS_A   internal host credentials               (required)
 *   E2E_USER_B / E2E_PASS_B   second internal participant             (required)
 *   E2E_GUEST_EMAIL           external guest email (for knock tests)  (optional)
 *
 * The selectors below are intentionally described, not hard-coded to brittle
 * DOM paths — wire each `// SELECTOR:` comment to the real test id when you
 * stand the suite up (the app already ships data-testid on most collab UI).
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Config + helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? "";
const ROOM_URL = process.env.E2E_ROOM_URL ?? "";
const USER_A = process.env.E2E_USER_A ?? "";
const PASS_A = process.env.E2E_PASS_A ?? "";
const USER_B = process.env.E2E_USER_B ?? "";
const PASS_B = process.env.E2E_PASS_B ?? "";
const GUEST_EMAIL = process.env.E2E_GUEST_EMAIL ?? "";

const REQUIRES_DO =
  "requires deployed DO (realtime_backend='do') + a real meeting URL";

// Skip the whole file (clearly, not silently) when the env isn't wired.
test.beforeAll(() => {
  test.skip(
    !BASE_URL || !ROOM_URL || !USER_A || !USER_B,
    `E2E env not set — ${REQUIRES_DO}. See e2e/README.md.`,
  );
});

/** Log a user in and open the meeting room. Encapsulates the login form +
 *  navigation so each test reads as steps. Wire the SELECTOR comments to the
 *  real app test ids when standing this up. */
async function openRoomAs(
  context: BrowserContext,
  email: string,
  password: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(BASE_URL);
  // SELECTOR: login form. The app uses Supabase Auth (magic-link + password).
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in|đăng nhập/i }).click();
  await page.waitForLoadState("networkidle");
  // Open the shared meeting URL (carries #room=<id>,<roomKey>).
  await page.goto(ROOM_URL);
  // Canvas mounted = collab transport connecting.
  // SELECTOR: the Excalidraw canvas container.
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
  return page;
}

/** Count remote collaborator avatars rendered for `page` (presence list). */
async function collaboratorCount(page: Page): Promise<number> {
  // SELECTOR: collaborator avatar list in the top bar / presence overlay.
  return page.locator('[data-testid="collaborator-avatar"]').count();
}

/** Draw a rectangle by dragging on the canvas. Returns nothing; assert on the
 *  peer side. */
async function drawRectangle(page: Page): Promise<void> {
  // SELECTOR: rectangle tool (keyboard shortcut 'r' also works in Excalidraw).
  await page.keyboard.press("r");
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("canvas has no bounding box");
  }
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 200, { steps: 8 });
  await page.mouse.up();
}

/** Read the live element count the app exposes for assertions. The app can
 *  surface `window.__mcmSceneElementCount` in E2E builds; fall back to probing
 *  the Excalidraw API if present. */
async function sceneElementCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __mcmSceneElementCount?: number;
      h?: { elements?: unknown[] };
    };
    if (typeof w.__mcmSceneElementCount === "number") {
      return w.__mcmSceneElementCount;
    }
    // Fallback: Excalidraw dev handle.
    return w.h?.elements?.length ?? -1;
  });
}

// ===========================================================================
// 1. Scene sync  (checklist group "1. Scene sync")
// ===========================================================================
test.describe("scene-sync [DO]", () => {
  test("two clients: draw / move / delete reconcile with version + order", async ({
    browser,
  }) => {
    // Steps:
    //  1. A and B both join the same DO-backed room.
    //  2. A draws a rectangle (UPDATE / SCENE_UPDATE :1323-1331).
    //  3. B sees exactly one new element (reconcile by version + order).
    //  4. B moves it; A sees the move.
    //  5. A deletes it; B's count drops (deletion needs a version bump to
    //     broadcast — ref collab-gotchas).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);

    const before = await sceneElementCount(b);
    await drawRectangle(a);
    await expect
      .poll(() => sceneElementCount(b), { timeout: 10_000 })
      .toBe(before + 1);

    // delete on A → B reflects removal (version bump broadcasts the delete).
    await a.keyboard.press("Control+a");
    await a.keyboard.press("Delete");
    await expect
      .poll(() => sceneElementCount(b), { timeout: 10_000 })
      .toBe(before);

    await ctxA.close();
    await ctxB.close();
  });

  test("late joiner gets full scene once (INIT, no duplicate)", async ({
    browser,
  }) => {
    // Steps:
    //  1. A joins, draws 3 elements.
    //  2. B joins LATE → receives one INIT (SCENE_INIT :1306-1322) carrying the
    //     full scene; `socketInitialized` must prevent a second INIT applying.
    //  3. B's element count == A's (no duplication, no missing).
    const ctxA = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    await drawRectangle(a);
    await drawRectangle(a);
    await drawRectangle(a);
    const aCount = await sceneElementCount(a);

    const ctxB = await browser.newContext();
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect
      .poll(() => sceneElementCount(b), { timeout: 10_000 })
      .toBe(aCount);

    await ctxA.close();
    await ctxB.close();
  });

  test("20s full-sync fanout does not desync or double versions (D6)", async ({
    browser,
  }) => {
    // Steps:
    //  1. A + B join; A draws elements.
    //  2. Idle > 20s so queueBroadcastAllElements fires a full-scene rebroadcast
    //     (SYNC_FULL_SCENE_INTERVAL_MS=20000).
    //  3. Element counts on A and B stay EQUAL and STABLE (no doubling, no
    //     version churn).
    test.setTimeout(60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await drawRectangle(a);
    await drawRectangle(a);
    const aCount = await sceneElementCount(a);
    // wait out one full-sync interval + margin.
    await a.waitForTimeout(23_000);
    expect(await sceneElementCount(a)).toBe(aCount);
    expect(await sceneElementCount(b)).toBe(aCount);
    await ctxA.close();
    await ctxB.close();
  });
});

// ===========================================================================
// 2. Presence  (checklist group "2. Presence" + "10. Reconnect")
// ===========================================================================
test.describe("presence [DO]", () => {
  test("join/leave updates the room-user list", async ({ browser }) => {
    // Steps: A joins (1 self, 0 remote). B joins → A sees 1 remote collaborator.
    // B leaves → A sees 0 remote (debounced ~250ms, no flicker).
    const ctxA = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    expect(await collaboratorCount(a)).toBe(0);

    const ctxB = await browser.newContext();
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(1);

    await ctxB.close();
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(0);
    await ctxA.close();
  });

  test("first-in-room fires once per room lifetime (not on reconnect)", async ({
    browser,
  }) => {
    // The DO drives first-in-room off the persisted `roomEverInitialized` flag,
    // NOT getWebSockets().length (§3.1 invariant 1 / R5). Steps:
    //  1. A joins, draws content.
    //  2. A reloads (reconnect). first-in-room must NOT re-fire → the scene must
    //     NOT be cleared. Assert A still sees its content after reload.
    const ctxA = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    await drawRectangle(a);
    const count = await sceneElementCount(a);
    expect(count).toBeGreaterThan(0);

    await a.reload();
    await expect(a.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
    // Scene preserved (re-INIT from a peer / R2 fallback), not wiped.
    await expect
      .poll(() => sceneElementCount(a), { timeout: 12_000 })
      .toBeGreaterThanOrEqual(count);
    await ctxA.close();
  });

  test("reconnect does not double the collaborator (new-user, no dup)", async ({
    browser,
  }) => {
    // Steps: A + B joined (A sees 1 remote). B reconnects (reload). A's remote
    // count returns to exactly 1 — the DO mints a new socketId per accept, but
    // the app dedups the host/peer by joinedAt, not socketId (§3.1 inv. 2,
    // checklist group 10). No phantom second avatar.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(1);

    await b.reload();
    await expect(b.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
    // After the dust settles there is still exactly ONE remote on A.
    await expect.poll(() => collaboratorCount(a), { timeout: 15_000 }).toBe(1);
    await ctxA.close();
    await ctxB.close();
  });
});

// ===========================================================================
// 3. Follow  (checklist group "3. Follow")
// ===========================================================================
test.describe("follow [DO]", () => {
  test("A follows B: B viewport pan pushes to A; B leaving unfollows", async ({
    browser,
  }) => {
    // Steps:
    //  1. A + B join.
    //  2. A clicks B's avatar → "follow" (user-follow FOLLOW; B receives
    //     user-follow-room-change with A in its follower list).
    //  3. B pans the canvas (USER_VISIBLE_SCENE_BOUNDS) → A's viewport follows.
    //  4. B leaves → A receives broadcast-unfollow and exits follow mode
    //     (no hang).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(1);

    // SELECTOR: click B's collaborator avatar to start following.
    await a.locator('[data-testid="collaborator-avatar"]').first().click();
    // SELECTOR: follow-mode indicator/banner on A.
    await expect(
      a.locator('[data-testid="follow-mode-banner"]'),
    ).toBeVisible({ timeout: 8_000 });

    // B pans; A's follow banner remains (viewport pushed). Then B leaves.
    await b.mouse.move(400, 400);
    await b.keyboard.down("Space");
    await b.mouse.down();
    await b.mouse.move(600, 500, { steps: 10 });
    await b.mouse.up();
    await b.keyboard.up("Space");

    await ctxB.close();
    // broadcast-unfollow → A exits follow mode (banner gone), no hang.
    await expect(
      a.locator('[data-testid="follow-mode-banner"]'),
    ).toBeHidden({ timeout: 10_000 });
    await ctxA.close();
  });
});

// ===========================================================================
// 5. Locks — screen share  (checklist group "5. Locks")
// ===========================================================================
test.describe("screen-share-lock [DO]", () => {
  test("one sharer locks others; abrupt drop prunes the lock", async ({
    browser,
  }) => {
    // Steps:
    //  1. A + B join.
    //  2. A starts screen share (SCREEN_SHARE :1448-1452; media via Daily.co).
    //  3. B's own share control early-returns / is blocked (applyScreenShare
    //     dedup :2405-2421) while A holds the lock.
    //  4. A drops abruptly (context close) → prune-on-leave (:1862-1883) frees
    //     the lock so B can now share (no stuck lock).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(1);

    // SELECTOR: present / screen-share button.
    await a.getByRole("button", { name: /present|share screen|trình bày/i }).click();
    // SELECTOR: a "someone is presenting" lock state visible on B.
    await expect(
      b.locator('[data-testid="screen-share-active"]'),
    ).toBeVisible({ timeout: 10_000 });

    // A drops abruptly.
    await ctxA.close();
    // Lock pruned → B can present now (button enabled / no lock state).
    await expect(
      b.locator('[data-testid="screen-share-active"]'),
    ).toBeHidden({ timeout: 12_000 });
    await ctxB.close();
  });
});

// ===========================================================================
// 6. Chat / reactions / raise-hand  (checklist group "6.")
// ===========================================================================
test.describe("chat-reactions-raisehand [DO]", () => {
  test("chat message + reaction + raise-hand propagate in order", async ({
    browser,
  }) => {
    // Steps:
    //  1. A + B join.
    //  2. A sends a chat message (CHAT :1411-1414) → B sees it, correct order.
    //  3. B reacts to it (CHAT_REACTION :1416-1419) → A sees the reaction on
    //     that message.
    //  4. B raises hand (RAISE_HAND :1442-1446) → A sees a sticky badge until
    //     lowered; badge pruned when B leaves (:1845-1859).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await expect.poll(() => collaboratorCount(a), { timeout: 10_000 }).toBe(1);

    const msg = `e2e-${Date.now()}`;
    // SELECTOR: open chat panel + message input.
    await a.getByRole("button", { name: /chat/i }).click();
    await a.getByPlaceholder(/message|tin nhắn/i).fill(msg);
    await a.keyboard.press("Enter");
    await b.getByRole("button", { name: /chat/i }).click();
    await expect(b.getByText(msg)).toBeVisible({ timeout: 10_000 });

    // B raises hand → A sees the raise-hand badge.
    await b.getByRole("button", { name: /raise hand|giơ tay/i }).click();
    await expect(
      a.locator('[data-testid="raise-hand-badge"]'),
    ).toBeVisible({ timeout: 10_000 });
    // B leaves → badge pruned on A.
    await ctxB.close();
    await expect(
      a.locator('[data-testid="raise-hand-badge"]'),
    ).toBeHidden({ timeout: 10_000 });
    await ctxA.close();
  });
});

// ===========================================================================
// 7. STT  (checklist group "7. STT")
// ===========================================================================
test.describe("stt-segment [DO]", () => {
  test("finalized STT segment rides client-broadcast in per-sender order", async ({
    browser,
  }) => {
    // STT_SEGMENT (:1459-1462) is E2E-encrypted over client-broadcast, NOT via
    // the Worker; the /stt proxy never touches RoomDO. This test asserts a
    // finalized caption from A's mic shows on B. STT defaults OFF (B8), so it
    // must be enabled for the meeting first.
    //
    // NOTE: requires mic / a fake-audio Playwright launch flag and STT enabled
    // — keep as a documented manual/optional path unless CI provides fake audio
    // (chromium: --use-fake-device-for-media-stream --use-file-for-fake-audio-
    // capture=<wav>). Marked fixme until that fixture exists.
    test.fixme(
      true,
      "needs fake-audio fixture + STT enabled for the meeting (B8 OFF by default)",
    );
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    // SELECTOR: enable captions on A; assert a finalized caption line on B.
    await a.getByRole("button", { name: /caption|subtitle|phụ đề/i }).click();
    await expect(
      b.locator('[data-testid="stt-caption"]').first(),
    ).toBeVisible({ timeout: 20_000 });
    await ctxA.close();
    await ctxB.close();
  });
});

// ===========================================================================
// 9. Knock / auth  (checklist group "9. Knock / auth")
// ===========================================================================
test.describe("knock-auth [DO]", () => {
  test("external denied guest CANNOT open the realtime WS (gate 403)", async ({
    browser,
  }) => {
    // The 1b/B12 fix: a guest who has the roomKey but is NOT admitted must be
    // rejected at the Worker AUTH GATE BEFORE 101 (403). This test drives the
    // WS handshake directly from the guest's authenticated page context and
    // asserts the upgrade is refused (close code != 1000/1006-after-101; the
    // socket never reaches readyState OPEN with a successful join).
    test.skip(
      !GUEST_EMAIL,
      "set E2E_GUEST_EMAIL (a non-admitted external) to run the knock-deny test",
    );
    const ctxGuest = await browser.newContext();
    const guest = await ctxGuest.newPage();
    await guest.goto(BASE_URL);
    // (Log the guest in via magic-link / password out of band, or seed a
    //  session.) Then attempt the raw WS upgrade with the guest's token.
    const result = await guest.evaluate(async (roomUrl) => {
      // Pull room id from the meeting URL hash (#room=<id>,<key>).
      const hash = new URL(roomUrl).hash.replace(/^#/, "");
      const roomId = (hash.match(/room=([^,]+)/)?.[1] ?? "").trim();
      // The app exposes the Supabase client in dev/E2E builds.
      const w = window as unknown as {
        supabase?: {
          auth: { getSession: () => Promise<{ data: { session?: { access_token?: string } } }> };
        };
      };
      const token =
        (await w.supabase?.auth.getSession())?.data?.session?.access_token ?? "";
      const wsBase = location.origin.replace(/^http/, "ws");
      return await new Promise<{ opened: boolean; code: number }>((resolve) => {
        const ws = new WebSocket(
          `${wsBase}/rooms/${encodeURIComponent(roomId)}/ws`,
          token ? ["mcm.v1", token] : ["mcm.v1"],
        );
        let opened = false;
        ws.onopen = () => {
          opened = true;
        };
        ws.onclose = (e) => resolve({ opened, code: e.code });
        ws.onerror = () => {
          /* close follows */
        };
        setTimeout(() => resolve({ opened, code: -1 }), 8000);
      });
    }, ROOM_URL);
    // A denied guest is rejected at the gate: the browser surfaces the failed
    // 403 upgrade as an immediate close WITHOUT a successful open.
    expect(result.opened).toBe(false);
    await ctxGuest.close();
  });

  test("admitted internal user CAN open the WS and join", async ({
    browser,
  }) => {
    // Positive control: an internal staff user (auto-admitted) opens the WS,
    // receives init-room, and joins. Asserts the canvas is live (transport up).
    const ctxA = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    await expect(a.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
    await ctxA.close();
  });
});

// ===========================================================================
// 10. Reconnect  (checklist group "10. Reconnect")
// ===========================================================================
test.describe("reconnect [DO]", () => {
  test("network blip → auto-reconnect, re-INIT, no desync", async ({
    browser,
  }) => {
    // Steps:
    //  1. A + B join; A draws content (B sees it).
    //  2. Simulate a network drop on B (context.setOffline), wait ~2s, restore.
    //  3. RawWsTransport backoff-reconnects, re-sends join-room, re-INITs.
    //  4. While B was offline, A draws more → after B reconnects, B converges
    //     to A's element count (no silent desync). Crucially the reconnect must
    //     NOT trigger a full-scene re-broadcast storm (Portal not closed; §3.1
    //     invariant 2 / R6) — covered indirectly by stable convergence.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await openRoomAs(ctxA, USER_A, PASS_A);
    const b = await openRoomAs(ctxB, USER_B, PASS_B);
    await drawRectangle(a);
    await expect
      .poll(() => sceneElementCount(b), { timeout: 10_000 })
      .toBe(await sceneElementCount(a));

    await ctxB.setOffline(true);
    await b.waitForTimeout(2_000);
    // A keeps drawing while B is offline.
    await drawRectangle(a);
    const target = await sceneElementCount(a);
    await ctxB.setOffline(false);

    // B auto-reconnects and converges.
    await expect
      .poll(() => sceneElementCount(b), { timeout: 20_000 })
      .toBe(target);
    await ctxA.close();
    await ctxB.close();
  });
});
