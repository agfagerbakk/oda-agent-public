import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Real model calls: generous timeouts, and never run test files in parallel
    // (keeps concurrent API load low and output readable).
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
