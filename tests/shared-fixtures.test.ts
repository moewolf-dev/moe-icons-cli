import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * P1-06 consumer contract test (CLI). Validates the SAME canonical fixture
 * bytes as the package-maker and proves the recorded SHA-256. The fixtures are
 * copied from moe-icons-package-maker/tests/fixtures/schemas/.
 */

const FIXTURES: Record<string, { checksum: string }> = {
  "valid-catalog.json": {
    checksum: "f178e142cf30d5fcf34809eaf4278fb9a802100833f3fef52a5c4655c2b712ce",
  },
  "valid-partial-manifest.json": {
    checksum: "1286febe325d5c9b8d39cb549d45b8585a6c161d0b012e6d1d6d9b034015396f",
  },
  "invalid-manifest.json": {
    checksum: "b73df13191aa3beea1abc5b934e29a5a604ca748b91b4f20f3c344243d3290e8",
  },
};

const packageMakerRoot = resolve(
  process.env.MOEICONS_PACKAGE_MAKER_REPO ?? join(process.cwd(), "..", "moe-icons-package-maker"),
);

describe("P1-06 CLI shared contract fixtures", () => {
  it("validates the same fixture bytes as package-maker (recorded checksums)", (ctx) => {
    const schemasDir = join(packageMakerRoot, "tests", "fixtures", "schemas");
    if (!existsSync(schemasDir)) {
      // Publish acceptance checkouts only cli/clitest/code-library; skip unless maker is present.
      ctx.skip();
      return;
    }
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      const bytes = readFileSync(join(schemasDir, name));
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(actual, `${name} checksum must match the shared contract`).toBe(
        fixture.checksum,
      );
    }
  });
});
