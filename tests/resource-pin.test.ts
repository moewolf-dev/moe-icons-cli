import { describe, expect, it } from "vitest";
import { validateCodeLibraryReleaseEvent } from "../scripts/validate-code-library-event.mjs";
import {
  applyResourcePin,
  assertAllowedPinDiff,
  buildResourceRelease,
  shouldSkipPin,
} from "../scripts/apply-resource-pin.mjs";
import {
  buildPinCommitMessage,
  nextPatch,
  planPinCommit,
} from "../scripts/plan-resource-pin-commit.mjs";

const EVENT = {
  resourceVersion: "0.0.18",
  sourceCommit: "a".repeat(40),
  generatorCommit: "b".repeat(40),
  privateDescriptorSha256: "c".repeat(64),
  publicDescriptorSha256: "d".repeat(64),
  freeCandidateArtifactId: "123456",
  upstreamRunId: "999",
  correlationId: "999-1-cli-pin",
};

function miniCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.18",
    sourceVersion: "0.0.18",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [{ id: "moe-outline", type: "outline", tiers: ["free"], formats: ["svg"], imageSizes: [] }],
    icons: [{ id: "ui-search", prefix: "ui", availableIn: ["moe-outline"] }],
    ...overrides,
  };
}

describe("G1A validate-code-library-event", () => {
  it("accepts a complete payload and rejects malformed fields", () => {
    expect(validateCodeLibraryReleaseEvent(EVENT).resourceVersion).toBe("0.0.18");
    expect(() => validateCodeLibraryReleaseEvent({ ...EVENT, resourceVersion: "v0.0.18" })).toThrow(
      /resourceVersion/,
    );
    expect(() => validateCodeLibraryReleaseEvent({ ...EVENT, sourceCommit: "short" })).toThrow(
      /sourceCommit/,
    );
    expect(() =>
      validateCodeLibraryReleaseEvent({ ...EVENT, freeCandidateArtifactId: "abc" }),
    ).toThrow(/freeCandidateArtifactId/);
  });
});

describe("G1A apply-resource-pin", () => {
  it("builds resource-release.json and skips identical pins", () => {
    const release = buildResourceRelease(EVENT, { catalogSha256: "e".repeat(64), appliedAt: "2026-09-08T08:00:00.000Z" });
    expect(release.resourceVersion).toBe("0.0.18");
    expect(shouldSkipPin(release, EVENT)).toBe(true);
    expect(shouldSkipPin({ ...release, privateDescriptorSha256: "f".repeat(64) }, EVENT)).toBe(false);
    assertAllowedPinDiff(["src/catalog/catalog.json", "src/catalog/resource-release.json"]);
    expect(() => assertAllowedPinDiff(["src/cli.ts"])).toThrow(/disallowed/);
  });

  it("dry-run applies without writing and rejects catalog/event mismatches", () => {
    const report = applyResourcePin({
      event: validateCodeLibraryReleaseEvent(EVENT),
      catalog: miniCatalog(),
      dryRun: true,
      nowIso: "2026-09-08T08:00:00.000Z",
    });
    expect(report.action).toBe("apply");
    expect(report.dryRun).toBe(true);
    expect(report.written).toEqual([
      "src/catalog/catalog.json",
      "src/catalog/resource-release.json",
    ]);
    expect(() =>
      applyResourcePin({
        event: validateCodeLibraryReleaseEvent(EVENT),
        catalog: miniCatalog({ catalogVersion: "0.0.17", sourceVersion: "0.0.17" }),
        dryRun: true,
      }),
    ).toThrow(/catalogVersion/);
  });
});

describe("G1A plan-resource-pin-commit", () => {
  it("bumps patch only and freezes the commit message format", () => {
    expect(nextPatch("0.0.1")).toBe("0.0.2");
    expect(nextPatch("1.2.3-beta")).toBe("1.2.4-beta");
    const plan = planPinCommit({ currentCliVersion: "0.0.1", resourceVersion: "0.0.18" });
    expect(plan.action).toBe("bump");
    expect(plan.nextCliVersion).toBe("0.0.2");
    expect(plan.commitMessage).toBe(buildPinCommitMessage("0.0.2", "0.0.18"));
    expect(plan.commitMessage).toMatch(/^chore\(release\): cli v0\.0\.2 for resources 0\.0\.18$/);
    expect(planPinCommit({ currentCliVersion: "0.0.1", resourceVersion: "0.0.18", skip: true }).action).toBe(
      "skip",
    );
  });
});
