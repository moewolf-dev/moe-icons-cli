#!/usr/bin/env node
/**
 * E2E-G1A: validate a moe-icons-code-library-release client_payload for CLI pin.
 */
import { readFileSync } from "node:fs";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const COMMIT = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const DIGITS = /^[0-9]+$/;
const BINDING_REQUIRED = [
  "releasePolicyCommit",
  "releasePolicySha256",
  "mediaContractVersion",
  "sourceManifestSchemaVersion",
  "releaseScope",
];
const SUPPORTED_VERSIONS = new Set([1, 2]);
const BITMAP_GROUP_ID = "moe-3d-metal";
const BITMAP_BATCHES = new Map([
  ["bitmap-wave-1", ["moe-3d-metal-256-webp"]],
  ["bitmap-wave-2", ["moe-3d-metal-256-webp", "moe-3d-metal-256-png"]],
  ["bitmap-wave-3", [
    "moe-3d-metal-128-png", "moe-3d-metal-128-webp",
    "moe-3d-metal-256-png", "moe-3d-metal-256-webp",
    "moe-3d-metal-512-png", "moe-3d-metal-512-webp",
  ]],
]);

function sortedList(values) {
  return [...values].sort();
}

function batchForVariants(variantIds) {
  const normalized = sortedList(variantIds);
  for (const [batchId, expected] of BITMAP_BATCHES) {
    const want = sortedList(expected);
    if (normalized.length === want.length && normalized.every((id, index) => id === want[index])) return batchId;
  }
  return undefined;
}

/** DEV-20-01: validate the nested entitlement binding. */
export function validateEventBinding(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("event binding must be an object");
  for (const field of Object.keys(raw)) {
    if (![...BINDING_REQUIRED, "bitmapBatch"].includes(field)) throw new Error(`event binding has unknown field "${field}"`);
  }
  for (const field of BINDING_REQUIRED) {
    if (raw[field] === undefined || raw[field] === "") throw new Error(`event binding missing ${field}`);
  }
  const releasePolicyCommit = String(raw.releasePolicyCommit).toLowerCase();
  const releasePolicySha256 = String(raw.releasePolicySha256).toLowerCase();
  if (!COMMIT.test(releasePolicyCommit)) throw new Error("invalid binding releasePolicyCommit");
  if (!SHA256.test(releasePolicySha256)) throw new Error("invalid binding releasePolicySha256");
  if (!SUPPORTED_VERSIONS.has(Number(raw.mediaContractVersion))) throw new Error(`unsupported binding mediaContractVersion ${raw.mediaContractVersion}`);
  if (!SUPPORTED_VERSIONS.has(Number(raw.sourceManifestSchemaVersion))) throw new Error(`unsupported binding sourceManifestSchemaVersion ${raw.sourceManifestSchemaVersion}`);
  const mediaVersion = Number(raw.mediaContractVersion);
  const schemaVersion = Number(raw.sourceManifestSchemaVersion);
  if (!((mediaVersion === 1 && schemaVersion === 1) || (mediaVersion === 2 && schemaVersion === 2))) {
    throw new Error(`illegal binding version combination mediaContractVersion=${mediaVersion} sourceManifestSchemaVersion=${schemaVersion}`);
  }
  if (raw.releaseScope !== "free" && raw.releaseScope !== "pro") throw new Error("invalid binding releaseScope");
  let bitmapBatch = null;
  if (raw.bitmapBatch !== undefined && raw.bitmapBatch !== null) {
    const batch = raw.bitmapBatch;
    if (typeof batch !== "object" || Array.isArray(batch)) throw new Error("event binding bitmapBatch must be an object");
    for (const field of Object.keys(batch)) {
      if (!["styleGroupIds", "variantIds", "batchId"].includes(field)) throw new Error(`event binding bitmapBatch has unknown field "${field}"`);
    }
    if (!Array.isArray(batch.styleGroupIds) || batch.styleGroupIds.length === 0) throw new Error("invalid binding bitmapBatch.styleGroupIds");
    if (!Array.isArray(batch.variantIds) || batch.variantIds.length === 0) throw new Error("invalid binding bitmapBatch.variantIds");
    const styleGroupIds = sortedList(batch.styleGroupIds.map((value) => String(value)));
    if (styleGroupIds.length !== 1 || styleGroupIds[0] !== BITMAP_GROUP_ID) {
      throw new Error(`binding bitmapBatch.styleGroupIds must be exactly ${BITMAP_GROUP_ID}`);
    }
    const variantIds = sortedList(batch.variantIds.map((value) => String(value)));
    const expectedBatchId = batchForVariants(variantIds);
    if (!expectedBatchId) throw new Error(`binding bitmapBatch.variantIds do not match a frozen C1/C2/C3 set: ${variantIds.join(",")}`);
    if (String(batch.batchId) !== expectedBatchId) {
      throw new Error(`binding bitmapBatch.batchId ${batch.batchId} != expected ${expectedBatchId}`);
    }
    bitmapBatch = { styleGroupIds, variantIds, batchId: expectedBatchId };
  }
  return {
    releasePolicyCommit,
    releasePolicySha256,
    mediaContractVersion: String(raw.mediaContractVersion),
    sourceManifestSchemaVersion: String(raw.sourceManifestSchemaVersion),
    releaseScope: raw.releaseScope,
    bitmapBatch,
  };
}

/** Return true when the binding pins the same contract as the vendored PIN. */
export function bindingMatchesPolicy(binding, policy) {
  if (!binding) return false;
  return (
    String(binding.releasePolicyCommit).toLowerCase() === String(policy.sourceCommit).toLowerCase() &&
    String(binding.releasePolicySha256).toLowerCase() === String(policy.sha256).toLowerCase()
  );
}

export function validateCodeLibraryReleaseEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("event payload must be an object");
  }
  const resourceVersion = String(raw.resourceVersion || "");
  if (!SEMVER.test(resourceVersion)) throw new Error("invalid resourceVersion");
  const sourceCommit = String(raw.sourceCommit || "").toLowerCase();
  const generatorCommit = String(raw.generatorCommit || "").toLowerCase();
  if (!COMMIT.test(sourceCommit)) throw new Error("invalid sourceCommit");
  if (!COMMIT.test(generatorCommit)) throw new Error("invalid generatorCommit");

  // DEV-20-01: artifact digests live in the nested `artifact` object; keep a
  // flat fallback so old serialized payloads remain readable.
  const artifact = raw.artifact && typeof raw.artifact === "object" ? raw.artifact : {};
  const privateDescriptorSha256 = String(
    artifact.privateDescriptorSha256 || raw.privateDescriptorSha256 || raw.descriptorSha256 || "",
  ).toLowerCase();
  const publicDescriptorSha256 = String(
    artifact.publicDescriptorSha256 || raw.publicDescriptorSha256 || "",
  ).toLowerCase();
  if (!SHA256.test(privateDescriptorSha256)) throw new Error("invalid privateDescriptorSha256");
  if (!SHA256.test(publicDescriptorSha256)) throw new Error("invalid publicDescriptorSha256");

  const freeCandidateArtifactId = String(
    artifact.candidateArtifactId || raw.freeCandidateArtifactId || raw.artifactId || "",
  );
  if (!DIGITS.test(freeCandidateArtifactId)) throw new Error("invalid freeCandidateArtifactId");

  const upstreamRunId = String(raw.upstreamRunId || "");
  if (!DIGITS.test(upstreamRunId)) throw new Error("invalid upstreamRunId");

  const correlationId = raw.correlationId ? String(raw.correlationId) : null;
  if (correlationId && !/^[0-9]+-[0-9]+-[a-z0-9-]+$/i.test(correlationId)) {
    throw new Error("invalid correlationId");
  }

  const binding = validateEventBinding(raw.binding);

  return {
    schemaVersion: 2,
    resourceVersion,
    sourceCommit,
    generatorCommit,
    privateDescriptorSha256,
    publicDescriptorSha256,
    freeCandidateArtifactId,
    upstreamRunId,
    correlationId,
    binding,
  };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("validate-code-library-event.mjs") ||
    process.argv[1].endsWith("validate-code-library-event.js"));

if (isMain) {
  try {
    const pathArg = process.argv[2];
    if (!pathArg) throw new Error("usage: validate-code-library-event.mjs <payload.json>");
    const event = validateCodeLibraryReleaseEvent(JSON.parse(readFileSync(pathArg, "utf8")));
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
