/**
 * BITMAP-SHARD-V1 (DEC-97..DEC-108): CLI-side identities for the frozen bitmap
 * shard contract. Filename/key/canonical-JSON rules must match
 * `docs/contracts/bitmap-shard-v1.md` and the code-library producer exactly.
 */

import { createHash } from "node:crypto";

export const BITMAP_SHARD_SCHEMA_VERSION = 1;

const SHA256_RE = /^[a-f0-9]{64}$/;
const GROUP_RE = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta))?$/;
const BITMAP_SIZES = new Set([64, 128, 256, 512]);

export type BitmapShardTier = "free" | "pro";
export type BitmapShardFormat = "png" | "webp";

export interface BitmapShardImageSize {
  readonly width: number;
  readonly height: number;
}

export interface BitmapShard {
  readonly schemaVersion: number;
  readonly resourceVersion: string;
  readonly tier: BitmapShardTier;
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
  readonly filename: string;
  readonly objectKey: string;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly sha256: string;
  readonly fileCount: number;
  readonly manifestSha256: string;
}

export interface BitmapShardTuple {
  readonly tier: BitmapShardTier;
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
}

const IDENTITY_FIELDS = [
  "tier",
  "styleGroupId",
  "imageSize",
  "format",
  "filename",
  "objectKey",
  "compressedSize",
  "expandedSize",
  "sha256",
  "fileCount",
  "manifestSha256",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Canonical JSON per bitmap-shard-v1.md section 4. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) fail("canonicalJson: non-finite number");
    return value;
  }
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail(`canonicalJson: undefined value at ${key}`);
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return fail(`canonicalJson: unsupported type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeTuple(input: {
  tier: unknown;
  styleGroupId: unknown;
  imageSize: unknown;
  format: unknown;
}): { tier: BitmapShardTier; styleGroupId: string; width: number; height: number; format: BitmapShardFormat } {
  const tier = input.tier;
  const styleGroupId = input.styleGroupId;
  const format = input.format;
  const size = input.imageSize as BitmapShardImageSize | undefined;
  if (tier !== "free" && tier !== "pro") fail(`invalid shard tier: ${String(tier)}`);
  if (typeof styleGroupId !== "string" || !GROUP_RE.test(styleGroupId)) fail(`invalid styleGroupId: ${String(styleGroupId)}`);
  if (format !== "png" && format !== "webp") fail(`invalid bitmap format: ${String(format)}`);
  if (
    !size
    || !Number.isInteger(size.width)
    || !Number.isInteger(size.height)
    || size.width !== size.height
    || !BITMAP_SIZES.has(size.width)
  ) {
    fail(`invalid bitmap imageSize for ${String(styleGroupId)}`);
  }
  return { tier, styleGroupId, width: size.width, height: size.height, format };
}

function assertResourceVersion(resourceVersion: string): void {
  if (!RESOURCE_VERSION_RE.test(resourceVersion)) fail(`invalid resourceVersion: ${String(resourceVersion)}`);
}

export function buildBitmapShardFilename(input: {
  tier: BitmapShardTier;
  styleGroupId: string;
  imageSize: BitmapShardImageSize;
  format: BitmapShardFormat;
  resourceVersion: string;
}): string {
  const tuple = normalizeTuple(input);
  assertResourceVersion(input.resourceVersion);
  return `moe-icons-bitmap-${tuple.tier}-${tuple.styleGroupId}-${tuple.width}x${tuple.height}-${tuple.format}-${input.resourceVersion}.tgz`;
}

export function parseBitmapShardFilename(
  filename: string,
): (BitmapShardTuple & { readonly resourceVersion: string }) | undefined {
  const match = /^moe-icons-bitmap-(free|pro)-(.+)-(\d{1,4})x(\d{1,4})-(png|webp)-(\d+\.\d+\.\d+(?:-(?:alpha|beta))?)\.tgz$/.exec(filename);
  if (!match) return undefined;
  const [, tier, styleGroupId, width, height, format, resourceVersion] = match;
  if (!GROUP_RE.test(styleGroupId ?? "") || !RESOURCE_VERSION_RE.test(resourceVersion ?? "")) return undefined;
  const widthNumber = Number(width);
  const heightNumber = Number(height);
  if (widthNumber !== heightNumber || !BITMAP_SIZES.has(widthNumber)) return undefined;
  const rebuilt = buildBitmapShardFilename({
    tier: tier as BitmapShardTier,
    styleGroupId: styleGroupId as string,
    imageSize: { width: widthNumber, height: heightNumber },
    format: format as BitmapShardFormat,
    resourceVersion: resourceVersion as string,
  });
  if (rebuilt !== filename) return undefined;
  return {
    tier: tier as BitmapShardTier,
    styleGroupId: styleGroupId as string,
    imageSize: { width: widthNumber, height: heightNumber },
    format: format as BitmapShardFormat,
    resourceVersion: resourceVersion as string,
  };
}

export function buildBitmapShardObjectKey(input: {
  tier: BitmapShardTier;
  styleGroupId: string;
  imageSize: BitmapShardImageSize;
  format: BitmapShardFormat;
  resourceVersion: string;
  filename?: string;
}): string {
  const tuple = normalizeTuple(input);
  assertResourceVersion(input.resourceVersion);
  const canonical = buildBitmapShardFilename({
    tier: tuple.tier,
    styleGroupId: tuple.styleGroupId,
    imageSize: { width: tuple.width, height: tuple.height },
    format: tuple.format,
    resourceVersion: input.resourceVersion,
  });
  const name = input.filename ?? canonical;
  if (name !== canonical) fail("shard filename does not match its tuple");
  return `moeicons/v1/releases/${input.resourceVersion}/${tuple.tier}/bitmap-shards/${tuple.styleGroupId}/${tuple.width}x${tuple.height}/${tuple.format}/${name}`;
}

function compareShards(a: BitmapShard, b: BitmapShard): number {
  if (a.styleGroupId !== b.styleGroupId) return a.styleGroupId < b.styleGroupId ? -1 : 1;
  if (a.imageSize.width !== b.imageSize.width) return a.imageSize.width - b.imageSize.width;
  if (a.imageSize.height !== b.imageSize.height) return a.imageSize.height - b.imageSize.height;
  if (a.format !== b.format) return a.format < b.format ? -1 : 1;
  return 0;
}

export function sortBitmapShards(shards: readonly BitmapShard[]): BitmapShard[] {
  return [...shards].sort(compareShards);
}

export function bitmapShardIdentity(shard: BitmapShard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) out[field] = shard[field];
  return canonicalize(out) as Record<string, unknown>;
}

export function bitmapShardSetSha256(shards: readonly BitmapShard[]): string {
  return sha256Hex(canonicalJson(sortBitmapShards(shards).map(bitmapShardIdentity)));
}

export function computeBitmapShardSetSha256(shards: readonly BitmapShard[]): string {
  return bitmapShardSetSha256(shards);
}

/** Fail-closed parse of one descriptor shard entry. */
export function parseBitmapShard(raw: unknown): BitmapShard {
  if (!isRecord(raw)) fail("bitmapShard must be an object");
  const allowed = ["schemaVersion", "resourceVersion", ...IDENTITY_FIELDS] as readonly string[];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`bitmapShard has unknown field(s): ${extra.join(", ")}`);
  if (raw.schemaVersion !== BITMAP_SHARD_SCHEMA_VERSION) fail("bitmapShard schemaVersion must be 1");
  const resourceVersion = raw.resourceVersion;
  if (typeof resourceVersion !== "string") fail("bitmapShard resourceVersion required");
  assertResourceVersion(resourceVersion);
  const tuple = normalizeTuple({
    tier: raw.tier,
    styleGroupId: raw.styleGroupId,
    imageSize: raw.imageSize,
    format: raw.format,
  });
  const expectedFilename = buildBitmapShardFilename({
    tier: tuple.tier,
    styleGroupId: tuple.styleGroupId,
    imageSize: { width: tuple.width, height: tuple.height },
    format: tuple.format,
    resourceVersion,
  });
  if (raw.filename !== expectedFilename) fail(`bitmapShard filename is not canonical: ${String(raw.filename)}`);
  const expectedKey = buildBitmapShardObjectKey({
    tier: tuple.tier,
    styleGroupId: tuple.styleGroupId,
    imageSize: { width: tuple.width, height: tuple.height },
    format: tuple.format,
    resourceVersion,
    filename: raw.filename,
  });
  if (raw.objectKey !== expectedKey) fail(`bitmapShard objectKey is not canonical: ${String(raw.objectKey)}`);
  if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) fail("bitmapShard sha256 must be 64 lowercase hex");
  if (typeof raw.manifestSha256 !== "string" || !SHA256_RE.test(raw.manifestSha256)) {
    fail("bitmapShard manifestSha256 must be 64 lowercase hex");
  }
  for (const field of ["compressedSize", "expandedSize", "fileCount"] as const) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      fail(`bitmapShard ${field} must be a positive integer`);
    }
  }
  return raw as unknown as BitmapShard;
}

export interface BitmapShardSetValidation {
  readonly shards: readonly BitmapShard[];
  readonly bitmapShardSetSha256: string;
}

/** Validate uniqueness + canonical order; verify the complete-set digest. */
export function validateBitmapShardSet(
  shards: readonly BitmapShard[],
  options: { readonly resourceVersion?: string; readonly styleGroupIds?: Iterable<string> } = {},
): BitmapShardSetValidation {
  const seen = new Set<string>();
  for (const shard of shards) {
    if (options.resourceVersion !== undefined && shard.resourceVersion !== options.resourceVersion) {
      fail("bitmapShard resourceVersion mismatch");
    }
    const key = `${shard.tier}/${shard.styleGroupId}/${shard.imageSize.width}x${shard.imageSize.height}/${shard.format}`;
    if (seen.has(key)) fail(`duplicate bitmap shard tuple: ${key}`);
    seen.add(key);
  }
  const sorted = sortBitmapShards(shards);
  for (let index = 0; index < shards.length; index += 1) {
    const a = shards[index] as BitmapShard;
    const b = sorted[index] as BitmapShard;
    if (
      a.styleGroupId !== b.styleGroupId
      || a.imageSize.width !== b.imageSize.width
      || a.imageSize.height !== b.imageSize.height
      || a.format !== b.format
    ) {
      fail(`bitmapShards is not in canonical order at index ${index}`);
    }
  }
  if (options.styleGroupIds) {
    const declared = new Set(options.styleGroupIds);
    for (const shard of shards) {
      if (!declared.has(shard.styleGroupId)) fail(`bitmap shard for unknown style group: ${shard.styleGroupId}`);
    }
  }
  return { shards: sorted, bitmapShardSetSha256: bitmapShardSetSha256(shards) };
}

/** Verify a descriptor's declared set digest against the actual shard list. */
export function assertBitmapShardSetSha256(shards: readonly BitmapShard[], expected: string): string {
  if (!SHA256_RE.test(expected)) fail("bitmapShardSetSha256 must be 64 lowercase hex");
  const actual = bitmapShardSetSha256(shards);
  if (actual !== expected) fail(`bitmapShardSetSha256 mismatch: expected ${expected}, got ${actual}`);
  return actual;
}
