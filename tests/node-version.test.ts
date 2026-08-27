import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const check = require(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "check-node.cjs")) as {
  MIN_MAJOR: number;
  assertSupportedNode: (version: string) => { ok: boolean; major: number | null; message: string };
};

describe("bin Node version guard", () => {
  it("rejects Node 18 and 20 with a no-stack LTS message", () => {
    const twenty = check.assertSupportedNode("v20.11.0");
    expect(twenty.ok).toBe(false);
    expect(twenty.message).toContain("Node.js 22 or later");
    expect(twenty.message).toContain("v20.11.0");
    expect(twenty.message).toContain("https://nodejs.org/en/download");
    expect(twenty.message).not.toContain("SyntaxError");
    expect(twenty.message).not.toMatch(/^\s*at /m);
    expect(check.assertSupportedNode("18.20.8").ok).toBe(false);
  });

  it("accepts Node 22 and 24", () => {
    expect(check.assertSupportedNode("v22.18.0").ok).toBe(true);
    expect(check.assertSupportedNode("v24.18.0").ok).toBe(true);
    expect(check.MIN_MAJOR).toBe(22);
  });
});
