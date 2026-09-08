#!/usr/bin/env node
/**
 * E2E-G1A: validate a moe-icons-code-library-release client_payload for CLI pin.
 */
import { readFileSync } from "node:fs";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const COMMIT = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const DIGITS = /^[0-9]+$/;

export function validateCodeLibraryReleaseEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("event payload must be an object");
  }
  const resourceVersion = String(raw.resourceVersion || "");
  if (!SEMVER.test(resourceVersion)) throw new Error("invalid resourceVersion");
  const sourceCommit = String(raw.sourceCommit || "").toLowerCase();
  const generatorCommit = String(raw.generatorCommit || "").toLowerCase();
  if (!COMMIT.test(sourceCommit)) throw new Error("invalid sourceCommit");
  if (!COMMIT.test(generatorCommit)) throw new Error("invalid generatorCommit");

  const privateDescriptorSha256 = String(
    raw.privateDescriptorSha256 || raw.descriptorSha256 || "",
  ).toLowerCase();
  const publicDescriptorSha256 = String(raw.publicDescriptorSha256 || "").toLowerCase();
  if (!SHA256.test(privateDescriptorSha256)) throw new Error("invalid privateDescriptorSha256");
  if (!SHA256.test(publicDescriptorSha256)) throw new Error("invalid publicDescriptorSha256");

  const freeCandidateArtifactId = String(
    raw.freeCandidateArtifactId || raw.artifactId || "",
  );
  if (!DIGITS.test(freeCandidateArtifactId)) throw new Error("invalid freeCandidateArtifactId");

  const upstreamRunId = String(raw.upstreamRunId || "");
  if (!DIGITS.test(upstreamRunId)) throw new Error("invalid upstreamRunId");

  const correlationId = raw.correlationId ? String(raw.correlationId) : null;
  if (correlationId && !/^[0-9]+-[0-9]+-[a-z0-9-]+$/i.test(correlationId)) {
    throw new Error("invalid correlationId");
  }

  return {
    schemaVersion: 1,
    resourceVersion,
    sourceCommit,
    generatorCommit,
    privateDescriptorSha256,
    publicDescriptorSha256,
    freeCandidateArtifactId,
    upstreamRunId,
    correlationId,
  };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("validate-code-library-event.mjs") ||
    process.argv[1].endsWith("validate-code-library-event.js"));

if (isMain) {
  try {
    const pathArg = process.argv[2];
    if (!pathArg) throw new Error("usage: validate-code-library-event.mjs <payload.json>");
    const event = validateCodeLibraryReleaseEvent(JSON.parse(readFileSync(pathArg, "utf8")));
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
