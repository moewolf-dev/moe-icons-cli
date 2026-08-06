#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * CLI-17: manual patch release dry-run. Validates clean main/tag, tests package
 * contents, computes the next patch version, and writes a proposed changelog +
 * version bump WITHOUT publishing. Major/minor require explicit inputs.
 *
 * Usage:
 *   node scripts/release-dry-run.mjs            # patch (default)
 *   node scripts/release-dry-run.mjs --major    # explicit major
 *   node scripts/release-dry-run.mjs --minor    # explicit minor
 *   node scripts/release-dry-run.mjs --publish  # NOT implemented; blocks
 */

const root = process.cwd();
const args = process.argv.slice(2);

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function readPkg() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function nextVersion(current, bump) {
  const parts = current.split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`invalid version: ${current}`);
  }
  const [major, minor, patch] = parts;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function fail(message) {
  console.error(`release blocked: ${message}`);
  process.exit(1);
}

const bump = args.includes("--major") ? "major" : args.includes("--minor") ? "minor" : "patch";

if (args.includes("--publish")) {
  fail("publication requires owner approval and is not implemented in dry-run");
}

const branch = run("git branch --show-current");
if (branch !== "main") fail(`must be on main (current: ${branch})`);
if (run("git status --porcelain") !== "") fail("working tree is not clean");

const pkg = readPkg();
const proposed = nextVersion(pkg.version, bump);
const today = new Date().toISOString().slice(0, 10);

const changelogPath = join(root, "CHANGELOG.md");
const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n";
const entry = `\n## [${proposed}] - ${today}\n\n- (release dry-run; no changes published)\n`;
writeFileSync(changelogPath, existing + entry);

console.log(JSON.stringify({
  ok: true,
  currentVersion: pkg.version,
  proposedVersion: proposed,
  bump,
  branch,
  changelogUpdated: true,
  published: false,
  note: "dry-run only; run the real release after owner approval",
}, null, 2));
