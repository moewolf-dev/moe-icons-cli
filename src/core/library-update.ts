import { join, relative, resolve } from "node:path";
import { parseCatalog } from "../catalog/catalog.js";
import { CliError } from "../errors/index.js";
import { planGeneratedFiles } from "../generator/generate.js";
import { readMoeiconsConfig } from "../project/config.js";
import { detectProject } from "../project/detect.js";
import { executeManagedReconcile, type TransactionalFsWithCopy } from "../project/install.js";
import { parseInstallMetadata, serializeInstallMetadata, sha256Bytes, type InstallMetadata } from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "../project/tailwind.js";
import { extractTarGz } from "../project/tar-gz.js";
import type { AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import { downloadFreeRelease, type FreeDownloadIo } from "./free-download.js";
import { downloadProArtifact } from "./pro-download.js";

export interface LibraryUpdateDeps {
  readonly fs: TransactionalFsWithCopy;
  readonly free: Omit<FreeDownloadIo, "signal">;
  readonly auth: AuthUseCaseDependencies;
  readonly fetch?: typeof fetch;
  readonly allowedProHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
}

export async function runLibraryUpdateUseCase(context: CommandContext, deps: LibraryUpdateDeps, expected: {
  readonly tier: "free" | "pro"; readonly version: string; readonly descriptorSha256: string;
}): Promise<{ readonly projectRoot: string; readonly artifactVersion: string; readonly files: readonly string[] }> {
  const project = detectProject(context.cwd);
  if (!project) throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents");

  let catalogJson: string;
  let archiveBytes: Uint8Array;
  let artifactSha256: string;
  let catalogSha256: string;
  if (expected.tier === "free") {
    const downloaded = await downloadFreeRelease({ ...deps.free, signal: context.signal, ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) }, expected.version);
    if (!downloaded.ok) throw new CliError(downloaded.reason === "cancelled" ? "CANCELLED" : "VALIDATION_ERROR", downloaded.message);
    if (downloaded.descriptorSha256 !== expected.descriptorSha256 || downloaded.descriptor.fullVersion !== expected.version) {
      throw new CliError("VALIDATION_ERROR", "downloaded release identity changed after version check; retry the update");
    }
    catalogJson = downloaded.catalogJson;
    archiveBytes = downloaded.artifactBytes;
    artifactSha256 = downloaded.descriptor.free.sha256;
    catalogSha256 = downloaded.descriptor.catalog.sha256;
  } else {
    const downloaded = await downloadProArtifact(context, deps.auth, expected, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.allowedProHosts ? { allowedHosts: deps.allowedProHosts } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    });
    catalogJson = downloaded.catalogJson;
    archiveBytes = downloaded.artifactBytes;
    artifactSha256 = downloaded.descriptor.sha256;
    catalogSha256 = downloaded.descriptor.catalogSha256;
  }

  let candidateCatalog;
  try { candidateCatalog = parseCatalog(JSON.parse(catalogJson)); }
  catch (error) { throw new CliError("VALIDATION_ERROR", error instanceof Error ? error.message : String(error)); }
  if (candidateCatalog.sourceVersion !== expected.version || sha256Bytes(catalogJson) !== catalogSha256) {
    throw new CliError("VALIDATION_ERROR", "candidate catalog identity does not match the selected release");
  }
  const loaded = readMoeiconsConfig(project.root, candidateCatalog);
  if (loaded.kind !== "ok" || loaded.config.tier !== expected.tier) throw new CliError("VALIDATION_ERROR", `config is invalid for the ${expected.tier} candidate`);
  const unpacked = extractTarGz(archiveBytes, { maxEntries: 20_000, maxExpandedBytes: 64 * 1024 * 1024 });
  if (unpacked.errors.length) throw new CliError("VALIDATION_ERROR", unpacked.errors[0] ?? "invalid artifact");
  const generated = planGeneratedFiles(loaded.config, loaded.config.outputDir, { archiveFiles: unpacked.files, catalog: candidateCatalog });
  if (!generated.ok) throw new CliError("VALIDATION_ERROR", generated.errors.join("; "));

  const writes: Record<string, string | Uint8Array> = {
    ".moeicons/catalog.json": catalogJson,
    [`${loaded.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "")}/.moeicons-${expected.tier}.marker`]: `${expected.tier}\n`,
  };
  for (const file of generated.files) writes[file.path.replace(/\\/g, "/")] = file.content;
  const tailwindPlan = planTailwindIntegration(project.root, loaded.config.outputDir, { noTailwind: false });
  for (const side of tailwindPlan.files) {
    const rel = relative(project.root, resolve(side.path)).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../")) throw new CliError("VALIDATION_ERROR", `side file escapes project: ${side.path}`);
    writes[rel] = side.content;
  }
  const pkgPath = join(project.root, "package.json");
  if (deps.fs.existsSync(pkgPath)) {
    const dependencyPlan = ensureClassMergeDependencies(deps.fs.readFileSync(pkgPath, "utf8"));
    if (dependencyPlan.changed) writes["package.json"] = dependencyPlan.nextSource;
  }
  const sidePaths = new Set(["package.json", ...tailwindPlan.files.map((file) => relative(project.root, resolve(file.path)).replace(/\\/g, "/"))]);
  const managedFiles = Object.fromEntries(Object.entries(writes).filter(([path]) => !sidePaths.has(path)).map(([path, content]) => [path, sha256Bytes(content)]));
  const nextMetadata: InstallMetadata = {
    schemaVersion: 1, artifactVersion: expected.version, tier: expected.tier, descriptorSha256: expected.descriptorSha256,
    artifactSha256, catalogSha256, installedAt: context.now().toISOString(), managedFiles,
  };
  writes[".moeicons/install-metadata.json"] = serializeInstallMetadata(nextMetadata);

  await withProjectLock(project.root, "update", () => {
    const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
    if (!deps.fs.existsSync(metadataPath)) throw new CliError("VALIDATION_ERROR", "managed install metadata is missing");
    const old = parseInstallMetadata(deps.fs.readFileSync(metadataPath, "utf8"));
    if (!old || old.tier !== expected.tier) throw new CliError("VALIDATION_ERROR", "managed install metadata is invalid");
    for (const [path, hash] of Object.entries(old.managedFiles)) {
      const absolute = join(project.root, path);
      if (!deps.fs.existsSync(absolute) || sha256Bytes(deps.fs.readFileSync(absolute) as string | Uint8Array) !== hash) {
        throw new CliError("VALIDATION_ERROR", `managed file was modified or removed: ${path}`);
      }
    }
    executeManagedReconcile(project.root, writes, Object.keys(old.managedFiles).filter((path) => !(path in managedFiles)), deps.fs);
  });
  return { projectRoot: project.root, artifactVersion: expected.version, files: generated.files.map((file) => file.path) };
}
