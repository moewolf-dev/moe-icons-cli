import { CliError } from "../errors/index.js";
import { extractTarGz, decodeUtf8 } from "../project/tar-gz.js";
import { sha256Bytes } from "../project/install-metadata.js";
import { downloadSignedArtifact, type SignedArtifactDescriptor } from "./signed-artifact.js";
import { runAccessTokenUseCase, type AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";

const ENDPOINT = "https://api.moeicons.com/v1/icon-library/pro/artifact-descriptor";
export const PRO_DOWNLOAD_HOSTS = ["06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com"] as const;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/;

export interface ProArtifactDescriptor extends SignedArtifactDescriptor {
  readonly tier: "pro";
  readonly version: string;
  readonly descriptorSha256: string;
  readonly catalogFilename: "catalog.json";
  readonly catalogSha256: string;
}

function parse(value: unknown, expected: { version: string; descriptorSha256: string }): ProArtifactDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError("VALIDATION_ERROR", "invalid pro artifact descriptor");
  const item = value as Record<string, unknown>;
  const allowed = ["ok", "tier", "version", "descriptorSha256", "catalogFilename", "catalogSha256", "url", "expiresAt", "size", "sha256"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || item.ok !== true || item.tier !== "pro" || item.version !== expected.version || item.descriptorSha256 !== expected.descriptorSha256 ||
      typeof item.version !== "string" || !VERSION.test(item.version) || typeof item.descriptorSha256 !== "string" || !SHA.test(item.descriptorSha256) ||
      item.catalogFilename !== "catalog.json" || typeof item.catalogSha256 !== "string" || !SHA.test(item.catalogSha256) || typeof item.url !== "string" ||
      typeof item.expiresAt !== "string" || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 1 || typeof item.sha256 !== "string" || !SHA.test(item.sha256)) {
    throw new CliError("VALIDATION_ERROR", "invalid or changed pro artifact descriptor");
  }
  return item as unknown as ProArtifactDescriptor;
}

async function requestDescriptor(token: string, expected: { version: string; descriptorSha256: string }, deps: { fetch: typeof fetch; signal: AbortSignal }): Promise<{ status: number; value?: ProArtifactDescriptor }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const abort = () => controller.abort();
  if (deps.signal.aborted) controller.abort();
  deps.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await deps.fetch(ENDPOINT, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(expected),
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, value: parse(await response.json(), expected) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(deps.signal.aborted ? "CANCELLED" : "NETWORK_ERROR", deps.signal.aborted ? "pro download cancelled" : "pro descriptor request failed");
  } finally { clearTimeout(timer); deps.signal.removeEventListener("abort", abort); }
}

export async function downloadProArtifact(context: CommandContext, auth: AuthUseCaseDependencies, expected: { version: string; descriptorSha256: string }, deps: {
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
} = {}): Promise<{ readonly descriptor: ProArtifactDescriptor; readonly artifactBytes: Uint8Array; readonly catalogJson: string }> {
  const fetchFn = deps.fetch ?? fetch;
  let token = await runAccessTokenUseCase(context, auth);
  let response = await requestDescriptor(token, expected, { fetch: fetchFn, signal: context.signal });
  if (response.status === 401) {
    token = await runAccessTokenUseCase(context, auth, true);
    response = await requestDescriptor(token, expected, { fetch: fetchFn, signal: context.signal });
  }
  token = "";
  if (response.status === 401) throw new CliError("AUTH_ERROR", "pro download authentication failed after one refresh");
  if (response.status === 403) throw new CliError("FORBIDDEN", "active pro entitlement required");
  if (response.status === 404) throw new CliError("NOT_FOUND", "pro artifact not found");
  if (!response.value) throw new CliError("NETWORK_ERROR", `pro descriptor request failed with ${response.status}`);
  const descriptor = response.value;
  const artifactBytes = await downloadSignedArtifact({ url: descriptor.url, expiresAt: descriptor.expiresAt, size: descriptor.size, sha256: descriptor.sha256 }, { allowedHosts: deps.allowedHosts ?? PRO_DOWNLOAD_HOSTS, fetch: fetchFn, signal: context.signal, now: context.now().getTime(), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) });
  const extracted = extractTarGz(artifactBytes, { maxEntries: 20_000, maxExpandedBytes: 64 * 1024 * 1024 });
  if (extracted.errors.length > 0) throw new CliError("VALIDATION_ERROR", extracted.errors[0] ?? "invalid pro archive");
  const catalog = extracted.files[descriptor.catalogFilename] ?? extracted.files[`./${descriptor.catalogFilename}`];
  if (!catalog || sha256Bytes(catalog) !== descriptor.catalogSha256) throw new CliError("VALIDATION_ERROR", "pro catalog SHA-256 mismatch");
  return { descriptor, artifactBytes, catalogJson: decodeUtf8(catalog) };
}
