/**
 * W2-A/A3: the CLI's global bitmap-shard resource cache.
 *
 * The CLI caches bitmap shards under `<cacheDir>/bitmap-shards/<version>/...`
 * and records exactly what it holds in a manifest (`bitmap-shards/manifest.json`)
 * so a later install can compute what is missing without touching the network.
 * The default warm-up set is the SVG/free package plus every bitmap style
 * group's `128/webp` shard; larger sizes or the `png` format are downloaded
 * on demand (W2-B) when the project config asks for them.
 */

import { join } from "node:path";
import { cacheArtifact, type CacheIo } from "./cache.js";
import type { IconCatalog } from "../catalog/catalog.js";
import { isVariantAvailable } from "../generator/theme-resolve.js";
import { buildResourceVariantId } from "./resource-variant.js";
import {
  parseBitmapShard,
  sortBitmapShards,
  type BitmapShard,
  type BitmapShardFormat,
  type BitmapShardImageSize,
} from "./bitmap-shards.js";
import {
  fetchSelectedBitmapShards,
  type BitmapShardFetchProgress,
  type BitmapShardTuple,
  type FetchBitmapShardsDeps,
} from "./bitmap-shard-resolver.js";

export const BITMAP_SHARD_CACHE_SCHEMA_VERSION = 1;

/** W2-A1: the default, always-warmed resource set. */
export const DEFAULT_WARMUP_SIZE = 128;
export const DEFAULT_WARMUP_FORMAT: BitmapShardFormat = "webp";

export interface BitmapShardCacheManifest {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly shards: readonly BitmapShard[];
}

export function bitmapShardCacheManifestPath(cacheDir: string): string {
  return join(cacheDir, "bitmap-shards", "manifest.json");
}

function emptyManifest(): BitmapShardCacheManifest {
  return { schemaVersion: BITMAP_SHARD_CACHE_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), shards: [] };
}

/**
 * Tolerant read: a missing/corrupt manifest is treated as empty (the cache is
 * additive and every cached entry is re-verified before use), never a crash.
 */
export function readBitmapShardCacheManifest(cacheDir: string, io: CacheIo): BitmapShardCacheManifest {
  const path = bitmapShardCacheManifestPath(cacheDir);
  if (!io.existsSync(path) || !io.readFileSync) return emptyManifest();
  try {
    const raw = JSON.parse(Buffer.from(io.readFileSync(path)).toString("utf8")) as {
      schemaVersion?: unknown;
      updatedAt?: unknown;
      shards?: unknown;
    };
    if (raw.schemaVersion !== BITMAP_SHARD_CACHE_SCHEMA_VERSION || !Array.isArray(raw.shards)) return emptyManifest();
    const shards = raw.shards.map(parseBitmapShard);
    return {
      schemaVersion: BITMAP_SHARD_CACHE_SCHEMA_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      shards: sortBitmapShards(shards),
    };
  } catch {
    return emptyManifest();
  }
}

/** Atomic, idempotent manifest write (verified bytes are staged then renamed). */
export function writeBitmapShardCacheManifest(
  cacheDir: string,
  io: CacheIo,
  shards: readonly BitmapShard[],
  now: number = Date.now(),
): void {
  const body = `${JSON.stringify(
    { schemaVersion: BITMAP_SHARD_CACHE_SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), shards: sortBitmapShards(shards) },
    null,
    2,
  )}\n`;
  cacheArtifact(io, bitmapShardCacheManifestPath(cacheDir), Buffer.from(body, "utf8"));
}

function tupleKey(shard: Pick<BitmapShard, "resourceVersion" | "styleGroupId" | "imageSize" | "format">): string {
  return `${shard.resourceVersion}/${shard.styleGroupId}/${shard.imageSize.width}x${shard.imageSize.height}/${shard.format}`;
}

/** Merge new pins over an existing manifest, keeping one entry per tuple@version. */
export function mergeBitmapShardCacheManifest(
  manifest: BitmapShardCacheManifest,
  pins: readonly BitmapShard[],
): BitmapShard[] {
  const byKey = new Map<string, BitmapShard>();
  for (const shard of [...manifest.shards, ...pins]) byKey.set(tupleKey(shard), shard);
  return sortBitmapShards([...byKey.values()]);
}

/** W2-B2: tuples with no cached entry for the exact resource version. */
export function missingBitmapShardTuples(
  manifest: BitmapShardCacheManifest,
  expected: readonly BitmapShardTuple[],
  version: string,
): BitmapShardTuple[] {
  const have = new Set(
    manifest.shards
      .filter((shard) => shard.resourceVersion === version)
      .map((shard) => tupleKey({ ...shard, resourceVersion: version })),
  );
  return expected.filter((tuple) => {
    const key = `${version}/${tuple.styleGroupId}/${tuple.imageSize.width}x${tuple.imageSize.height}/${tuple.format}`;
    return !have.has(key);
  });
}

/**
 * W2-A1: every bitmap style group's `128/webp` shard, in canonical order.
 * Groups that do not ship the default variant are skipped (the config
 * validator reports that explicitly when a user asks for them).
 */
export function defaultWarmupTuples(catalog: IconCatalog): BitmapShardTuple[] {
  const imageSize: BitmapShardImageSize = { width: DEFAULT_WARMUP_SIZE, height: DEFAULT_WARMUP_SIZE };
  const tuples: BitmapShardTuple[] = [];
  for (const group of catalog.styleGroups) {
    if (group.type !== "bitmap") continue;
    const variantId = buildResourceVariantId(group.id, DEFAULT_WARMUP_FORMAT, DEFAULT_WARMUP_SIZE);
    if (!isVariantAvailable(group, variantId)) continue;
    tuples.push({ styleGroupId: group.id, imageSize, format: DEFAULT_WARMUP_FORMAT });
  }
  tuples.sort((a, b) => (a.styleGroupId < b.styleGroupId ? -1 : a.styleGroupId > b.styleGroupId ? 1 : 0));
  return tuples;
}

export interface WarmupPlan {
  readonly tuples: readonly BitmapShardTuple[];
  readonly missing: readonly BitmapShardTuple[];
  readonly reused: number;
}

export interface WarmDefaultBitmapShardsDeps extends Omit<FetchBitmapShardsDeps, "existingPins"> {
  readonly catalog: IconCatalog;
  readonly cacheDir: string;
  readonly io: CacheIo;
  readonly now?: number;
  /** Emitted once before any network request so the UI can print the plan. */
  readonly onPlan?: (plan: WarmupPlan) => void;
  /** W2-B6: per-tuple/byte progress forwarded from the shard fetch. */
  readonly onProgress?: (event: BitmapShardFetchProgress) => void;
}

export interface WarmDefaultBitmapShardsResult {
  readonly tuples: readonly BitmapShardTuple[];
  readonly pins: readonly BitmapShard[];
  readonly downloaded: number;
  readonly reused: number;
}

/**
 * W2-A2/B7: warm the default set into the cache. Already-cached shards are
 * re-verified and reused without a network call; only missing tuples are
 * fetched. The manifest is updated atomically after a fully verified fetch.
 */
export async function warmDefaultBitmapShards(
  deps: WarmDefaultBitmapShardsDeps,
): Promise<WarmDefaultBitmapShardsResult> {
  const tuples = defaultWarmupTuples(deps.catalog);
  const manifest = readBitmapShardCacheManifest(deps.cacheDir, deps.io);
  const missing = missingBitmapShardTuples(manifest, tuples, deps.version);
  deps.onPlan?.({ tuples, missing, reused: tuples.length - missing.length });
  if (tuples.length === 0) return { tuples, pins: [], downloaded: 0, reused: 0 };

  const existingPins = manifest.shards.filter((shard) => shard.resourceVersion === deps.version);
  const fetched = await fetchSelectedBitmapShards(tuples, { ...deps, existingPins });
  writeBitmapShardCacheManifest(deps.cacheDir, deps.io, mergeBitmapShardCacheManifest(manifest, fetched.pins), deps.now ?? Date.now());
  return {
    tuples,
    pins: fetched.pins,
    downloaded: fetched.shards.length,
    reused: fetched.pins.length - fetched.shards.length,
  };
}
