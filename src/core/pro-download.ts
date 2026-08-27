import { CliError } from "../errors/index.js";
import { extractTarGz, decodeUtf8 } from "../project/tar-gz.js";
import { sha256Bytes } from "../project/install-metadata.js";
import {
  downloadSignedArtifact,
  parseSignedDescriptor,
  type SignedArtifactDescriptor,
} from "./signed-artifact.js";
import { runAccessTokenUseCase, type AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import type { ReleaseTarget, ReleaseTargetMetadata } from "./release-descriptor.js";
import { extractAndVerifyMetadataArchive } from "../metadata/archive.js";

const ENDPOINT = "https://api.moeicons.com/v1/icon-library/pro/artifact-descriptor";
export const PRO_DOWNLOAD_HOSTS = ["06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com"] as const;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Test seam: `MOEICONS_PRO_DESCRIPTOR_URL` overrides the authenticated Pro
 * descriptor endpoint. Only an https URL or a loopback http URL is accepted, so
 * production behavior is unchanged and a local mock can drive the packed CLI
 * during candidate acceptance.
 */
export function resolveProDescriptorEndpoint(env: Readonly<Record<string, string | undefined>>):
  { readonly url: string; readonly allowLoopback: boolean; readonly loopbackHost: string | null } {
  const override = env.MOEICONS_PRO_DESCRIPTOR_URL;
  if (!override) return { url: ENDPOINT, allowLoopback: false, loopbackHost: null };
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_PRO_DESCRIPTOR_URL is not a valid URL");
  }
  const loopback = parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_PRO_DESCRIPTOR_URL must be https or loopback http");
  }
  return { url: override, allowLoopback: loopback, loopbackHost: loopback ? parsed.host : null };
}

export interface ProArtifactDescriptor extends SignedArtifactDescriptor {
  readonly tier: "pro";
  readonly version: string;
  readonly descriptorSha256: string;
  readonly catalogFilename: "catalog.json";
  readonly catalogSha256: string;
  /** Signed URL for the small metadata archive (MANUAL.md + manifest.json). */
  readonly metadata?: SignedArtifactDescriptor;
  /** Optional per-target subtree metadata; verified when the API provides it. */
  readonly targetMetadata?: Readonly<Partial<Record<ReleaseTarget, ReleaseTargetMetadata>>>;
}

function parseTargetMetadata(
  value: unknown,
): Readonly<Partial<Record<ReleaseTarget, ReleaseTargetMetadata>>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Partial<Record<ReleaseTarget, ReleaseTargetMetadata>> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      key !== "react" &&
      key !== "vue" &&
      key !== "vanilla" &&
      key !== "assets"
    ) {
      return undefined;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || /(^|[\\/])\.\.([\\/]|$)/.test(item.path)) return undefined;
    if (typeof item.sha256 !== "string" || !SHA.test(item.sha256)) return undefined;
    if (typeof item.fileCount !== "number" || !Number.isSafeInteger(item.fileCount)) return undefined;
    if (typeof item.byteCount !== "number" || !Number.isSafeInteger(item.byteCount)) return undefined;
    result[key] = {
      path: item.path,
      sha256: item.sha256,
      fileCount: item.fileCount,
      byteCount: item.byteCount,
    };
  }
  return result;
}

function parse(value: unknown, expected: { version: string; descriptorSha256: string }, now: number, allowLoopback: boolean): ProArtifactDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError("VALIDATION_ERROR", "invalid pro artifact descriptor");
  const item = value as Record<string, unknown>;
  const allowed = ["ok", "tier", "version", "descriptorSha256", "catalogFilename", "catalogSha256", "url", "expiresAt", "size", "sha256", "targetMetadata", "metadata"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || item.ok !== true || item.tier !== "pro" || item.version !== expected.version || item.descriptorSha256 !== expected.descriptorSha256 ||
      typeof item.version !== "string" || !VERSION.test(item.version) || typeof item.descriptorSha256 !== "string" || !SHA.test(item.descriptorSha256) ||
      item.catalogFilename !== "catalog.json" || typeof item.catalogSha256 !== "string" || !SHA.test(item.catalogSha256) || typeof item.url !== "string" ||
      typeof item.expiresAt !== "string" || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 1 || typeof item.sha256 !== "string" || !SHA.test(item.sha256)) {
    throw new CliError("VALIDATION_ERROR", "invalid or changed pro artifact descriptor");
  }
  const targetMetadata = item.targetMetadata !== undefined ? parseTargetMetadata(item.targetMetadata) : undefined;
  const metadata = item.metadata !== undefined ? parseSignedDescriptor(item.metadata, now, { allowLoopback }) : undefined;
  return {
    ...(item as unknown as ProArtifactDescriptor),
    ...(targetMetadata ? { targetMetadata } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

async function requestDescriptor(token: string, endpoint: string, expected: { version: string; descriptorSha256: string }, deps: { fetch: typeof fetch; signal: AbortSignal; now: number; allowLoopback: boolean }): Promise<{ status: number; value?: ProArtifactDescriptor }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const abort = () => controller.abort();
  if (deps.signal.aborted) controller.abort();
  deps.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await deps.fetch(endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(expected),
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, value: parse(await response.json(), expected, deps.now, deps.allowLoopback) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(deps.signal.aborted ? "CANCELLED" : "NETWORK_ERROR", deps.signal.aborted ? "pro download cancelled" : "pro descriptor request failed");
  } finally { clearTimeout(timer); deps.signal.removeEventListener("abort", abort); }
}

/** Exchange auth for the Pro descriptor (token dance + error mapping). */
export async function fetchProDescriptor(context: CommandContext, auth: AuthUseCaseDependencies, expected: { version: string; descriptorSha256: string }, deps: {
  readonly fetch?: typeof fetch;
} = {}): Promise<ProArtifactDescriptor> {
  const fetchFn = deps.fetch ?? fetch;
  const { url: endpoint, allowLoopback } = resolveProDescriptorEndpoint(context.env);
  let token = await runAccessTokenUseCase(context, auth);
  const now = () => context.now().getTime();
  let response = await requestDescriptor(token, endpoint, expected, { fetch: fetchFn, signal: context.signal, now: now(), allowLoopback });
  if (response.status === 401) {
    token = await runAccessTokenUseCase(context, auth, true);
    response = await requestDescriptor(token, endpoint, expected, { fetch: fetchFn, signal: context.signal, now: now(), allowLoopback });
  }
  token = "";
  if (response.status === 401) throw new CliError("AUTH_ERROR", "pro download authentication failed after one refresh");
  if (response.status === 403) throw new CliError("FORBIDDEN", "active pro entitlement required");
  if (response.status === 404) throw new CliError("NOT_FOUND", "pro artifact not found");
  if (!response.value) throw new CliError("NETWORK_ERROR", `pro descriptor request failed with ${response.status}`);
  return response.value;
}

/** Extract + verify the pro metadata archive; the manifest must match the pro release. */
export function extractProMetadata(artifactBytes: Uint8Array, catalogSha256: string, version: string):
  { readonly manifestJson: string; readonly manualMd: string; readonly catalogJson: string } {
  const result = extractAndVerifyMetadataArchive(artifactBytes, {
    expectedCatalogSha: catalogSha256,
    expectedTier: "pro",
    expectedVersion: version,
  });
  if (result.kind !== "ok") throw new CliError("VALIDATION_ERROR", result.message);
  return result.value;
}

/** Shared signed-download options for the Pro archive (endpoint-aware loopback). */
export function proSignedDownloadOptions(context: CommandContext, deps: {
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
} = {}) {
  const { allowLoopback, loopbackHost } = resolveProDescriptorEndpoint(context.env);
  return {
    allowedHosts: deps.allowedHosts ?? (loopbackHost ? [...PRO_DOWNLOAD_HOSTS, loopbackHost] : PRO_DOWNLOAD_HOSTS),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    signal: context.signal,
    now: context.now().getTime(),
    ...(allowLoopback ? { allowLoopback: true } : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  };
}

export async function downloadProArtifact(context: CommandContext, auth: AuthUseCaseDependencies, expected: { version: string; descriptorSha256: string }, deps: {
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
} = {}): Promise<{ readonly descriptor: ProArtifactDescriptor; readonly artifactBytes: Uint8Array; readonly catalogJson: string; readonly manifestJson: string; readonly manualMd: string; readonly metadataSha256: string; readonly metadataBytes?: Uint8Array }> {
  const fetchFn = deps.fetch ?? fetch;
  const descriptor = await fetchProDescriptor(context, auth, expected, { fetch: fetchFn });
  const downloadOptions = proSignedDownloadOptions(context, deps);
  const artifactBytes = await downloadSignedArtifact({ url: descriptor.url, expiresAt: descriptor.expiresAt, size: descriptor.size, sha256: descriptor.sha256 }, downloadOptions);
  const extracted = extractTarGz(artifactBytes, { maxEntries: 20_000, maxExpandedBytes: 64 * 1024 * 1024 });
  if (extracted.errors.length > 0) throw new CliError("VALIDATION_ERROR", extracted.errors[0] ?? "invalid pro archive");
  const catalog = extracted.files[descriptor.catalogFilename] ?? extracted.files[`./${descriptor.catalogFilename}`];
  if (!catalog || sha256Bytes(catalog) !== descriptor.catalogSha256) throw new CliError("VALIDATION_ERROR", "pro catalog SHA-256 mismatch");

  let metadata: { manifestJson: string; manualMd: string } | undefined;
  let metadataBytes: Uint8Array | undefined;
  if (descriptor.metadata) {
    metadataBytes = await downloadSignedArtifact(descriptor.metadata, downloadOptions);
    metadata = extractProMetadata(metadataBytes, descriptor.catalogSha256, descriptor.version);
  } else {
    throw new CliError("VALIDATION_ERROR", "pro release descriptor is missing the metadata archive");
  }
  return {
    descriptor,
    artifactBytes,
    catalogJson: decodeUtf8(catalog),
    manifestJson: metadata.manifestJson,
    manualMd: metadata.manualMd,
    metadataSha256: descriptor.metadata.sha256,
    metadataBytes,
  };
}
