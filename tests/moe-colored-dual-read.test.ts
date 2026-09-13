import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCatalog, findCatalogStyleGroup, type IconCatalog } from "../src/catalog/catalog.js";
import { readMoeiconsConfig } from "../src/project/config.js";
import { parseReleaseDescriptor } from "../src/core/release-descriptor.js";

/**
 * B7A (D-13): the CLI must read BOTH old Pro-only and new Free+Pro
 * `moe-colored` descriptors/catalogs. Tier availability is driven by the
 * catalog the consumer actually holds; old bytes are never rewritten in place.
 * The bundled catalog stays frozen here — regeneration is a release step — so
 * these tests inject catalogs, matching the `library update` / install path.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-moe-colored-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCatalog(moeColoredTiers: Array<"free" | "pro">): IconCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [
      { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      { id: "moe-colored", type: "mixed", tiers: moeColoredTiers, formats: ["svg"], imageSizes: [] },
    ],
    icons: [
      { id: "archive", prefix: "ar", label: "Archive", aliases: [], availableIn: ["moe-outline", "moe-colored"] },
    ],
  };
}

function writeFreeColoredConfig(): void {
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(
    join(dir, "moeicons.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      tier: "free",
      framework: "react",
      outputDir: "src/moeicons",
      defaultTheme: "colored",
      themes: { colored: { styleGroup: "moe-colored" } },
      icons: ["archive"],
    }),
  );
}

function descriptorBytes(freeStyleGroups: string[]): Uint8Array {
  return Buffer.from(JSON.stringify({
    fullVersion: "0.0.18",
    free: { filename: "moe-icons-free-0.0.18.tgz", sha256: "c".repeat(64), styleGroups: freeStyleGroups },
    pro: { filename: "moe-icons-pro-0.0.18.tgz", sha256: "d".repeat(64), styleGroups: ["moe-colored"] },
    catalog: { filename: "catalog.json", sha256: "e".repeat(64) },
  }, null, 2));
}

describe("B7A moe-colored catalog dual-read", () => {
  it("preserves old Pro-only tiers and new Free+Pro tiers without rewriting", () => {
    const oldCatalog = parseCatalog(makeCatalog(["pro"]));
    const newCatalog = parseCatalog(makeCatalog(["free", "pro"]));
    expect(findCatalogStyleGroup("moe-colored", oldCatalog)?.tiers).toEqual(["pro"]);
    expect(findCatalogStyleGroup("moe-colored", newCatalog)?.tiers).toEqual(["free", "pro"]);
  });

  it("keeps rejecting free moe-colored against an old Pro-only catalog", () => {
    writeFreeColoredConfig();
    const result = readMoeiconsConfig(dir, makeCatalog(["pro"]));
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("not available in free tier");
  });

  it("accepts free moe-colored against the migrated Free+Pro catalog", () => {
    writeFreeColoredConfig();
    const result = readMoeiconsConfig(dir, makeCatalog(["free", "pro"]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.config.tier).toBe("free");
  });
});

describe("B7A moe-colored descriptor dual-read", () => {
  it("parses old free.styleGroups and new free.styleGroups without inventing moe-colored", () => {
    const oldDescriptor = parseReleaseDescriptor(descriptorBytes(["moe-outline"]));
    expect(oldDescriptor.free.styleGroups).toEqual(["moe-outline"]);

    const newDescriptor = parseReleaseDescriptor(descriptorBytes(["moe-outline", "moe-colored"]));
    expect(newDescriptor.free.styleGroups).toEqual(["moe-outline", "moe-colored"]);
    // The reader must not infer/append the migrated group from pro bytes.
    expect(oldDescriptor.free.styleGroups).not.toContain("moe-colored");
  });
});
