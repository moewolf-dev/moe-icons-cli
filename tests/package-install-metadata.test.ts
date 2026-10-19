import { describe, expect, it } from "vitest";
import { parsePackageInstallMetadata, serializePackageInstallMetadata, type PackageInstallMetadata } from "../src/project/package-install-metadata.js";

const digest = (char: string): string => char.repeat(64);

function metadata(overrides: Partial<PackageInstallMetadata> = {}): PackageInstallMetadata {
  return {
    schemaVersion: 2,
    candidate: {
      schemaVersion: 1, tier: "free", fullVersion: "1.2.3",
      sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40),
      packageSetSha256: digest("c"), candidateRootSha256: digest("d"),
    },
    target: "react",
    resourceKeys: ["code/free/react/moe-outline", "metadata/free/moe-outline"],
    packages: [
      { resourceKey: "code/free/react/moe-outline", packageSha256: digest("e"), dependencies: [digest("a")] },
      { resourceKey: "metadata/free/moe-outline", packageSha256: digest("f"), dependencies: [] },
      { resourceKey: "shared/free/react", packageSha256: digest("a"), dependencies: [] },
    ],
    catalogSha256: digest("1"),
    installedAt: "2026-10-17T00:00:00.000Z",
    managedFiles: {
      ".moeicons/artifact/react/types.d.ts": digest("2"),
      ".moeicons/catalog.json": digest("1"),
    },
    targetSha256: digest("3"),
    targetFileCount: 1,
    targetByteCount: 15,
    ...overrides,
  };
}

describe("package install metadata v2", () => {
  it("round-trips an exact candidate identity and selected package closure", () => {
    const serialized = serializePackageInstallMetadata(metadata());
    const parsed = parsePackageInstallMetadata(serialized);
    expect(parsed).toEqual(metadata());
    expect(serialized).not.toContain('"artifactSha256"');
    expect(serialized).not.toContain('"descriptorSha256"');
  });

  it("rejects a package dependency omitted from the installed closure", () => {
    const value = metadata({ packages: [
      { resourceKey: "code/free/react/moe-outline", packageSha256: digest("e"), dependencies: [digest("a")] },
      { resourceKey: "metadata/free/moe-outline", packageSha256: digest("f"), dependencies: [] },
    ] });
    expect(parsePackageInstallMetadata(serializePackageInstallMetadata(value))).toBeUndefined();
  });

  it("rejects candidate tier drift and noncanonical bytes", () => {
    const wrongTier = metadata({
      candidate: { ...metadata().candidate, tier: "pro" },
    });
    expect(parsePackageInstallMetadata(serializePackageInstallMetadata(wrongTier))).toBeUndefined();
    expect(parsePackageInstallMetadata(`${serializePackageInstallMetadata(metadata())} `)).toBeUndefined();
  });

  it("rejects resource packages for a different framework target", () => {
    const mismatched = metadata({ target: "vue" });
    expect(parsePackageInstallMetadata(serializePackageInstallMetadata(mismatched))).toBeUndefined();
  });

  it("rejects archive-shaped fields that could counterfeit the legacy identity", () => {
    const archiveShaped = { ...metadata(), artifactSha256: digest("4") } as PackageInstallMetadata;
    expect(parsePackageInstallMetadata(serializePackageInstallMetadata(archiveShaped))).toBeUndefined();
  });
});
