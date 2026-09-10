import { describe, expect, it } from "vitest";
import { catalog, findCatalogIcon, findCatalogStyleGroup, parseCatalog } from "../src/catalog/catalog.js";

describe("bundled catalog", () => {
  it("contains the frozen v1 metadata and deterministic style groups", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.catalogVersion).toBe(catalog.sourceVersion);
    expect(catalog.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(catalog.generatorCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(catalog.styleGroups.map((group) => group.id)).toEqual(
      [...catalog.styleGroups].map((group) => group.id).sort(),
    );
    expect(findCatalogStyleGroup("moe-outline")?.tiers).toEqual(["free", "pro"]);
    expect(findCatalogStyleGroup("moe-colored")?.tiers).toEqual(["pro"]);
  });

  it("indexes complete icon IDs and their availability", () => {
    const icon = findCatalogIcon("ui-search");
    expect(icon?.prefix).toBe("ui");
    expect(icon?.availableIn).toContain("moe-outline");
    expect(findCatalogIcon("search")).toBeUndefined();
  });
});

describe("bitmap catalog variants", () => {
  const base = {
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    icons: [],
  };

  it("rejects malformed, duplicate and cross-group variants", () => {
    expect(() => parseCatalog({
      ...base,
      styleGroups: [{ id: "moe-3d-metal", type: "bitmap", tiers: ["pro"], formats: ["webp"], imageSizes: [256], variants: "bad" }],
    })).toThrow(/invalid variants/);
    expect(() => parseCatalog({
      ...base,
      styleGroups: [{ id: "moe-3d-metal", type: "bitmap", tiers: ["pro"], formats: ["webp"], imageSizes: [256], variants: ["moe-3d-metal-256-webp", "moe-3d-metal-256-webp"] }],
    })).toThrow(/duplicate variants/);
    expect(() => parseCatalog({
      ...base,
      styleGroups: [{ id: "moe-3d-metal", type: "bitmap", tiers: ["pro"], formats: ["webp"], imageSizes: [256], variants: ["moe-other-256-webp"] }],
    })).toThrow(/inconsistent variant/);
  });
});
