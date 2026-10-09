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
  binding: null,
};

function miniCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.18",
    sourceVersion: "0.0.18",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: ["moe-outline", "moe-lite-outline", "moe-solid", "moe-colored"].map(id => ({ id, type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] })),
    icons: [{ id: "ui-search", prefix: "ui", label: "Search", aliases: [], availableIn: ["moe-outline"] }],
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
    const report = applyResourcePin({ currentRelease: null,
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
      applyResourcePin({ currentRelease: null,
        event: validateCodeLibraryReleaseEvent(EVENT),
        catalog: miniCatalog({ catalogVersion: "0.0.17", sourceVersion: "0.0.17" }),
        dryRun: true,
      }),
    ).toThrow(/catalogVersion/);
  });
});

describe("G1A plan-resource-pin-commit", () => {
  it("updates the resource pin only and leaves the CLI version to Publish CLI", () => {
    // nextPatch is still exported for other callers, but the pin no longer bumps.
    expect(nextPatch("0.0.1")).toBe("0.0.2");
    const plan = planPinCommit({ currentCliVersion: "0.0.1", resourceVersion: "0.0.18" });
    expect(plan.action).toBe("pin");
    // Single version owner: the pin must NOT advance the CLI version.
    expect(plan.nextCliVersion).toBe("0.0.1");
    expect(plan.commitMessage).toBe(buildPinCommitMessage("0.0.18"));
    expect(plan.commitMessage).toMatch(/^chore\(release\): pin cli resources 0\.0\.18$/);
    expect(planPinCommit({ currentCliVersion: "0.0.1", resourceVersion: "0.0.18", skip: true }).action).toBe(
      "skip",
    );
  });
});

// DEV-20-01: nested entitlement binding enforcement for the CLI pin writer.
import { validateEventBinding, bindingMatchesPolicy } from "../scripts/validate-code-library-event.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PIN = JSON.parse(
  readFileSync(join(process.cwd(), "vendor/moe-icons-release-policy/PIN.json"), "utf8"),
);
const BINDING = {
  releasePolicyCommit: PIN.sourceCommit,
  releasePolicySha256: PIN.sha256,
  mediaContractVersion: "2",
  sourceManifestSchemaVersion: "2",
  releaseScope: "pro",
  bitmapBatch: {
    styleGroupIds: ["moe-3d-metal"],
    variantIds: ["moe-3d-metal-256-png", "moe-3d-metal-256-webp"],
    batchId: "bitmap-wave-2",
  },
};

describe("DEV-20-01 CLI pin binding", () => {
  it("validates the nested binding and matches the vendored PIN", () => {
    const binding = validateEventBinding(BINDING);
    expect(binding?.releaseScope).toBe("pro");
    expect(binding?.bitmapBatch?.batchId).toBe("bitmap-wave-2");
    expect(bindingMatchesPolicy(binding, PIN)).toBe(true);
    expect(bindingMatchesPolicy(validateEventBinding({ ...BINDING, releasePolicyCommit: "c".repeat(40) }), PIN)).toBe(false);
    expect(() => validateEventBinding({ ...BINDING, releasePolicyCommit: "nope" })).toThrow(/releasePolicyCommit/);
    expect(() => validateEventBinding({ ...BINDING, releaseScope: "ent" })).toThrow(/releaseScope/);
    expect(() => validateEventBinding({ ...BINDING, bitmapBatch: { ...BINDING.bitmapBatch, batchId: "wave" } })).toThrow(/batchId/);
  });

  it("rejects a writer pin without a binding or with a mismatched PIN/scope", () => {
    const event = validateCodeLibraryReleaseEvent(EVENT);
    expect(() => applyResourcePin({ currentRelease: null, event, catalog: miniCatalog(), dryRun: false })).toThrow(/unbound release event/);
    const bound = validateCodeLibraryReleaseEvent({ ...EVENT, binding: BINDING });
    // A correct Pro binding is accepted (dry-run keeps the real tree untouched).
    expect(
      applyResourcePin({ currentRelease: null, event: bound, catalog: miniCatalog(), dryRun: true, nowIso: "2026-09-11T00:00:00.000Z" }).dryRun,
    ).toBe(true);
    const wrongPin = validateCodeLibraryReleaseEvent({
      ...EVENT,
      binding: { ...BINDING, releasePolicySha256: "f".repeat(64) },
    });
    expect(() => applyResourcePin({ currentRelease: null, event: wrongPin, catalog: miniCatalog(), dryRun: false })).toThrow(/vendored release PIN/);
    const wrongScope = validateCodeLibraryReleaseEvent({ ...EVENT, binding: { ...BINDING, releaseScope: "free" } });
    expect(() => applyResourcePin({ currentRelease: null, event: wrongScope, catalog: miniCatalog(), dryRun: false })).toThrow(/releaseScope pro/);
  });
});

describe("FIX-22-A CLI binding batch strictness", () => {
  it("rejects unsupported versions and non-frozen variant sets", async () => {
    const { validateEventBinding } = await import("../scripts/validate-code-library-event.mjs");
    expect(() => validateEventBinding({ ...BINDING, mediaContractVersion: "999" })).toThrow(/mediaContractVersion/);
    expect(() => validateEventBinding({ ...BINDING, sourceManifestSchemaVersion: "999" })).toThrow(/sourceManifestSchemaVersion/);
    expect(() =>
      validateEventBinding({ ...BINDING, bitmapBatch: { styleGroupIds: ["moe-3d-metal"], variantIds: ["moe-3d-metal-128-png"], batchId: "bitmap-wave-1" } }),
    ).toThrow(/must include 128\/256\/512/);
    expect(() =>
      validateEventBinding({ ...BINDING, bitmapBatch: { styleGroupIds: ["moe-wrong"], variantIds: ["moe-3d-metal-256-webp"], batchId: "bitmap-wave-1" } }),
    ).toThrow(/styleGroupIds/);
    expect(() => validateEventBinding({ ...BINDING, extra: 1 })).toThrow(/unknown field/);
  });

  it("D01 accepts PNG-only and WebP-only complete size sets", async () => {
    const { validateEventBinding } = await import("../scripts/validate-code-library-event.mjs");
    for (const format of ["png", "webp"]) {
      const variantIds = [128, 256, 512].map((size) => `moe-new-collection-${size}-${format}`);
      const result = validateEventBinding({ ...BINDING, bitmapBatch: {
        styleGroupIds: ["moe-new-collection"], variantIds, batchId: "bitmap-wave-3",
      } });
      expect(result?.bitmapBatch?.variantIds).toHaveLength(3);
    }
  });
});

describe("PATCH-24-B CLI version pairing", () => {
  it("rejects illegal media/schema combinations before pinning", async () => {
    const { validateEventBinding } = await import("../scripts/validate-code-library-event.mjs");
    expect(() => validateEventBinding({ ...BINDING, mediaContractVersion: "1" })).toThrow(/illegal binding version combination/);
    expect(() => validateEventBinding({ ...BINDING, sourceManifestSchemaVersion: "1" })).toThrow(/illegal binding version combination/);
    expect(validateEventBinding({ ...BINDING, mediaContractVersion: "1", sourceManifestSchemaVersion: "1" })?.mediaContractVersion).toBe("1");
  });
});


describe("resource ordering and replay", () => {
  it("refuses stale/conflicting versions and validates repeated catalog bytes", async () => {
    const { createHash } = await import("node:crypto");
    const event = validateCodeLibraryReleaseEvent({ ...EVENT, binding: BINDING });
    const catalog = miniCatalog();
    const catalogSha256 = createHash("sha256").update(JSON.stringify(catalog, null, 2) + "\n").digest("hex");
    const release = buildResourceRelease(event, { catalogSha256 });
    expect(() => applyResourcePin({ event, catalog, currentRelease: { ...release, resourceVersion: "0.0.19" }, dryRun: true })).toThrow(/stale/);
    expect(() => applyResourcePin({ event, catalog, currentRelease: { ...release, publicDescriptorSha256: "f".repeat(64) }, dryRun: true })).toThrow(/conflicting descriptor/);
    expect(applyResourcePin({ event, catalog, currentRelease: release, dryRun: true }).action).toBe("skip");
    expect(() => applyResourcePin({ event, catalog: miniCatalog({ icons: [] }), currentRelease: release, dryRun: true })).toThrow(/conflicting catalog/);
  });
});
