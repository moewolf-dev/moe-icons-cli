import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildForbidEvidence } from "../scripts/derive-forbid-evidence.mjs";
import { scanBundleForForbidden } from "../scripts/scan-bundle.mjs";

describe("production release scan evidence", () => {
  it("blocks Pro group/variant/archive leakage using the verified resource snapshot", () => {
    const evidence = buildForbidEvidence({ freePath: resolve("vendor/moe-icons-release-policy/free-style-groups.v1.json"), manifestPath: resolve("vendor/moe-icons-release-scan/pro-manifest.json") });
    expect(evidence.tokens).toContain("moe-3d-metal-128-webp");
    expect(evidence.tokens).not.toContain("moe-outline");
    expect(scanBundleForForbidden(Buffer.from("moe-3d-metal-128-webp"), evidence.tokens).ok).toBe(false);
    expect(scanBundleForForbidden(Buffer.from("free CLI code"), evidence.tokens).ok).toBe(true);
  });
  it("fails closed on absent or malformed declared evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-evidence-"));
    try {
      const path = join(root, "manifest.json");
      expect(() => buildForbidEvidence({ manifestPath: path })).toThrow("missing");
      writeFileSync(path, "{}");
      expect(() => buildForbidEvidence({ manifestPath: path })).toThrow("invalid release scan manifest");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
