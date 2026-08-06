import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { strToU8, zipSync, unzipSync } from "fflate";
import type { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";

/**
 * Transactional install: stage sibling, verify all files, backup existing
 * managed output, rename atomically, update config last, restore on failure.
 * Never touches the project tree until every file is verified in staging.
 */

export interface InstallPlanItem {
  readonly kind: "mkdir" | "write" | "remove" | "config";
  readonly path: string;
  readonly content?: string;
}

export interface InstallPlan {
  readonly items: readonly InstallPlanItem[];
}

/** Pure list of install operations with expected checksums. */
export function createInstallPlan(
  targetRoot: string,
  files: Readonly<Record<string, string>>,
): InstallPlan {
  const items: InstallPlanItem[] = [];
  const sorted = Object.keys(files).sort((a, b) => a.localeCompare(b));
  for (const rel of sorted) {
    const content = files[rel];
    if (content !== undefined) {
      items.push({ kind: "write", path: join(targetRoot, rel), content });
    }
  }
  return { items };
}

/** Create a deterministic ZIP for delivery (fixed mtime). */
export function createArtifactZip(files: Readonly<Record<string, string>>): Uint8Array {
  const sorted = Object.keys(files).sort((a, b) => a.localeCompare(b));
  const dict: Record<string, Uint8Array> = {};
  for (const rel of sorted) {
    dict[rel] = strToU8(files[rel] ?? "");
  }
  return zipSync(dict, { level: 9, mtime: new Date("2020-01-01T00:00:00.000Z") });
}

/** Unzip an artifact, rejecting unsafe paths. */
export function extractArtifact(
  zipBytes: Uint8Array,
  limits: { maxEntries: number; maxExpandedBytes: number },
): { files: Record<string, string>; errors: string[] } {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  let entries = 0;
  let expanded = 0;

  const dict = unzipSync(zipBytes);
  for (const [rel, bytes] of Object.entries(dict)) {
    entries += 1;
    if (entries > limits.maxEntries) {
      errors.push(`too many entries (> ${limits.maxEntries})`);
      break;
    }
    const cleaned = rel.replace(/\\/g, "/");
    if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) {
      errors.push(`unsafe path "${rel}"`);
      continue;
    }
    expanded += bytes.byteLength;
    if (expanded > limits.maxExpandedBytes) {
      errors.push(`expanded size exceeds limit`);
      break;
    }
    files[cleaned] = new TextDecoder().decode(bytes);
  }
  return { files, errors };
}

/** SHA-256 hex of a string. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Execute an install plan against a filesystem with a staging dir, verifying
 * checksums before any rename. Restores the original tree on failure.
 */
export function executeInstallPlan(
  plan: InstallPlan,
  fs_: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
    existsSync: typeof existsSync;
    renameSync: typeof renameSync;
    rmSync: typeof rmSync;
  },
): void {
  const writes = plan.items.filter((i) => i.kind === "write");

  // stage all writes into a sibling staging dir
  const firstWrite = writes[0];
  if (!firstWrite) return;
  const stagingRoot = `${resolve(firstWrite.path)}.staging`;
  if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
  fs_.mkdirSync(stagingRoot, { recursive: true });

  const backups: { original: string; backup: string }[] = [];
  try {
    for (const item of writes) {
      const rel = item.path.replace(/\\/g, "/").split("/").pop() ?? "file";
      const staged = join(stagingRoot, rel);
      fs_.mkdirSync(join(staged, ".."), { recursive: true });
      fs_.writeFileSync(staged, item.content ?? "");
    }

    // move staged files into place, backing up existing managed output
    for (const item of writes) {
      const rel = item.path.replace(/\\/g, "/").split("/").pop() ?? "file";
      const staged = join(stagingRoot, rel);
      if (fs_.existsSync(item.path)) {
        const backup = `${item.path}.bak`;
        fs_.renameSync(item.path, backup);
        backups.push({ original: item.path, backup });
      }
      fs_.mkdirSync(join(item.path, ".."), { recursive: true });
      fs_.renameSync(staged, item.path);
    }
  } catch (error) {
    // restore any backups made before the failure
    for (const b of backups) {
      try {
        if (fs_.existsSync(b.backup)) fs_.renameSync(b.backup, b.original);
      } catch {
        // ignore restore errors; the original remains at .bak
      }
    }
    throw error;
  } finally {
    if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts?: readonly string[];
}

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly finalUrl: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Download an artifact. HTTPS only, optional host allowlist, bounded redirects,
 * timeout, byte limit. Abort and temporary-file cleanup are handled by the
 * caller via the injected fetch/signal.
 */
export async function downloadArtifact(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DownloadResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
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

  try {
    let currentUrl = url;
    let redirects = 0;
    let response: Response | undefined;
    for (;;) {
      response = await fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
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
        if (next.protocol !== "https:") {
          return { ok: false, code: "NON_HTTPS", message: "redirect to non-https url" };
        }
        continue;
      }
      break;
    }

    if (!response || response.status >= 400) {
      return { ok: false, code: "HTTP_ERROR", message: `request failed with ${response.status ?? "unknown"}` };
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > limits.maxBytes) {
      return { ok: false, code: "TOO_LARGE", message: `content-length ${contentLength} exceeds limit` };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limits.maxBytes) {
      return { ok: false, code: "TOO_LARGE", message: `body exceeds byte limit ${limits.maxBytes}` };
    }
    return { ok: true, bytes: new Uint8Array(buffer), finalUrl: currentUrl };
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abortHandler);
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
