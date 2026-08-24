import { describe, expect, it } from "vitest";
import { catalog, findCatalogIcon, findCatalogStyleGroup } from "../src/catalog/catalog.js";

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
