import { defineConfig } from "vitest/config";

// Worker unit tests run on the plain node pool with a MINIMAL in-memory
// Durable Object / WebSocket harness (see test/roomDO.test.ts). We avoid
// @cloudflare/vitest-pool-workers on purpose: it needs the workerd runtime +
// a bound local D1, which is held open by `wrangler dev` during development
// and would deadlock (SQLITE_BUSY). Node 22 provides fetch/Request/Response/
// crypto; the harness mocks the DO-specific globals.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
