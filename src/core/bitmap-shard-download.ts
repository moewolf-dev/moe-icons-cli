/**
 * BITMAP-SHARD-V1 (DEC-97..DEC-108): CLI shard descriptor fetch, direct-from-R2
 * download, strict verification and atomic cached persistence.
 *
 * The bearer is only ever sent to the trusted API origin. The R2 shard download
 * never forwards authorization/cookies (`downloadSignedArtifact`).
 *
 * Budget constants here are interim; `DEV-G08`/`OPS-05-05` freeze the final
 * per-shard download/expand budgets after real measurement.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { CliError } from "../errors/index.js";
import { cacheArtifact, type CacheIo } from "./cache.js";
import { extractTarGz } from "../project/tar-gz.js";
import { PRO_DOWNLOAD_HOSTS } from "./pro-download.js";
import { downloadSignedArtifact, type SignedArtifactDescriptor } from "./signed-artifact.js";
import {
  BITMAP_SHARD_SCHEMA_VERSION,
  buildBitmapShardObjectKey,
  type BitmapShard,
  type BitmapShardFormat,
  type BitmapShardImageSize,
} from "./bitmap-shards.js";
import { BITMAP_SHARD_BUDGET, BITMAP_SHARD_MAX_ENTRIES, BITMAP_SHARD_MAX_EXPANDED_BYTES } from "./bitmap-shard-budget.js";

export { BITMAP_SHARD_MAX_ENTRIES, BITMAP_SHARD_MAX_EXPANDED_BYTES };

const API_ORIGIN = "https://api.moeicons.com";
const SHARD_ENDPOINT_PATH = "/v1/icon-library/pro/bitmap-shard-descriptor";
export const BITMAP_SHARD_DESCRIPTOR_URL = `${API_ORIGIN}${SHARD_ENDPOINT_PATH}`;
const SHA256 = /^[a-f0-9]{64}$/;
const ICON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/;
const BITMAP_SIZES = new Set([64, 128, 256, 512]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Only the fields that identify the immutable shard are required to verify
 * cached bytes; a full descriptor additionally carries a signed URL/expiry.
 */
export interface BitmapShardVerificationTarget {
  readonly version: string;
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
  readonly size: number;
  readonly sha256: string;
  readonly manifestSha256: string;
}

export interface BitmapShardCacheIdentity {
  readonly version: string;
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
  readonly sha256: string;
}

export interface BitmapShardDescriptor extends SignedArtifactDescriptor, BitmapShardVerificationTarget {
  readonly tier: "pro";
  readonly descriptorSha256: string;
  readonly filename: string;
}

/**
 * Test seam: `MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL` overrides the authenticated
 * per-shard descriptor endpoint. Only https or loopback http is accepted, so a
 * production endpoint can never be redirected by a stray environment variable
 * to a plaintext or untrusted origin (mirrors the Pro descriptor seam).
 */
export function resolveBitmapShardDescriptorEndpoint(env: Readonly<Record<string, string | undefined>>):
  { readonly url: string; readonly allowLoopback: boolean } {
  const override = env.MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL;
  if (!override) return { url: BITMAP_SHARD_DESCRIPTOR_URL, allowLoopback: false };
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL is not a valid URL");
  }
  const loopback = parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL must be https or loopback http");
  }
  return { url: override, allowLoopback: loopback };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBitmapShardDescriptor(
  value: unknown,
  now: number,
  options: { readonly allowLoopback?: boolean } = {},
): BitmapShardDescriptor {
  if (!isRecord(value)) throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  const allowed = ["tier", "version", "descriptorSha256", "styleGroupId", "imageSize", "format", "filename", "url", "expiresAt", "size", "sha256", "manifestSha256"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  if (value.tier !== "pro" || typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  }
  if (typeof value.descriptorSha256 !== "string" || !SHA256.test(value.descriptorSha256)) throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  if (typeof value.styleGroupId !== "string" || typeof value.format !== "string" || (value.format !== "png" && value.format !== "webp")) {
    throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  }
  const imageSize = value.imageSize;
  if (!isRecord(imageSize) || typeof imageSize.width !== "number" || typeof imageSize.height !== "number"
    || imageSize.width !== imageSize.height || !BITMAP_SIZES.has(imageSize.width)) {
    throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  const expectedKey = buildBitmapShardObjectKey({
    tier: "pro",
    styleGroupId: value.styleGroupId,
    imageSize: { width: imageSize.width, height: imageSize.height },
    format: value.format,
    resourceVersion: value.version,
  });
  const expectedFilename = expectedKey.split("/").pop();
  if (value.filename !== expectedFilename) throw new CliError("VALIDATION_ERROR", "bitmap shard filename does not match its tuple");
  const url = value.url;
  const expiresAt = value.expiresAt;
  if (typeof url !== "string" || typeof expiresAt !== "string" || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new CliError("VALIDATION_ERROR", "invalid bitmap shard descriptor");
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError("VALIDATION_ERROR", "invalid bitmap shard URL"); }
  const expires = Date.parse(expiresAt);
  const loopbackHttp = options.allowLoopback === true && parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");
  if ((parsed.protocol !== "https:" && !loopbackHttp) || !Number.isFinite(expires) || expires <= now) {
    throw new CliError("VALIDATION_ERROR", "bitmap shard descriptor is expired or insecure");
  }
  return value as unknown as BitmapShardDescriptor;
}

/**
 * POST one tuple to the trusted API. Bearer is never sent to R2. The request is
 * bounded by `BITMAP_SHARD_BUDGET.descriptorTimeoutMs` unless overridden, and
 * honors an external cancellation signal (DEV-G08).
 */
export async function fetchBitmapShardDescriptor(
  tuple: { readonly version: string; readonly descriptorSha256: string; readonly styleGroupId: string; readonly imageSize: BitmapShardImageSize; readonly format: BitmapShardFormat },
  accessToken: string,
  deps: { readonly fetch?: typeof fetch; readonly now?: number; readonly allowLoopback?: boolean; readonly endpoint?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<BitmapShardDescriptor> {
  const url = deps.endpoint ?? BITMAP_SHARD_DESCRIPTOR_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? BITMAP_SHARD_BUDGET.descriptorTimeoutMs);
  const onExternalAbort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ version: tuple.version, descriptorSha256: tuple.descriptorSha256, styleGroupId: tuple.styleGroupId, imageSize: tuple.imageSize, format: tuple.format }),
    });
    if (!response.ok) {
      const code = response.status === 401 ? "AUTH_ERROR" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : "NETWORK_ERROR";
      throw new CliError(code, `bitmap shard descriptor request failed with ${response.status}`);
    }
    return parseBitmapShardDescriptor(await response.json(), deps.now ?? Date.now(), deps.allowLoopback ? { allowLoopback: true } : {});
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (deps.signal?.aborted) throw new CliError("CANCELLED", "bitmap shard descriptor request cancelled");
    if (controller.signal.aborted) throw new CliError("NETWORK_ERROR", "bitmap shard descriptor request timed out");
    throw new CliError("NETWORK_ERROR", "bitmap shard descriptor request failed");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function magicMatches(bytes: Uint8Array, format: BitmapShardFormat): boolean {
  if (format === "png") return bytes.byteLength >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE);
  return bytes.byteLength >= 12 && Buffer.from(bytes).toString("ascii", 0, 4) === "RIFF" && Buffer.from(bytes).toString("ascii", 8, 12) === "WEBP";
}

function readImageSize(bytes: Uint8Array, format: BitmapShardFormat): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes);
  if (format === "png") {
    if (buffer.byteLength < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.byteLength < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)), height: 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16)) };
  if (chunk === "VP8L") { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return undefined;
}

export interface VerifiedBitmapShard {
  readonly descriptor: BitmapShardDescriptor;
  /** `icons/<iconId>.<format>` -> bytes. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly iconIds: readonly string[];
}

/** An offline-verified shard loaded from the cache; the URL/expiry is irrelevant. */
export interface CachedBitmapShard {
  readonly target: BitmapShardVerificationTarget;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly iconIds: readonly string[];
}

/**
 * DEC-101: verify response size/SHA, then the internal manifest digest,
 * icon set, magic bytes and real dimensions before accepting any bytes.
 */
function verifyShardContents(bytes: Uint8Array, descriptor: BitmapShardVerificationTarget): { readonly files: Record<string, Uint8Array>; readonly iconIds: readonly string[] } {
  if (bytes.byteLength !== descriptor.size) {
    throw new CliError("VALIDATION_ERROR", `bitmap shard size mismatch: expected ${descriptor.size}, got ${bytes.byteLength}`);
  }
  if (bytes.byteLength > BITMAP_SHARD_BUDGET.compressedBytes) {
    throw new CliError("VALIDATION_ERROR", `bitmap shard exceeds the compressed byte budget (${BITMAP_SHARD_BUDGET.compressedBytes})`);
  }
  const archiveSha = createHash("sha256").update(bytes).digest("hex");
  if (archiveSha !== descriptor.sha256) {
    throw new CliError("VALIDATION_ERROR", `bitmap shard SHA-256 mismatch: expected ${descriptor.sha256}, got ${archiveSha}`);
  }
  const extracted = extractTarGz(bytes, { maxEntries: BITMAP_SHARD_MAX_ENTRIES, maxExpandedBytes: BITMAP_SHARD_MAX_EXPANDED_BYTES });
  if (extracted.errors.length > 0) throw new CliError("VALIDATION_ERROR", `bitmap shard archive rejected: ${extracted.errors[0]}`);
  const manifestBytes = extracted.files["manifest.json"];
  if (!manifestBytes) throw new CliError("VALIDATION_ERROR", "bitmap shard is missing manifest.json");
  if (createHash("sha256").update(manifestBytes).digest("hex") !== descriptor.manifestSha256) {
    throw new CliError("VALIDATION_ERROR", "bitmap shard manifest digest mismatch");
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as Record<string, unknown>; }
  catch { throw new CliError("VALIDATION_ERROR", "bitmap shard manifest is not valid JSON"); }
  if (manifest.schemaVersion !== BITMAP_SHARD_SCHEMA_VERSION || manifest.resourceVersion !== descriptor.version
    || manifest.tier !== "pro" || manifest.styleGroupId !== descriptor.styleGroupId || manifest.format !== descriptor.format) {
    throw new CliError("VALIDATION_ERROR", "bitmap shard manifest identity mismatch");
  }
  const declaredSize = manifest.imageSize as { width?: unknown; height?: unknown } | undefined;
  if (!declaredSize || declaredSize.width !== descriptor.imageSize.width || declaredSize.height !== descriptor.imageSize.height) {
    throw new CliError("VALIDATION_ERROR", "bitmap shard manifest imageSize mismatch");
  }
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0 || manifest.iconCount !== files.length) {
    throw new CliError("VALIDATION_ERROR", "bitmap shard manifest files are invalid");
  }
  const expected: Record<string, Uint8Array> = {};
  const iconIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (!isRecord(entry) || typeof entry.iconId !== "string" || !ICON_ID.test(entry.iconId) || seen.has(entry.iconId)) {
      throw new CliError("VALIDATION_ERROR", "bitmap shard manifest has an invalid icon id");
    }
    seen.add(entry.iconId);
    const path = `icons/${entry.iconId}.${descriptor.format}`;
    if (entry.path !== path) throw new CliError("VALIDATION_ERROR", `bitmap shard manifest path ${String(entry.path)} is not canonical`);
    const content = extracted.files[path];
    if (!content) throw new CliError("VALIDATION_ERROR", `bitmap shard is missing ${path}`);
    if (content.byteLength > BITMAP_SHARD_BUDGET.singleFileBytes) {
      throw new CliError("VALIDATION_ERROR", `bitmap shard payload ${path} exceeds the single-file byte budget`);
    }
    if (typeof entry.byteSize !== "number" || entry.byteSize !== content.byteLength) throw new CliError("VALIDATION_ERROR", `bitmap shard size drift for ${path}`);
    if (typeof entry.sha256 !== "string" || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
      throw new CliError("VALIDATION_ERROR", `bitmap shard digest drift for ${path}`);
    }
    if (!magicMatches(content, descriptor.format)) throw new CliError("VALIDATION_ERROR", `bitmap shard magic does not match ${descriptor.format} for ${path}`);
    const size = readImageSize(content, descriptor.format);
    if (!size || size.width !== descriptor.imageSize.width || size.height !== descriptor.imageSize.height) {
      throw new CliError("VALIDATION_ERROR", `bitmap shard dimensions do not match its tuple for ${path}`);
    }
    expected[path] = content;
    iconIds.push(entry.iconId);
  }
  const declaredFiles = Object.keys(extracted.files).filter((name) => name.startsWith("icons/"));
  if (declaredFiles.length !== files.length) throw new CliError("VALIDATION_ERROR", "bitmap shard archive has undeclared icons");
  iconIds.sort((a, b) => a.localeCompare(b, "en"));
  return { files: expected, iconIds };
}

/** DEC-101 verification of downloaded shard bytes against the full descriptor. */
export function verifyBitmapShardArchive(bytes: Uint8Array, descriptor: BitmapShardVerificationTarget): VerifiedBitmapShard {
  const { files, iconIds } = verifyShardContents(bytes, descriptor);
  return { descriptor: descriptor as BitmapShardDescriptor, files, iconIds };
}

/** Unambiguous cache identity (DEC-101). */
export function bitmapShardCacheKey(identity: BitmapShardCacheIdentity): string {
  return [identity.version, "pro", identity.styleGroupId, identity.imageSize.width, identity.imageSize.height, identity.format, identity.sha256].join("/");
}

export function bitmapShardCachePath(cacheDir: string, identity: BitmapShardCacheIdentity): string {
  return join(cacheDir, "bitmap-shards", ...bitmapShardCacheKey(identity).split("/").slice(0, -1), `${identity.sha256}.tgz`);
}

/**
 * Offline/pin path: load one shard from the local cache and re-verify its
 * identity, size, SHA, manifest digest, icon set and dimensions. A missing or
 * partial cache fails closed; a poisoned cache fails digest verification.
 */
export function loadCachedBitmapShard(
  target: BitmapShardVerificationTarget,
  cacheDir: string,
  io: CacheIo,
): CachedBitmapShard {
  const path = bitmapShardCachePath(cacheDir, target);
  if (!io.existsSync(path) || !io.readFileSync) {
    throw new CliError("VALIDATION_ERROR", `bitmap shard is not cached for ${target.styleGroupId}/${target.imageSize.width}/${target.format}; run install while online`);
  }
  const bytes = io.readFileSync(path);
  const { files, iconIds } = verifyShardContents(bytes, target);
  return { target, files, iconIds };
}

/** Reconstruct the offline verification identity pinned in install metadata. */
export function bitmapShardVerificationTargetFromPin(pin: {
  readonly resourceVersion: string;
  readonly styleGroupId: string;
  readonly imageSize: BitmapShardImageSize;
  readonly format: BitmapShardFormat;
  readonly compressedSize: number;
  readonly sha256: string;
  readonly manifestSha256: string;
}): BitmapShardVerificationTarget {
  return {
    version: pin.resourceVersion,
    styleGroupId: pin.styleGroupId,
    imageSize: pin.imageSize,
    format: pin.format,
    size: pin.compressedSize,
    sha256: pin.sha256,
    manifestSha256: pin.manifestSha256,
  };
}

/** Build the canonical pin identity from a freshly verified download. */
export function bitmapShardPinFromVerified(verified: VerifiedBitmapShard): BitmapShard {
  const descriptor = verified.descriptor;
  const expandedSize = Object.values(verified.files).reduce((total, bytes) => total + bytes.byteLength, 0);
  const filename = descriptor.filename;
  return {
    schemaVersion: BITMAP_SHARD_SCHEMA_VERSION,
    resourceVersion: descriptor.version,
    tier: "pro",
    styleGroupId: descriptor.styleGroupId,
    imageSize: descriptor.imageSize,
    format: descriptor.format,
    filename,
    objectKey: buildBitmapShardObjectKey({
      tier: "pro",
      styleGroupId: descriptor.styleGroupId,
      imageSize: descriptor.imageSize,
      format: descriptor.format,
      resourceVersion: descriptor.version,
      filename,
    }),
    compressedSize: descriptor.size,
    expandedSize,
    sha256: descriptor.sha256,
    fileCount: verified.iconIds.length,
    manifestSha256: descriptor.manifestSha256,
  };
}

/**
 * Download directly from the private R2 signed host and atomically cache the
 * verified archive. Any size/SHA/manifest/dimension drift fails closed.
 */
export async function downloadAndCacheBitmapShard(
  descriptor: BitmapShardDescriptor,
  deps: {
    readonly cacheDir: string;
    readonly io: CacheIo;
    readonly fetch?: typeof fetch;
    readonly allowedHosts?: readonly string[];
    readonly now?: number;
    readonly allowLoopback?: boolean;
    readonly signal?: AbortSignal;
    readonly statfs?: (dir: string) => { readonly availableBytes: number } | undefined;
    readonly timeoutMs?: number;
  },
): Promise<VerifiedBitmapShard> {
  // DEV-G08-R2: reject an over-budget shard BEFORE issuing any network request,
  // so a hostile/oversized descriptor costs zero bytes and never touches cache.
  if (descriptor.size > BITMAP_SHARD_BUDGET.compressedBytes) {
    throw new CliError("VALIDATION_ERROR", `bitmap shard ${descriptor.filename} exceeds the compressed byte budget (${BITMAP_SHARD_BUDGET.compressedBytes})`);
  }
  // DEV-G08: reserve room for the compressed shard PLUS the unpacked staging
  // headroom before downloading. A missing statfs is treated as "enough"
  // (non-Linux hosts); a statfs that throws fails closed, never silently.
  if (deps.statfs) {
    let available: { readonly availableBytes: number } | undefined;
    try {
      available = deps.statfs(deps.cacheDir);
    } catch {
      throw new CliError("DISK_FULL", `cannot determine cache space for bitmap shard ${descriptor.filename}`);
    }
    const required = descriptor.size + BITMAP_SHARD_BUDGET.tempDiskBytes;
    if (available && available.availableBytes < required) {
      throw new CliError("DISK_FULL", `insufficient cache space for bitmap shard ${descriptor.filename} (needs ${required} bytes, has ${available.availableBytes})`);
    }
  }
  const bytes = await downloadSignedArtifact(
    { url: descriptor.url, expiresAt: descriptor.expiresAt, size: descriptor.size, sha256: descriptor.sha256 },
    {
      allowedHosts: deps.allowedHosts ?? PRO_DOWNLOAD_HOSTS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.allowLoopback ? { allowLoopback: true } : {}),
      timeoutMs: deps.timeoutMs ?? BITMAP_SHARD_BUDGET.downloadTimeoutMs,
    },
  );
  const verified = verifyBitmapShardArchive(bytes, descriptor);
  cacheArtifact(deps.io, bitmapShardCachePath(deps.cacheDir, descriptor), bytes, descriptor.sha256);
  return verified;
}
