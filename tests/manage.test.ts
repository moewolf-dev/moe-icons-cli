import { describe, expect, it } from "vitest";
import { formatLibraryVersionStatus, getLibraryVersionStatus } from "../src/core/manage.js";
import type { InstallMetadata, InstalledResourceState } from "../src/project/install-metadata.js";

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
});
