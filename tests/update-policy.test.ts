import { describe, expect, it } from "vitest";
import { decideUpdate, verifyCandidateIdentity } from "../src/core/update-policy.js";

describe("resource update policy", () => {
  it("allows only a higher version in the same tier and prerelease channel", () => {
    expect(decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: "1.2.3", remoteVersion: "1.2.4" })).toEqual({ kind: "update" });
    expect(decideUpdate({ installedTier: "pro", remoteTier: "pro", installedVersion: "1.2.3-alpha", remoteVersion: "1.2.4-alpha" })).toEqual({ kind: "update" });
    expect(decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: "1.2.3", remoteVersion: "1.2.3" })).toEqual({ kind: "current" });
  });

  it("refuses tier crossing, channel crossing, downgrade and invalid versions", () => {
    expect(decideUpdate({ installedTier: "free", remoteTier: "pro", installedVersion: "1.0.0", remoteVersion: "2.0.0" })).toEqual({ kind: "refuse", reason: "tier-mismatch" });
    expect(decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: "1.0.0-alpha", remoteVersion: "1.0.0" })).toEqual({ kind: "refuse", reason: "channel-mismatch" });
    expect(decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: "2.0.0", remoteVersion: "1.9.9" })).toEqual({ kind: "refuse", reason: "downgrade" });
    expect(decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: "latest", remoteVersion: "2.0.0" })).toEqual({ kind: "refuse", reason: "invalid-version" });
  });

  it("requires an exact second identity check immediately before commit", () => {
    const expected = { tier: "free" as const, version: "1.2.4", descriptorSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
    expect(verifyCandidateIdentity(expected, { ...expected })).toBe(true);
    expect(verifyCandidateIdentity(expected, { ...expected, version: "1.2.5" })).toBe(false);
    expect(verifyCandidateIdentity(expected, { ...expected, artifactSha256: "c".repeat(64) })).toBe(false);
  });
});
