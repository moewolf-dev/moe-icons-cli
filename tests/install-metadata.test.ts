import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstallMetadata, readInstalledResourceState, serializeInstallMetadata, sha256Bytes, type InstallMetadata } from "../src/project/install-metadata.js";
import { serializePackageInstallMetadata, type PackageInstallMetadata } from "../src/project/package-install-metadata.js";

describe("managed install metadata contract", () => {
  let root: string;
  let metadata: InstallMetadata;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moeicons-metadata-"));
    const catalog = '{"schemaVersion":1}\n';
    const marker = "free\n";
    mkdirSync(join(root, ".moeicons"), { recursive: true });
    mkdirSync(join(root, "src", "moeicons"), { recursive: true });
    writeFileSync(join(root, ".moeicons", "catalog.json"), catalog);
    writeFileSync(join(root, "src", "moeicons", ".marker"), marker);
    metadata = {
      schemaVersion: 1, artifactVersion: "0.0.15-alpha", tier: "free", target: "react",
      descriptorSha256: "a".repeat(64), artifactSha256: "b".repeat(64),
      catalogSha256: sha256Bytes(catalog), installedAt: "2026-08-24T00:00:00.000Z",
      managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog), "src/moeicons/.marker": sha256Bytes(marker) },
    };
    writeFileSync(join(root, ".moeicons", "install-metadata.json"), serializeInstallMetadata(metadata));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts a complete hash-verified install and matching tier", () => {
    expect(parseInstallMetadata(serializeInstallMetadata(metadata))).toEqual(metadata);
    expect(readInstalledResourceState(root, "free")).toEqual({ kind: "ok", metadata });
  });

  it("rejects missing, modified, tier-mismatched and catalog-inconsistent state", () => {
    expect(readInstalledResourceState(root, "pro")).toMatchObject({ kind: "invalid" });
    writeFileSync(join(root, "src", "moeicons", ".marker"), "changed\n");
    expect(readInstalledResourceState(root, "free")).toMatchObject({ kind: "invalid", message: expect.stringContaining("modified") });
    writeFileSync(join(root, "src", "moeicons", ".marker"), "free\n");
    writeFileSync(join(root, ".moeicons", "install-metadata.json"), serializeInstallMetadata({ ...metadata, catalogSha256: "c".repeat(64) }));
    expect(readInstalledResourceState(root, "free")).toMatchObject({ kind: "invalid", message: expect.stringContaining("catalog hash") });
    rmSync(join(root, ".moeicons", "install-metadata.json"));
    expect(readInstalledResourceState(root, "free")).toMatchObject({ kind: "missing" });
  });

  it("requires target instead of inferring it", () => {
    expect(parseInstallMetadata(serializeInstallMetadata({ ...metadata, target: undefined as never }))).toBeUndefined();
  });

  it("recognizes a verified package-set install without treating its root as an archive digest", () => {
    const catalog = '{"schemaVersion":1}\n';
    const types = "export type Icon = string;\n";
    writeFileSync(join(root, ".moeicons", "catalog.json"), catalog);
    writeFileSync(join(root, "src", "moeicons", "types.ts"), types);
    const packageMetadata: PackageInstallMetadata = {
      schemaVersion: 2,
      candidate: {
        schemaVersion: 1, tier: "free", fullVersion: "1.2.3",
        sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40),
        packageSetSha256: "c".repeat(64), candidateRootSha256: "d".repeat(64),
      },
      target: "react",
      resourceKeys: ["code/free/react/moe-outline"],
      packages: [
        { resourceKey: "code/free/react/moe-outline", packageSha256: "e".repeat(64), dependencies: ["f".repeat(64)] },
        { resourceKey: "shared/free/react", packageSha256: "f".repeat(64), dependencies: [] },
      ],
      catalogSha256: sha256Bytes(catalog),
      installedAt: "2026-10-17T00:00:00Z",
      managedFiles: {
        ".moeicons/catalog.json": sha256Bytes(catalog),
        "src/moeicons/types.ts": sha256Bytes(types),
      },
      targetSha256: "1".repeat(64), targetFileCount: 1, targetByteCount: types.length,
    };
    writeFileSync(join(root, ".moeicons", "install-metadata.json"), serializePackageInstallMetadata(packageMetadata));

    expect(readInstalledResourceState(root, "free")).toEqual({ kind: "ok", metadata: packageMetadata });
    writeFileSync(join(root, "src", "moeicons", "types.ts"), "changed\n");
    expect(readInstalledResourceState(root, "free")).toMatchObject({ kind: "invalid", message: expect.stringContaining("modified") });
  });

  it("rejects unknown fields, unsafe paths and placeholder hashes", () => {
    expect(parseInstallMetadata(JSON.stringify({ ...metadata, extra: true }))).toBeUndefined();
    expect(parseInstallMetadata(JSON.stringify({ ...metadata, managedFiles: { "../escape": "a".repeat(64) } }))).toBeUndefined();
    expect(parseInstallMetadata(JSON.stringify({ ...metadata, managedFiles: { "src/file": "types" } }))).toBeUndefined();
  });
});
