import { join } from "node:path";
import { homedir } from "node:os";
import { CliError } from "../errors/index.js";
import { detectProject } from "../project/detect.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
} from "../project/install-metadata.js";
import { executeManagedReconcile, type TransactionalFsWithCopy } from "../project/install.js";
import { withProjectLock } from "../project/project-lock.js";
import { cacheArtifact } from "./cache.js";
import type { CommandContext } from "./context.js";
import type { AuthUseCaseDependencies } from "./auth.js";
import {
  downloadMetadataArchive,
  fetchFreeDescriptor,
  metadataCachePath,
  type FreeDownloadIo,
} from "./free-download.js";
import { downloadSignedArtifact } from "./signed-artifact.js";
import { extractProMetadata, fetchProDescriptor, proSignedDownloadOptions } from "./pro-download.js";

export interface MetadataSyncDeps {
  readonly fs: TransactionalFsWithCopy;
  readonly free: Omit<FreeDownloadIo, "signal">;
  readonly auth: AuthUseCaseDependencies;
  readonly fetch?: typeof fetch;
  readonly allowedProHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
}

function toCliError(result: { readonly ok: false; readonly reason: string; readonly message: string }): CliError {
  return new CliError(result.reason === "cancelled" ? "CANCELLED" : "VALIDATION_ERROR", result.message);
}

/**
 * Metadata-only sync: downloads only the small metadata archive for the
 * already-installed code version and reconciles `.moeicons/{MANUAL.md,
 * catalog.json, manifest.json}`. Never downloads the code archive and never
 * changes the installed code version.
 */
export async function runMetadataSyncUseCase(
  context: CommandContext,
  deps: MetadataSyncDeps,
  options: { readonly tier?: "free" | "pro" } = {},
): Promise<{
  readonly projectRoot: string;
  readonly tier: "free" | "pro";
  readonly artifactVersion: string;
  readonly metadataSha256: string;
  readonly files: readonly string[];
}> {
  const project = detectProject(context.cwd);
  if (!project) throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents");
  const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
  if (!deps.fs.existsSync(metadataPath))
    throw new CliError("VALIDATION_ERROR", "managed install metadata is missing; run install first");
  const old = parseInstallMetadata(deps.fs.readFileSync(metadataPath, "utf8"));
  if (!old) throw new CliError("VALIDATION_ERROR", "managed install metadata is invalid; run install first");
  const tier = options.tier ?? old.tier;
  const version = old.artifactVersion;

  let catalogJson: string;
  let manifestJson: string;
  let manualMd: string;
  let metadataSha256: string;
  if (tier === "free") {
    const fetched = await fetchFreeDescriptor(
      { ...deps.free, signal: context.signal, ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) },
      version,
    );
    if (!fetched.ok) throw toCliError(fetched);
    const metaRef = fetched.descriptor.free.metadata;
    if (!metaRef) throw new CliError("VALIDATION_ERROR", "release descriptor is missing the metadata archive");
    const meta = await downloadMetadataArchive(
      { ...deps.free, signal: context.signal, ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) },
      metaRef,
      fetched.descriptor.catalog.sha256,
      "free",
      version,
      fetched.tag,
    );
    if (!meta.ok) throw toCliError(meta);
    catalogJson = meta.value.catalogJson;
    manifestJson = meta.value.manifestJson;
    manualMd = meta.value.manualMd;
    metadataSha256 = meta.value.metadataSha256;
  } else {
    const descriptor = await fetchProDescriptor(
      context,
      deps.auth,
      { version, descriptorSha256: old.descriptorSha256 },
      { ...(deps.fetch ? { fetch: deps.fetch } : {}) },
    );
    if (!descriptor.metadata) throw new CliError("VALIDATION_ERROR", "pro descriptor is missing the metadata archive");
    const metaBytes = await downloadSignedArtifact(
      descriptor.metadata,
      proSignedDownloadOptions(context, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.allowedProHosts ? { allowedHosts: deps.allowedProHosts } : {}),
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      }),
    );
    const meta = extractProMetadata(metaBytes, descriptor.catalogSha256, descriptor.version);
    catalogJson = meta.catalogJson;
    manifestJson = meta.manifestJson;
    manualMd = meta.manualMd;
    metadataSha256 = descriptor.metadata.sha256;
    const cacheDir = context.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
    const cached = metadataCachePath(cacheDir, descriptor.version, descriptor.metadata.sha256);
    if (!deps.fs.existsSync(cached)) {
      cacheArtifact(deps.fs, cached, metaBytes, descriptor.metadata.sha256);
    }
  }

  const writes: Record<string, string | Uint8Array> = {
    ".moeicons/MANUAL.md": manualMd,
    ".moeicons/catalog.json": catalogJson,
    ".moeicons/manifest.json": manifestJson,
  };
  const managedFiles = {
    ...old.managedFiles,
    ".moeicons/MANUAL.md": sha256Bytes(manualMd),
    ".moeicons/catalog.json": sha256Bytes(catalogJson),
    ".moeicons/manifest.json": sha256Bytes(manifestJson),
  };
  const nextMetadata = {
    ...old,
    installedAt: context.now().toISOString(),
    managedFiles,
  };
  writes[".moeicons/install-metadata.json"] = serializeInstallMetadata(nextMetadata);

  await withProjectLock(project.root, "update", () => executeManagedReconcile(project.root, writes, [], deps.fs));

  return {
    projectRoot: project.root,
    tier,
    artifactVersion: version,
    metadataSha256,
    files: [".moeicons/MANUAL.md", ".moeicons/catalog.json", ".moeicons/manifest.json"],
  };
}
