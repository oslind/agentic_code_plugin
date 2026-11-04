import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests that wait for background work allow up to 10 s (WAIT_MS in test/chat.test.ts) on slow CI runners.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
