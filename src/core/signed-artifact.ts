import { CliError } from "../errors/index.js";
import { readFile } from "node:fs/promises";
import { downloadArtifactToFile, type DownloadedFile } from "../project/install.js";
import type { DownloadScheduler } from "../project/download-scheduler.js";

const API_ORIGIN = "https://api.moeicons.com";
const SHA256 = /^[a-f0-9]{64}$/;

export interface SignedArtifactDescriptor {
  readonly url: string;
  readonly expiresAt: string;
  readonly size: number;
  readonly sha256: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function parseSignedDescriptor(
  value: unknown,
  now: number,
  options: { readonly allowLoopback?: boolean } = {},
): SignedArtifactDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError("VALIDATION_ERROR", "invalid signed artifact descriptor");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !["url", "expiresAt", "size", "sha256"].includes(key)) ||
    typeof item.url !== "string" ||
    typeof item.expiresAt !== "string" ||
    typeof item.size !== "number" ||
    !Number.isSafeInteger(item.size) ||
    item.size < 1 ||
    typeof item.sha256 !== "string" ||
    !SHA256.test(item.sha256)
  ) {
    throw new CliError("VALIDATION_ERROR", "invalid signed artifact descriptor");
  }
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    throw new CliError("VALIDATION_ERROR", "invalid signed artifact URL");
  }
  const expires = Date.parse(item.expiresAt);
  const loopbackHttp =
    options.allowLoopback === true && url.protocol === "http:" && isLoopback(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || !Number.isFinite(expires) || expires <= now) {
    throw new CliError("VALIDATION_ERROR", "signed artifact descriptor is expired or insecure");
  }
  return item as unknown as SignedArtifactDescriptor;
}

/**
 * Exchange an access token for a descriptor. The caller supplies only the
 * frozen API path; credentials can never be sent to another origin. The
 * descriptor request uses `redirect: "error"` — an API endpoint must never
 * bounce us to an untrusted host mid-handshake (unlike the large signed-artifact
 * download below, which follows a bounded number of CDN redirects).
 */
export async function fetchSignedArtifactDescriptor(
  apiPath: string,
  accessToken: string,
  deps: {
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly now?: number;
  } = {},
): Promise<SignedArtifactDescriptor> {
  const url = new URL(apiPath, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !apiPath.startsWith("/"))
    throw new CliError("VALIDATION_ERROR", "pro descriptor path must use the trusted API origin");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  const abort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok)
      throw new CliError(
        response.status === 401
          ? "AUTH_ERROR"
          : response.status === 403
            ? "FORBIDDEN"
            : "NETWORK_ERROR",
        `pro descriptor request failed with ${response.status}`,
      );
    return parseSignedDescriptor(await response.json(), deps.now ?? Date.now());
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      deps.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR",
      deps.signal?.aborted ? "pro descriptor request cancelled" : "pro descriptor request failed",
    );
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

export interface SignedDownloadOptions {
  readonly allowedHosts: readonly string[];
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly now?: number;
  readonly allowLoopback?: boolean;
  readonly onProgress?: (event: {
    readonly downloadedBytes: number;
    readonly totalBytes?: number;
  }) => void;
  /** REF-04: transient-failure retry (default on for file downloads). */
  readonly maxAttempts?: number;
  readonly stallTimeoutMs?: number;
  readonly scheduler?: DownloadScheduler;
}

function downloadLimitsFor(checked: SignedArtifactDescriptor, options: SignedDownloadOptions) {
  return {
    maxBytes: checked.size,
    timeoutMs:
      options.timeoutMs ??
      Math.min(600_000, Math.max(30_000, Math.ceil(checked.size / (128 * 1024)) * 1_000 + 15_000)),
    maxRedirects: options.maxRedirects ?? 5,
    allowedHosts: options.allowedHosts,
    ...(options.allowLoopback ? { allowHttpLoopback: true } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.stallTimeoutMs !== undefined ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  } as const;
}

/**
 * P0-02: download a signed resource to a verified local file. The caller owns
 * the file and MUST call `cleanup()` after extraction/commit.
 */
export async function downloadSignedArtifactToFile(
  descriptor: SignedArtifactDescriptor,
  options: SignedDownloadOptions,
): Promise<DownloadedFile> {
  if (options.signal?.aborted)
    throw new CliError("CANCELLED", "signed resource download cancelled");
  const checked = parseSignedDescriptor(descriptor, options.now ?? Date.now(), options);
  const result = await downloadArtifactToFile(checked.url, downloadLimitsFor(checked, options), {
    ...(options.fetch ? { fetchFn: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.signal?.aborted) {
    if (result.ok) await result.file.cleanup();
    throw new CliError("CANCELLED", "signed resource download cancelled");
  }
  if (!result.ok)
    throw new CliError(
      result.code === "NETWORK_ERROR" ? "NETWORK_ERROR" : "VALIDATION_ERROR",
      result.message,
      { phase: "download", retryable: result.retryable === true },
    );
  if (result.file.size !== checked.size) {
    await result.file.cleanup();
    throw new CliError(
      "VALIDATION_ERROR",
      `artifact size mismatch: expected ${checked.size}, got ${result.file.size}`,
      { phase: "verify" },
    );
  }
  if (result.file.sha256.toLowerCase() !== checked.sha256.toLowerCase()) {
    const actual = result.file.sha256;
    await result.file.cleanup();
    throw new CliError(
      "VALIDATION_ERROR",
      `artifact SHA-256 mismatch: expected ${checked.sha256}, got ${actual}`,
      { phase: "verify" },
    );
  }
  return result.file;
}

/**
 * Small-metadata convenience wrapper. Large resources MUST use the file API so
 * the whole package is never read back into memory.
 */
export async function downloadSignedArtifact(
  descriptor: SignedArtifactDescriptor,
  options: SignedDownloadOptions,
): Promise<Uint8Array> {
  const file = await downloadSignedArtifactToFile(descriptor, options);
  try {
    const buffer = await readFile(file.path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    await file.cleanup();
  }
}
