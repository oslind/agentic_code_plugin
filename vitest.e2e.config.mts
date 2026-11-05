import { defineConfig } from "vitest/config";

// The real-model suite (npm run e2e). Scenarios run one at a time: a local server serves one request at a time anyway.
export default defineConfig({
  test: { include: ["e2e/**/*.e2e.ts"], fileParallelism: false, testTimeout: 40 * 60000, hookTimeout: 120000, reporters: ["verbose"] },
});
