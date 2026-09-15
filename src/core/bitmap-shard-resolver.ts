/**
 * DEV-G07 (DEC-100/101/107): normalize configured bitmap references to canonical
 * tuples, fetch exactly those shards (one descriptor each, bearer only to the
 * API), and map verified shard bytes back to the existing local `assets/`
 * layout so generated code/imports never change.
 */

import type { MoeiconsConfigFile } from "../project/config.js";
import type { IconCatalog } from "../catalog/catalog.js";
import { catalog as defaultCatalog } from "../catalog/catalog.js";
import { findCatalogStyleGroup } from "../catalog/catalog.js";
import { isVariantAvailable } from "../generator/theme-resolve.js";
import {
  buildResourceVariantId,
  DEFAULT_BITMAP_FORMAT,
  DEFAULT_BITMAP_SIZE,
  resolveResourceVariant,
} from "./resource-variant.js";
import {
  bitmapShardSetSha256,
  buildBitmapShardFilename,
  buildBitmapShardObjectKey,
  type BitmapShard,
  type BitmapShardFormat,
  type BitmapShardImageSize,
} from "./bitmap-shards.js";
import {
  bitmapShardPinFromVerified,
  bitmapShardVerificationTargetFromPin,
  downloadAndCacheBitmapShard,
  fetchBitmapShardDescriptor,
  loadCachedBitmapShard,
  resolveBitmapShardDescriptorEndpoint,
  type BitmapShardDescriptor,
  type BitmapShardVerificationTarget,
  type VerifiedBitmapShard,
} from "./bitmap-shard-download.js";
import type { CacheIo } from "./cache.js";
import { BITMAP_SHARD_BUDGET } from "./bitmap-shard-budget.js";
import { CliError } from "../errors/index.js";

export interface BitmapShardTuple {
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
}

function tupleKey(tuple: BitmapShardTuple): string {
  return `${tuple.styleGroupId}/${tuple.imageSize.width}x${tuple.imageSize.height}/${tuple.format}`;
}

function compareTuples(a: BitmapShardTuple, b: BitmapShardTuple): number {
  if (a.styleGroupId !== b.styleGroupId) return a.styleGroupId < b.styleGroupId ? -1 : 1;
  if (a.imageSize.width !== b.imageSize.width) return a.imageSize.width - b.imageSize.width;
  if (a.imageSize.height !== b.imageSize.height) return a.imageSize.height - b.imageSize.height;
  if (a.format !== b.format) return a.format < b.format ? -1 : 1;
  return 0;
}

/**
 * Resolve every bitmap variant the config actually references into unique,
 * canonically sorted tuples. Same tuple used by many icons/themes appears once.
 */
export function resolveBitmapTuples(
  config: MoeiconsConfigFile,
  sourceCatalog: IconCatalog = defaultCatalog,
): { readonly ok: true; readonly tuples: readonly BitmapShardTuple[] } | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const tuples: BitmapShardTuple[] = [];
  for (const [theme, entry] of Object.entries(config.themes)) {
    const group = findCatalogStyleGroup(entry.styleGroup, sourceCatalog);
    // Non-bitmap and unknown groups are out of scope here; install/generate
    // validate theme/catalog consistency separately.
    if (!group || group.type !== "bitmap") continue;
    try {
      let variant;
      if (entry.format === undefined && entry.imageSize === undefined) {
        const defaultId = buildResourceVariantId(group.id, DEFAULT_BITMAP_FORMAT, DEFAULT_BITMAP_SIZE);
        if (!isVariantAvailable(group, defaultId)) {
          errors.push(
            `bitmap group "${group.id}" does not include the default ${DEFAULT_BITMAP_FORMAT}/${String(DEFAULT_BITMAP_SIZE)} variant; set format and imageSize explicitly`,
          );
          continue;
        }
        variant = resolveResourceVariant(group.id);
      } else {
        variant = resolveResourceVariant(group.id, {
          ...(entry.format !== undefined ? { format: entry.format } : {}),
          ...(entry.imageSize !== undefined ? { imageSize: entry.imageSize } : {}),
        });
      }
      if (!isVariantAvailable(group, variant.resourceVariantId)) {
        errors.push(`variant ${variant.resourceVariantId} is unavailable for ${group.id}`);
        continue;
      }
      const tuple: BitmapShardTuple = {
        styleGroupId: variant.styleGroupId,
        imageSize: { width: variant.imageSize, height: variant.imageSize },
        format: variant.format,
      };
      const key = tupleKey(tuple);
      if (seen.has(key)) continue;
      seen.add(key);
      tuples.push(tuple);
    } catch (error) {
      errors.push(`theme "${theme}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  tuples.sort(compareTuples);
  return { ok: true, tuples };
}

export interface BitmapShardRequest extends BitmapShardTuple {
  readonly filename: string;
  readonly objectKey: string;
}

/** Pure canonical request plan (one immutable key per selected tuple). */
export function planBitmapShardRequests(
  tuples: readonly BitmapShardTuple[],
  version: string,
): BitmapShardRequest[] {
  const seen = new Set<string>();
  const requests: BitmapShardRequest[] = [];
  for (const tuple of tuples) {
    const key = tupleKey(tuple);
    if (seen.has(key)) throw new Error(`duplicate bitmap tuple in plan: ${key}`);
    seen.add(key);
    const filename = buildBitmapShardFilename({ ...tuple, tier: "pro", resourceVersion: version });
    requests.push({
      ...tuple,
      filename,
      objectKey: buildBitmapShardObjectKey({ ...tuple, tier: "pro", resourceVersion: version, filename }),
    });
  }
  requests.sort(compareTuples);
  return requests;
}

export interface FetchBitmapShardsDeps {
  readonly version: string;
  readonly descriptorSha256: string;
  readonly accessToken: string;
  readonly cacheDir: string;
  readonly io: CacheIo;
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly now?: number;
  readonly allowLoopback?: boolean;
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
  readonly statfs?: (dir: string) => { readonly availableBytes: number } | undefined;
  /**
   * DEV-G10: already-pinned shards. A tuple whose pinned shard still verifies in
   * the cache is reused without any API/R2 request, so switching size only
   * fetches the newly selected tuple.
   */
  readonly existingPins?: readonly BitmapShard[];
}

export interface ResolvedBitmapShards {
  readonly requests: readonly BitmapShardRequest[];
  readonly shards: readonly VerifiedBitmapShard[];
  /** Canonical pin identities recorded in install metadata. */
  readonly pins: readonly BitmapShard[];
  /** Local-layout files: `assets/<resourceVariantId>/<iconId>.<format>` -> bytes. */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

/** Map verified shard bytes to the canonical local `assets/` layout. */
export function shardAssetsToLocalLayout(shard: VerifiedBitmapShard): Record<string, Uint8Array> {
  const variantId = buildResourceVariantId(shard.descriptor.styleGroupId, shard.descriptor.format, shard.descriptor.imageSize.width);
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(shard.files)) {
    const iconId = path.slice("icons/".length, path.length - (shard.descriptor.format.length + 1));
    out[`assets/${variantId}/${iconId}.${shard.descriptor.format}`] = bytes;
  }
  return out;
}

/**
 * Fetch exactly the selected shards, sequentially (concurrency 1 per DEC-102/
 * 107), verify each, and return the merged local-layout file map. Never
 * prefetches unselected tuples/formats/sizes.
 */
export async function fetchSelectedBitmapShards(
  tuples: readonly BitmapShardTuple[],
  deps: FetchBitmapShardsDeps,
): Promise<ResolvedBitmapShards> {
  const requests = planBitmapShardRequests(tuples, deps.version);
  const shards: VerifiedBitmapShard[] = [];
  const pins: BitmapShard[] = [];
  const files: Record<string, Uint8Array> = {};
  const existingByTuple = new Map<string, BitmapShard>();
  for (const pin of deps.existingPins ?? []) {
    existingByTuple.set(tupleKey({ styleGroupId: pin.styleGroupId, imageSize: pin.imageSize, format: pin.format }), pin);
  }
  let downloadedBytes = 0;
  for (const request of requests) {
    const published = existingByTuple.get(tupleKey(request));
    if (published) {
      // Re-verify the cached pinned shard; a miss/poison falls through to fetch.
      try {
        const cached = loadPinnedBitmapShardAssets(
          [published],
          [{ styleGroupId: request.styleGroupId, imageSize: request.imageSize, format: request.format }],
          deps.cacheDir,
          deps.io,
        );
        Object.assign(files, cached.files);
        pins.push(cached.pins[0] as BitmapShard);
        continue;
      } catch {
        // Fall through: re-fetch this tuple online.
      }
    }
    const descriptor: BitmapShardDescriptor = await fetchBitmapShardDescriptor(
      {
        version: deps.version,
        descriptorSha256: deps.descriptorSha256,
        styleGroupId: request.styleGroupId,
        imageSize: request.imageSize,
        format: request.format,
      },
      deps.accessToken,
      {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.allowLoopback ? { allowLoopback: true } : {}),
        ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
    // The descriptor must describe exactly the requested tuple.
    if (descriptor.filename !== request.filename) {
      throw new Error(`bitmap shard descriptor ${descriptor.filename} does not match request ${request.filename}`);
    }
    const verified = await downloadAndCacheBitmapShard(descriptor, {
      cacheDir: deps.cacheDir,
      io: deps.io,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.allowedHosts ? { allowedHosts: deps.allowedHosts } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.allowLoopback ? { allowLoopback: true } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.statfs ? { statfs: deps.statfs } : {}),
    });
    downloadedBytes += verified.descriptor.size;
    if (downloadedBytes > BITMAP_SHARD_BUDGET.totalDownloadBytes) {
      throw new CliError("VALIDATION_ERROR", `bitmap shard total download exceeds the budget (${BITMAP_SHARD_BUDGET.totalDownloadBytes})`);
    }
    Object.assign(files, shardAssetsToLocalLayout(verified));
    shards.push(verified);
    pins.push(bitmapShardPinFromVerified(verified));
  }
  return { requests, shards, pins, files };
}

export interface EnsureBitmapShardsDeps {
  readonly config: MoeiconsConfigFile;
  readonly catalog: IconCatalog;
  readonly version: string;
  readonly descriptorSha256: string;
  readonly cacheDir: string;
  readonly io: CacheIo;
  readonly accessToken: string;
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
  readonly signal?: AbortSignal;
  readonly statfs?: (dir: string) => { readonly availableBytes: number } | undefined;
  readonly existingPins?: readonly BitmapShard[];
}

export interface ConfiguredBitmapShards {
  readonly tuples: readonly BitmapShardTuple[];
  readonly requests: readonly BitmapShardRequest[];
  readonly pins: readonly BitmapShard[];
  /** Local-layout files: `assets/<resourceVariantId>/<iconId>.<format>` -> bytes. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly bitmapShardSetSha256: string;
}

/**
 * DEV-G07: resolve the config's bitmap tuples, then obtain each selected shard.
 * Online (an access token is available) fetches one descriptor per tuple from
 * the API and downloads it from the signed R2 host. Offline (no token) loads
 * the already-pinned cache and fails closed when any shard is missing.
 */
export async function resolveConfiguredBitmapShards(
  deps: EnsureBitmapShardsDeps,
): Promise<ConfiguredBitmapShards> {
  const resolved = resolveBitmapTuples(deps.config, deps.catalog);
  if (!resolved.ok) throw new CliError("VALIDATION_ERROR", resolved.errors.join("; "));
  const tuples = resolved.tuples;
  if (tuples.length === 0) {
    return { tuples, requests: [], pins: [], files: {}, bitmapShardSetSha256: bitmapShardSetSha256([]) };
  }
  const requests = planBitmapShardRequests(tuples, deps.version);
  const endpoint = resolveBitmapShardDescriptorEndpoint(deps.env ?? {});
  const fetched = await fetchSelectedBitmapShards(tuples, {
    version: deps.version,
    descriptorSha256: deps.descriptorSha256,
    accessToken: deps.accessToken,
    cacheDir: deps.cacheDir,
    io: deps.io,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.allowedHosts ? { allowedHosts: deps.allowedHosts } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(endpoint.allowLoopback ? { allowLoopback: true } : {}),
    endpoint: endpoint.url,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.statfs ? { statfs: deps.statfs } : {}),
    ...(deps.existingPins ? { existingPins: deps.existingPins } : {}),
  });
  return {
    tuples,
    requests,
    pins: fetched.pins,
    files: fetched.files,
    bitmapShardSetSha256: bitmapShardSetSha256(fetched.pins),
  };
}

/**
 * Offline path: re-verify every configured tuple's shard against its pinned
 * identity. The pin supplies the archive SHA, manifest SHA and size, so a
 * truncated/poisoned cache can never be accepted, and every unselected tuple
 * is never read.
 */
export function loadPinnedBitmapShardAssets(
  pins: readonly BitmapShard[],
  selectedTuples: readonly BitmapShardTuple[],
  cacheDir: string,
  io: CacheIo,
): { readonly files: Record<string, Uint8Array>; readonly pins: readonly BitmapShard[]; readonly bitmapShardSetSha256: string } {
  const wanted = new Map(selectedTuples.map((tuple) => [tupleKey(tuple), tuple]));
  const files: Record<string, Uint8Array> = {};
  const loaded: BitmapShard[] = [];
  for (const pin of pins) {
    const key = tupleKey({
      styleGroupId: pin.styleGroupId,
      imageSize: pin.imageSize,
      format: pin.format,
    });
    if (selectedTuples.length > 0 && !wanted.has(key)) continue;
    const target: BitmapShardVerificationTarget = bitmapShardVerificationTargetFromPin(pin);
    const cached = loadCachedBitmapShard(target, cacheDir, io);
    const variantId = buildResourceVariantId(pin.styleGroupId, pin.format, pin.imageSize.width);
    for (const [path, bytes] of Object.entries(cached.files)) {
      const iconId = path.slice("icons/".length, path.length - (pin.format.length + 1));
      files[`assets/${variantId}/${iconId}.${pin.format}`] = bytes;
    }
    loaded.push(pin);
  }
  if (selectedTuples.length > 0 && loaded.length !== selectedTuples.length) {
    const missing = selectedTuples
      .filter((tuple) => !loaded.some((pin) => tupleKey({ styleGroupId: pin.styleGroupId, imageSize: pin.imageSize, format: pin.format }) === tupleKey(tuple)))
      .map((tuple) => tupleKey(tuple));
    throw new CliError("VALIDATION_ERROR", `bitmap shards are not all cached: ${missing.join(", ")}; run install while online`);
  }
  return { files, pins: loaded, bitmapShardSetSha256: bitmapShardSetSha256(loaded) };
}

