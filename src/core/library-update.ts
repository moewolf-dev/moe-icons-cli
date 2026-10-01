import { assertDownloadSelection } from "./selected-resources.js";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parseCatalog } from "../catalog/catalog.js";
import { CliError } from "../errors/index.js";
import { planGeneratedFiles } from "../generator/generate.js";
import {
  readMoeiconsConfig,
  loadConfigDocument,
  validateConfigDocument,
} from "../project/config.js";
import { detectProject } from "../project/detect.js";
import { executeManagedReconcile, type TransactionalFsWithCopy } from "../project/install.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
  type InstallMetadata,
} from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "../project/tailwind.js";
import {
  extractTarGz,
  ICON_ARCHIVE_MAX_ENTRIES,
  ICON_ARCHIVE_MAX_EXPANDED_BYTES,
} from "../project/tar-gz.js";
import type { AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import {
  artifactCachePath,
  downloadFreeRelease,
  metadataCachePath,
  type FreeDownloadIo,
  type SelectedResourceDownload,
} from "./free-download.js";
import { downloadProArtifact } from "./pro-download.js";
import { PRO_DOWNLOAD_HOSTS, resolveProDescriptorEndpoint } from "./pro-download.js";
import { runAccessTokenUseCase } from "./auth.js";
import { resolveBitmapTuples, resolveConfiguredBitmapShards } from "./bitmap-shard-resolver.js";
import {
  mergeBitmapShardCacheManifest,
  readBitmapShardCacheManifest,
  writeBitmapShardCacheManifest,
} from "./bitmap-shard-cache.js";
import type { BitmapShard } from "./bitmap-shards.js";
import type { CacheIo } from "./cache.js";
import {
  configuredComponentFiles,
  selectTargetSubtree,
  computeSubtreeHash,
  type TargetSubtreeSource,
} from "./target-subtree.js";

export interface LibraryUpdateDeps {
  readonly fs: TransactionalFsWithCopy;
  readonly free?: Omit<FreeDownloadIo, "signal">;
  readonly auth: AuthUseCaseDependencies;
  readonly fetch?: typeof fetch;
  readonly allowedProHosts?: readonly string[];
  readonly onProgress?: (event: {
    readonly downloadedBytes: number;
    readonly totalBytes?: number;
  }) => void;
}

export async function runLibraryUpdateUseCase(
  context: CommandContext,
  deps: LibraryUpdateDeps,
  expected: {
    readonly tier: "free" | "pro";
    readonly version: string;
    readonly descriptorSha256: string;
  },
): Promise<{
  readonly projectRoot: string;
  readonly artifactVersion: string;
  readonly files: readonly string[];
  readonly downloadMode: "icons" | "full";
  readonly downloadNotes: readonly string[];
  readonly networkBytes?: number;
  readonly selectedFiles?: number;
}> {
  const project = detectProject(context.cwd);
  if (!project)
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents",
    );

  const document = loadConfigDocument(project.root);
  const bootstrap = validateConfigDocument(document, undefined, { lenientCatalog: true });
  if (bootstrap.kind !== "ok" || bootstrap.config.tier !== expected.tier)
    throw new CliError(
      "VALIDATION_ERROR",
      bootstrap.kind === "invalid"
        ? bootstrap.message
        : `config.tier must match ${expected.tier}; edit config before updating`,
    );
  assertDownloadSelection(bootstrap.config);
  let selected: SelectedResourceDownload | undefined;
  let catalogJson: string;
  let archiveBytes: Uint8Array;
  let artifactSha256: string;
  let catalogSha256: string;
  let manifestJson: string;
  let manualMd: string;
  let tierSource: TargetSubtreeSource;
  if (expected.tier === "free") {
    if (!deps.free)
      throw new CliError("VALIDATION_ERROR", "free release download dependencies are missing");
    const downloaded = await downloadFreeRelease(
      {
        ...deps.free,
        signal: context.signal,
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      },
      expected.version,
      {
        config: bootstrap.config,
        document,
        onPlan: (message) => context.ui.note(message, context.signal),
      },
    );
    if (!downloaded.ok)
      throw new CliError(
        downloaded.reason === "cancelled" ? "CANCELLED" : "VALIDATION_ERROR",
        downloaded.message,
      );
    if (
      downloaded.descriptorSha256 !== expected.descriptorSha256 ||
      downloaded.descriptor.fullVersion !== expected.version
    ) {
      throw new CliError(
        "VALIDATION_ERROR",
        "downloaded release identity changed after version check; retry the update",
      );
    }
    selected = downloaded.selected;
    catalogJson = downloaded.catalogJson;
    archiveBytes = downloaded.artifactBytes;
    artifactSha256 = downloaded.descriptor.free.sha256;
    catalogSha256 = downloaded.descriptor.catalog.sha256;
    manifestJson = downloaded.manifestJson;
    manualMd = downloaded.manualMd;
    tierSource = downloaded.descriptor.free;
  } else {
    const downloaded = await downloadProArtifact(context, deps.auth, expected, {
      selection: { config: bootstrap.config, document },
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.allowedProHosts ? { allowedHosts: deps.allowedProHosts } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    });
    selected = downloaded.selected;
    catalogJson = downloaded.catalogJson;
    archiveBytes = downloaded.artifactBytes;
    artifactSha256 = downloaded.descriptor.sha256;
    catalogSha256 = downloaded.descriptor.catalogSha256;
    manifestJson = downloaded.manifestJson;
    manualMd = downloaded.manualMd;
    tierSource = downloaded.descriptor;
    const cacheDir = context.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
    const cached = artifactCachePath(
      cacheDir,
      downloaded.descriptor.version,
      downloaded.descriptor.sha256,
    );
    if (!selected && !deps.fs.existsSync(cached)) {
      deps.fs.mkdirSync(join(cached, ".."), { recursive: true });
      deps.fs.writeFileSync(cached, downloaded.artifactBytes);
    }
    if (downloaded.metadataBytes && downloaded.descriptor.metadata) {
      const metaCached = metadataCachePath(
        cacheDir,
        downloaded.descriptor.version,
        downloaded.descriptor.metadata.sha256,
      );
      if (!deps.fs.existsSync(metaCached)) {
        deps.fs.mkdirSync(join(metaCached, ".."), { recursive: true });
        deps.fs.writeFileSync(metaCached, downloaded.metadataBytes);
      }
    }
  }

  let candidateCatalog;
  try {
    candidateCatalog = parseCatalog(JSON.parse(catalogJson));
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", error instanceof Error ? error.message : String(error));
  }
  if (
    candidateCatalog.sourceVersion !== expected.version ||
    sha256Bytes(catalogJson) !== catalogSha256
  ) {
    throw new CliError(
      "VALIDATION_ERROR",
      "candidate catalog identity does not match the selected release",
    );
  }
  const loaded = validateConfigDocument(document, candidateCatalog);
  if (loaded.kind !== "ok" || loaded.config.tier !== expected.tier)
    throw new CliError("VALIDATION_ERROR", `config is invalid for the ${expected.tier} candidate`);
  const plannedConfig = JSON.stringify(loaded.config);
  const installMetadataPath = join(project.root, ".moeicons", "install-metadata.json");
  const plannedMetadata = deps.fs.existsSync(installMetadataPath)
    ? deps.fs.readFileSync(installMetadataPath, "utf8")
    : undefined;
  const unpacked = selected
    ? { files: selected.files, errors: [] }
    : extractTarGz(archiveBytes, {
        maxEntries: ICON_ARCHIVE_MAX_ENTRIES,
        maxExpandedBytes: ICON_ARCHIVE_MAX_EXPANDED_BYTES,
      });
  if (unpacked.errors.length)
    throw new CliError("VALIDATION_ERROR", unpacked.errors[0] ?? "invalid artifact");
  const target = loaded.config.target;
  const selectedTarget = selected
    ? Object.fromEntries(
        Object.entries(selected.files)
          .filter(([path]) => path.startsWith(`${target}/`))
          .map(([path, bytes]) => [path.slice(target.length + 1), bytes]),
      )
    : undefined;
  const subtree = selectedTarget
    ? { ok: true as const, target, files: selectedTarget, ...computeSubtreeHash(selectedTarget) }
    : selectTargetSubtree(archiveBytes, tierSource, target);
  if (!subtree.ok) throw new CliError("VALIDATION_ERROR", subtree.message);
  const archiveFiles = { ...unpacked.files };
  let bitmapPins: readonly BitmapShard[] | undefined;
  let bitmapShardSetSha256: string | undefined;
  const tuples = resolveBitmapTuples(loaded.config, candidateCatalog);
  if (!tuples.ok) throw new CliError("VALIDATION_ERROR", tuples.errors.join("; "));
  if (!selected && tuples.tuples.length > 0 && expected.tier === "pro") {
    const cacheDir = context.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
    const cacheIo: CacheIo = {
      mkdirSync: (path) => deps.fs.mkdirSync(path, { recursive: true }),
      writeFileSync: deps.fs.writeFileSync,
      renameSync: deps.fs.renameSync,
      existsSync: deps.fs.existsSync,
      rmSync: deps.fs.rmSync,
      readFileSync: deps.fs.readFileSync,
      readdirSync: deps.fs.readdirSync,
    };
    const cacheManifest = readBitmapShardCacheManifest(cacheDir, cacheIo);
    const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
    const old = deps.fs.existsSync(metadataPath)
      ? parseInstallMetadata(deps.fs.readFileSync(metadataPath, "utf8"))
      : undefined;
    const existingPins = mergeBitmapShardCacheManifest(
      cacheManifest,
      old?.bitmapShards ?? [],
    ).filter((pin) => pin.resourceVersion === expected.version);
    const accessToken = await runAccessTokenUseCase(context, deps.auth);
    const { loopbackHost } = resolveProDescriptorEndpoint(context.env);
    const allowedHosts =
      deps.allowedProHosts ??
      (loopbackHost ? [...PRO_DOWNLOAD_HOSTS, loopbackHost] : PRO_DOWNLOAD_HOSTS);
    const shards = await resolveConfiguredBitmapShards({
      config: loaded.config,
      catalog: candidateCatalog,
      version: expected.version,
      descriptorSha256: expected.descriptorSha256,
      cacheDir,
      io: cacheIo,
      accessToken,
      allowedHosts,
      existingPins,
      env: context.env,
      now: context.now().getTime(),
      signal: context.signal,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    Object.assign(archiveFiles, shards.files);
    bitmapPins = shards.pins;
    bitmapShardSetSha256 = shards.bitmapShardSetSha256;
    writeBitmapShardCacheManifest(
      cacheDir,
      cacheIo,
      mergeBitmapShardCacheManifest(cacheManifest, shards.pins),
      context.now().getTime(),
    );
  }
  const generated = planGeneratedFiles(loaded.config, loaded.config.outputDir, {
    archiveFiles,
    catalog: candidateCatalog,
  });
  if (!generated.ok) throw new CliError("VALIDATION_ERROR", generated.errors.join("; "));
  const installedFiles = selected
    ? subtree.files
    : configuredComponentFiles(subtree.files, target, loaded.config, candidateCatalog);

  const writes: Record<string, string | Uint8Array> = {
    ".moeicons/catalog.json": catalogJson,
    ".moeicons/manifest.json": manifestJson,
    ".moeicons/MANUAL.md": manualMd,
    ".moeicons/artifact/package.json": '{"private":true,"type":"module","sideEffects":false}\n',
    [`${loaded.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "")}/.moeicons-${expected.tier}.marker`]: `${expected.tier}\n`,
  };
  for (const file of generated.files) writes[file.path.replace(/\\/g, "/")] = file.content;
  for (const [rel, bytes] of Object.entries(installedFiles)) {
    writes[`.moeicons/artifact/${target}/${rel}`] = bytes;
  }
  if (selected) {
    writes[".moeicons/resource-index.json.gz"] = selected.indexBytes;
    for (const [rel, bytes] of Object.entries(selected.files))
      writes[`.moeicons/artifact/${rel}`] = bytes;
  }
  const tailwindPlan = planTailwindIntegration(project.root, loaded.config.outputDir, {
    noTailwind: false,
    target,
  });
  const expectedSideFiles: Record<string, string | undefined> = {};
  for (const side of tailwindPlan.files) {
    const rel = relative(project.root, resolve(side.path)).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../"))
      throw new CliError("VALIDATION_ERROR", `side file escapes project: ${side.path}`);
    writes[rel] = side.content;
    expectedSideFiles[rel] = deps.fs.existsSync(side.path)
      ? sha256Bytes(deps.fs.readFileSync(side.path))
      : undefined;
  }
  const pkgPath = join(project.root, "package.json");
  if (deps.fs.existsSync(pkgPath)) {
    const pkgSource = deps.fs.readFileSync(pkgPath, "utf8");
    expectedSideFiles["package.json"] = sha256Bytes(pkgSource);
    const dependencyPlan =
      target === "react" || target === "vue"
        ? ensureClassMergeDependencies(pkgSource)
        : { nextSource: pkgSource, changed: false, notes: [] };
    if (dependencyPlan.changed) writes["package.json"] = dependencyPlan.nextSource;
  }
  const sidePaths = new Set([
    "package.json",
    ...tailwindPlan.files.map((file) =>
      relative(project.root, resolve(file.path)).replace(/\\/g, "/"),
    ),
  ]);
  const managedFiles = Object.fromEntries(
    Object.entries(writes)
      .filter(([path]) => !sidePaths.has(path))
      .map(([path, content]) => [path, sha256Bytes(content)]),
  );
  const nextMetadata: InstallMetadata = {
    schemaVersion: 1,
    artifactVersion: expected.version,
    tier: expected.tier,
    target,
    descriptorSha256: expected.descriptorSha256,
    artifactSha256,
    catalogSha256,
    installedAt: context.now().toISOString(),
    managedFiles,
    ...(selected
      ? {
          delivery: {
            mode: "icons" as const,
            indexSha256: selected.refs.index.sha256,
            bundleSha256: selected.refs.bundle.sha256,
          },
        }
      : {}),
    generatedOutputDir: loaded.config.outputDir,
    targetSha256: subtree.sha256,
    targetFileCount: subtree.fileCount,
    targetByteCount: subtree.byteCount,
    ...(bitmapPins && bitmapShardSetSha256
      ? { bitmapShards: bitmapPins, bitmapShardSetSha256 }
      : {}),
  };
  writes[".moeicons/install-metadata.json"] = serializeInstallMetadata(nextMetadata);

  await withProjectLock(project.root, "update", () => {
    const currentConfig = readMoeiconsConfig(project.root, candidateCatalog);
    if (currentConfig.kind !== "ok" || JSON.stringify(currentConfig.config) !== plannedConfig)
      throw new CliError("VALIDATION_ERROR", "config changed while preparing update; retry");
    const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
    if (
      !plannedMetadata ||
      !deps.fs.existsSync(metadataPath) ||
      deps.fs.readFileSync(metadataPath, "utf8") !== plannedMetadata
    )
      throw new CliError("VALIDATION_ERROR", "installation changed while preparing update; retry");
    if (!deps.fs.existsSync(metadataPath))
      throw new CliError("VALIDATION_ERROR", "managed install metadata is missing");
    const old = parseInstallMetadata(deps.fs.readFileSync(metadataPath, "utf8"));
    if (!old || old.tier !== expected.tier)
      throw new CliError("VALIDATION_ERROR", "managed install metadata is invalid");
    for (const [path, hash] of Object.entries(old.managedFiles)) {
      const absolute = join(project.root, path);
      if (
        !deps.fs.existsSync(absolute) ||
        sha256Bytes(deps.fs.readFileSync(absolute) as string | Uint8Array) !== hash
      ) {
        throw new CliError("VALIDATION_ERROR", `managed file was modified or removed: ${path}`);
      }
    }
    for (const path of Object.keys(managedFiles)) {
      if (deps.fs.existsSync(join(project.root, path)) && !(path in old.managedFiles)) {
        throw new CliError(
          "VALIDATION_ERROR",
          `update path collides with an unowned user file: ${path}`,
        );
      }
    }
    executeManagedReconcile(
      project.root,
      writes,
      Object.keys(old.managedFiles).filter((path) => !(path in managedFiles)),
      deps.fs,
      {
        expectedSha256: {
          ...Object.fromEntries(
            [...Object.keys(writes), ...Object.keys(old.managedFiles)].map((path) => [
              path,
              old.managedFiles[path] ??
                (path === ".moeicons/install-metadata.json"
                  ? sha256Bytes(plannedMetadata)
                  : undefined),
            ]),
          ),
          ...expectedSideFiles,
        },
      },
    );
  });
  return {
    projectRoot: project.root,
    artifactVersion: expected.version,
    files: generated.files.map((file) => file.path),
    downloadMode: selected ? "icons" : "full",
    downloadNotes:
      selected?.fallbacks ??
      (bootstrap.config.downloadMode === "full"
        ? []
        : [
            "Release does not advertise selected downloads; auto used the verified full archive. Set downloadMode=icons to require selected downloads.",
          ]),
    ...(selected
      ? { networkBytes: selected.networkBytes, selectedFiles: Object.keys(selected.files).length }
      : {}),
  };
}
