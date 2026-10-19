import { it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePromise = import("../scripts/apply-package-set-pin.mjs") as Promise<{
  applyPackageSetPin(input: Record<string, any>): Record<string, any>;
}>;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const sourceDispatchId = "1".repeat(64);
  const packageSets = {
    schemaVersion: 1,
    resourceVersion: "1.2.3",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    free: { packageSetSha256: "c".repeat(64), candidateRootSha256: "d".repeat(64), candidateRootBytes: 512 },
    pro: { packageSetSha256: "e".repeat(64), candidateRootSha256: "f".repeat(64), candidateRootBytes: 768 },
  };
  const digest = hash(`moe-icons-small-package-plugin-v1\n${sourceDispatchId}\n${packageSets.free.packageSetSha256}\n${packageSets.pro.packageSetSha256}\n`);
  const event = {
    schemaVersion: 1, eventId: `package-set:1.2.3:${digest}`, sourceRepository: "moewolf-dev/moe-icons-code-library",
    sourceVersion: "1.2.3", sourceCommit: packageSets.sourceCommit, resourceVersion: "1.2.3", generatorCommit: packageSets.generatorCommit,
    sourceDispatchId, packageSets,
    producer: { repository: "moewolf-dev/moe-icons-code-library", workflowPath: ".github/workflows/small-pack-candidate.yml", runId: "123", runAttempt: 2, headSha: packageSets.generatorCommit },
  };
  const catalog = {
    schemaVersion: 1, catalogVersion: "1.2.3", sourceVersion: "1.2.3", sourceCommit: packageSets.sourceCommit,
    generatorCommit: packageSets.generatorCommit, manifestSchemaVersion: 2,
    styleGroups: [
      { id: "moe-game-blue", type: "mixed", tiers: ["pro"], formats: ["svg"], imageSizes: [] },
      { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    ],
    icons: [
      { id: "archive-box", name: "Archive Box", prefix: "archive", label: "Archive Box", keywords: ["archive"], categories: [], variants: ["moe-outline"], targets: ["react", "vue", "vanilla", "assets"], aliases: [], availableIn: ["moe-outline"] },
      { id: "pixel-sword", name: "Pixel Sword", prefix: "pixel", label: "Pixel Sword", keywords: ["pixel"], categories: [], variants: ["moe-game-blue"], targets: ["react", "vue", "vanilla", "assets"], aliases: [], availableIn: ["moe-game-blue"] },
    ],
  };
  return { event, packageSets, catalog, catalogSha256: hash(`${JSON.stringify(catalog, null, 2)}\n`) };
}

it("pins the exact package-set roots and catalog, then treats identical replay as idempotent", async () => {
  const { applyPackageSetPin } = await modulePromise;
  const rootDir = await mkdtemp(join(tmpdir(), "moe-cli-package-set-pin-"));
  try {
    const input = fixture();
    const result = applyPackageSetPin({ ...input, rootDir, nowIso: "2026-10-17T00:00:00.000Z" });
    assert.equal(result.action, "apply");
    assert.equal(result.release.schemaVersion, 2);
    assert.equal(result.release.packageSets.free.candidateRootSha256, "d".repeat(64));
    const storedRelease = JSON.parse(await readFile(join(rootDir, "src/catalog/resource-release.json"), "utf8"));
    assert.deepEqual(storedRelease.packageSets, input.packageSets);
    const storedCatalog = await readFile(join(rootDir, "src/catalog/catalog.json"), "utf8");
    assert.equal(hash(storedCatalog), input.catalogSha256);
    const replay = applyPackageSetPin({ ...input, rootDir, currentRelease: storedRelease });
    assert.equal(replay.action, "skip");
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

it("rejects a reused package-set event ID with changed roots or metadata", async () => {
  const { applyPackageSetPin } = await modulePromise;
  const input = fixture();
  const rootDir = await mkdtemp(join(tmpdir(), "moe-cli-package-set-pin-conflict-"));
  try {
    const result = applyPackageSetPin({ ...input, rootDir, nowIso: "2026-10-17T00:00:00.000Z" });
    const changedCatalog = { ...input.catalog, icons: input.catalog.icons.slice(0, 1) };
    const changedSha = hash(`${JSON.stringify(changedCatalog, null, 2)}\n`);
    assert.throws(() => applyPackageSetPin({ ...input, catalog: changedCatalog, catalogSha256: changedSha, rootDir, currentRelease: result.release }), /same resource version has conflicting package-set roots or catalog content/);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});
