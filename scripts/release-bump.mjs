#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePayloadHash } from "./payload-hash.mjs";

/**
 * E2E-G1A: compute the next CLI patch version and the normalized payload hash
 * for the current tree.
 *
 * Usage:
 *   node scripts/release-bump.mjs
 *
 * Reads package.json version + lockfile, bumps patch only (x/y are
 * human-owned), and prints { currentVersion, nextVersion, payloadHash }.
 *
 * A `main` push is only released when payloadHash differs from the last
 * published CLI release; README/docs/test-only pushes keep the same payload
 * hash and skip publishing (enforced by the workflow).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$/.exec(version);
  if (!match) throw new Error(`invalid version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ? `-${match[4]}` : ""}`;
}

/** Files shipped by the npm package (matches package.json "files"). */
function shippedFileSet(pkg) {
  const entries = {};
  const walk = (rel) => {
    const full = join(root, rel);
    if (!statSync(full, { throwIfNoEntry: false })) return;
    if (statSync(full).isDirectory()) {
      for (const child of readdirSync(full).sort((a, b) => a.localeCompare(b))) walk(`${rel}/${child}`);
    } else {
      entries[rel] = readFileSync(full);
    }
  };
  for (const rel of pkg.files ?? []) walk(rel);
  return entries;
}

function main() {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const files = shippedFileSet(pkg);
  const payloadHash = computePayloadHash({
    files,
    packageJson: pkg,
    lockfile: lock,
  });
  const result = {
    currentVersion: pkg.version,
    nextVersion: nextPatch(pkg.version),
    payloadHash,
    bump: "patch",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
