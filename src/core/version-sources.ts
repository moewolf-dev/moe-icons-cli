/**
 * P0-01 / REF-06: independent npm and GitHub version evidence.
 *
 * npm metadata is the executable-install truth. A GitHub Release is an
 * independent release/source-evidence stream. They are fetched, cached and
 * reported separately; a conflict is displayed as two facts, never merged into
 * one "latest" number, and GitHub never produces an npm install command.
 */

import {
  detectInstallSource,
  detectLocalInstall,
  fixedUpdateInstruction,
  type CliUpdateFileSystem,
  type InstallSource,
} from "./cli-update.js";
import { fetchMoeiconsVersionsCached, latestInChannel } from "./version-service.js";
import { parseVersion } from "./update-policy.js";
import { CliError } from "../errors/index.js";

export type VersionSourceId = "npm" | "github";

export interface VersionSourceError {
  readonly code: "NETWORK_ERROR" | "VALIDATION_ERROR" | "RATE_LIMITED" | "TIMEOUT";
  readonly message: string;
}

export interface VersionSourceEvidence {
  readonly source: VersionSourceId;
  readonly status: "ok" | "unavailable" | "error";
  readonly checkedAt: string;
  readonly versions: readonly string[];
  readonly latestVersion?: string;
  readonly latestPublishedAt?: string;
  readonly error?: VersionSourceError;
}

export interface GithubRelease {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly publishedAt?: string;
}

export interface CliVersionCheck {
  readonly currentVersion: string;
  readonly installSource: InstallSource;
  readonly npm: VersionSourceEvidence;
  readonly github: VersionSourceEvidence;
  /** True only when npm proves a newer stable version exists. */
  readonly npmUpdateAvailable: boolean;
  readonly githubUpdateAvailable: boolean;
  readonly npmInstruction?: string;
  /** GitHub is a evidence/release channel; distribution must be documented. */
  readonly githubNote: string;
}

export const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/moewolf-dev/moe-icons-cli/releases?per_page=30";
export const CLI_UPDATE_DOCS_URL = "https://moeicons.com/docs/cli-update";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function nowIso(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

/** Test seam: only https or loopback http is accepted. */
export function resolveGithubReleasesEndpoint(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.MOEICONS_GITHUB_RELEASES_URL;
  if (!override) return GITHUB_RELEASES_URL;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_GITHUB_RELEASES_URL is not a valid URL");
  }
  const loopback = parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new CliError(
      "VALIDATION_ERROR",
      "MOEICONS_GITHUB_RELEASES_URL must be https or loopback http",
    );
  }
  return override;
}

async function boundedJson(
  url: string,
  fetchFn: typeof fetch,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly headers?: Record<string, string>;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "moeicons-cli",
        ...(options.headers ?? {}),
      },
    });
    if (response.status === 429 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError("NETWORK_ERROR", `rate limited (HTTP ${response.status})`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError("NETWORK_ERROR", `request failed with ${response.status}`);
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw new CliError("VALIDATION_ERROR", "version response exceeds size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CliError("VALIDATION_ERROR", "empty version response");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const value = part.value as Uint8Array;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CliError("VALIDATION_ERROR", "version response exceeds size limit");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new CliError("VALIDATION_ERROR", "invalid version response JSON");
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function parseGithubReleases(value: unknown, now = Date.now()): GithubRelease[] {
  if (!Array.isArray(value))
    throw new CliError("VALIDATION_ERROR", "invalid GitHub releases response");
  const releases: GithubRelease[] = [];
  for (const entry of value.slice(0, 100)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.tag_name !== "string") continue;
    const version = item.tag_name.replace(/^v/, "");
    if (!parseVersion(version)) continue;
    const published = typeof item.published_at === "string" ? item.published_at : undefined;
    if (published && !Number.isFinite(Date.parse(published))) continue;
    if (published && Date.parse(published) > now + 24 * 60 * 60 * 1000) continue;
    releases.push({
      tag: item.tag_name,
      version,
      prerelease: item.prerelease === true,
      draft: item.draft === true,
      ...(published ? { publishedAt: published } : {}),
    });
  }
  return releases;
}

const GITHUB_CACHE_TTL_MS = 5 * 60 * 1_000;
let githubCache:
  | { readonly key: string; readonly expiresAt: number; readonly evidence: VersionSourceEvidence }
  | undefined;

/** Test seam: clear the short-lived GitHub evidence cache. */
export function resetVersionEvidenceCache(): void {
  githubCache = undefined;
}

export async function fetchGithubEvidence(
  deps: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly now?: () => Date;
  } = {},
): Promise<VersionSourceEvidence> {
  const checkedAt = nowIso(deps.now);
  const cacheKey = resolveGithubReleasesEndpoint(deps.env ?? {});
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  if (
    !deps.signal &&
    githubCache &&
    githubCache.key === cacheKey &&
    githubCache.expiresAt > nowMs
  ) {
    return githubCache.evidence;
  }
  try {
    const endpoint = resolveGithubReleasesEndpoint(deps.env ?? {});
    const raw = await boundedJson(endpoint, deps.fetch ?? fetch, {
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    const releases = parseGithubReleases(raw);
    const versions = releases
      .filter((release) => !release.prerelease && !release.draft)
      .map((release) => release.version);
    const latest = versions.slice().sort(compareVersions).at(-1);
    const latestRelease = latest
      ? releases.find((release) => release.version === latest)
      : undefined;
    const evidence: VersionSourceEvidence = {
      source: "github",
      status: "ok",
      checkedAt,
      versions,
      ...(latest ? { latestVersion: latest } : {}),
      ...(latestRelease?.publishedAt ? { latestPublishedAt: latestRelease.publishedAt } : {}),
    };
    githubCache = { key: cacheKey, expiresAt: nowMs + GITHUB_CACHE_TTL_MS, evidence };
    return evidence;
  } catch (error) {
    const code =
      error instanceof CliError && /rate limited/i.test(error.message)
        ? "RATE_LIMITED"
        : "NETWORK_ERROR";
    return {
      source: "github",
      status: "error",
      checkedAt,
      versions: [],
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export async function fetchNpmEvidence(deps: {
  readonly fetchVersions?: () => Promise<readonly string[]>;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly currentVersion: string;
}): Promise<VersionSourceEvidence> {
  const checkedAt = nowIso(deps.now);
  try {
    const versions = deps.fetchVersions
      ? await deps.fetchVersions()
      : await fetchMoeiconsVersionsCached({
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        });
    const latest = latestInChannel(deps.currentVersion, versions);
    return {
      source: "npm",
      status: "ok",
      checkedAt,
      versions,
      ...(latest ? { latestVersion: latest } : {}),
    };
  } catch (error) {
    return {
      source: "npm",
      status: "error",
      checkedAt,
      versions: [],
      error: {
        code:
          error instanceof CliError && error.code === "CANCELLED"
            ? "NETWORK_ERROR"
            : "NETWORK_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Compose independent evidence into one display contract (never a merged latest). */
export function collectCliVersionCheck(input: {
  readonly currentVersion: string;
  readonly installSource: InstallSource;
  readonly npm: VersionSourceEvidence;
  readonly github: VersionSourceEvidence;
}): CliVersionCheck {
  const npmUpdateAvailable =
    input.npm.latestVersion !== undefined &&
    compareVersions(input.npm.latestVersion, input.currentVersion) > 0;
  const githubUpdateAvailable =
    input.github.latestVersion !== undefined &&
    compareVersions(input.github.latestVersion, input.currentVersion) > 0;
  return {
    currentVersion: input.currentVersion,
    installSource: input.installSource,
    npm: input.npm,
    github: input.github,
    npmUpdateAvailable,
    githubUpdateAvailable,
    ...(npmUpdateAvailable && input.npm.latestVersion
      ? { npmInstruction: fixedUpdateInstruction(input.installSource, input.npm.latestVersion) }
      : {}),
    githubNote: githubUpdateAvailable
      ? `GitHub Release v${input.github.latestVersion} is published independently; npm package status is shown above. Installation guidance: ${CLI_UPDATE_DOCS_URL}`
      : `GitHub Releases are source/artifact evidence; installed-CLI upgrades use the npm channel. Docs: ${CLI_UPDATE_DOCS_URL}`,
  };
}

/**
 * Explicit, read-only update check. Network failures never fail the command and
 * never block the interactive wizard: each source reports its own status.
 */
export async function runCliVersionCheck(input: {
  readonly currentVersion: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: CliUpdateFileSystem;
  readonly fetchVersions?: () => Promise<readonly string[]>;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Tests/programmatic callers may skip the independent GitHub request. */
  readonly checkGithub?: boolean;
}): Promise<CliVersionCheck> {
  const timeoutMs = Math.min(10_000, Math.max(250, input.timeoutMs ?? 1_000));
  const local = detectLocalInstall(input.cwd, input.fs);
  const source = detectInstallSource({ env: input.env, ...local });
  const [npm, github] = await Promise.all([
    fetchNpmEvidence({
      ...(input.fetchVersions ? { fetchVersions: input.fetchVersions } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.now ? { now: input.now } : {}),
      currentVersion: input.currentVersion,
      timeoutMs,
    }),
    input.checkGithub === false
      ? Promise.resolve<VersionSourceEvidence>({
          source: "github",
          status: "unavailable",
          checkedAt: nowIso(input.now),
          versions: [],
          error: { code: "NETWORK_ERROR", message: "GitHub release check skipped" },
        })
      : fetchGithubEvidence({
          env: input.env,
          ...(input.fetch ? { fetch: input.fetch } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.now ? { now: input.now } : {}),
          timeoutMs,
        }),
  ]);
  return collectCliVersionCheck({
    currentVersion: input.currentVersion,
    installSource: source,
    npm,
    github,
  });
}
