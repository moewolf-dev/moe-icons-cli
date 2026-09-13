#!/usr/bin/env node
/**
 * FIX-26-D: scan a packed CLI tarball for forbidden Pro group names, variant
 * ids and digests. Reads the decompressed tar bytes so tokens are caught in file
 * paths, JSON metadata and other text entries.
 *
 * Forbid tokens are derived from the frozen Pro manifest/descriptor (Pro-only
 * groups + their variant ids) so operators cannot pass a short hand list; a
 * `--forbid` list is only additive.
 *
 * Usage:
 *   node scripts/scan-bundle.mjs --tgz <cli.tgz> --forbid-manifest <manifest.json>
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_FREE_GROUPS = ["moe-colored", "moe-lite-outline", "moe-outline", "moe-solid"];

export function deriveForbiddenTokens({ manifest, descriptor, freeGroups = DEFAULT_FREE_GROUPS, resourceRelease }) {
  const tokens = new Set();
  const isFree = (id) => freeGroups.includes(id);
  const groups = manifest && Array.isArray(manifest.styleGroups) ? manifest.styleGroups : [];
  for (const group of groups) {
    if (!group || isFree(group.id)) continue;
    tokens.add(group.id);
    for (const variant of group.variants || []) {
      if (variant && variant.id) tokens.add(variant.id);
      for (const file of variant.files || []) {
        if (file && file.sha256) tokens.add(file.sha256);
      }
    }
  }
  if (descriptor && descriptor.pro) {
    for (const name of descriptor.pro.styleGroups || []) {
      if (!isFree(name)) tokens.add(name);
    }
    if (descriptor.pro.sha256) tokens.add(descriptor.pro.sha256);
    if (descriptor.pro.assets && descriptor.pro.assets.sha256) tokens.add(descriptor.pro.assets.sha256);
  }
  // AUD-BLOCK-46: the CLI's own pinned resource release carries the Pro bitmap
  // batch that was actually published, so the leak gate can derive real tokens
  // even without cross-repo manifest access.
  const binding = resourceRelease && resourceRelease.binding;
  if (binding && binding.bitmapBatch) {
    for (const id of binding.bitmapBatch.styleGroupIds || []) tokens.add(id);
    for (const id of binding.bitmapBatch.variantIds || []) tokens.add(id);
  }
  return [...tokens];
}

export function scanBundleForForbidden(bytes, forbiddenTokens, forbidPrefixes = []) {
  if (!bytes || bytes.length === 0) throw new Error("bundle bytes are empty");
  if (forbiddenTokens.length === 0 && forbidPrefixes.length === 0) throw new Error("at least one forbidden token/prefix is required");
  const tar = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const text = tar.toString("latin1");
  const hits = new Set(forbiddenTokens.filter((token) => token && text.includes(token)));
  for (const prefix of forbidPrefixes) {
    if (prefix && text.includes(prefix)) hits.add(prefix);
  }
  return { ok: hits.size === 0, hits: [...hits], scannedTokens: forbiddenTokens.length + forbidPrefixes.length };
}

export function bundleSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const tgz = arg("--tgz");
  if (!tgz) throw new Error("usage: scan-bundle.mjs --tgz <cli.tgz> --forbid-manifest <manifest.json> | --forbid-file <evidence.json>");
  if (!existsSync(tgz)) throw new Error(`bundle not found: ${tgz}`);
  const manifestPath = arg("--forbid-manifest");
  const descriptorPath = arg("--forbid-descriptor");
  const resourceReleasePath = arg("--resource-release");
  const forbidFile = arg("--forbid-file");
  for (const [label, value] of [["--forbid-manifest", manifestPath], ["--forbid-descriptor", descriptorPath], ["--resource-release", resourceReleasePath], ["--forbid-file", forbidFile]]) {
    if (value && !existsSync(value)) throw new Error(`${label} declared but missing: ${value}`);
  }
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const descriptor = descriptorPath ? JSON.parse(readFileSync(descriptorPath, "utf8")) : undefined;
  const resourceRelease = resourceReleasePath ? JSON.parse(readFileSync(resourceReleasePath, "utf8")) : undefined;
  const explicit = String(arg("--forbid") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const prefixes = String(arg("--forbid-prefix") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const fromFile = forbidFile
    ? (() => {
        const parsed = JSON.parse(readFileSync(forbidFile, "utf8"));
        const list = Array.isArray(parsed) ? parsed : parsed.tokens;
        if (!Array.isArray(list)) throw new Error("--forbid-file must contain an array or { tokens: [] }");
        return list;
      })()
    : [];
  const tokens = [...new Set([...deriveForbiddenTokens({ manifest, descriptor, resourceRelease }), ...explicit, ...fromFile.map(String)])];
  if (tokens.length === 0 && prefixes.length === 0) throw new Error("no forbidden tokens could be derived; provide --forbid-manifest/--forbid-file or --forbid-prefix");
  const bytes = readFileSync(tgz);
  const result = scanBundleForForbidden(bytes, tokens, prefixes);
  process.stdout.write(`${JSON.stringify({ ...result, tgzSha256: bundleSha256(bytes) })}\n`);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("scan-bundle.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
