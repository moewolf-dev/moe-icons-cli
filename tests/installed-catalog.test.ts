import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadInstalledCatalog } from "../src/core/generate.js";
import { readMoeiconsConfig } from "../src/project/config.js";
import { serializeInstallMetadata } from "../src/project/install-metadata.js";
import type { IconCatalog } from "../src/catalog/catalog.js";

/**
 * B5/B7A: generate must consume the catalog written by install/library-update
 * so a resourceVersion's real style groups (migrated moe-colored free+pro and
 * bitmap variants) are honored instead of a stale bundled allowlist.
 */

const nodeFs = { readFileSync, existsSync };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-installed-catalog-"));
  writeFileSync(join(dir, "package.json"), "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bitmapCatalog(): IconCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [
      { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      {
        id: "moe-3d-metal",
        type: "bitmap",
        tiers: ["pro"],
        formats: ["png", "webp"],
        imageSizes: [128, 256, 512],
        variants: ["moe-3d-metal-256-webp", "moe-3d-metal-256-png"],
      },
    ],
    icons: [
      { id: "archive-box", prefix: "ar", label: "Archive box", aliases: [], availableIn: ["moe-outline", "moe-3d-metal"] },
    ],
  };
}

function writeInstalledCatalog(catalog: IconCatalog): void {
  mkdirSync(join(dir, ".moeicons"), { recursive: true });
  const text = JSON.stringify(catalog);
  writeFileSync(join(dir, ".moeicons", "catalog.json"), text);
  const hash = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(dir, ".moeicons", "install-metadata.json"), serializeInstallMetadata({
    schemaVersion: 1,
    artifactVersion: "1.0.0",
    tier: "pro",
    target: "react",
    descriptorSha256: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    catalogSha256: hash,
    installedAt: "2026-09-11T00:00:00Z",
    managedFiles: { ".moeicons/catalog.json": hash },
  }));
}

describe("loadInstalledCatalog", () => {
  it("returns undefined when no installed catalog exists", () => {
    expect(loadInstalledCatalog(dir, nodeFs)).toBeUndefined();
  });

  it("returns undefined for a corrupt installed catalog (fail-safe to bundled)", () => {
    mkdirSync(join(dir, ".moeicons"), { recursive: true });
    writeFileSync(join(dir, ".moeicons", "catalog.json"), "{not json");
    expect(loadInstalledCatalog(dir, nodeFs)).toBeUndefined();
  });

  it("enables bitmap theming that the bundled catalog cannot validate", () => {
    const catalog = bitmapCatalog();
    writeInstalledCatalog(catalog);
    const loadedCatalog = loadInstalledCatalog(dir, nodeFs);
    expect(loadedCatalog?.styleGroups.map((group) => group.id)).toContain("moe-3d-metal");

    writeFileSync(
      join(dir, "moeicons.config.json"),
      JSON.stringify({
        schemaVersion: 2,
        tier: "pro",
        target: "react",
        outputDir: "src/moeicons",
        defaultTheme: "metal",
        themes: { metal: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 256 } },
        icons: ["archive-box"],
      }),
    );
    const result = readMoeiconsConfig(dir, loadedCatalog);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.config.tier).toBe("pro");
  });
});

describe("FIX-22-B refresh-bundled-catalog validation", () => {
  const fourGroups: any[] = [
    { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    { id: "moe-solid", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    { id: "moe-lite-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    { id: "moe-colored", type: "mixed", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
  ];
  const catalog = (): any => ({
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: structuredClone(fourGroups),
    icons: [
      { id: "ui-search", prefix: "ui", label: "Search", aliases: [], availableIn: ["moe-outline", "moe-colored"] },
    ],
  });

  it("accepts exactly the frozen four Free groups", async () => {
    const { validateFreeCatalog } = await import("../scripts/refresh-bundled-catalog.mjs");
    expect(validateFreeCatalog(catalog()).freeGroups).toEqual(["moe-colored", "moe-lite-outline", "moe-outline", "moe-solid"]);
  });

  it("rejects a fifth Pro group or bitmap variants/format/size", async () => {
    const { validateFreeCatalog } = await import("../scripts/refresh-bundled-catalog.mjs");
    const withFifth = catalog();
    withFifth.styleGroups.push({ id: "moe-secret-pro", type: "bitmap", tiers: ["pro"], formats: ["webp"], imageSizes: [256], variants: ["moe-secret-pro-256-webp"] });
    expect(() => validateFreeCatalog(withFifth)).toThrow(/exactly/);

    const bitmapFree = catalog();
    bitmapFree.styleGroups[0] = { id: "moe-outline", type: "bitmap", tiers: ["free", "pro"], formats: ["png", "webp"], imageSizes: [256], variants: ["moe-outline-256-webp"] };
    expect(() => validateFreeCatalog(bitmapFree)).toThrow(/non-Free type|must not declare/);
  });

  it("rejects an orphan Pro icon and a pro-only moe-colored", async () => {
    const { validateFreeCatalog } = await import("../scripts/refresh-bundled-catalog.mjs");
    const orphan = catalog();
    orphan.icons.push({ id: "secret-icon", prefix: "se", label: "Secret", aliases: [], availableIn: ["moe-secret-pro"] });
    expect(() => validateFreeCatalog(orphan)).toThrow(/non-Free group/);

    const proOnly = catalog();
    proOnly.styleGroups = proOnly.styleGroups.map((group: any) => group.id === "moe-colored" ? { ...group, tiers: ["pro"] } : group);
    expect(() => validateFreeCatalog(proOnly)).toThrow(/moe-colored/);
  });

  it("rejects a non-commit sourceCommit and missing metadata", async () => {
    const { validateFreeCatalog } = await import("../scripts/refresh-bundled-catalog.mjs");
    expect(() => validateFreeCatalog({ ...catalog(), sourceCommit: "not-a-commit" })).toThrow(/sourceCommit/);
    const noIcons = catalog();
    delete noIcons.icons;
    expect(() => validateFreeCatalog(noIcons)).toThrow(/icons/);
  });
});

describe("PATCH-24-F refresh exact keys / descriptor binding / bundle scan", () => {
  const base = (): any => ({
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [
      { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      { id: "moe-solid", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      { id: "moe-lite-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      { id: "moe-colored", type: "mixed", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    ],
    icons: [{ id: "ui-search", prefix: "ui", label: "Search", aliases: [], availableIn: ["moe-outline"] }],
  });

  it("rejects unknown keys, duplicate ids and non-exact tiers", async () => {
    const { validateFreeCatalog } = await import("../scripts/refresh-bundled-catalog.mjs");
    expect(() => validateFreeCatalog({ ...base(), extra: 1 })).toThrow(/unknown field/);
    const dup = base();
    dup.icons.push({ ...dup.icons[0] });
    expect(() => validateFreeCatalog(dup)).toThrow(/icon ids/);
    const tiers = base();
    tiers.styleGroups[0].tiers = ["free"];
    expect(() => validateFreeCatalog(tiers)).toThrow(/tiers/);
    const group = base();
    group.styleGroups[0].extra = 1;
    expect(() => validateFreeCatalog(group)).toThrow(/unknown field/);
  });

  it("binds the catalog to a frozen descriptor identity", async () => {
    const { assertCatalogMatchesDescriptor } = await import("../scripts/refresh-bundled-catalog.mjs");
    const descriptor = { fullVersion: "1.0.0", sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40) };
    expect(assertCatalogMatchesDescriptor(base(), descriptor)).toBe(true);
    expect(() => assertCatalogMatchesDescriptor(base(), { ...descriptor, sourceCommit: "c".repeat(40) })).toThrow(/sourceCommit/);
    expect(() => assertCatalogMatchesDescriptor(base(), { ...descriptor, fullVersion: "2.0.0" })).toThrow(/catalogVersion/);
  });

  it("scans a packed bundle for forbidden Pro names", async () => {
    const { gzipSync } = await import("node:zlib");
    const { scanBundleForForbidden } = await import("../scripts/scan-bundle.mjs");
    const withPro = gzipSync(Buffer.from('{"path":"dist/pro/moe-3d-metal/x.js"}'));
    const result = scanBundleForForbidden(withPro, ["moe-3d-metal", "moe-secret-pro"]);
    expect(result.ok).toBe(false);
    expect(result.hits).toEqual(["moe-3d-metal"]);
    const clean = gzipSync(Buffer.from('{"path":"dist/lib/moe-outline/x.js"}'));
    expect(scanBundleForForbidden(clean, ["moe-3d-metal"]).ok).toBe(true);
  });
});
