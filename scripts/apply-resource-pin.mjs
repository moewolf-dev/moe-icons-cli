#!/usr/bin/env node
/**
 * E2E-G1A: apply a verified catalog + resource-release pin into the CLI tree.
 *
 * Usage:
 *   node scripts/apply-resource-pin.mjs \
 *     --event payload.json \
 *     --catalog catalog.json \
 *     [--catalog-sha256 <hex>] \
 *     [--dry-run]
 *
 * Writes only:
 *   src/catalog/catalog.json
 *   src/catalog/resource-release.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCodeLibraryReleaseEvent } from "./validate-code-library-event.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_WRITE_PATHS = [
  "src/catalog/catalog.json",
  "src/catalog/resource-release.json",
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assertCatalogShape(catalog, event) {
  if (!catalog || typeof catalog !== "object") throw new Error("catalog must be an object");
  if (catalog.schemaVersion !== 1) throw new Error("catalog.schemaVersion must be 1");
  if (catalog.catalogVersion !== event.resourceVersion) {
    throw new Error(
      `catalog.catalogVersion ${catalog.catalogVersion} != resourceVersion ${event.resourceVersion}`,
    );
  }
  if (catalog.sourceVersion !== event.resourceVersion) {
    throw new Error("catalog.sourceVersion must equal resourceVersion");
  }
  if (String(catalog.sourceCommit).toLowerCase() !== event.sourceCommit) {
    throw new Error("catalog.sourceCommit mismatch vs event");
  }
  if (String(catalog.generatorCommit).toLowerCase() !== event.generatorCommit) {
    throw new Error("catalog.generatorCommit mismatch vs event");
  }
  if (!Array.isArray(catalog.styleGroups) || !Array.isArray(catalog.icons)) {
    throw new Error("catalog must include styleGroups and icons arrays");
  }
}

export function buildResourceRelease(event, options = {}) {
  return {
    schemaVersion: 1,
    resourceVersion: event.resourceVersion,
    privateDescriptorSha256: event.privateDescriptorSha256,
    publicDescriptorSha256: event.publicDescriptorSha256,
    sourceCommit: event.sourceCommit,
    generatorCommit: event.generatorCommit,
    freeCandidateArtifactId: event.freeCandidateArtifactId,
    upstreamRunId: event.upstreamRunId,
    correlationId: event.correlationId,
    catalogSha256: options.catalogSha256 || null,
    appliedAt: options.appliedAt || new Date().toISOString(),
  };
}

export function shouldSkipPin(existingRelease, event) {
  if (!existingRelease || typeof existingRelease !== "object") return false;
  return (
    existingRelease.resourceVersion === event.resourceVersion &&
    String(existingRelease.privateDescriptorSha256 || "").toLowerCase() ===
      event.privateDescriptorSha256 &&
    String(existingRelease.publicDescriptorSha256 || "").toLowerCase() ===
      event.publicDescriptorSha256
  );
}

export function assertAllowedPinDiff(changedPaths) {
  const unexpected = changedPaths.filter((p) => !ALLOWED_WRITE_PATHS.includes(p));
  if (unexpected.length) {
    throw new Error(`pin apply would touch disallowed paths: ${unexpected.join(", ")}`);
  }
}

export function applyResourcePin({ event, catalog, catalogSha256, dryRun = false, nowIso }) {
  assertCatalogShape(catalog, event);
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const actualSha = sha256Text(catalogJson);
  if (catalogSha256 && catalogSha256.toLowerCase() !== actualSha) {
    throw new Error(`catalog sha256 mismatch: expected ${catalogSha256}, got ${actualSha}`);
  }

  const releasePath = join(root, "src/catalog/resource-release.json");
  const existing = existsSync(releasePath)
    ? JSON.parse(readFileSync(releasePath, "utf8"))
    : null;
  if (shouldSkipPin(existing, event)) {
    return {
      action: "skip",
      reason: "identical resourceVersion + descriptor digests already pinned",
      resourceVersion: event.resourceVersion,
      written: [],
    };
  }

  const release = buildResourceRelease(event, {
    catalogSha256: catalogSha256 || actualSha,
    appliedAt: nowIso,
  });
  const releaseJson = `${JSON.stringify(release, null, 2)}\n`;
  const written = ["src/catalog/catalog.json", "src/catalog/resource-release.json"];
  assertAllowedPinDiff(written);

  if (!dryRun) {
    mkdirSync(join(root, "src/catalog"), { recursive: true });
    writeFileSync(join(root, "src/catalog/catalog.json"), catalogJson);
    writeFileSync(releasePath, releaseJson);
  }

  return {
    action: "apply",
    resourceVersion: event.resourceVersion,
    catalogSha256: catalogSha256 || actualSha,
    written,
    release,
    dryRun,
  };
}

function main() {
  const eventPath = arg("--event");
  const catalogPath = arg("--catalog");
  if (!eventPath || !catalogPath) {
    throw new Error(
      "usage: apply-resource-pin.mjs --event <payload.json> --catalog <catalog.json> [--catalog-sha256 <hex>] [--dry-run]",
    );
  }
  const event = validateCodeLibraryReleaseEvent(JSON.parse(readFileSync(eventPath, "utf8")));
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const report = applyResourcePin({
    event,
    catalog,
    catalogSha256: arg("--catalog-sha256"),
    dryRun: hasFlag("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("apply-resource-pin.mjs") ||
    process.argv[1].endsWith("apply-resource-pin.js"));

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
