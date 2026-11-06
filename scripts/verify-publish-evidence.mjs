#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Verify that the staged recovery evidence describes the SAME publication the
 * canonical receipt is about to describe.
 *
 * Recovery stages (see .github/workflows/publish.yml):
 *   1. publish-intent            persisted before the external write
 *   2. publish-command-succeeded persisted right after the publish command
 *   3. registry-accepted         the same version was read back from npm
 *
 * A recovery may only continue the exact version recorded by the original
 * intent; it must never bind a different candidate, a different pin or a
 * different version. This script has no network access on purpose: the caller
 * provides the observed values.
 *
 * Usage:
 *   node scripts/verify-publish-evidence.mjs \
 *     --intent intent.json --accepted accepted.json \
 *     --tag v1.2.3 --candidate <sha256> --pin <sha> [--require-accepted]
 */

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name.startsWith("--")) throw new Error(`invalid argument ${name}`);
    if (name === "--require-accepted") {
      args.set("require-accepted", "1");
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    args.set(name.slice(2), value);
    i += 1;
  }
  return args;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error.message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

export function verifyPublishEvidence({ intent, accepted, tag, candidate, pin, requireAccepted = false }) {
  if (!intent || typeof intent !== "object") throw new Error("publish intent is required");
  if (!accepted || typeof accepted !== "object") throw new Error("accepted evidence is required");
  if (intent.stage !== "publish-intent") throw new Error(`intent stage must be publish-intent, got ${intent.stage}`);
  if (intent.tag !== tag) throw new Error(`intent tag must match the release tag: expected ${tag}, got ${intent.tag}`);
  if (intent.pinCommit !== pin) throw new Error(`intent pinCommit must match the original publication: expected ${pin}, got ${intent.pinCommit}`);
  if (intent.candidateSha256 !== candidate) throw new Error(`intent candidateSha256 must match the candidate: expected ${candidate}, got ${intent.candidateSha256}`);
  assertEqual(accepted.version, intent.version, "accepted version must equal the intent version");
  assertEqual(accepted.tag, intent.tag, "accepted tag must equal the intent tag");
  if (accepted.stage !== "publish-command-succeeded" && accepted.stage !== "registry-accepted") {
    throw new Error(`accepted stage must be a known recovery stage, got ${accepted.stage}`);
  }
  if (requireAccepted) {
    if (accepted.stage !== "registry-accepted") throw new Error("the version must be read back before a canonical receipt is written");
    if (!/^sha512-/.test(String(accepted.npmIntegrity || ""))) throw new Error("registry-accepted evidence must carry the npm integrity");
  }
  return { version: intent.version, tag: intent.tag, pinCommit: intent.pinCommit, stage: accepted.stage };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const required of ["intent", "accepted", "tag", "candidate", "pin"]) {
      if (!args.has(required)) throw new Error(`--${required} is required`);
    }
    const result = verifyPublishEvidence({
      intent: readJson(args.get("intent"), "publish intent"),
      accepted: readJson(args.get("accepted"), "accepted evidence"),
      tag: args.get("tag"),
      candidate: args.get("candidate"),
      pin: args.get("pin"),
      requireAccepted: args.has("require-accepted"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`verify-publish-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
