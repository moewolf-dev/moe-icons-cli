import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { MAX_PACKAGE_BYTES } = require("../src/core/small-pack/candidate-set.cjs") as {
  MAX_PACKAGE_BYTES: number;
};
const support = JSON.parse(readFileSync(join(__dirname, "..", "release-support.json"), "utf8"));

describe("release-support package-only contract", () => {
  it("matches the package-set reader's byte budget and exact resource binding", () => {
    expect(support).toMatchObject({
      schemaVersion: 1,
      maxPackageBytes: MAX_PACKAGE_BYTES,
      maxPackageZipBytes: 130 * 1024 ** 2,
      packageScopedResources: true,
      bitmapFormats: ["png", "webp"],
      manifestDigestBinding: true,
    });
    expect(support).not.toHaveProperty("maxAggregateInputBytes");
  });
});
