import { CliError } from "../errors/index.js";
import { downloadArtifact, verifyArtifact } from "../project/install.js";

const API_ORIGIN = "https://api.moeicons.com";
const SHA256 = /^[a-f0-9]{64}$/;

export interface SignedArtifactDescriptor {
  readonly url: string;
  readonly expiresAt: string;
  readonly size: number;
  readonly sha256: string;
}

function parseDescriptor(value: unknown, now: number): SignedArtifactDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError("VALIDATION_ERROR", "invalid signed artifact descriptor");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["url", "expiresAt", "size", "sha256"].includes(key)) ||
      typeof item.url !== "string" || typeof item.expiresAt !== "string" ||
      typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 1 ||
      typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
    throw new CliError("VALIDATION_ERROR", "invalid signed artifact descriptor");
  }
  let url: URL;
  try { url = new URL(item.url); } catch { throw new CliError("VALIDATION_ERROR", "invalid signed artifact URL"); }
  const expires = Date.parse(item.expiresAt);
  if (url.protocol !== "https:" || !Number.isFinite(expires) || expires <= now) throw new CliError("VALIDATION_ERROR", "signed artifact descriptor is expired or insecure");
  return item as unknown as SignedArtifactDescriptor;
}

/**
 * Exchange an access token for a descriptor. The caller supplies only the
 * frozen API path; credentials can never be sent to another origin.
 */
export async function fetchSignedArtifactDescriptor(apiPath: string, accessToken: string, deps: {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: number;
} = {}): Promise<SignedArtifactDescriptor> {
  const url = new URL(apiPath, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !apiPath.startsWith("/")) throw new CliError("VALIDATION_ERROR", "pro descriptor path must use the trusted API origin");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  const abort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new CliError(response.status === 401 ? "AUTH_ERROR" : response.status === 403 ? "FORBIDDEN" : "NETWORK_ERROR", `pro descriptor request failed with ${response.status}`);
    return parseDescriptor(await response.json(), deps.now ?? Date.now());
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(deps.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", deps.signal?.aborted ? "pro descriptor request cancelled" : "pro descriptor request failed");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

/** Download signed bytes without forwarding API credentials or cookies. */
export async function downloadSignedArtifact(descriptor: SignedArtifactDescriptor, options: {
  readonly allowedHosts: readonly string[];
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly now?: number;
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
}): Promise<Uint8Array> {
  const checked = parseDescriptor(descriptor, options.now ?? Date.now());
  const result = await downloadArtifact(checked.url, {
    maxBytes: checked.size,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRedirects: options.maxRedirects ?? 5,
    allowedHosts: options.allowedHosts,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }, {
    ...(options.fetch ? { fetchFn: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!result.ok) throw new CliError(result.code === "NETWORK_ERROR" ? "NETWORK_ERROR" : "VALIDATION_ERROR", result.message);
  if (result.bytes.byteLength !== checked.size) throw new CliError("VALIDATION_ERROR", `artifact size mismatch: expected ${checked.size}, got ${result.bytes.byteLength}`);
  const verified = verifyArtifact(result.bytes, checked.sha256);
  if (!verified.ok) throw new CliError("VALIDATION_ERROR", `artifact SHA-256 mismatch: expected ${checked.sha256}, got ${verified.actual}`);
  return result.bytes;
}
