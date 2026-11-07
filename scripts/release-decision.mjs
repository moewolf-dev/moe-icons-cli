#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Decide what the CLI publish workflow must do for the current candidate.
 *
 * Recovery rule (audit AUDIT-2026-11-06 CLI recovery): once a publish intent
 * exists for this exact pin, the version is PINNED to the intent. Registry
 * visibility never changes that decision — a lagging read path (ETARGET/E404)
 * must not push the workflow back into the ordinary "bump a new patch" branch.
 * Only a confirmed absence of an intent may fall through to the payload check.
 *
 * The shell performs the network calls (with their own bounded retries) and
 * passes the observed status in; this function is pure and unit testable.
 */

function fail(message) {
  throw new Error(message);
}

export function decideRelease({
  intentStatus,
  intent,
  registry,
  candidateSha256,
  nextVersion,
  payloadHash,
  lastPublishedPayloadHash,
}) {
  if (intentStatus === "failed") {
    fail("publish intent lookup failed; refusing to allocate a new version without knowing whether a recovery is pending");
  }
  if (intentStatus === "found") {
    if (!intent || typeof intent !== "object") fail("publish intent artifact is unreadable");
    if (typeof intent.version !== "string" || !/^\d+\.\d+\.\d+$/.test(intent.version)) {
      fail(`publish intent version is invalid: ${intent.version}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(candidateSha256 || ""))) fail("candidate sha256 is required");
    if (intent.candidateSha256 !== candidateSha256) {
      fail(`publish intent belongs to another candidate (${intent.candidateSha256} != ${candidateSha256})`);
    }
    // Registry readability is recorded but never changes the decision.
    return {
      shouldRelease: true,
      nextVersion: intent.version,
      resume: true,
      reuseReason: "resumed-intent",
      registry: registry === "visible" || registry === "missing" ? registry : "unknown",
    };
  }
  if (intentStatus !== "missing") fail(`unknown publish intent status: ${intentStatus}`);
  if (typeof payloadHash === "string" && payloadHash === lastPublishedPayloadHash) {
    return { shouldRelease: false, resume: false, reuseReason: "unchanged-payload" };
  }
  if (typeof nextVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
    fail(`next version is invalid: ${nextVersion}`);
  }
  return { shouldRelease: true, nextVersion, resume: false, reuseReason: "new-payload" };
}

const FLAGS = new Set(["intent-status", "intent", "registry", "candidate", "next", "payload", "last-payload"]);

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name.startsWith("--")) fail(`invalid argument ${name}`);
    const key = name.slice(2);
    if (!FLAGS.has(key)) fail(`unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) fail(`--${key} requires a value`);
    args.set(key, value);
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const intentFile = args.get("intent");
  const intent = intentFile ? JSON.parse(readFileSync(intentFile, "utf8")) : undefined;
  const result = decideRelease({
    intentStatus: args.get("intent-status"),
    intent,
    registry: args.get("registry"),
    candidateSha256: args.get("candidate"),
    nextVersion: args.get("next"),
    payloadHash: args.get("payload"),
    lastPublishedPayloadHash: args.get("last-payload"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-decision: ${error.message}\n`);
    process.exitCode = 1;
  }
}
