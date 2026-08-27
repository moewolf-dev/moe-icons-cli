import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [["tests/ui/**", "happy-dom"]],
    // Packed install matrix and release-preflight spawn real npm; Vitest 4
    // defaults to 5s which is too short for cold installs.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
