#!/usr/bin/env node
// do-loadtest.mjs — standalone WS load + hibernation test for the RoomDO
// realtime backend (docs/plans/durable-objects-migration.md §9.3).
//
// REQUIRES A DEPLOYED DO. There is no live DO yet — this script CANNOT be run
// until the Worker (worker/src/index.ts) + RoomDO (worker/src/roomDO.ts) are
// deployed with `realtime_backend='do'` set for the target meeting in D1. It is
// written to speak the REAL wire protocol so it is correct the moment a DO
// exists.
//
// It opens N raw WebSockets to GET /rooms/:roomId/ws using the real subprotocol
// (["mcm.v1", <token>]) and the real frame format from roomDO.ts:
//   • CONTROL = ws.send(JSON.stringify({ ev, args:[...] }))          (a string)
//   • BINARY  = ws.send(ArrayBuffer) laid out [type:1B][iv:12B][ciphertext]
//                 type 1 = broadcast, 2 = volatile
// Receiver distinguishes by typeof: string → control, ArrayBuffer → binary.
//
// The script:
//   1. opens N sockets, each waits for the server's `init-room` control frame,
//      reads its minted socketId from args[0].socketId, then emits `join-room`.
//   2. one "publisher" socket broadcasts encrypted-SHAPED binary frames
//      (random bytes in place of real AES-GCM ciphertext — the DO is a DUMB E2E
//      relay and never decrypts, so random payload is wire-faithful for fanout).
//   3. every other socket measures receive latency (send-stamp embedded in the
//      ciphertext bytes) and counts delivered messages → reports fanout latency
//      percentiles + delivered/expected.
//   4. an optional 20s full-sync mode (--fullsync) makes EVERY socket emit a
//      large full-scene binary every 20s, reproducing the worst-case
//      N×(N-1) binary relay burst (plan §9.3 D6) — NOT just small cursor delta.
//   5. an `--hibernation` mode opens ONE socket, goes idle, and prints the
//      manual steps to confirm 0 wake events over 10 min (plan §9.3 hibernation).
//
// ---------------------------------------------------------------------------
// RUN (AFTER the DO is deployed). The token is a Supabase access_token JWT for
// a user who can see the meeting (canSeeMeeting) and is admitted (knock) — get
// it from the browser: `await supabase.auth.getSession()` → access_token.
//
//   # Fanout latency, 50 clients, 100 broadcasts at ~5/s, on a real meeting:
//   node scripts/do-loadtest.mjs \
//     --base wss://mcm-storage.rnd-ai.workers.dev \
//     --room <ROOM_ID> --token "<JWT>" \
//     --clients 50 --messages 100 --rate 5 --size 4096
//
//   # Worst-case 20s full-sync fanout, 100 clients, 200 KiB scene (plan D6):
//   node scripts/do-loadtest.mjs --base wss://... --room <ID> --token "<JWT>" \
//     --clients 100 --fullsync --size 204800 --duration 70
//
//   # Hibernation probe: 1 idle socket, then watch DO logs for 10 min:
//   node scripts/do-loadtest.mjs --base wss://... --room <ID> --token "<JWT>" \
//     --hibernation
//
// Env-var equivalents (CLI wins): DO_BASE, DO_ROOM, DO_TOKEN, DO_CLIENTS,
// DO_MESSAGES, DO_RATE, DO_SIZE, DO_DURATION.
//
// Node 22+ has a global WebSocket; on older Node, `npm i ws` and the script
// falls back to it automatically.
// ---------------------------------------------------------------------------

import process from "node:process";

// --- WebSocket impl: prefer global (Node 22+), fall back to the `ws` package ---
let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
  try {
    const mod = await import("ws");
    WebSocketImpl = mod.WebSocket ?? mod.default;
  } catch {
    console.error(
      "No global WebSocket (need Node 22+) and the 'ws' package is not " +
        "installed. Run with Node 22+ or `npm i ws`.",
    );
    process.exit(2);
  }
}

// --- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) {
    return undefined;
  }
  const next = argv[i + 1];
  // boolean flag if the next token is missing or another --flag
  if (next === undefined || next.startsWith("--")) {
    return true;
  }
  return next;
};
const str = (name, env, dflt) => {
  const v = flag(name);
  if (v === true || v === undefined) {
    return process.env[env] ?? dflt;
  }
  return v;
};
const num = (name, env, dflt) => {
  const v = flag(name);
  const raw = v === true || v === undefined ? process.env[env] : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
};
const bool = (name) => flag(name) === true || flag(name) === "true";

const BASE = str("base", "DO_BASE", "");
const ROOM = str("room", "DO_ROOM", "");
const TOKEN = str("token", "DO_TOKEN", "");
const CLIENTS = num("clients", "DO_CLIENTS", 10);
const MESSAGES = num("messages", "DO_MESSAGES", 50);
const RATE = num("rate", "DO_RATE", 5); // broadcasts per second
const SIZE = num("size", "DO_SIZE", 4096); // ciphertext bytes per frame
const DURATION = num("duration", "DO_DURATION", 0); // seconds; 0 = until done
const FULLSYNC = bool("fullsync");
const HIBERNATION = bool("hibernation");

if (!BASE || !ROOM || !TOKEN) {
  console.error(
    "Missing required args. Need --base <wss://...> --room <id> --token <jwt> " +
      "(or DO_BASE / DO_ROOM / DO_TOKEN env vars).",
  );
  process.exit(2);
}

// --- wire protocol constants (MUST match worker/src/roomDO.ts) -------------
const FRAME_BROADCAST = 1;
const FRAME_VOLATILE = 2;
const IV_LENGTH = 12;
const SUBPROTOCOL_MARKER = "mcm.v1";
const STAMP_BYTES = 8; // we embed a send timestamp (ms, double) for latency.

const wsUrl = () => {
  const base = BASE.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/rooms/${encodeURIComponent(ROOM)}/ws`;
};

// --- frame builders --------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

const packControl = (ev, args = []) => JSON.stringify({ ev, args });

/** Build a [type:1B][iv:12B][ciphertext] binary frame. The first STAMP_BYTES
 *  of the "ciphertext" carry a float64 send timestamp so a receiver can compute
 *  fanout latency; the rest is random filler to hit `size`. The DO never reads
 *  the body (opaque relay), so this is wire-faithful. */
const packBinary = (volatile, size) => {
  const cipherLen = Math.max(STAMP_BYTES, size);
  const buf = new ArrayBuffer(1 + IV_LENGTH + cipherLen);
  const u8 = new Uint8Array(buf);
  u8[0] = volatile ? FRAME_VOLATILE : FRAME_BROADCAST;
  // iv: random 12 bytes (faithful to AES-GCM iv shape; value irrelevant).
  for (let i = 1; i <= IV_LENGTH; i++) {
    u8[i] = Math.floor(Math.random() * 256);
  }
  const view = new DataView(buf);
  view.setFloat64(1 + IV_LENGTH, performance.now()); // send stamp
  // leave the rest as zeroes (cheap); size still reflects real payload bytes.
  return buf;
};

const readStamp = (buf) => {
  if (buf.byteLength < 1 + IV_LENGTH + STAMP_BYTES) {
    return null;
  }
  return new DataView(buf).getFloat64(1 + IV_LENGTH);
};

// --- stats -----------------------------------------------------------------
const latencies = [];
let delivered = 0;
let malformed = 0;

const pct = (arr, p) => {
  if (!arr.length) {
    return NaN;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

// --- a single client -------------------------------------------------------
class Client {
  constructor(index) {
    this.index = index;
    this.socketId = undefined;
    this.joined = false;
    this.ws = null;
    this.openResolve = null;
    this.openPromise = new Promise((res) => {
      this.openResolve = res;
    });
  }

  connect() {
    // Token rides in the subprotocol list exactly like the browser client
    // (RawWsTransport.openSocket): ["mcm.v1", <jwt>]. NEVER as a query param.
    const protocols = [SUBPROTOCOL_MARKER, TOKEN];
    const ws = new WebSocketImpl(wsUrl(), protocols);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onerror = (err) => {
      console.error(`client#${this.index} error:`, err?.message ?? err);
    };
    ws.onclose = (ev) => {
      // 1006/4xx here means the AUTH GATE rejected before 101 (token invalid /
      // not admitted / room full) OR the DO closed. Surface the code.
      if (!this.joined) {
        console.error(
          `client#${this.index} closed before join (code ${ev.code}) — ` +
            "auth gate rejection or DO unavailable?",
        );
        this.openResolve?.(false);
      }
    };
    ws.onopen = () => {
      // 101 received; wait for the DO's init-room control frame (it is sent
      // synchronously after acceptWebSocket, BEFORE we should emit join-room).
    };
    return this.openPromise;
  }

  onMessage(data) {
    if (typeof data === "string") {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      const args = Array.isArray(frame.args) ? frame.args : [];
      if (frame.ev === "init-room") {
        // The DO mints our socketId and sends it as args:[{ socketId }].
        const first = args[0];
        if (first && typeof first.socketId === "string") {
          this.socketId = first.socketId;
        }
        // Only now emit join-room (mirrors Portal.tsx: join after init-room).
        this.send(packControl("join-room", [ROOM, { socketId: this.socketId }]));
        this.joined = true;
        this.openResolve?.(true);
      }
      // first-in-room / new-user / room-user-change are presence control frames;
      // the load test doesn't need to act on them, but we could count them here.
      return;
    }
    if (data instanceof ArrayBuffer) {
      const stamp = readStamp(data);
      if (stamp === null) {
        malformed += 1;
        return;
      }
      latencies.push(performance.now() - stamp);
      delivered += 1;
      return;
    }
    // Node's `ws` may deliver a Buffer for binary; normalize.
    if (data && data.buffer instanceof ArrayBuffer) {
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
      const stamp = readStamp(ab);
      if (stamp === null) {
        malformed += 1;
        return;
      }
      latencies.push(performance.now() - stamp);
      delivered += 1;
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(payload);
    }
  }

  broadcast(volatile, size) {
    this.send(packBinary(volatile, size));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- hibernation mode ------------------------------------------------------
async function runHibernation() {
  console.log("=== Hibernation probe (plan §9.3) ===");
  console.log(`Opening 1 idle socket to ${wsUrl()} ...`);
  const c = new Client(0);
  const ok = await c.connect();
  if (!ok) {
    console.error("Could not establish the socket (auth gate / DO down).");
    process.exit(1);
  }
  console.log(`Connected. socketId = ${c.socketId}`);
  console.log("");
  console.log("Now CONFIRM hibernation MANUALLY over the next 10 minutes:");
  console.log(
    "  1. Tail the DO logs:  cd worker && npx wrangler tail mcm-storage --format pretty",
  );
  console.log(
    "  2. This socket stays open + idle. The runtime answers WS ping with",
  );
  console.log(
    "     pong via setWebSocketAutoResponse WITHOUT waking the DO, so you must",
  );
  console.log(
    "     observe ZERO `webSocketMessage` / constructor / alarm log lines for",
  );
  console.log("     this room over the full 10 minutes.");
  console.log(
    "  3. PASS = 0 wake events in 10 min (no setInterval/alarm/heartbeat is",
  );
  console.log(
    "     keeping the DO warm). FAIL = any wake log line while idle.",
  );
  console.log("");
  console.log("Holding the socket open. Ctrl-C to stop.");
  // Hold forever (idle). Do NOT send anything — sending would wake the DO.
  await new Promise(() => {});
}

// --- load mode -------------------------------------------------------------
async function runLoad() {
  console.log("=== WS load test (plan §9.3) ===");
  console.log(
    `base=${BASE} room=${ROOM} clients=${CLIENTS} messages=${MESSAGES} ` +
      `rate=${RATE}/s size=${SIZE}B fullsync=${FULLSYNC}`,
  );

  // 1) connect all clients + join-room.
  const clients = Array.from({ length: CLIENTS }, (_, i) => new Client(i));
  const results = await Promise.all(clients.map((c) => c.connect()));
  const connected = results.filter(Boolean).length;
  console.log(`Connected + joined: ${connected}/${CLIENTS}`);
  if (connected < 2) {
    console.error("Need >=2 joined clients to measure fanout. Aborting.");
    clients.forEach((c) => c.close());
    process.exit(1);
  }

  // small settle so every join-room has propagated.
  await sleep(500);

  const expectedPerMessage = connected - 1; // sender is skipped by the DO.
  let sent = 0;

  if (FULLSYNC) {
    // Worst-case: EVERY client emits a large full-scene binary every 20s.
    // Reproduces N×(N-1) relay bursts (plan §9.3 / D6). Runs for `duration`.
    console.log(
      `Full-sync mode: ${connected} clients × full-scene (${SIZE}B) every 20s`,
    );
    const endAt = performance.now() + (DURATION > 0 ? DURATION : 70) * 1000;
    const tick = async () => {
      while (performance.now() < endAt) {
        for (const c of clients) {
          c.broadcast(false, SIZE); // non-volatile (reliable) full scene
          sent += 1;
        }
        await sleep(20_000); // SYNC_FULL_SCENE_INTERVAL_MS
      }
    };
    await tick();
  } else {
    // Steady broadcast from ONE publisher at `rate`/s for `messages` frames.
    const publisher = clients[0];
    const intervalMs = Math.max(1, Math.floor(1000 / RATE));
    console.log(
      `Publisher#0 broadcasting ${MESSAGES} frames at ~${RATE}/s ...`,
    );
    for (let i = 0; i < MESSAGES; i++) {
      publisher.broadcast(false, SIZE);
      sent += 1;
      await sleep(intervalMs);
    }
  }

  // drain: allow in-flight fanout to arrive.
  await sleep(2000);

  const expectedTotal = sent * expectedPerMessage;
  console.log("");
  console.log("=== Results ===");
  console.log(`Frames sent:        ${sent}`);
  console.log(`Expected delivered: ${expectedTotal} (sent × (clients-1))`);
  console.log(`Actually delivered: ${delivered}`);
  console.log(
    `Delivery ratio:     ${
      expectedTotal ? ((delivered / expectedTotal) * 100).toFixed(1) : "n/a"
    }%`,
  );
  console.log(`Malformed frames:   ${malformed}`);
  console.log("Fanout latency (ms):");
  console.log(`  p50  ${pct(latencies, 50)?.toFixed(1)}`);
  console.log(`  p90  ${pct(latencies, 90)?.toFixed(1)}`);
  console.log(`  p99  ${pct(latencies, 99)?.toFixed(1)}`);
  console.log(
    `  max  ${latencies.length ? Math.max(...latencies).toFixed(1) : "n/a"}`,
  );
  console.log("");
  console.log(
    "Interpretation: a delivery ratio well under 100% or a climbing p99 under " +
      "full-sync load points to DO single-thread backpressure (plan R13) — " +
      "consider chunked fanout (queueMicrotask) on the relay side.",
  );

  clients.forEach((c) => c.close());
  // give close frames a moment, then exit.
  await sleep(300);
  process.exit(0);
}

// --- main ------------------------------------------------------------------
if (HIBERNATION) {
  await runHibernation();
} else {
  await runLoad();
}
