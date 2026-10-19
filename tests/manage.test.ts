import { describe, expect, it } from "vitest";
import { formatLibraryVersionStatus, getLibraryVersionStatus } from "../src/core/manage.js";
import type { InstallMetadata, InstalledResourceState } from "../src/project/install-metadata.js";
import type { PackageInstallMetadata } from "../src/project/package-install-metadata.js";

const metadata: InstallMetadata = {
  schemaVersion: 1, artifactVersion: "1.2.3", tier: "free", target: "react", descriptorSha256: "a".repeat(64), artifactSha256: "b".repeat(64),
  catalogSha256: "c".repeat(64), installedAt: "2026-08-24T00:00:00Z", managedFiles: { ".moeicons/catalog.json": "c".repeat(64) },
};
const readState = (): InstalledResourceState => ({ kind: "ok", metadata });
const versions = (version: string | null) => async () => ({
  schemaVersion: 1 as const,
  free: version ? { version, releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: "d".repeat(64) } : null,
  pro: null,
});

describe("management version status", () => {
  it("derives update/current/channel/older from managed metadata, never config version", async () => {
    await expect(getLibraryVersionStatus("/project", "free", { readState, fetchVersions: versions("1.2.4") })).resolves.toMatchObject({ kind: "update", latestVersion: "1.2.4" });
    await expect(getLibraryVersionStatus("/project", "free", { readState, fetchVersions: versions("1.2.3") })).resolves.toMatchObject({ kind: "current" });
    await expect(getLibraryVersionStatus("/project", "free", { readState, fetchVersions: versions("1.2.4-alpha") })).resolves.toMatchObject({ kind: "channel-mismatch" });
    await expect(getLibraryVersionStatus("/project", "free", { readState, fetchVersions: versions("1.2.2") })).resolves.toMatchObject({ kind: "remote-older" });
  });

  it("keeps local management usable when installation or network state is unavailable", async () => {
    const invalid = await getLibraryVersionStatus("/project", "free", { readState: () => ({ kind: "invalid", message: "bad hash" }), fetchVersions: versions("9.0.0") });
    expect(formatLibraryVersionStatus(invalid)).toContain("installation invalid");
    const offline = await getLibraryVersionStatus("/project", "free", { readState, fetchVersions: async () => { throw new Error("offline"); } });
    expect(offline).toMatchObject({ kind: "check-failed", message: "offline" });
    expect(formatLibraryVersionStatus(offline)).toContain("Latest: unavailable");
  });

  it("does not invent a version for an unpublished tier", async () => {
    await expect(getLibraryVersionStatus("/project", "free", { readState, fetchVersions: versions(null) })).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("does not compare a package-set install against the legacy descriptor service", async () => {
    const packageMetadata: PackageInstallMetadata = {
      schemaVersion: 2,
      candidate: {
        schemaVersion: 1, tier: "free", fullVersion: "1.2.3",
        sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40),
        packageSetSha256: "c".repeat(64), candidateRootSha256: "d".repeat(64),
      },
      target: "react", resourceKeys: ["code/free/react/moe-outline"],
      packages: [{ resourceKey: "code/free/react/moe-outline", packageSha256: "e".repeat(64), dependencies: [] }],
      catalogSha256: "f".repeat(64), installedAt: "2026-10-17T00:00:00Z",
      managedFiles: { ".moeicons/catalog.json": "f".repeat(64) },
      targetSha256: "1".repeat(64), targetFileCount: 1, targetByteCount: 1,
    };
    let fetched = false;
    const status = await getLibraryVersionStatus("/project", "free", {
      readState: () => ({ kind: "ok", metadata: packageMetadata }),
      fetchVersions: async () => { fetched = true; return versions("9.9.9")(); },
    });
    expect(fetched).toBe(false);
    expect(status.kind).toBe("package-set-update-check-required");
    expect(formatLibraryVersionStatus(status)).toContain("package-set update check required");
  });
});
