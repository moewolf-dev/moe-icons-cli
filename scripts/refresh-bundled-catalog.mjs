#!/usr/bin/env node
/**
 * DEV-20-02 / FIX-22-B: refresh the CLI bundled catalog from a verified Free
 * candidate catalog. Never hand-edit `src/catalog/catalog.json`.
 *
 * Strict rules now enforced:
 *   - the catalog must contain EXACTLY the frozen four Free style groups; any
 *     extra Pro group, orphan icon, bitmap `variants`, or unknown metadata is
 *     rejected so a full Pro catalog can never be installed as the Free bundle;
 *   - every icon.availableIn must be a subset of those four groups;
 *   - the written bytes are the normalized JSON, and both the input digest and
 *     the normalized output digest are reported;
 *   - `--sha256` is required to write; `--check` exits non-zero on any drift.
 *
 * Usage:
 *   node scripts/refresh-bundled-catalog.mjs --catalog <catalog.json> --sha256 <hex>
 *   node scripts/refresh-bundled-catalog.mjs --catalog <catalog.json> --check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src", "catalog", "catalog.json");
const EXPECTED_FREE = ["moe-colored", "moe-lite-outline", "moe-outline", "moe-solid"];
const GROUP_ID = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function normalizeText(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(object, allowed, label) {
  assert(object && typeof object === "object" && !Array.isArray(object), `${label} must be an object`);
  const extra = Object.keys(object).filter((key) => !allowed.includes(key));
  assert(extra.length === 0, `${label} has unknown field(s): ${extra.join(",")}`);
}

function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `${label} must be unique`);
}

/** Strict Free-catalog validation. Exported for tests. */
export function validateFreeCatalog(catalog) {
  assertExactKeys(catalog, ["schemaVersion", "catalogVersion", "sourceVersion", "sourceCommit", "generatorCommit", "styleGroups", "icons"], "catalog");
  assert(catalog.schemaVersion === 1, "catalog schemaVersion must be 1");
  assert(typeof catalog.catalogVersion === "string" && SEMVER.test(catalog.catalogVersion), "catalog catalogVersion must be X.Y.Z");
  assert(typeof catalog.sourceVersion === "string" && SEMVER.test(catalog.sourceVersion), "catalog sourceVersion must be X.Y.Z");
  assert(typeof catalog.sourceCommit === "string" && COMMIT.test(catalog.sourceCommit), "catalog sourceCommit must be 40-hex");
  assert(typeof catalog.generatorCommit === "string" && COMMIT.test(catalog.generatorCommit), "catalog generatorCommit must be 40-hex");
  assert(Array.isArray(catalog.styleGroups), "catalog styleGroups must be an array");
  assert(Array.isArray(catalog.icons), "catalog icons must be an array");

  const groupIds = catalog.styleGroups.map((group) => group.id);
  const expected = [...EXPECTED_FREE].sort();
  const actual = [...groupIds].sort();
  assert(
    actual.length === expected.length && actual.every((id, index) => id === expected[index]),
    `catalog styleGroups must be exactly ${EXPECTED_FREE.join(",")} (got ${groupIds.join(",") || "none"})`,
  );
  assertUnique(groupIds, "catalog style group ids");

  const exactTiers = JSON.stringify(["free", "pro"]);
  for (const group of catalog.styleGroups) {
    assertExactKeys(group, ["id", "type", "tiers", "formats", "imageSizes", "variants"], `catalog group ${group.id}`);
    assert(GROUP_ID.test(group.id || ""), `catalog invalid group id ${String(group.id)}`);
    assert(["outline", "solid", "mixed"].includes(group.type), `catalog group ${group.id} has a non-Free type ${String(group.type)}`);
    assert(Array.isArray(group.tiers) && JSON.stringify([...group.tiers].sort()) === exactTiers, `catalog group ${group.id} tiers must be exactly ["free","pro"]`);
    assert(Array.isArray(group.formats) && group.formats.every((format) => format === "svg"), `catalog group ${group.id} must be SVG-only in the Free bundle`);
    assert(Array.isArray(group.imageSizes) && group.imageSizes.length === 0, `catalog group ${group.id} must not declare bitmap sizes`);
    assert(group.variants === undefined, `catalog group ${group.id} must not declare bitmap variants in the Free bundle`);
  }

  const allowed = new Set(groupIds);
  const iconIds = [];
  for (const icon of catalog.icons) {
    assertExactKeys(icon, ["id", "name", "prefix", "label", "keywords", "categories", "variants", "targets", "aliases", "deprecatedAt", "replacedBy", "availableIn"], `catalog icon ${icon && icon.id}`);
    assert(icon && typeof icon === "object" && ICON_ID.test(icon.id || ""), `catalog invalid icon ${String(icon && icon.id)}`);
    assert(typeof icon.prefix === "string" && typeof icon.label === "string" && Array.isArray(icon.aliases), `catalog icon ${icon.id} missing required metadata`);
    assert(Array.isArray(icon.availableIn) && icon.availableIn.length > 0, `catalog icon ${icon.id} must declare availability`);
    assertUnique(icon.availableIn, `catalog icon ${icon.id} availableIn`);
    assertUnique(icon.aliases, `catalog icon ${icon.id} aliases`);
    for (const id of icon.availableIn) {
      assert(allowed.has(id), `catalog icon ${icon.id} references a non-Free group ${id}`);
    }
    iconIds.push(icon.id);
  }
  assertUnique(iconIds, "catalog icon ids");
  return { groupCount: catalog.styleGroups.length, iconCount: catalog.icons.length, freeGroups: expected };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** PATCH-24-F: bind a Free catalog to a frozen candidate descriptor. */
export function assertCatalogMatchesDescriptor(catalog, descriptor) {
  assert(descriptor && typeof descriptor === "object", "descriptor must be an object");
  assert(catalog.catalogVersion === descriptor.fullVersion, `catalog.catalogVersion ${catalog.catalogVersion} != descriptor.fullVersion ${descriptor.fullVersion}`);
  assert(catalog.sourceVersion === descriptor.fullVersion, "catalog.sourceVersion must equal descriptor.fullVersion");
  assert(String(catalog.sourceCommit).toLowerCase() === String(descriptor.sourceCommit).toLowerCase(), "catalog.sourceCommit != descriptor.sourceCommit");
  assert(String(catalog.generatorCommit).toLowerCase() === String(descriptor.generatorCommit).toLowerCase(), "catalog.generatorCommit != descriptor.generatorCommit");
  return true;
}

function main() {
  const catalogPath = arg("--catalog");
  const expectedSha = arg("--sha256");
  const check = process.argv.includes("--check");
  if (!catalogPath) throw new Error("usage: refresh-bundled-catalog.mjs --catalog <catalog.json> --sha256 <hex> | --check");
  if (!existsSync(catalogPath)) throw new Error(`catalog not found: ${catalogPath}`);

  const inputBytes = readFileSync(catalogPath, "utf8");
  const inputSha = sha256(inputBytes);
  const catalog = JSON.parse(inputBytes);
  const summary = validateFreeCatalog(catalog);

  // PATCH-24-F: bind the catalog to a frozen candidate descriptor when given.
  const descriptorPath = arg("--descriptor");
  if (descriptorPath) {
    assert(existsSync(descriptorPath), `descriptor not found: ${descriptorPath}`);
    assertCatalogMatchesDescriptor(catalog, JSON.parse(readFileSync(descriptorPath, "utf8")));
  }

  const outputText = normalizeText(catalog);
  const outputSha = sha256(outputText);
  const currentSha = existsSync(TARGET) ? sha256(readFileSync(TARGET, "utf8")) : null;

  if (check) {
    const matches = currentSha === outputSha;
    process.stdout.write(`${JSON.stringify({ ...summary, inputSha256: inputSha, outputSha256: outputSha, currentSha256: currentSha, matches })}\n`);
    if (!matches) {
      process.stderr.write("bundled catalog drift detected\n");
      process.exit(1);
    }
    return;
  }

  assert(expectedSha, "--sha256 is required to write the bundled catalog");
  assert(expectedSha.toLowerCase() === inputSha, `input catalog sha256 ${inputSha} != expected ${expectedSha}`);
  writeFileSync(TARGET, outputText);
  process.stdout.write(`${JSON.stringify({ ...summary, inputSha256: inputSha, outputSha256: outputSha, written: TARGET })}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("refresh-bundled-catalog.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
