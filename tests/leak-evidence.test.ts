import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveForbiddenTokens, scanBundleForForbidden } from "../scripts/scan-bundle.mjs";
import { buildForbidEvidence } from "../scripts/derive-forbid-evidence.mjs";

/**
 * AUD-BLOCK-46: the publish gate must scan with a derived Pro token set, not a
 * hand-written short list.
 */
describe("derived leak-scan evidence", () => {
  it("derives Pro-only groups/variants from a manifest and the free contract", () => {
    const manifest = {
      styleGroups: [
        { id: "moe-outline", tiers: ["free", "pro"], variants: [{ id: "moe-outline", files: [] }] },
        { id: "moe-3d-metal", tiers: ["pro"], variants: [{ id: "moe-3d-metal-256-webp", files: [{ sha256: "a".repeat(64) }] }] },
        { id: "moe-secret-pro", tiers: ["pro"], variants: [{ id: "moe-secret-pro-128-png", files: [{ sha256: "b".repeat(64) }] }] },
      ],
    };
    const tokens = deriveForbiddenTokens({ manifest, freeGroups: ["moe-outline"] });
    expect(tokens).toContain("moe-3d-metal");
    expect(tokens).toContain("moe-secret-pro");
    expect(tokens).toContain("moe-secret-pro-128-png");
    expect(tokens).toContain("a".repeat(64));
    expect(tokens).not.toContain("moe-outline");
  });

  it("derives tokens from the CLI's pinned resource release binding", () => {
    const resourceRelease = {
      binding: { bitmapBatch: { styleGroupIds: ["moe-3d-metal"], variantIds: ["moe-3d-metal-256-webp"] } },
    };
    const tokens = deriveForbiddenTokens({ resourceRelease, freeGroups: ["moe-outline"] });
    expect(tokens).toEqual(expect.arrayContaining(["moe-3d-metal", "moe-3d-metal-256-webp"]));
  });

  it("buildForbidEvidence emits a canonical token set and digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "forbid-evidence-"));
    try {
      const freePath = join(dir, "free.json");
      const releasePath = join(dir, "release.json");
      writeFileSync(freePath, JSON.stringify({ freeStyleGroups: ["moe-outline", "moe-colored"] }));
      writeFileSync(releasePath, JSON.stringify({ binding: { bitmapBatch: { styleGroupIds: ["moe-3d-metal"], variantIds: ["moe-3d-metal-256-webp"] } } }));
      const evidence = buildForbidEvidence({ freePath, resourceReleasePath: releasePath });
      expect(evidence.tokens).toEqual(["moe-3d-metal", "moe-3d-metal-256-webp"]);
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans a bundle for a second Pro group and a digest-only leak", () => {
    const bundle = gzipSync(Buffer.from(`{"x":"moe-secret-pro","d":"${"b".repeat(64)}"}`));
    const result = scanBundleForForbidden(bundle, ["moe-secret-pro", "b".repeat(64)]);
    expect(result.ok).toBe(false);
    expect(result.hits).toEqual(expect.arrayContaining(["moe-secret-pro", "b".repeat(64)]));
  });
});

describe("AUD-BLOCK-48 missing-evidence fail-closed", () => {
  it("buildForbidEvidence throws when a declared input is missing", () => {
    expect(() => buildForbidEvidence({ resourceReleasePath: "/nonexistent/resource-release.json" })).toThrow(/declared but missing/);
    expect(() => buildForbidEvidence({ freePath: "/nonexistent/free.json" })).toThrow(/declared but missing/);
  });

  it("derive-forbid-evidence CLI exits non-zero on a missing declared input", () => {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("node", ["scripts/derive-forbid-evidence.mjs", "--resource-release", "/nonexistent/release.json"], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/declared but missing/);
  });
});
