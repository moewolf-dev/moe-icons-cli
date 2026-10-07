import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts?: readonly string[];
  readonly userAgent?: string;
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
  readonly allowHttpLoopback?: boolean;
}

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly finalUrl: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Download an artifact. HTTPS only, optional host allowlist, bounded redirects,
 * timeout, byte limit. Abort and temporary-file cleanup are handled by the
 * caller via the injected fetch/signal.
 *
 * Redirect policy: unlike the API descriptor handshake (which uses
 * `redirect: "error"`), payload downloads intentionally follow a bounded number
 * of redirects because code/metadata archives are served from CDNs that 3xx to
 * a signed object host; the destination host is re-checked against the
 * allowlist on every hop.
 */
export async function downloadArtifact(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DownloadResult> {
  if (deps.signal?.aborted) return { ok: false, code: "CANCELLED", message: "download cancelled" };
  const parsed = new URL(url);
  const loopbackHttp = limits.allowHttpLoopback === true && parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return { ok: false, code: "NON_HTTPS", message: "artifact URLs must use https" };
  }
  if (limits.allowedHosts && !limits.allowedHosts.includes(parsed.host)) {
    return { ok: false, code: "HOST_NOT_ALLOWED", message: `host ${parsed.host} not in allowlist` };
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const abortHandler = () => controller.abort();
  deps.signal?.addEventListener("abort", abortHandler, { once: true });

  let response: Response | undefined;
  let temporary: string | undefined;
  let file: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      response = await fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        ...(limits.userAgent ? { headers: { "user-agent": limits.userAgent } } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        redirects += 1;
        if (redirects > limits.maxRedirects) {
          return { ok: false, code: "TOO_MANY_REDIRECTS", message: `exceeded ${limits.maxRedirects} redirects` };
        }
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, code: "REDIRECT_NO_LOCATION", message: "redirect without location header" };
        }
        currentUrl = new URL(location, currentUrl).toString();
        const next = new URL(currentUrl);
        const nextLoopback = limits.allowHttpLoopback === true && next.protocol === "http:" && (next.hostname === "127.0.0.1" || next.hostname === "localhost" || next.hostname === "::1");
        if (next.protocol !== "https:" && !nextLoopback) {
          return { ok: false, code: "NON_HTTPS", message: "redirect to non-https url" };
        }
        if (limits.allowedHosts && !limits.allowedHosts.includes(next.host)) {
          return { ok: false, code: "HOST_NOT_ALLOWED", message: `redirect host ${next.host} not in allowlist` };
        }
        continue;
      }
      break;
    }

    if (!response || response.status >= 400) {
      return { ok: false, code: "HTTP_ERROR", message: `request failed with ${response.status ?? "unknown"}` };
    }

    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    if (contentLength !== undefined && contentLength > limits.maxBytes) {
      return { ok: false, code: "TOO_LARGE", message: `content-length ${contentLength} exceeds limit` };
    }

    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        downloadedBytes += value.byteLength;
        if (downloadedBytes > limits.maxBytes) {
          await reader.cancel();
          return { ok: false, code: "TOO_LARGE", message: `body exceeds byte limit ${limits.maxBytes}` };
        }
        if (!file && downloadedBytes > 8 * 1024 * 1024) {
          temporary = await mkdtemp(join(tmpdir(), "moeicons-download-"));
          file = await open(join(temporary, "bytes"), "wx", 0o600);
          for (const previous of chunks) await file.writeFile(previous);
          chunks.length = 0;
        }
        if (file) await file.writeFile(value);
        else chunks.push(value);
        limits.onProgress?.({ downloadedBytes, ...(contentLength !== undefined ? { totalBytes: contentLength } : {}) });
      }
    } else {
      const buffer = await response.arrayBuffer();
      downloadedBytes = buffer.byteLength;
      if (downloadedBytes > limits.maxBytes) return { ok: false, code: "TOO_LARGE", message: `body exceeds byte limit ${limits.maxBytes}` };
      chunks.push(new Uint8Array(buffer));
      limits.onProgress?.({ downloadedBytes, ...(contentLength !== undefined ? { totalBytes: contentLength } : {}) });
    }
    if (file) {
      await file.close(); file = undefined;
      const bytes = await readFile(join(temporary!, "bytes"));
      if (controller.signal.aborted) return { ok: false, code: deps.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", message: "download aborted" };
      return { ok: true, bytes, finalUrl: currentUrl };
    }
    const bytes = new Uint8Array(downloadedBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, bytes, finalUrl: currentUrl };
  } catch (error) {
    return {
      ok: false,
      code: controller.signal.aborted ? (deps.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR") : "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (reader) { try { await reader.cancel(); } catch { /* Stream may already be closed. */ } reader.releaseLock(); }
    else { try { await response?.body?.cancel(); } catch { /* Redirect or error response. */ } }
    if (file) await file.close().catch(() => undefined);
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abortHandler);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

/** Verify a downloaded artifact against an expected SHA-256 (and optional signature). */
export function verifyArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return { ok: actual.toLowerCase() === expectedSha256.toLowerCase(), actual };
}
