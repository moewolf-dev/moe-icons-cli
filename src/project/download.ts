import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDownloadScheduler,
  type DownloadKind,
  type DownloadScheduler,
} from "./download-scheduler.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleep as defaultSleep,
} from "./retry-policy.js";

export interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts?: readonly string[];
  readonly userAgent?: string;
  readonly onProgress?: (event: {
    readonly downloadedBytes: number;
    readonly totalBytes?: number;
  }) => void;
  readonly allowHttpLoopback?: boolean;
  /** P0-03: package bodies occupy a shared slot; metadata has its own bounded pool. */
  readonly kind?: DownloadKind;
  /** REF-04: retry transient failures. Legacy `downloadArtifact` keeps this off. */
  readonly retry?: boolean;
  readonly maxAttempts?: number;
  /** Abort when no body chunk arrives for this long (default 30s). */
  readonly stallTimeoutMs?: number;
  /** Staging directory override (tests/embedding); defaults to os.tmpdir(). */
  readonly tempDir?: string;
  readonly retryAfterCapMs?: number;
  readonly scheduler?: DownloadScheduler;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A verified download is a local file, never an in-memory copy of the package. */
export interface DownloadedFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly finalUrl: string;
  /** Removes the temporary directory. Idempotent; must run after consumption. */
  readonly cleanup: () => Promise<void>;
}

export type DownloadFileResult =
  | { readonly ok: true; readonly file: DownloadedFile; readonly attempts: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly attempts: number;
      readonly retryable?: boolean;
    };

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly finalUrl: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface AttemptSuccess {
  readonly ok: true;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly finalUrl: string;
  readonly directory: string;
}

interface AttemptFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | undefined;
}

/**
 * Temp directories are tracked so a SIGINT/SIGTERM shutdown can remove partial
 * payloads even if a caller never reaches its cleanup. The wrapper owns signal
 * handling; this registry only exposes a synchronous sweep.
 */
const liveTempDirectories = new Set<string>();

export function cleanupDownloadTempDirsSync(): number {
  let removed = 0;
  for (const directory of [...liveTempDirectories]) {
    try {
      rmSync(directory, { recursive: true, force: true });
      removed += 1;
      liveTempDirectories.delete(directory);
    } catch {
      /* Best effort on shutdown. */
    }
  }
  return removed;
}

function loopbackAllowed(url: URL, limits: DownloadLimits): boolean {
  return (
    limits.allowHttpLoopback === true &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
  );
}

function validateUrl(url: string, limits: DownloadLimits): AttemptFailure | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "VALIDATION_ERROR", message: "invalid artifact URL" };
  }
  if (parsed.protocol !== "https:" && !loopbackAllowed(parsed, limits)) {
    return { ok: false, code: "NON_HTTPS", message: "artifact URLs must use https" };
  }
  if (limits.allowedHosts && !limits.allowedHosts.includes(parsed.host)) {
    return { ok: false, code: "HOST_NOT_ALLOWED", message: `host ${parsed.host} not in allowlist` };
  }
  return undefined;
}

function classifyDownloadError(error: unknown): AttemptFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC") {
    return {
      ok: false,
      code: "DISK_FULL",
      message: "not enough disk space for the download",
      retryable: false,
    };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return {
      ok: false,
      code: "IO_ERROR",
      message: `cannot write the temporary download: ${raw}`,
      retryable: false,
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: `DNS lookup failed: ${raw}`,
      retryable: true,
    };
  }
  if (/certificate|self[- ]signed|TLS|SSL/i.test(raw)) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: `TLS verification failed: ${raw}`,
      retryable: false,
    };
  }
  return { ok: false, code: "NETWORK_ERROR", message: raw, retryable: true };
}

class DownloadAbortError extends Error {
  constructor(readonly reason: "timeout" | "stall" | "cancelled") {
    super(
      reason === "timeout"
        ? "download timed out"
        : reason === "stall"
          ? "download stalled"
          : "download cancelled",
    );
    this.name = "DownloadAbortError";
  }
}

/** One network attempt: redirects + body streaming + incremental SHA-256. */
async function attemptOnce(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn: typeof fetch; signal?: AbortSignal },
): Promise<AttemptSuccess | AttemptFailure> {
  if (deps.signal?.aborted) return { ok: false, code: "CANCELLED", message: "download cancelled" };
  const initial = validateUrl(url, limits);
  if (initial) return initial;

  const controller = new AbortController();
  let abortReason: DownloadAbortError | undefined;
  const timeout = setTimeout(() => {
    abortReason = new DownloadAbortError("timeout");
    controller.abort();
  }, limits.timeoutMs);
  const stallMs = limits.stallTimeoutMs ?? 30_000;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const resetStall = () => {
    if (stallMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortReason = new DownloadAbortError("stall");
      controller.abort();
    }, stallMs);
  };
  const abortHandler = () => {
    abortReason ??= new DownloadAbortError("cancelled");
    controller.abort();
  };
  deps.signal?.addEventListener("abort", abortHandler, { once: true });
  if (deps.signal?.aborted) abortHandler();

  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: FileHandle | undefined;
  let directory: string | undefined;
  let succeeded = false;
  try {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      response = await deps.fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        ...(limits.userAgent ? { headers: { "user-agent": limits.userAgent } } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        redirects += 1;
        if (redirects > limits.maxRedirects) {
          return {
            ok: false,
            code: "TOO_MANY_REDIRECTS",
            message: `exceeded ${limits.maxRedirects} redirects`,
          };
        }
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: false,
            code: "REDIRECT_NO_LOCATION",
            message: "redirect without location header",
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        const next = validateUrl(currentUrl, limits);
        if (next)
          return {
            ...next,
            message: `redirect to ${next.code === "NON_HTTPS" ? "non-https url" : next.message}`,
          };
        continue;
      }
      break;
    }

    if (!response) return { ok: false, code: "NETWORK_ERROR", message: "no response" };
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        code: "HTTP_ERROR",
        message: `request failed with ${response.status}`,
        retryable: isRetryableStatus(response.status),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }

    const rawLength = response.headers.get("content-length");
    const contentLength =
      rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    if (contentLength !== undefined && contentLength > limits.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        code: "TOO_LARGE",
        message: `content-length ${contentLength} exceeds limit`,
      };
    }

    directory = await mkdtemp(join(limits.tempDir ?? tmpdir(), "moeicons-download-"));
    liveTempDirectories.add(directory);
    const path = join(directory, "payload");
    file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let downloadedBytes = 0;

    if (response.body) {
      resetStall();
      reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        resetStall();
        downloadedBytes += value.byteLength;
        if (downloadedBytes > limits.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return {
            ok: false,
            code: "TOO_LARGE",
            message: `body exceeds byte limit ${limits.maxBytes}`,
          };
        }
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const written = await file.write(value, offset, value.byteLength - offset);
          offset += written.bytesWritten;
        }
        limits.onProgress?.({
          downloadedBytes,
          ...(contentLength !== undefined ? { totalBytes: contentLength } : {}),
        });
      }
      reader.releaseLock();
      reader = undefined;
    } else if (contentLength !== undefined && contentLength > 0) {
      return { ok: false, code: "NETWORK_ERROR", message: "response body is missing" };
    }

    await file.close();
    file = undefined;
    if (contentLength !== undefined && downloadedBytes !== contentLength) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: `truncated response: expected ${contentLength} bytes, received ${downloadedBytes}`,
        retryable: true,
      };
    }
    if (deps.signal?.aborted || abortReason?.reason === "cancelled") {
      return { ok: false, code: "CANCELLED", message: "download cancelled" };
    }
    if (abortReason) {
      // A timeout/stall already consumed the bounded wait; do not multiply it.
      return { ok: false, code: "NETWORK_ERROR", message: abortReason.message, retryable: false };
    }
    succeeded = true;
    return {
      ok: true,
      path,
      sha256: hash.digest("hex"),
      size: downloadedBytes,
      finalUrl: currentUrl,
      directory,
    };
  } catch (error) {
    if (deps.signal?.aborted)
      return { ok: false, code: "CANCELLED", message: "download cancelled" };
    if (abortReason?.reason === "cancelled")
      return { ok: false, code: "CANCELLED", message: "download cancelled" };
    if (abortReason) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: abortReason.message,
        retryable: false,
      };
    }
    return classifyDownloadError(error);
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* Stream may already be closed. */
      }
      reader.releaseLock();
    } else {
      await response?.body?.cancel().catch(() => undefined);
    }
    if (file) await file.close().catch(() => undefined);
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(timeout);
    deps.signal?.removeEventListener("abort", abortHandler);
    if (!succeeded && directory) {
      liveTempDirectories.delete(directory);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Download a resource to a verified local temporary file.
 *
 * P0-02: the body is never accumulated in memory; the SHA-256 is computed
 * incrementally while writing. P0-03: each attempt runs inside the shared
 * scheduler; backoff between attempts holds no slot.
 */
export async function downloadArtifactToFile(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DownloadFileResult> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const scheduler = limits.scheduler ?? getDownloadScheduler();
  const retry = limits.retry ?? true;
  const maxAttempts = Math.max(
    1,
    Math.min(10, limits.maxAttempts ?? (retry ? DEFAULT_MAX_ATTEMPTS : 1)),
  );
  const kind: DownloadKind = limits.kind ?? "package";
  const sleep = limits.sleep ?? defaultSleep;
  let attempts = 0;
  let last: AttemptFailure | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    if (deps.signal?.aborted)
      return { ok: false, code: "CANCELLED", message: "download cancelled", attempts };
    const result = await scheduler.run(kind, () =>
      attemptOnce(url, limits, { fetchFn, ...(deps.signal ? { signal: deps.signal } : {}) }),
    );
    if (result.ok) {
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        liveTempDirectories.delete(result.directory);
        await rm(result.directory, { recursive: true, force: true }).catch(() => undefined);
      };
      return {
        ok: true,
        attempts,
        file: {
          path: result.path,
          sha256: result.sha256,
          size: result.size,
          finalUrl: result.finalUrl,
          cleanup,
        },
      };
    }
    last = result;
    if (!result.retryable || !retry || attempt === maxAttempts || deps.signal?.aborted) break;
    const delay = retryDelayMs(attempt, {
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      ...(limits.retryAfterCapMs !== undefined ? { maxRetryAfterMs: limits.retryAfterCapMs } : {}),
      ...(limits.random ? { random: limits.random } : {}),
    });
    await sleep(delay);
  }
  return {
    ok: false,
    code: last?.code ?? "NETWORK_ERROR",
    message: last?.message ?? "download failed",
    attempts,
    ...(last?.retryable !== undefined ? { retryable: last.retryable } : {}),
  };
}

/**
 * Legacy convenience API: downloads and returns bytes. It is retained only for
 * small descriptors/metadata and test fixtures; large artifacts MUST use
 * `downloadArtifactToFile` so a whole package is never resident in memory.
 * Retries stay off by default to preserve the single-attempt contract.
 */
export async function downloadArtifact(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DownloadResult> {
  const result = await downloadArtifactToFile(
    url,
    { ...limits, retry: limits.retry ?? false, maxAttempts: limits.maxAttempts ?? 1 },
    deps,
  );
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  try {
    const buffer = await readFile(result.file.path);
    return {
      ok: true,
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      finalUrl: result.file.finalUrl,
    };
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await result.file.cleanup();
  }
}

/** Streaming verification for a downloaded file (never reads it into memory). */
export async function verifyFileSha256(
  path: string,
  expectedSha256: string,
): Promise<{ ok: boolean; actual: string }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const actual = hash.digest("hex");
  return { ok: actual.toLowerCase() === expectedSha256.toLowerCase(), actual };
}

/** Verify a downloaded artifact against an expected SHA-256 (and optional signature). */
export function verifyArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return { ok: actual.toLowerCase() === expectedSha256.toLowerCase(), actual };
}
