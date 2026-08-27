import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { CliError } from "../errors/index.js";
import { artifactCachePath, metadataCachePath } from "./free-download.js";
import { downloadSignedArtifact } from "./signed-artifact.js";
import { fetchProDescriptor, proSignedDownloadOptions } from "./pro-download.js";
import { fetchLibraryVersions } from "./version-service.js";
import type { AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import { isVersionNewer } from "../metadata/version.js";
import { verifyArtifact } from "../project/install.js";
import { cacheArtifact } from "./cache.js";

function cacheDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
}

/** Versions of pro archives currently present in the global cache. */
function cachedProVersions(dir: string): string[] {
  const base = join(dir, "moewolf-dev", "moe-icons");
  if (!existsSync(base)) return [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return names.filter((name) => /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/.test(name));
}

export type ProResourceState =
  | { readonly kind: "not-cached"; readonly version: string; readonly codeBytes: number; readonly metadataBytes: number }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "outdated"; readonly version: string; readonly latestVersion: string; readonly codeBytes: number; readonly metadataBytes: number }
  | { readonly kind: "corrupt"; readonly version: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Read-only state of cached Pro resources relative to the published latest
 * version. Used by the authenticated home screen (Download/Update/Repair).
 */
export async function proResourceState(
  context: CommandContext,
  auth: AuthUseCaseDependencies,
  deps: { readonly fetch?: typeof fetch; readonly allowedProHosts?: readonly string[] } = {},
): Promise<ProResourceState> {
  let versions;
  try {
    versions = await fetchLibraryVersions({ ...(deps.fetch ? { fetch: deps.fetch } : {}), signal: context.signal, env: context.env });
  } catch {
    return { kind: "unavailable", reason: "version check failed" };
  }
  if (!versions.pro) return { kind: "unavailable", reason: "no pro release is published" };
  const latest = versions.pro;

  let descriptor;
  try {
    descriptor = await fetchProDescriptor(
      context,
      auth,
      { version: latest.version, descriptorSha256: latest.descriptorSha256 },
      { ...(deps.fetch ? { fetch: deps.fetch } : {}) },
    );
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof CliError ? error.message : "pro resources unavailable",
    };
  }

  const dir = cacheDir(context.env);
  const codePath = artifactCachePath(dir, descriptor.version, descriptor.sha256);
  const metaPath = descriptor.metadata
    ? metadataCachePath(dir, descriptor.version, descriptor.metadata.sha256)
    : undefined;

  if (existsSync(codePath) && (metaPath === undefined || existsSync(metaPath))) {
    const codeOk = verifyArtifact(readFileSync(codePath), descriptor.sha256).ok;
    const metaOk = metaPath === undefined || verifyArtifact(readFileSync(metaPath), descriptor.metadata!.sha256).ok;
    if (codeOk && metaOk) return { kind: "current", version: descriptor.version };
    return { kind: "corrupt", version: descriptor.version };
  }

  const cached = cachedProVersions(dir).find(
    (version) => version !== descriptor.version && isVersionNewer(descriptor.version, version),
  );
  if (cached) {
    return {
      kind: "outdated",
      version: cached,
      latestVersion: descriptor.version,
      codeBytes: descriptor.size,
      metadataBytes: descriptor.metadata?.size ?? 0,
    };
  }
  return {
    kind: "not-cached",
    version: descriptor.version,
    codeBytes: descriptor.size,
    metadataBytes: descriptor.metadata?.size ?? 0,
  };
}

export interface ProPredownloadResult {
  readonly version: string;
  readonly codeSha256: string;
  readonly metadataSha256?: string;
  readonly codeBytes: number;
  readonly metadataBytes: number;
}

/**
 * Pre-download (and verify + cache) the full Pro code + metadata archives after
 * login or from the home screen, without installing anything into a project.
 */
export async function runProPredownloadUseCase(
  context: CommandContext,
  auth: AuthUseCaseDependencies,
  deps: {
    readonly fetch?: typeof fetch;
    readonly allowedProHosts?: readonly string[];
    readonly force?: boolean;
    readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
  } = {},
): Promise<ProPredownloadResult> {
  const versions = await fetchLibraryVersions({ ...(deps.fetch ? { fetch: deps.fetch } : {}), signal: context.signal, env: context.env });
  if (!versions.pro) throw new CliError("NOT_FOUND", "no pro release is published");
  const latest = versions.pro;
  const descriptor = await fetchProDescriptor(
    context,
    auth,
    { version: latest.version, descriptorSha256: latest.descriptorSha256 },
    { ...(deps.fetch ? { fetch: deps.fetch } : {}) },
  );

  const dir = cacheDir(context.env);
  const downloadOptions = proSignedDownloadOptions(context, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.allowedProHosts ? { allowedHosts: deps.allowedProHosts } : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  });
  const persist = (path: string, bytes: Uint8Array, expectedSha256: string): void => {
    if (deps.force && existsSync(path)) rmSync(path, { force: true });
    if (!existsSync(path) || deps.force) {
      cacheArtifact(
        {
          mkdirSync: (dir) => mkdirSync(dir, { recursive: true }),
          writeFileSync,
          renameSync,
          existsSync,
          rmSync,
        },
        path,
        bytes,
        expectedSha256,
      );
    }
  };

  const codeRef = { url: descriptor.url, expiresAt: descriptor.expiresAt, size: descriptor.size, sha256: descriptor.sha256 };
  const codeBytes = await downloadSignedArtifact(codeRef, downloadOptions);
  persist(artifactCachePath(dir, descriptor.version, descriptor.sha256), codeBytes, descriptor.sha256);

  let metadataSha256: string | undefined;
  let metadataBytes = 0;
  if (descriptor.metadata) {
    const metaBytes = await downloadSignedArtifact(descriptor.metadata, downloadOptions);
    metadataSha256 = descriptor.metadata.sha256;
    metadataBytes = metaBytes.byteLength;
    persist(metadataCachePath(dir, descriptor.version, descriptor.metadata.sha256), metaBytes, descriptor.metadata.sha256);
  }

  return {
    version: descriptor.version,
    codeSha256: descriptor.sha256,
    ...(metadataSha256 ? { metadataSha256 } : {}),
    codeBytes: codeBytes.byteLength,
    metadataBytes,
  };
}
