import { describe, expect, it } from "vitest";
import { parseMetadataManifest } from "../src/metadata/manifest.js";

const SHA = "a".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tier: "free",
    libraryVersion: "1.2.3",
    manualVersion: "1.2.3",
    catalogVersion: "1.2.3",
    cliVersion: "0.1.0",
    generatedAt: { sourceCommit: "b".repeat(40), generatorCommit: "c".repeat(40) },
    targets: ["react", "vue", "vanilla", "assets"],
    dependencies: { react: { react: ">=17.0.0" }, vue: { vue: ">=3.2.0" }, vanilla: {}, assets: {} },
    files: {
      "MANUAL.md": { size: 10, sha256: SHA },
      "catalog.json": { size: 20, sha256: SHA },
    },
  };
}

describe("metadata manifest parsing (MC.1)", () => {
  it("parses a valid manifest and preserves frozen fields", () => {
    const manifest = parseMetadataManifest(JSON.stringify(validManifest()));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.tier).toBe("free");
    expect(manifest.libraryVersion).toBe("1.2.3");
    expect(manifest.files["MANUAL.md"].size).toBe(10);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() =>
      parseMetadataManifest(JSON.stringify({ ...validManifest(), schemaVersion: 2 })),
    ).toThrow(/schemaVersion/);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseMetadataManifest(JSON.stringify({ ...validManifest(), telemetry: true })),
    ).toThrow(/unknown field: telemetry/);
  });

  it("rejects an invalid tier", () => {
    expect(() =>
      parseMetadataManifest(JSON.stringify({ ...validManifest(), tier: "ent" })),
    ).toThrow(/invalid tier/);
  });

  it("rejects malformed semver versions", () => {
    expect(() =>
      parseMetadataManifest(JSON.stringify({ ...validManifest(), libraryVersion: "v1.2.3" })),
    ).toThrow(/valid semver/);
  });

  it("rejects bad file digests", () => {
    expect(() =>
      parseMetadataManifest(
        JSON.stringify({
          ...validManifest(),
          files: { "MANUAL.md": { size: 10, sha256: "xyz" }, "catalog.json": { size: 20, sha256: SHA } },
        }),
      ),
    ).toThrow(/sha256/);
  });

  it("rejects an unknown dependency target", () => {
    expect(() =>
      parseMetadataManifest(
        JSON.stringify({ ...validManifest(), dependencies: { solid: {} } }),
      ),
    ).toThrow(/unknown target dependency/);
  });

  it("rejects an unknown files entry", () => {
    expect(() =>
      parseMetadataManifest(
        JSON.stringify({
          ...validManifest(),
          files: {
            "MANUAL.md": { size: 10, sha256: SHA },
            "catalog.json": { size: 20, sha256: SHA },
            "aliases.json": { size: 5, sha256: SHA },
          },
        }),
      ),
    ).toThrow(/unknown entry/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseMetadataManifest("{not json")).toThrow(/not valid JSON/);
  });
});
