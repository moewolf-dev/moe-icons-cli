import { join } from "node:path";
import { createHash } from "node:crypto";
import { downloadArtifact, verifyArtifact, type DownloadLimits } from "../project/install.js";
import { decodeUtf8, extractTarGz } from "../project/tar-gz.js";
import { catalog as bundledCatalog } from "../catalog/catalog.js";
import {
  cacheKey,
  FREE_DOWNLOAD_HOSTS,
  githubReleaseAssetUrl,
  parseReleaseDescriptor,
  parseSha256Sidecar,
  type ReleaseDescriptor,
} from "./release-descriptor.js";

export const DESCRIPTOR_MAX_BYTES = 256 * 1024;
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
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
  | { readonly ok: false; readonly reason: "cancelled"; readonly message: string };

export type FreeDownloadSuccess = {
  readonly ok: true;
  readonly descriptor: ReleaseDescriptor;
  readonly descriptorSha256: string;
  readonly artifactBytes: Uint8Array;
  readonly catalogJson: string;
  readonly cacheHit: boolean;
  readonly tag: string;
};

export type FreeDownloadResult = FreeDownloadSuccess | FreeDownloadFailure;

export interface FreeDownloadIo {
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

function cachePath(io: FreeDownloadIo, fullVersion: string, sha256: string): string {
  return artifactCachePath(io.cacheDir, fullVersion, sha256);
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

/**
 * Fetch descriptor sidecar → verify descriptor → download free.filename from
 * the descriptor (never guessed) → verify archive + nested catalog checksums.
 * Local `fixtureDir` stands in for a GitHub Release directory.
 */
export async function downloadFreeRelease(io: FreeDownloadIo, sourceVersion: string): Promise<FreeDownloadResult> {
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

  const artifactCache = cachePath(io, descriptor.fullVersion, descriptor.free.sha256);
  if (io.existsSync(artifactCache)) {
    const cached = io.readFileSync(artifactCache);
    const verified = verifyArtifact(cached, descriptor.free.sha256);
    if (verified.ok) {
      const catalog = catalogFromArchive(cached, descriptor.catalog.filename, descriptor.catalog.sha256);
      if (!catalog.ok) return catalog;
      return {
        ok: true,
        descriptor,
        descriptorSha256: actualDescriptorSha,
        artifactBytes: cached,
        catalogJson: catalog.json,
        cacheHit: true,
        tag,
      };
    }
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

  io.mkdirSync(join(artifactCache, ".."));
  io.writeFileSync(artifactCache, artifact.bytes);

  return {
    ok: true,
    descriptor,
    descriptorSha256: actualDescriptorSha,
    artifactBytes: artifact.bytes,
    catalogJson: catalog.json,
    cacheHit: false,
    tag,
  };
}

export function bundledSourceVersion(): string {
  return bundledCatalog.sourceVersion;
}
