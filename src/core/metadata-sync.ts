import { join } from "node:path";
import { homedir } from "node:os";
import { CliError } from "../errors/index.js";
import { detectProject } from "../project/detect.js";
import { loadConfigDocument, validateConfigDocument } from "../project/config.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
} from "../project/install-metadata.js";
import { parsePackageInstallMetadata, serializePackageInstallMetadata } from "../project/package-install-metadata.js";
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
import { downloadFreeVersionPackages } from "./free-small-package-download.js";
import { downloadProVersionPackages } from "./pro-small-package-download.js";
import { runAccessTokenUseCase } from "./auth.js";
import { packageTargetFiles, planConfigPackagesFromMetadata } from "./config-package-plan.js";
import { canonicalBytes, sha256, type PackageRow } from "./small-pack/candidate-set.cjs";
import type { SelectedCandidate } from "./small-package-selection.js";

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
  const rawMetadata = deps.fs.readFileSync(metadataPath, "utf8");
  let schemaVersion: unknown;
  try {
    const parsed: unknown = JSON.parse(rawMetadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
  } catch { /* reported as invalid metadata below */ }
  if (schemaVersion === 2) {
    return runPackageSetMetadataSync(context, deps, project.root, rawMetadata, options);
  }
  const old = parseInstallMetadata(rawMetadata);
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

async function runPackageSetMetadataSync(
  context: CommandContext,
  deps: MetadataSyncDeps,
  projectRoot: string,
  rawMetadata: string,
  options: { readonly tier?: "free" | "pro" },
): Promise<{
  readonly projectRoot: string;
  readonly tier: "free" | "pro";
  readonly artifactVersion: string;
  readonly metadataSha256: string;
  readonly files: readonly string[];
  readonly networkBytes: number;
}> {
  const installed = parsePackageInstallMetadata(rawMetadata);
  if (!installed) throw new CliError("VALIDATION_ERROR", "package-set install metadata is invalid; run install first");
  const tier = installed.candidate.tier;
  if (options.tier && options.tier !== tier)
    throw new CliError("VALIDATION_ERROR", "metadata refresh tier differs from the installed package-set");

  const document = loadConfigDocument(projectRoot);
  const bootstrap = validateConfigDocument(document, undefined, { lenientCatalog: true });
  if (bootstrap.kind !== "ok")
    throw new CliError("VALIDATION_ERROR", bootstrap.kind === "invalid" ? bootstrap.message : "project config is missing");
  if (bootstrap.config.tier !== tier || bootstrap.config.target !== installed.target)
    throw new CliError("VALIDATION_ERROR", "metadata refresh config differs from the installed package-set; run update");
  const plannedConfigDocument = JSON.stringify(document);
  const expectedPins = installed.packages
    .map(({ resourceKey, packageSha256, dependencies }) => ({ resourceKey, packageSha256, dependencies: [...dependencies] }))
    .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en"));
  let packagePlan: Awaited<ReturnType<typeof planConfigPackagesFromMetadata>> | undefined;
  const writes: Record<string, string | Uint8Array> = Object.create(null) as Record<string, string | Uint8Array>;
  const resolveResourceKeys = async (
    candidate: SelectedCandidate,
    loadVerifiedPackage: (row: PackageRow) => Promise<Readonly<Record<string, Uint8Array>>>,
  ): Promise<readonly string[]> => {
    const identity = candidate.root;
    if (
      identity.fullVersion !== installed.candidate.fullVersion ||
      identity.tier !== tier ||
      identity.packageSetSha256 !== installed.candidate.packageSetSha256 ||
      identity.sourceCommit !== installed.candidate.sourceCommit ||
      identity.generatorCommit !== installed.candidate.generatorCommit ||
      sha256(canonicalBytes(identity)) !== installed.candidate.candidateRootSha256
    ) throw new CliError("VALIDATION_ERROR", "published package-set identity differs from the installed pin; refusing metadata refresh");

    packagePlan = await planConfigPackagesFromMetadata(bootstrap.config, candidate, loadVerifiedPackage);
    const actualPins = packagePlan.packages
      .map(({ resourceKey, packageSha256, dependencies }) => ({ resourceKey, packageSha256, dependencies: [...dependencies] }))
      .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en"));
    if (JSON.stringify(actualPins) !== JSON.stringify(expectedPins))
      throw new CliError("VALIDATION_ERROR", "configured package selection differs from the installed candidate; run update before metadata refresh");
    return packagePlan.resourceKeys.filter((key) => key.startsWith(`metadata/${tier}/`));
  };
  const consume = (row: PackageRow, files: Readonly<Record<string, Uint8Array>>): Promise<void> => {
    if (row.kind !== "metadata") throw new CliError("VALIDATION_ERROR", "metadata refresh selected a non-metadata package");
    const mapped = packageTargetFiles(row, files, bootstrap.config.target);
    for (const [path, bytes] of Object.entries(mapped.files)) {
      const installPath = `.moeicons/package-metadata/${path}`;
      if (Object.hasOwn(writes, installPath)) throw new CliError("VALIDATION_ERROR", "metadata package paths overlap");
      writes[installPath] = bytes;
    }
    return Promise.resolve();
  };
  const cacheDir = deps.free.cacheDir ?? join(homedir(), ".moeicons", "cache");
  const downloadOptions = {
    cacheDir,
    fullVersion: installed.candidate.fullVersion,
    expectedPackageSetSha256: installed.candidate.packageSetSha256,
    resolveResourceKeys,
    consume,
    ...(context.env.MOEICONS_API_BASE_URL ? { apiBaseUrl: context.env.MOEICONS_API_BASE_URL } : {}),
    ...(deps.fetch ? { fetchFn: deps.fetch } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
  const report = tier === "free"
    ? await downloadFreeVersionPackages({
        ...downloadOptions,
        ...(deps.free.fixtureBaseUrl ? { fixtureOrigin: deps.free.fixtureBaseUrl } : {}),
      })
    : await downloadProVersionPackages({
        ...downloadOptions,
        accessToken: await runAccessTokenUseCase(context, deps.auth),
      });
  if (!packagePlan) throw new CliError("VALIDATION_ERROR", "metadata refresh did not produce a verified package plan");

  const catalogJson = `${JSON.stringify(packagePlan.catalog, null, 2)}\n`;
  const catalogSha256 = sha256Bytes(catalogJson);
  writes[".moeicons/catalog.json"] = catalogJson;
  const managedFiles = {
    ...installed.managedFiles,
    ...Object.fromEntries(Object.entries(writes).map(([path, content]) => [path, sha256Bytes(content)])),
  };
  const nextMetadata = {
    ...installed,
    catalogSha256,
    installedAt: context.now().toISOString(),
    managedFiles,
  };
  writes[".moeicons/install-metadata.json"] = serializePackageInstallMetadata(nextMetadata);

  await withProjectLock(projectRoot, "update", () => {
    if (deps.fs.readFileSync(join(projectRoot, ".moeicons", "install-metadata.json"), "utf8") !== rawMetadata)
      throw new CliError("VALIDATION_ERROR", "installed package-set changed during metadata refresh; retry");
    if (JSON.stringify(loadConfigDocument(projectRoot)) !== plannedConfigDocument)
      throw new CliError("VALIDATION_ERROR", "config changed during metadata refresh; retry");
    executeManagedReconcile(projectRoot, writes, [], deps.fs);
  });
  return {
    projectRoot,
    tier,
    artifactVersion: installed.candidate.fullVersion,
    metadataSha256: catalogSha256,
    files: Object.keys(writes).sort((a, b) => a.localeCompare(b, "en")),
    networkBytes: report.networkBytes + report.metadataNetworkBytes,
  };
}
