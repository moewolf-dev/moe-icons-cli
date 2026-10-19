import { it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const modulePromise = import("../scripts/cli-package-set-delivery.mjs") as Promise<{
  buildCliPackageSetDelivery(input: { resource: Record<string, any>; receipt: Record<string, any>; run: Record<string, any>; publishRunId: string }): { eventId: string; delivery: Record<string, any> };
}>;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function fixture() {
  const packageSets = {
    schemaVersion: 1, resourceVersion: "1.2.3", sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40),
    free: { packageSetSha256: "c".repeat(64), candidateRootSha256: "d".repeat(64), candidateRootBytes: 512 },
    pro: { packageSetSha256: "e".repeat(64), candidateRootSha256: "f".repeat(64), candidateRootBytes: 768 },
  };
  const sourceDispatchId = "1".repeat(64);
  const producer = { repository: "moewolf-dev/moe-icons-code-library", workflowPath: ".github/workflows/small-pack-candidate.yml", runId: "123", runAttempt: 2, headSha: "b".repeat(40) };
  const resource = {
    schemaVersion: 2, resourceVersion: "1.2.3", sourceCommit: packageSets.sourceCommit, generatorCommit: packageSets.generatorCommit,
    sourceDispatchId, producer, packageSets,
    packageSetResourceDigest: sha(`moe-icons-package-set-resource-v1\n1.2.3\n${packageSets.sourceCommit}\n${packageSets.generatorCommit}\n${packageSets.free.packageSetSha256}\n${packageSets.pro.packageSetSha256}\n`),
    packageSetDescriptorSha256: sha(Buffer.from(`${JSON.stringify(canonical(packageSets))}\n`)),
    catalogSha256: "9".repeat(64), appliedAt: "2026-10-17T00:00:00.000Z",
  };
  const receipt = { version: "0.0.13", releaseCommit: "f".repeat(40), runId: "987", npmIntegrity: "sha512-fixture" };
  const run = { id: "987", head_sha: "0".repeat(40), conclusion: "success" };
  return { resource, receipt, run, producer, packageSets };
}

it("delivers the exact package-set roots with a CLI-publish-bound joint event", async () => {
  const { buildCliPackageSetDelivery } = await modulePromise;
  const f = fixture();
  const result = buildCliPackageSetDelivery({ resource: f.resource, receipt: f.receipt, run: f.run, publishRunId: "987" });
  assert.equal(result.eventId, "resource:1.2.3:cli:0.0.13");
  assert.deepEqual(result.delivery.packageSets, f.packageSets);
  assert.deepEqual(result.delivery.producer, f.producer);
  assert.equal(result.delivery.cliPublishHead, f.run.head_sha);
  assert.equal(result.delivery.cliNpmIntegrity, f.receipt.npmIntegrity);
});

it("rejects changed roots or a non-successful CLI publisher", async () => {
  const { buildCliPackageSetDelivery } = await modulePromise;
  const f = fixture();
  const tampered = structuredClone(f.resource);
  tampered.packageSets.pro.candidateRootSha256 = "8".repeat(64);
  assert.throws(() => buildCliPackageSetDelivery({ resource: tampered, receipt: f.receipt, run: f.run, publishRunId: "987" }), /package-set resource digests mismatch/);
  assert.throws(() => buildCliPackageSetDelivery({ resource: f.resource, receipt: f.receipt, run: { ...f.run, conclusion: "failure" }, publishRunId: "987" }), /CLI publish run identity is invalid/);
});
