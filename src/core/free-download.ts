import { join } from "node:path";
import { createHash } from "node:crypto";
import { downloadArtifact, verifyArtifact, type DownloadLimits } from "../project/install.js";
import { decodeUtf8, extractTarGz } from "../project/tar-gz.js";
import { catalog as bundledCatalog } from "../catalog/catalog.js";
import { cacheArtifact, type CacheIo } from "./cache.js";
import { extractAndVerifyMetadataArchive, type MetadataArchiveFiles } from "../metadata/archive.js";
import {
  cacheKey,
  FREE_DOWNLOAD_HOSTS,
  githubReleaseAssetUrl,
  parseReleaseDescriptor,
  parseSha256Sidecar,
  type ReleaseDescriptor,
  type ReleaseMetadataRef,
} from "./release-descriptor.js";

export const DESCRIPTOR_MAX_BYTES = 256 * 1024;
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const METADATA_MAX_BYTES = 8 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
export const DESCRIPTOR_NAME = "release-descriptor.json";
export const DESCRIPTOR_SHA_NAME = "release-descriptor.json.sha256";

export type FreeDownloadFailure =
  | { readonly ok: false; readonly reason: "network"; readonly message: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly message: string }
  | { readonly ok: false; readonly reason: "validation"; readonly message: string }
  | { readonly ok: false; readonly reason: "checksum-mismatch"; readonly message: string }
  | { readonly ok: false; readonly reason: "offline-no-cache"; readonly message: string }
  | { readonly ok: false; readonly reason: "cancelled"; readonly message: string }
  | { readonly ok: false; readonly reason: "disk-full"; readonly message: string };

export type FreeDownloadSuccess = {
  readonly ok: true;
  readonly descriptor: ReleaseDescriptor;
  readonly descriptorSha256: string;
  readonly artifactBytes: Uint8Array;
  readonly catalogJson: string;
  readonly cacheHit: boolean;
  readonly tag: string;
  readonly metadataSha256: string;
  readonly manifestJson: string;
  readonly manualMd: string;
};

export type FreeDownloadResult = FreeDownloadSuccess | FreeDownloadFailure;

export interface FreeDownloadIo extends CacheIo {
  readonly fetchFn: typeof fetch;
  readonly readFileSync: (path: string) => Uint8Array;
  readonly writeFileSync: (path: string, data: Uint8Array) => void;
  readonly mkdirSync: (path: string) => void;
  readonly existsSync: (path: string) => boolean;
  readonly fixtureDir?: string;
  /** Test-only loopback HTTP fixture root; production callers leave unset. */
  readonly fixtureBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly cacheDir: string;
  readonly cliVersion: string;
  readonly signal: AbortSignal;
  readonly onProgress?: DownloadLimits["onProgress"];
  readonly statfs?: (dir: string) => { readonly availableBytes: number } | undefined;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function userAgent(cliVersion: string): string {
  return `moeicons/${cliVersion} (+https://github.com/moewolf-dev/moe-icons-cli)`;
}

function descriptorLimits(cliVersion: string, onProgress?: DownloadLimits["onProgress"], fixtureBaseUrl?: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): DownloadLimits {
  return {
    maxBytes: DESCRIPTOR_MAX_BYTES,
    timeoutMs,
    maxRedirects: MAX_REDIRECTS,
    allowedHosts: fixtureBaseUrl ? [new URL(fixtureBaseUrl).host] : FREE_DOWNLOAD_HOSTS,
    ...(fixtureBaseUrl ? { allowHttpLoopback: true } : {}),
    userAgent: userAgent(cliVersion),
    ...(onProgress ? { onProgress } : {}),
  };
}

function artifactLimits(cliVersion: string, onProgress?: DownloadLimits["onProgress"], fixtureBaseUrl?: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): DownloadLimits {
  return {
    maxBytes: ARTIFACT_MAX_BYTES,
    timeoutMs,
    maxRedirects: MAX_REDIRECTS,
    allowedHosts: fixtureBaseUrl ? [new URL(fixtureBaseUrl).host] : FREE_DOWNLOAD_HOSTS,
    ...(fixtureBaseUrl ? { allowHttpLoopback: true } : {}),
    userAgent: userAgent(cliVersion),
    ...(onProgress ? { onProgress } : {}),
  };
}

function metadataLimits(cliVersion: string, onProgress?: DownloadLimits["onProgress"], fixtureBaseUrl?: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): DownloadLimits {
  return {
    maxBytes: METADATA_MAX_BYTES,
    timeoutMs,
    maxRedirects: MAX_REDIRECTS,
    allowedHosts: fixtureBaseUrl ? [new URL(fixtureBaseUrl).host] : FREE_DOWNLOAD_HOSTS,
    ...(fixtureBaseUrl ? { allowHttpLoopback: true } : {}),
    userAgent: userAgent(cliVersion),
    ...(onProgress ? { onProgress } : {}),
  };
}

function mapDownloadError(code: string, message: string): FreeDownloadFailure {
  if (code === "HTTP_ERROR" && / 404$/.test(message)) {
    return { ok: false, reason: "not-found", message };
  }
  if (code === "NETWORK_ERROR") return { ok: false, reason: "network", message };
  return { ok: false, reason: "validation", message };
}

function readFixture(io: FreeDownloadIo, name: string): Uint8Array {
  return io.readFileSync(join(io.fixtureDir ?? "", name));
}

export function artifactCachePath(cacheDir: string, fullVersion: string, sha256: string): string {
  return join(cacheDir, ...cacheKey(fullVersion, sha256).split("/"), "artifact.tgz");
}

export function metadataCachePath(cacheDir: string, fullVersion: string, sha256: string): string {
  return join(cacheDir, ...cacheKey(fullVersion, sha256).split("/"), "metadata.tgz");
}

function cachePath(io: FreeDownloadIo, fullVersion: string, sha256: string): string {
  return artifactCachePath(io.cacheDir, fullVersion, sha256);
}

/** Best-effort disk-space preflight; missing statfs support is treated as "enough". */
export function hasEnoughFreeSpace(io: FreeDownloadIo, dir: string, requiredBytes: number): boolean {
  try {
    const state = io.statfs?.(dir);
    if (state) return state.availableBytes >= requiredBytes;
  } catch {
    // statfs unsupported or the dir does not exist yet; assume enough.
  }
  return true;
}

async function loadBytes(
  io: FreeDownloadIo,
  filename: string,
  limits: DownloadLimits,
  tag: string,
): Promise<{ ok: true; bytes: Uint8Array } | FreeDownloadFailure> {
  if (io.signal.aborted) return { ok: false, reason: "cancelled", message: "download cancelled" };
  if (io.fixtureDir) {
    try {
      return { ok: true, bytes: readFixture(io, filename) };
    } catch (error) {
      return { ok: false, reason: "validation", message: error instanceof Error ? error.message : String(error) };
    }
  }
  const url = io.fixtureBaseUrl ? new URL(filename, io.fixtureBaseUrl.endsWith("/") ? io.fixtureBaseUrl : `${io.fixtureBaseUrl}/`).toString() : githubReleaseAssetUrl(tag, filename);
  const result = await downloadArtifact(url, limits, { fetchFn: io.fetchFn, signal: io.signal });
  if (!result.ok) return mapDownloadError(result.code, result.message);
  return { ok: true, bytes: result.bytes };
}

function catalogFromArchive(artifactBytes: Uint8Array, catalogFilename: string, expectedSha: string):
  | { ok: true; json: string }
  | FreeDownloadFailure {
  const unpacked = extractTarGz(artifactBytes, { maxEntries: 20_000, maxExpandedBytes: ARTIFACT_MAX_BYTES });
  if (unpacked.errors.length > 0) {
    return { ok: false, reason: "validation", message: unpacked.errors[0] ?? "extract failed" };
  }
  const catalogBytes = unpacked.files[catalogFilename] ?? unpacked.files[`./${catalogFilename}`];
  if (!catalogBytes) {
    return { ok: false, reason: "validation", message: `artifact is missing ${catalogFilename}` };
  }
  const actual = sha256Hex(catalogBytes);
  if (actual !== expectedSha) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: `catalog SHA-256 mismatch: expected ${expectedSha}, got ${actual}`,
    };
  }
  return { ok: true, json: decodeUtf8(catalogBytes) };
}

export interface ExtractedMetadata extends MetadataArchiveFiles {
  metadataSha256: string;
}

/**
 * Download the small metadata archive, verify the whole-archive SHA-256 plus
 * size and every nested file digest, then cache it atomically.
 */
export async function downloadMetadataArchive(
  io: FreeDownloadIo,
  metadataRef: ReleaseMetadataRef,
  expectedCatalogSha: string,
  expectedTier: "free" | "pro",
  expectedVersion: string,
  tag: string,
): Promise<{ ok: true; value: ExtractedMetadata; cacheHit: boolean } | FreeDownloadFailure> {
  const cachedPath = metadataCachePath(io.cacheDir, expectedVersion, metadataRef.sha256);
  if (io.existsSync(cachedPath)) {
    const cached = io.readFileSync(cachedPath);
    const verified = verifyArtifact(cached, metadataRef.sha256);
    if (verified.ok && cached.byteLength === metadataRef.size) {
      const extracted = extractAndVerifyMetadataArchive(cached, {
        expectedCatalogSha,
        expectedTier,
        expectedVersion,
        perFileDigests: metadataRef.files,
      });
      if (extracted.kind === "ok") {
        return { ok: true, value: { ...extracted.value, metadataSha256: metadataRef.sha256 }, cacheHit: true };
      }
    }
  }
  if (!hasEnoughFreeSpace(io, io.cacheDir, metadataRef.size)) {
    return { ok: false, reason: "disk-full", message: `not enough free disk space for ${metadataRef.size} bytes of metadata` };
  }
  const downloaded = await loadBytes(io, metadataRef.filename, metadataLimits(io.cliVersion, io.onProgress, io.fixtureBaseUrl, io.timeoutMs), tag);
  if (!downloaded.ok) {
    if (!io.fixtureDir && downloaded.reason === "network") {
      return { ok: false, reason: "offline-no-cache", message: downloaded.message };
    }
    return downloaded;
  }
  const verified = verifyArtifact(downloaded.bytes, metadataRef.sha256);
  if (!verified.ok) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: `metadata archive SHA-256 mismatch: expected ${metadataRef.sha256}, got ${verified.actual}`,
    };
  }
  if (downloaded.bytes.byteLength !== metadataRef.size) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: `metadata archive size mismatch: expected ${metadataRef.size}, got ${downloaded.bytes.byteLength}`,
    };
  }
  const extracted = extractAndVerifyMetadataArchive(downloaded.bytes, {
    expectedCatalogSha,
    expectedTier,
    expectedVersion,
    perFileDigests: metadataRef.files,
  });
  if (extracted.kind !== "ok") {
    return { ok: false, reason: extracted.reason, message: extracted.message };
  }
  try {
    cacheArtifact(io, cachedPath, downloaded.bytes, metadataRef.sha256);
  } catch {
    // Cache is best-effort; the verified bytes are still used for this install.
  }
  return { ok: true, value: { ...extracted.value, metadataSha256: metadataRef.sha256 }, cacheHit: false };
}

/**
 * Fetch the descriptor sidecar → verify descriptor. Does not download the code
 * artifact; used by metadata-only sync and by the full download.
 */
export async function fetchFreeDescriptor(io: FreeDownloadIo, sourceVersion: string):
  Promise<{ ok: true; descriptor: ReleaseDescriptor; descriptorSha256: string; tag: string } | FreeDownloadFailure> {
  if (io.signal.aborted) return { ok: false, reason: "cancelled", message: "download cancelled" };
  const tag = `v${sourceVersion}`;

  const shaFile = await loadBytes(io, DESCRIPTOR_SHA_NAME, descriptorLimits(io.cliVersion, io.onProgress, io.fixtureBaseUrl, io.timeoutMs), tag);
  if (!shaFile.ok) {
    if (!io.fixtureDir && shaFile.reason === "network") {
      return { ok: false, reason: "offline-no-cache", message: shaFile.message };
    }
    return shaFile;
  }
  let expectedDescriptorSha: string;
  try {
    expectedDescriptorSha = parseSha256Sidecar(decodeUtf8(shaFile.bytes));
  } catch (error) {
    return { ok: false, reason: "validation", message: error instanceof Error ? error.message : String(error) };
  }

  const descriptorFile = await loadBytes(io, DESCRIPTOR_NAME, descriptorLimits(io.cliVersion, io.onProgress, io.fixtureBaseUrl, io.timeoutMs), tag);
  if (!descriptorFile.ok) return descriptorFile;
  const actualDescriptorSha = sha256Hex(descriptorFile.bytes);
  if (actualDescriptorSha !== expectedDescriptorSha) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: `descriptor SHA-256 mismatch: expected ${expectedDescriptorSha}, got ${actualDescriptorSha}`,
    };
  }

  let descriptor: ReleaseDescriptor;
  try {
    descriptor = parseReleaseDescriptor(descriptorFile.bytes);
  } catch (error) {
    return { ok: false, reason: "validation", message: error instanceof Error ? error.message : String(error) };
  }
  if (descriptor.fullVersion !== sourceVersion) {
    return {
      ok: false,
      reason: "validation",
      message: `descriptor fullVersion ${descriptor.fullVersion} does not match catalog sourceVersion ${sourceVersion}`,
    };
  }
  return { ok: true, descriptor, descriptorSha256: actualDescriptorSha, tag };
}

/**
 * Fetch descriptor sidecar → verify descriptor → download free.filename from
 * the descriptor (never guessed) → verify archive + nested catalog checksums →
 * download/verify/cache the matching metadata archive.
 */
export async function downloadFreeRelease(io: FreeDownloadIo, sourceVersion: string): Promise<FreeDownloadResult> {
  const fetched = await fetchFreeDescriptor(io, sourceVersion);
  if (!fetched.ok) return fetched;
  const { descriptor, descriptorSha256, tag } = fetched;

  const metadataRef = descriptor.free.metadata;
  if (!metadataRef) {
    return {
      ok: false,
      reason: "validation",
      message: "release descriptor is missing free metadata; the release predates metadata support",
    };
  }

  const artifactCache = cachePath(io, descriptor.fullVersion, descriptor.free.sha256);
  if (io.existsSync(artifactCache)) {
    const cached = io.readFileSync(artifactCache);
    const verified = verifyArtifact(cached, descriptor.free.sha256);
    if (verified.ok) {
      const catalog = catalogFromArchive(cached, descriptor.catalog.filename, descriptor.catalog.sha256);
      if (!catalog.ok) return catalog;
      const metadata = await downloadMetadataArchive(io, metadataRef, descriptor.catalog.sha256, "free", descriptor.fullVersion, tag);
      if (!metadata.ok) return metadata;
      return {
        ok: true,
        descriptor,
        descriptorSha256,
        artifactBytes: cached,
        catalogJson: catalog.json,
        cacheHit: true,
        tag,
        metadataSha256: metadata.value.metadataSha256,
        manifestJson: metadata.value.manifestJson,
        manualMd: metadata.value.manualMd,
      };
    }
  }

  if (!hasEnoughFreeSpace(io, io.cacheDir, ARTIFACT_MAX_BYTES + METADATA_MAX_BYTES)) {
    return { ok: false, reason: "disk-full", message: "not enough free disk space to cache the icon library" };
  }
  const artifact = await loadBytes(io, descriptor.free.filename, artifactLimits(io.cliVersion, io.onProgress, io.fixtureBaseUrl, io.timeoutMs), tag);
  if (!artifact.ok) {
    if (!io.fixtureDir && artifact.reason === "network") {
      return { ok: false, reason: "offline-no-cache", message: artifact.message };
    }
    return artifact;
  }
  const verified = verifyArtifact(artifact.bytes, descriptor.free.sha256);
  if (!verified.ok) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: `free artifact SHA-256 mismatch: expected ${descriptor.free.sha256}, got ${verified.actual}`,
    };
  }
  const catalog = catalogFromArchive(artifact.bytes, descriptor.catalog.filename, descriptor.catalog.sha256);
  if (!catalog.ok) return catalog;

  const metadata = await downloadMetadataArchive(io, metadataRef, descriptor.catalog.sha256, "free", descriptor.fullVersion, tag);
  if (!metadata.ok) return metadata;

  try {
    cacheArtifact(io, artifactCache, artifact.bytes, descriptor.free.sha256);
  } catch {
    // Cache is best-effort; verified bytes are still used for this install.
  }

  return {
    ok: true,
    descriptor,
    descriptorSha256,
    artifactBytes: artifact.bytes,
    catalogJson: catalog.json,
    cacheHit: false,
    tag,
    metadataSha256: metadata.value.metadataSha256,
    manifestJson: metadata.value.manifestJson,
    manualMd: metadata.value.manualMd,
  };
}

export function bundledSourceVersion(): string {
  return bundledCatalog.sourceVersion;
}
