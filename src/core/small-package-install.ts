import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, posix } from "node:path";
import { canonicalBytes, sha256, type PackageRow } from "./small-pack/candidate-set.cjs";
import { downloadFreeStablePackages, downloadFreeVersionPackages } from "./free-small-package-download.js";
import { downloadProStablePackages, downloadProVersionPackages } from "./pro-small-package-download.js";
import { packageTargetFiles, planConfigPackagesFromMetadata } from "./config-package-plan.js";
import { createInstallPlan, executeInstallPlan, safeManagedPath, type ManagedFileContent, type StagedInstallFile, type TransactionalFs } from "../project/install.js";
import { loadConfigDocument, type MoeiconsConfigFile } from "../project/config.js";
import { serializePackageInstallMetadata, type PackageInstallMetadata } from "../project/package-install-metadata.js";
import { sha256Bytes } from "../project/install-metadata.js";
import type { Target } from "../commands/parser.js";
import { withProjectLock } from "../project/project-lock.js";
import type { SelectedCandidate } from "./small-package-selection.js";

export interface SmallPackageInstallResult {
  readonly artifactVersion: string;
  readonly candidateRootSha256: string;
  readonly packageSetSha256: string;
  readonly catalogSha256: string;
  readonly metadataSha256: string;
  readonly artifactBytes: number;
  readonly files: readonly string[];
  readonly packageCount: number;
  readonly planItems: number;
  readonly selectedFiles: number;
  readonly networkBytes: number;
  readonly cacheHit: boolean;
  readonly cacheHits: number;
  readonly metadataCacheHits: number;
  readonly transferRetryCount: number;
  readonly target: Target;
  readonly targetSha256: string;
  readonly targetFileCount: number;
  readonly targetByteCount: number;
  readonly fallbacks: readonly string[];
}

interface StagedTargetFile {
  readonly absolutePath: string;
  readonly byteSize: number;
}

function targetSubtreeDigest(files: ReadonlyMap<string, StagedTargetFile>): { sha256: string; fileCount: number; byteCount: number } {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const namesAt = (prefix: string): string[] => {
    const names = new Set<string>();
    for (const rel of files.keys()) {
      if (!prefix || rel.startsWith(`${prefix}/`)) {
        const rest = prefix ? rel.slice(prefix.length + 1) : rel;
        const slash = rest.indexOf("/");
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  };
  const appendFile = (entry: StagedTargetFile): void => {
    const descriptor = openSync(entry.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("staged target output is not a regular file");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      let count = 1;
      while (count > 0) {
        count = readSync(descriptor, buffer, 0, buffer.length, position);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        position += count;
      }
      if (position !== entry.byteSize) throw new Error("staged target output changed while calculating install identity");
      byteCount += position;
    } finally {
      closeSync(descriptor);
    }
  };
  const walk = (prefix: string): void => {
    for (const name of namesAt(prefix)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = files.get(relative);
      if (entry) {
        hash.update(relative).update("\0");
        appendFile(entry);
        hash.update("\0");
        fileCount += 1;
      } else walk(relative);
    }
  };
  walk("");
  return { sha256: hash.digest("hex"), fileCount, byteCount };
}

function destination(area: "target" | "assets" | "metadata", target: Target, path: string): string {
  if (area === "target") return `.moeicons/artifact/${target}/${path}`;
  if (area === "assets") return `.moeicons/artifact/assets/${path}`;
  return `.moeicons/package-metadata/${path}`;
}

export async function runSmallPackageInstall(options: {
  readonly projectRoot: string;
  readonly fullVersion?: string;
  readonly expectedPackageSetSha256?: string;
  readonly proAccessToken?: string;
  readonly apiBaseUrl?: string;
  readonly config: MoeiconsConfigFile;
  readonly plannedConfigDocument: string;
  readonly fs: TransactionalFs;
  readonly cacheDir: string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly fixtureOrigin?: string;
}): Promise<SmallPackageInstallResult> {
  if (options.config.downloadMode === "full") throw new Error("package installs require downloadMode=icons; full archive delivery is disabled");
  if (options.config.tier === "pro" && (!options.proAccessToken || options.proAccessToken.length > 8192 || /[\r\n]/.test(options.proAccessToken))) {
    throw new Error("Pro package installs require an authenticated access token");
  }
  if (options.config.icons.length === 0 || Object.keys(options.config.themes).length === 0) throw new Error("configure at least one icon and theme before installing selected packages");

  const operationId = randomUUID();
  const stageRoot = `.moeicons/.package-stage-${operationId}`;
  const stageRootPath = safeManagedPath(options.projectRoot, stageRoot).target;
  const controlPath = safeManagedPath(options.projectRoot, ".moeicons").target;
  let packagePlan: Awaited<ReturnType<typeof planConfigPackagesFromMetadata>> | undefined;
  let candidateRoot: SelectedCandidate | undefined;
  let installedFileCount = 0;
  let nextFile = 0;
  const installFiles: Record<string, ManagedFileContent> = Object.create(null) as Record<string, ManagedFileContent>;
  const targetFiles = new Map<string, StagedTargetFile>();
  const assetManifestEntries: Array<{ path: string; size: number; sha256: string }> = [];

  const stageFile = (installPath: string, relativeToTarget: string | undefined, bytes: Uint8Array): void => {
    if (Object.hasOwn(installFiles, installPath)) throw new Error(`selected packages produce a duplicate install path: ${installPath}`);
    const stagedRelative = `${stageRoot}/files/${String(nextFile++).padStart(6, "0")}`;
    const stagedPath = safeManagedPath(options.projectRoot, stagedRelative);
    options.fs.mkdirSync(dirname(stagedPath.target), { recursive: true });
    options.fs.writeFileSync(stagedPath.target, bytes);
    const digest = sha256Bytes(bytes);
    const staged: StagedInstallFile = { kind: "staged-file", path: stagedRelative, sha256: digest };
    installFiles[installPath] = staged;
    installedFileCount += 1;
    if (relativeToTarget !== undefined) {
      if (targetFiles.has(relativeToTarget)) throw new Error(`selected packages produce a duplicate target file: ${relativeToTarget}`);
      targetFiles.set(relativeToTarget, { absolutePath: stagedPath.target, byteSize: bytes.byteLength });
    }
  };

  options.fs.mkdirSync(controlPath, { recursive: true });
  options.fs.mkdirSync(stageRootPath, { recursive: false });
  try {
    const downloadOptions = {
      cacheDir: options.cacheDir,
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.fixtureOrigin ? { fixtureOrigin: options.fixtureOrigin } : {}),
      resolveResourceKeys: async (candidate: SelectedCandidate, loadVerifiedPackage: (row: PackageRow) => Promise<Readonly<Record<string, Uint8Array>>>) => {
        candidateRoot = candidate;
        packagePlan = await planConfigPackagesFromMetadata(options.config, candidate, loadVerifiedPackage);
        return packagePlan.resourceKeys;
      },
      consume: (row: PackageRow, verifiedFiles: Readonly<Record<string, Uint8Array>>) => {
        const mapped = packageTargetFiles(row, verifiedFiles, options.config.target);
        for (const [relative, bytes] of Object.entries(mapped.files)) {
          const installPath = destination(mapped.area, options.config.target, relative);
          if (mapped.area === "assets") {
            assetManifestEntries.push({ path: relative, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
          }
          const targetRelative = mapped.area === "target" || options.config.target === "assets" && mapped.area === "assets"
            ? relative
            : undefined;
          stageFile(installPath, targetRelative, bytes);
        }
        return Promise.resolve();
      },
    };
    const report = options.config.tier === "free"
      ? options.fullVersion
        ? await downloadFreeVersionPackages({ ...downloadOptions, fullVersion: options.fullVersion, ...(options.expectedPackageSetSha256 ? { expectedPackageSetSha256: options.expectedPackageSetSha256 } : {}) })
        : await downloadFreeStablePackages(downloadOptions)
      : options.fullVersion && options.expectedPackageSetSha256
        ? await downloadProVersionPackages({ ...downloadOptions, accessToken: options.proAccessToken!, fullVersion: options.fullVersion, expectedPackageSetSha256: options.expectedPackageSetSha256 })
        : options.fullVersion || options.expectedPackageSetSha256
          ? (() => { throw new Error("Pro package-set updates require both exact version and package-set SHA-256"); })()
          : await downloadProStablePackages({ ...downloadOptions, accessToken: options.proAccessToken! });
    if (!packagePlan || !candidateRoot) throw new Error("candidate planner did not produce an install plan");
    if (options.signal?.aborted) throw new Error("package install cancelled");

    const catalogJson = `${JSON.stringify(packagePlan.catalog, null, 2)}\n`;
    const catalogSha256 = sha256Bytes(catalogJson);
    installFiles[".moeicons/catalog.json"] = catalogJson;
    if (assetManifestEntries.length > 0) {
      const assets = assetManifestEntries.sort((a, b) => a.path.localeCompare(b.path, "en"));
      const manifestBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`);
      if (options.config.target === "assets") stageFile(".moeicons/artifact/assets/manifest.json", "manifest.json", manifestBytes);
      else installFiles[".moeicons/artifact/assets/manifest.json"] = manifestBytes;
    }
    installFiles[".moeicons/artifact/package.json"] = '{"private":true,"type":"module","sideEffects":false}\n';
    const outputDir = options.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "");
    installFiles[`${outputDir}/types.ts`] = smallPackageTypesReexport(options.config.target, outputDir);
    installFiles[`${outputDir}/.moeicons-${options.config.tier}.marker`] = `${options.config.tier}\n`;
    const tree = targetSubtreeDigest(targetFiles);
    if (tree.fileCount === 0) throw new Error("selected candidate contains no files for the configured target");
    const candidateRootSha256 = sha256(canonicalBytes(candidateRoot.root));
    const packagePins = packagePlan.packages
      .map((row) => ({ resourceKey: row.resourceKey, packageSha256: row.packageSha256, dependencies: [...row.dependencies] }))
      .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en"));
    const metadata: PackageInstallMetadata = {
      schemaVersion: 2,
      candidate: {
        schemaVersion: 1,
        tier: options.config.tier,
        fullVersion: candidateRoot.root.fullVersion,
        sourceCommit: candidateRoot.root.sourceCommit,
        generatorCommit: candidateRoot.root.generatorCommit,
        packageSetSha256: candidateRoot.root.packageSetSha256,
        candidateRootSha256,
      },
      target: options.config.target,
      resourceKeys: [...packagePlan.resourceKeys].sort((a, b) => a.localeCompare(b, "en")),
      packages: packagePins,
      catalogSha256,
      installedAt: options.now().toISOString(),
      managedFiles: Object.fromEntries(Object.entries(installFiles).map(([path, content]) => [
        path,
        typeof content === "object" && "kind" in content ? content.sha256 : sha256Bytes(content),
      ])),
      targetSha256: tree.sha256,
      targetFileCount: tree.fileCount,
      targetByteCount: tree.byteCount,
      generatedOutputDir: outputDir,
    };
    const metadataText = serializePackageInstallMetadata(metadata);
    installFiles[".moeicons/install-metadata.json"] = metadataText;
    const plan = createInstallPlan(options.projectRoot, installFiles);

    await withProjectLock(options.projectRoot, "install", () => {
      if (JSON.stringify(loadConfigDocument(options.projectRoot)) !== options.plannedConfigDocument)
        throw new Error("config changed while preparing package install; retry");
      executeInstallPlan(plan, options.fs);
    });

    return {
      artifactVersion: candidateRoot.root.fullVersion,
      candidateRootSha256,
      packageSetSha256: candidateRoot.root.packageSetSha256,
      catalogSha256,
      metadataSha256: sha256Bytes(metadataText),
      artifactBytes: packagePlan.packages.reduce((sum, row) => sum + row.compressedBytes, 0),
      files: Object.keys(installFiles).sort((a, b) => a.localeCompare(b, "en")),
      packageCount: report.packageCount,
      planItems: plan.items.length,
      selectedFiles: installedFileCount,
      networkBytes: report.networkBytes + report.metadataNetworkBytes,
      cacheHit: report.networkBytes === 0 && report.metadataNetworkBytes === 0,
      cacheHits: report.cacheHits,
      metadataCacheHits: report.metadataCacheHits,
      transferRetryCount: report.transferRetryCount,
      target: options.config.target,
      targetSha256: tree.sha256,
      targetFileCount: tree.fileCount,
      targetByteCount: tree.byteCount,
      fallbacks: packagePlan.fallbacks,
    };
  } catch (error) {
    try {
      if (options.fs.existsSync(stageRootPath)) options.fs.rmSync(stageRootPath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `small package install failed; staging cleanup failed at ${stageRootPath}`);
    }
    throw error;
  }
}

function smallPackageTypesReexport(target: Target, outputDir: string): string {
  const from = posix.relative(outputDir.replace(/\\/g, "/"), `.moeicons/artifact/${target}/types`);
  const specifier = from.startsWith(".") ? from : `./${from}`;
  if (target === "react") return `export type { ReactIconProps } from "${specifier}";\n`;
  if (target === "vue") return `export type { VueIconProps } from "${specifier}";\n`;
  if (target === "vanilla") return `export type { VanillaIconOptions } from "${specifier}";\n`;
  return "export {};\n";
}
