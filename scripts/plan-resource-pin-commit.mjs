#!/usr/bin/env node
/**
 * E2E-G1A: plan the bot commit for a resource pin (message + version bump).
 * Does not git-commit; callers decide whether writes are allowed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$/.exec(version);
  if (!match) throw new Error(`invalid version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ? `-${match[4]}` : ""}`;
}

export function buildPinCommitMessage(cliVersion, resourceVersion) {
  return `chore(release): cli v${cliVersion} for resources ${resourceVersion}`;
}

export function planPinCommit({ currentCliVersion, resourceVersion, skip = false }) {
  if (skip) {
    return {
      action: "skip",
      currentCliVersion,
      nextCliVersion: currentCliVersion,
      commitMessage: null,
      resourceVersion,
    };
  }
  const nextCliVersion = nextPatch(currentCliVersion);
  return {
    action: "bump",
    currentCliVersion,
    nextCliVersion,
    commitMessage: buildPinCommitMessage(nextCliVersion, resourceVersion),
    resourceVersion,
  };
}

export function applyPackageVersionBump(nextVersion, { dryRun = false } = {}) {
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  pkg.version = nextVersion;
  if (lock.version !== undefined) lock.version = nextVersion;
  if (lock.packages && lock.packages[""] && lock.packages[""].version !== undefined) {
    lock.packages[""].version = nextVersion;
  }
  if (!dryRun) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  return {
    written: ["package.json", "package-lock.json"],
    version: nextVersion,
    dryRun,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("plan-resource-pin-commit.mjs") ||
    process.argv[1].endsWith("plan-resource-pin-commit.js"));

if (isMain) {
  try {
    const applyVersion = arg("--apply-version");
    if (applyVersion) {
      const report = applyPackageVersionBump(applyVersion, { dryRun: process.argv.includes("--dry-run") });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(0);
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const plan = planPinCommit({
      currentCliVersion: pkg.version,
      resourceVersion: arg("--resource-version") || "0.0.0",
      skip: process.argv.includes("--skip"),
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
