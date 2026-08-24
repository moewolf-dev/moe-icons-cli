import { join } from "node:path";
import { homedir } from "node:os";
import { executeGeneratedFilesDir, type TransactionalFsWithCopy } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig, type MoeiconsConfigFile } from "../project/config.js";
import { planGeneratedFiles } from "../generator/generate.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "../project/tailwind.js";
import { isCliError } from "../errors/index.js";
import { extractTarGz } from "../project/tar-gz.js";
import { artifactCachePath } from "./free-download.js";
import { resolveThemes } from "../generator/theme-resolve.js";
import type { CommandContext } from "./context.js";

export type GenerateResult =
  | { readonly ok: true; readonly files: readonly string[]; readonly warnings?: readonly string[]; readonly notes?: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly errors?: readonly string[]; readonly code?: string };

function hasBitmapThemes(config: MoeiconsConfigFile): boolean {
  const resolved = resolveThemes(config);
  return resolved.ok && resolved.themes.some((theme) => theme.kind === "bitmap");
}

function readInstallMetadata(
  projectRoot: string,
  readFileSync: (path: string, encoding: "utf8") => string,
  existsSync: (path: string) => boolean,
): { artifactVersion?: string; artifactSha256?: string } | undefined {
  const path = join(projectRoot, ".moeicons", "install-metadata.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      artifactVersion?: unknown;
      artifactSha256?: unknown;
    };
    return {
      ...(typeof parsed.artifactVersion === "string" ? { artifactVersion: parsed.artifactVersion } : {}),
      ...(typeof parsed.artifactSha256 === "string" ? { artifactSha256: parsed.artifactSha256 } : {}),
    };
  } catch {
    return undefined;
  }
}

function readBinaryFile(fs_: Pick<TransactionalFsWithCopy, "readFileSync">, path: string): Uint8Array {
  const data = fs_.readFileSync(path) as Buffer | string;
  return typeof data === "string" ? Buffer.from(data, "utf8") : new Uint8Array(data);
}

/**
 * Load the cached free tarball (or an injected map) so G5 can copy a single
 * bitmap variant into the generate transaction.
 */
export function loadArchiveFiles(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  fs_: Pick<TransactionalFsWithCopy, "readFileSync" | "existsSync">,
  injected?: Readonly<Record<string, Uint8Array>>,
): { readonly ok: true; readonly files: Readonly<Record<string, Uint8Array>> } | { readonly ok: false; readonly reason: string } {
  if (injected) return { ok: true, files: injected };
  const fixtureTgz = env.MOEICONS_BITMAP_ARCHIVE;
  if (fixtureTgz && fs_.existsSync(fixtureTgz)) {
    const unpacked = extractTarGz(readBinaryFile(fs_, fixtureTgz), {
      maxEntries: 20_000,
      maxExpandedBytes: 64 * 1024 * 1024,
    });
    if (unpacked.errors.length > 0) return { ok: false, reason: unpacked.errors[0] ?? "invalid bitmap archive fixture" };
    return { ok: true, files: unpacked.files };
  }
  const meta = readInstallMetadata(projectRoot, fs_.readFileSync, fs_.existsSync);
  const cacheDir = env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
  if (meta?.artifactVersion && meta.artifactSha256) {
    const cached = artifactCachePath(cacheDir, meta.artifactVersion, meta.artifactSha256);
    if (fs_.existsSync(cached)) {
      const unpacked = extractTarGz(readBinaryFile(fs_, cached), {
        maxEntries: 20_000,
        maxExpandedBytes: 64 * 1024 * 1024,
      });
      if (unpacked.errors.length > 0) return { ok: false, reason: unpacked.errors[0] ?? "invalid cached artifact" };
      return { ok: true, files: unpacked.files };
    }
  }
  return { ok: false, reason: "bitmap archive not found" };
}

export function runGenerateUseCase(
  context: CommandContext,
  fs_: TransactionalFsWithCopy,
  options: { readonly noTailwind?: boolean; readonly archiveFiles?: Readonly<Record<string, Uint8Array>> } = {},
): GenerateResult {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };
  const loaded = readMoeiconsConfig(project.root);
  if (loaded.kind !== "ok") return { ok: false, reason: `config state: ${loaded.kind}` };

  const bitmap = hasBitmapThemes(loaded.config);
  let archiveFiles: Readonly<Record<string, Uint8Array>> | undefined = options.archiveFiles;
  if (bitmap && archiveFiles === undefined) {
    const loadedArchive = loadArchiveFiles(project.root, context.env, fs_, undefined);
    if (!loadedArchive.ok) {
      return {
        ok: false,
        reason: "validation",
        errors: [
          "bitmap themes require a downloaded free artifact; run `moeicons install` or set MOEICONS_BITMAP_ARCHIVE",
        ],
      };
    }
    archiveFiles = loadedArchive.files;
  }

  const plan = planGeneratedFiles(loaded.config, loaded.config.outputDir, archiveFiles ? { archiveFiles } : {});
  if (!plan.ok) return { ok: false, reason: "validation", errors: plan.errors };

  const notes: string[] = [];
  const sideFiles: { path: string; content: string }[] = [];

  try {
    const tw = planTailwindIntegration(project.root, loaded.config.outputDir, {
      noTailwind: options.noTailwind === true,
    });
    notes.push(...tw.notes);
    sideFiles.push(...tw.files);
  } catch (error) {
    if (isCliError(error) && error.code === "TAILWIND_VERSION_UNSUPPORTED") {
      return { ok: false, reason: error.message, code: error.code };
    }
    throw error;
  }

  const pkgPath = join(project.root, "package.json");
  if (fs_.existsSync(pkgPath)) {
    const pkgSource = fs_.readFileSync(pkgPath, "utf8");
    const deps = ensureClassMergeDependencies(pkgSource);
    notes.push(...deps.notes);
    if (deps.changed) {
      sideFiles.push({ path: pkgPath, content: deps.nextSource });
    }
  }

  try {
    executeGeneratedFilesDir(plan.files, project.root, loaded.config.outputDir, fs_);
    for (const file of sideFiles) {
      fs_.writeFileSync(file.path, file.content);
    }
    return {
      ok: true,
      files: plan.files.map((file) => file.path),
      ...((loaded.warnings.length > 0 || notes.length > 0)
        ? { warnings: [...loaded.warnings, ...notes] }
        : {}),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
