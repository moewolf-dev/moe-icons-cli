#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Manual release dry-run. Automated agents may only propose a patch (z)
 * increment. Major (x) and minor (y) must be edited by hand in package.json —
 * this script refuses --major/--minor so they cannot be bumped accidentally.
 *
 * Usage:
 *   node scripts/release-dry-run.mjs            # patch only
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

/** Only patch (z) may be auto-incremented. x/y require a human edit. */
function nextPatchVersion(current) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$/.exec(current);
  if (!match) throw new Error(`invalid version: ${current}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const channel = match[4] ? `-${match[4]}` : "";
  return `${major}.${minor}.${patch + 1}${channel}`;
}

function fail(message) {
  console.error(`release blocked: ${message}`);
  process.exit(1);
}

if (args.includes("--publish")) {
  fail("publication requires owner approval and is not implemented in dry-run");
}
if (args.includes("--major") || args.includes("--minor")) {
  fail(
    "major/minor (x/y) must be set manually in package.json; automation may only increment patch (z)",
  );
}

const branch = run("git branch --show-current");
if (branch !== "main") fail(`must be on main (current: ${branch})`);
if (run("git status --porcelain") !== "") fail("working tree is not clean");

const pkg = readPkg();
const proposed = nextPatchVersion(pkg.version);
const today = new Date().toISOString().slice(0, 10);

const changelogPath = join(root, "CHANGELOG.md");
const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n";
const entry = `\n## [${proposed}] - ${today}\n\n- (release dry-run; no changes published)\n`;
writeFileSync(changelogPath, existing + entry);

console.log(JSON.stringify({
  ok: true,
  currentVersion: pkg.version,
  proposedVersion: proposed,
  bump: "patch",
  branch,
  changelogUpdated: true,
  published: false,
  note: "dry-run only; x/y are human-owned, automation may only bump z",
}, null, 2));
