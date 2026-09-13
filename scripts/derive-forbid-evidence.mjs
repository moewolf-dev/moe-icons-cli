#!/usr/bin/env node
/**
 * AUD-BLOCK-46: derive the publish leak-scan forbidden token set from the
 * frozen CLI state (vendored Free contract + pinned resource release). The
 * output is `{ schemaVersion, tokens, sha256, sources }` so the publish gate can
 * bind the exact evidence it scanned against.
 *
 * Usage:
 *   node scripts/derive-forbid-evidence.mjs \
 *     --free vendor/moe-icons-release-policy/free-style-groups.v1.json \
 *     --resource-release src/catalog/resource-release.json \
 *     [--descriptor <pro-release-descriptor.json>] \
 *     [--out forbid-evidence.json]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { deriveForbiddenTokens } from "./scan-bundle.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function buildForbidEvidence({ freePath, resourceReleasePath, descriptorPath }) {
  // AUD-BLOCK-48: a declared but missing input fails closed; never silently
  // produce an empty token set.
  for (const [label, value] of [["--free", freePath], ["--resource-release", resourceReleasePath], ["--descriptor", descriptorPath]]) {
    if (value && !existsSync(value)) throw new Error(`${label} declared but missing: ${value}`);
  }
  const freeGroups = freePath && existsSync(freePath)
    ? JSON.parse(readFileSync(freePath, "utf8")).freeStyleGroups
    : undefined;
  const resourceRelease = resourceReleasePath && existsSync(resourceReleasePath)
    ? JSON.parse(readFileSync(resourceReleasePath, "utf8"))
    : undefined;
  const descriptor = descriptorPath && existsSync(descriptorPath)
    ? JSON.parse(readFileSync(descriptorPath, "utf8"))
    : undefined;
  const tokens = deriveForbiddenTokens({ freeGroups, resourceRelease, descriptor });
  const canonical = `${JSON.stringify({ schemaVersion: 1, tokens: [...tokens].sort() }, null, 2)}\n`;
  return {
    schemaVersion: 1,
    tokens: [...tokens].sort(),
    sha256: createHash("sha256").update(canonical).digest("hex"),
    sources: {
      free: freePath && existsSync(freePath) ? freePath : null,
      resourceRelease: resourceReleasePath && existsSync(resourceReleasePath) ? resourceReleasePath : null,
      descriptor: descriptorPath && existsSync(descriptorPath) ? descriptorPath : null,
    },
  };
}

function main() {
  const evidence = buildForbidEvidence({
    freePath: arg("--free"),
    resourceReleasePath: arg("--resource-release"),
    descriptorPath: arg("--descriptor"),
  });
  const out = arg("--out");
  const canonical = `${JSON.stringify({ schemaVersion: 1, tokens: evidence.tokens }, null, 2)}\n`;
  if (out) writeFileSync(out, canonical);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("derive-forbid-evidence.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
