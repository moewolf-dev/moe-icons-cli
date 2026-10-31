#!/usr/bin/env node
/** Apply a verified Free/Pro package-set pin and its metadata-only catalog. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackageSetCatalog } from "./refresh-bundled-catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_REPOSITORY = "moewolf-dev/moe-icons-code-library";
const SOURCE_WORKFLOW = ".github/workflows/small-pack-candidate.yml";

function assert(condition, message) { if (!condition) throw new Error(message); }
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  assert(record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} has unexpected or missing fields`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value))}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function compareVersion(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  return 0;
}

export function validatePackageSetEvent(event) {
  exactKeys(event, ["schemaVersion", "eventId", "sourceRepository", "sourceVersion", "sourceCommit", "resourceVersion", "generatorCommit", "sourceDispatchId", "packageSets", "producer"], "package-set event");
  assert(event.schemaVersion === 1 && event.sourceRepository === SOURCE_REPOSITORY
    && VERSION.test(event.sourceVersion || "") && event.sourceVersion === event.resourceVersion
    && COMMIT.test(event.sourceCommit || "") && COMMIT.test(event.generatorCommit || "")
    && SHA.test(event.sourceDispatchId || ""), "package-set event identity is invalid");
  const binding = event.packageSets;
  exactKeys(binding, ["schemaVersion", "resourceVersion", "sourceCommit", "generatorCommit", "free", "pro"], "package-set binding");
  assert(binding.schemaVersion === 1 && binding.resourceVersion === event.resourceVersion
    && binding.sourceCommit === event.sourceCommit && binding.generatorCommit === event.generatorCommit, "package-set binding differs from the event");
  for (const tier of ["free", "pro"]) {
    const row = binding[tier];
    exactKeys(row, ["packageSetSha256", "candidateRootSha256", "candidateRootBytes"], `${tier} candidate binding`);
    assert(SHA.test(row.packageSetSha256 || "") && SHA.test(row.candidateRootSha256 || "")
      && Number.isSafeInteger(row.candidateRootBytes) && row.candidateRootBytes > 0 && row.candidateRootBytes <= 1024 ** 2,
    `${tier} candidate binding is invalid`);
  }
  assert(binding.free.packageSetSha256 !== binding.pro.packageSetSha256, "Free and Pro package sets must be distinct");
  exactKeys(event.producer, ["repository", "workflowPath", "runId", "runAttempt", "headSha"], "candidate producer");
  assert(event.producer.repository === SOURCE_REPOSITORY && event.producer.workflowPath === SOURCE_WORKFLOW
    && /^[1-9]\d*$/.test(String(event.producer.runId)) && Number.isSafeInteger(event.producer.runAttempt) && event.producer.runAttempt > 0
    && COMMIT.test(event.producer.headSha || ""), "candidate producer identity is invalid");
  const idDigest = sha256(`moe-icons-small-package-plugin-v1\n${event.sourceDispatchId}\n${binding.free.packageSetSha256}\n${binding.pro.packageSetSha256}\n`);
  assert(event.eventId === `package-set:${event.resourceVersion}:${idDigest}`, "package-set event ID mismatch");
  return event;
}

export function buildPackageSetResourceRelease(event, catalogSha256, appliedAt) {
  const resourceDigest = sha256(`moe-icons-package-set-resource-v1\n${event.resourceVersion}\n${event.sourceCommit}\n${event.generatorCommit}\n${event.packageSets.free.packageSetSha256}\n${event.packageSets.pro.packageSetSha256}\n`);
  const descriptorSha256 = sha256(canonicalBytes(event.packageSets));
  return {
    schemaVersion: 2,
    resourceVersion: event.resourceVersion,
    sourceCommit: event.sourceCommit,
    generatorCommit: event.generatorCommit,
    sourceDispatchId: event.sourceDispatchId,
    producer: event.producer,
    packageSets: event.packageSets,
    packageSetResourceDigest: resourceDigest,
    packageSetDescriptorSha256: descriptorSha256,
    catalogSha256,
    appliedAt,
  };
}

function atomicWrite(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
  renameSync(temp, path);
}

export function applyPackageSetPin({ event: input, catalog, catalogSha256, dryRun = false, nowIso = new Date().toISOString(), rootDir = ROOT, currentRelease }) {
  const event = validatePackageSetEvent(input);
  validatePackageSetCatalog(catalog);
  assert(catalog.catalogVersion === event.resourceVersion && catalog.sourceVersion === event.resourceVersion
    && catalog.sourceCommit === event.sourceCommit && catalog.generatorCommit === event.generatorCommit,
  "generated catalog differs from the exact package-set producer identity");
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const catalogDigest = sha256(catalogJson);
  assert(SHA.test(catalogSha256 || "") && catalogSha256 === catalogDigest, "generated catalog SHA-256 mismatch");
  assert(!Number.isNaN(Date.parse(nowIso)), "appliedAt is invalid");

  const releasePath = join(rootDir, "src/catalog/resource-release.json");
  const catalogPath = join(rootDir, "src/catalog/catalog.json");
  const existing = currentRelease !== undefined ? currentRelease : existsSync(releasePath)
    ? JSON.parse(readFileSync(releasePath, "utf8")) : null;
  if (existing) {
    assert(typeof existing.resourceVersion === "string" && VERSION.test(existing.resourceVersion), "stored resource pin version is invalid");
    const comparison = compareVersion(event.resourceVersion, existing.resourceVersion);
    assert(comparison >= 0, "stale package-set event cannot downgrade the pin");
    if (comparison === 0) {
      const next = buildPackageSetResourceRelease(event, catalogDigest, nowIso);
      const same = existing.schemaVersion === 2 && existing.catalogSha256 === catalogDigest
        && JSON.stringify(canonical(existing.packageSets)) === JSON.stringify(canonical(next.packageSets))
        && existing.sourceCommit === next.sourceCommit && existing.generatorCommit === next.generatorCommit;
      assert(same, "same resource version has conflicting package-set roots or catalog content");
      if (currentRelease === undefined) {
        assert(existsSync(catalogPath) && sha256(readFileSync(catalogPath)) === catalogDigest, "stored package-set catalog drifted; repair before replay");
      }
      return { action: "skip", resourceVersion: event.resourceVersion, packageSets: event.packageSets, catalogSha256: catalogDigest, written: [] };
    }
  }

  const release = buildPackageSetResourceRelease(event, catalogDigest, nowIso);
  const releaseJson = `${JSON.stringify(release, null, 2)}\n`;
  if (!dryRun) {
    mkdirSync(dirname(catalogPath), { recursive: true });
    atomicWrite(catalogPath, catalogJson);
    atomicWrite(releasePath, releaseJson);
  }
  return {
    action: "apply",
    resourceVersion: event.resourceVersion,
    packageSets: event.packageSets,
    catalogSha256: catalogDigest,
    written: ["src/catalog/catalog.json", "src/catalog/resource-release.json"],
    release,
    dryRun,
  };
}

function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
if (process.argv[1]?.endsWith("apply-package-set-pin.mjs")) {
  try {
    const eventPath = arg("--event"), catalogPath = arg("--catalog"), expectedSha = arg("--catalog-sha256");
    assert(eventPath && catalogPath && expectedSha, "usage: node scripts/apply-package-set-pin.mjs --event <event.json> --catalog <catalog.json> --catalog-sha256 <sha256> [--dry-run]");
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    process.stdout.write(`${JSON.stringify(applyPackageSetPin({ event, catalog, catalogSha256: expectedSha, dryRun: process.argv.includes("--dry-run") }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
