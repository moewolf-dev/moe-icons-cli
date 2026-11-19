import { defineConfig } from "vitest/config";

/** Opt-in performance gate; not part of the default unit suite. */
export default defineConfig({
  test: {
    include: ["tests/perf/**/*.perf.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
