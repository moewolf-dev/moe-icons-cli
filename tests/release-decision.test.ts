import { describe, expect, it } from "vitest";
import { decideRelease } from "../scripts/release-decision.mjs";

const candidate = "a".repeat(64);
const intent = { version: "0.0.19", tag: "v0.0.19", candidateSha256: candidate, pinCommit: "b".repeat(40), stage: "publish-intent" };

const decide = (overrides = {}) =>
  decideRelease({
    intentStatus: "missing",
    candidateSha256: candidate,
    nextVersion: "0.0.21",
    payloadHash: "c".repeat(64),
    lastPublishedPayloadHash: "d".repeat(64),
    ...overrides,
  });

describe("release decision", () => {
  it("pins the recorded intent version even when the registry is not readable yet", () => {
    // The exact ETARGET scenario: npm accepted 0.0.19, the read path lags.
    for (const registry of ["unknown", "missing", "visible"]) {
      const result = decide({ intentStatus: "found", intent, registry });
      expect(result).toMatchObject({ shouldRelease: true, nextVersion: "0.0.19", resume: true, reuseReason: "resumed-intent" });
      expect(result.nextVersion).not.toBe("0.0.21");
    }
  });

  it("records the observed registry state without changing the pin", () => {
    expect(decide({ intentStatus: "found", intent, registry: "unknown" }).registry).toBe("unknown");
    expect(decide({ intentStatus: "found", intent, registry: "missing" }).registry).toBe("missing");
  });

  it("refuses to allocate a new version when the intent lookup itself failed", () => {
    expect(() => decide({ intentStatus: "failed" })).toThrow(/refusing to allocate a new version/);
  });

  it("refuses an intent that belongs to another candidate", () => {
    expect(() => decide({ intentStatus: "found", intent: { ...intent, candidateSha256: "e".repeat(64) } }))
      .toThrow(/another candidate/);
  });

  it("falls through to the payload check only when no intent exists", () => {
    expect(decide({ intentStatus: "missing", payloadHash: "d".repeat(64), lastPublishedPayloadHash: "d".repeat(64) }))
      .toMatchObject({ shouldRelease: false, reuseReason: "unchanged-payload" });
    expect(decide({ intentStatus: "missing" }))
      .toMatchObject({ shouldRelease: true, nextVersion: "0.0.21", resume: false, reuseReason: "new-payload" });
  });

  it("rejects an unreadable or malformed intent instead of bumping", () => {
    expect(() => decide({ intentStatus: "found" })).toThrow(/unreadable/);
    expect(() => decide({ intentStatus: "found", intent: { version: "next" } })).toThrow(/version is invalid/);
  });
});
